import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";
import type { OAuthProviderContext } from "../provider-runtime.ts";

import { optionalString } from "../../core/cast.ts";
import {
  createProviderTimeout,
  defineOAuthProviderExecutors,
  isAbortSignalError,
  ProviderRequestError,
  ProviderResponseTooLargeError,
  providerUserAgent,
  readProviderJsonBody,
} from "../provider-runtime.ts";
import { quickBooksOnlineAccountingScope } from "./scopes.ts";

const service = "quickbooks_online";
const apiBaseUrls = {
  sandbox: "https://sandbox-quickbooks.api.intuit.com/v3/company",
  production: "https://quickbooks.api.intuit.com/v3/company",
} as const;
const maxProjectionBytes = 2 * 1024 * 1024;
const maxReportCells = 10_000;
const maxReportDepth = 16;
const maxCellLength = 2_048;

interface QuickBooksContext extends OAuthProviderContext {
  realmId: string;
}

interface ReportRequest {
  reportName: "ProfitAndLoss" | "BalanceSheet";
  accountingMethod: "Cash" | "Accrual";
  startDate: string;
  endDate: string;
  asOfDate?: string;
}

export const executors: ProviderExecutors = defineOAuthProviderExecutors(service, {
  async get_company_info(_input, context) {
    return projectCompanyInfo(await getCompanyInfo(toQuickBooksContext(context)));
  },
  async get_profit_and_loss(input, context) {
    const startDate = requireDate(input.start_date, "start_date");
    const endDate = requireDate(input.end_date, "end_date");
    assertProfitAndLossPeriod(startDate, endDate);
    return getReport(toQuickBooksContext(context), {
      reportName: "ProfitAndLoss",
      accountingMethod: requireAccountingMethod(input.accounting_method),
      startDate,
      endDate,
    });
  },
  async get_balance_sheet(input, context) {
    const asOfDate = requireDate(input.as_of_date, "as_of_date");
    return getReport(toQuickBooksContext(context), {
      reportName: "BalanceSheet",
      accountingMethod: requireAccountingMethod(input.accounting_method),
      startDate: `${asOfDate.slice(0, 4)}-01-01`,
      endDate: asOfDate,
      asOfDate,
    });
  },
});

export const credentialValidators: CredentialValidators = {
  async oauth2(input, { fetcher, signal }) {
    const realmId = requireRealmId(input.providerSecret);
    const payload = await getCompanyInfo({
      accessToken: input.accessToken,
      tokenType: input.tokenType,
      providerSecret: input.providerSecret,
      providerConfig: readProviderConfig(input.metadata.oauthClientExtra),
      fetcher,
      signal,
      realmId,
    });
    const companyInfo = requireRecord(payload.CompanyInfo, "CompanyInfo");
    return {
      profile: {
        displayName: requireBoundedString(companyInfo.CompanyName, "CompanyInfo.CompanyName"),
      },
      grantedScopes: [quickBooksOnlineAccountingScope],
    };
  },
};

function toQuickBooksContext(context: OAuthProviderContext): QuickBooksContext {
  return { ...context, realmId: requireRealmId(context.providerSecret) };
}

function readProviderConfig(value: unknown): Record<string, string> | undefined {
  const environment = optionalString(record(value).environment);
  return environment ? { environment } : undefined;
}

function requireRealmId(providerSecret: Record<string, unknown> | undefined): string {
  const realmId = providerSecret?.realmId;
  if (typeof realmId !== "string" || !/^[0-9]{1,255}$/.test(realmId)) {
    throw new ProviderRequestError(401, "Reconnect QuickBooks Online to bind a valid company.");
  }
  return realmId;
}

async function getCompanyInfo(context: QuickBooksContext): Promise<Record<string, unknown>> {
  return getQuickBooksJson(createCompanyUrl(context, `companyinfo/${context.realmId}`), context);
}

async function getReport(context: QuickBooksContext, request: ReportRequest): Promise<Record<string, unknown>> {
  const url = createCompanyUrl(context, `reports/${request.reportName}`);
  url.searchParams.set("start_date", request.startDate);
  url.searchParams.set("end_date", request.endDate);
  url.searchParams.set("accounting_method", request.accountingMethod);
  url.searchParams.set("summarize_column_by", "Total");
  return projectReport(await getQuickBooksJson(url, context), request);
}

function createCompanyUrl(context: Pick<QuickBooksContext, "realmId" | "providerConfig">, path: string): URL {
  const environment = context.providerConfig?.environment;
  if (environment !== "sandbox" && environment !== "production") {
    throw new ProviderRequestError(500, "QuickBooks Online environment is not configured.");
  }
  return new URL(`${apiBaseUrls[environment]}/${encodeURIComponent(context.realmId)}/${path}`);
}

async function getQuickBooksJson(
  url: URL,
  context: Pick<QuickBooksContext, "accessToken" | "tokenType" | "fetcher" | "refreshCredential" | "signal">,
): Promise<Record<string, unknown>> {
  const timeout = createProviderTimeout(context.signal);
  let replayed = false;
  try {
    while (true) {
      let response: Response;
      try {
        response = await context.fetcher(url, {
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: `${context.tokenType ?? "Bearer"} ${context.accessToken}`,
            "user-agent": providerUserAgent,
          },
          signal: timeout.signal,
        });
      } catch (error) {
        throw new ProviderRequestError(
          isAbortSignalError(timeout.signal, error) ? 504 : 502,
          isAbortSignalError(timeout.signal, error)
            ? "QuickBooks Online request timed out."
            : "QuickBooks Online request failed.",
        );
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        if (!replayed && response.status === 401 && context.refreshCredential) {
          const refreshed = await context.refreshCredential();
          context.accessToken = refreshed.accessToken;
          context.tokenType = refreshed.tokenType;
          replayed = true;
          continue;
        }
        if (!replayed && response.status === 500) {
          replayed = true;
          continue;
        }
        if (!replayed && (response.status === 502 || response.status === 503)) {
          replayed = true;
          await waitForRetry(timeout.signal, 250);
          continue;
        }
        if (response.status === 429) {
          throw new ProviderRequestError(
            429,
            "QuickBooks Online rate limit exceeded; retry after at least 60 seconds.",
          );
        }
        throw new ProviderRequestError(response.status, "QuickBooks Online request failed.");
      }
      let payload: unknown;
      try {
        payload = await readProviderJsonBody(response, {
          maxBytes: maxProjectionBytes,
          emptyBody: {},
          invalidJsonMessage: "QuickBooks Online returned an invalid response.",
        });
      } catch (error) {
        if (error instanceof ProviderRequestError && error.status === 413) throw new ProviderResponseTooLargeError();
        throw error;
      }
      const result = requireRecord(payload, "response");
      if (result.Fault != null) throw new ProviderRequestError(502, "QuickBooks Online request failed.");
      return result;
    }
  } finally {
    timeout.cleanup();
  }
}

async function waitForRetry(signal: AbortSignal, milliseconds: number): Promise<void> {
  if (signal.aborted) throw new ProviderRequestError(504, "QuickBooks Online request timed out.");
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeoutId);
      reject(new ProviderRequestError(504, "QuickBooks Online request timed out."));
    };
    const timeoutId = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function projectCompanyInfo(payload: Record<string, unknown>): Record<string, unknown> {
  const info = requireRecord(payload.CompanyInfo, "CompanyInfo");
  const result: Record<string, unknown> = {
    company_name: requireBoundedString(info.CompanyName, "CompanyInfo.CompanyName"),
    observed_at: new Date().toISOString(),
  };
  addOptionalString(result, "country", info.Country);
  addOptionalDate(result, "company_start_date", info.CompanyStartDate);
  addOptionalString(result, "fiscal_year_start_month", info.FiscalYearStartMonth);
  addOptionalString(result, "default_time_zone", info.DefaultTimeZone);
  assertProjectionSize(result);
  return result;
}

function projectReport(payload: Record<string, unknown>, request: ReportRequest): Record<string, unknown> {
  const header = requireRecord(payload.Header, "Header");
  const reportName = requireBoundedString(readCaseInsensitive(header, "ReportName"), "Header.ReportName");
  const reportBasis = requireBoundedString(
    readCaseInsensitive(header, "ReportBasis") ?? readCaseInsensitive(header, "AccountingMethod"),
    "Header.ReportBasis",
  );
  const startDate = requireProviderDate(readCaseInsensitive(header, "StartPeriod"), "Header.StartPeriod");
  const endDate = requireProviderDate(readCaseInsensitive(header, "EndPeriod"), "Header.EndPeriod");
  const summarizeColumnsBy = requireBoundedString(
    readCaseInsensitive(header, "SummarizeColumnsBy"),
    "Header.SummarizeColumnsBy",
  );
  if (
    reportName !== request.reportName ||
    reportBasis !== request.accountingMethod ||
    startDate !== request.startDate ||
    endDate !== request.endDate ||
    summarizeColumnsBy !== "Total"
  ) {
    throw new ProviderRequestError(502, "QuickBooks Online returned mismatched report metadata.");
  }
  const budget = { cells: 0 };
  const columns = readCollection(payload.Columns, "Column", "Columns").map((value) => {
    const column = requireRecord(value, "Columns.Column[]");
    budget.cells += 2;
    assertCellBudget(budget.cells);
    return {
      title: boundedCellString(readCaseInsensitive(column, "ColTitle"), "Columns.Column[].ColTitle"),
      type: boundedCellString(readCaseInsensitive(column, "ColType"), "Columns.Column[].ColType"),
    };
  });
  const rows = readCollection(payload.Rows, "Row", "Rows").map((row) => projectReportRow(row, 1, budget));
  const result: Record<string, unknown> = {
    report_name: request.reportName,
    accounting_method: request.accountingMethod,
    start_date: startDate,
    end_date: endDate,
    observed_at: new Date().toISOString(),
    no_data: readNoReportData(payload),
    columns,
    rows,
  };
  if (request.asOfDate) result.as_of_date = request.asOfDate;
  const currency = boundedString(readCaseInsensitive(header, "Currency"));
  if (currency) result.currency = currency;
  assertProjectionSize(result);
  return result;
}

function projectReportRow(value: unknown, depth: number, budget: { cells: number }): Record<string, unknown> {
  if (depth > maxReportDepth) throw new ProviderResponseTooLargeError();
  const row = requireRecord(value, "Rows.Row[]");
  const childField = findCaseInsensitive(row, "Rows");
  const type = requireBoundedString(readCaseInsensitive(row, "type"), "Rows.Row[].Type");
  if (type !== "Section" && type !== "Data") {
    throw new ProviderRequestError(502, "QuickBooks Online returned an invalid report row type.");
  }
  if ((type === "Section" && !childField.found) || (type === "Data" && childField.found)) {
    throw new ProviderRequestError(502, "QuickBooks Online returned a contradictory report row structure.");
  }
  const childValues = childField.found ? readCollection(childField.value, "Row", "Rows.Row[].Rows") : [];
  const result: Record<string, unknown> = {
    kind: type === "Section" ? "section" : "data",
  };
  addOptionalString(result, "group", readCaseInsensitive(row, "group"));
  addOptionalNestedCells(result, "header", row, "Header", budget);
  addOptionalDirectCells(result, "cells", row, "ColData", budget);
  addOptionalNestedCells(result, "summary", row, "Summary", budget);
  if (childValues.length > 0) result.children = childValues.map((child) => projectReportRow(child, depth + 1, budget));
  return result;
}

function addOptionalNestedCells(
  result: Record<string, unknown>,
  key: string,
  row: Record<string, unknown>,
  containerKey: string,
  budget: { cells: number },
): void {
  const container = findCaseInsensitive(row, containerKey);
  if (!container.found) return;
  const values = Array.isArray(container.value)
    ? container.value
    : requireArray(
        readCaseInsensitive(requireRecord(container.value, containerKey), "ColData"),
        `${containerKey}.ColData`,
      );
  addCells(result, key, values, budget);
}

function addOptionalDirectCells(
  result: Record<string, unknown>,
  key: string,
  row: Record<string, unknown>,
  fieldKey: string,
  budget: { cells: number },
): void {
  const field = findCaseInsensitive(row, fieldKey);
  if (!field.found) return;
  addCells(result, key, requireArray(field.value, fieldKey), budget);
}

function addCells(result: Record<string, unknown>, key: string, values: unknown[], budget: { cells: number }): void {
  const cells = values.map((item) => boundedCellString(readCaseInsensitive(requireRecord(item, key), "value")));
  if (cells.length === 0) return;
  budget.cells += cells.length;
  assertCellBudget(budget.cells);
  result[key] = cells;
}

function readNoReportData(payload: Record<string, unknown>): boolean {
  const header = requireRecord(readCaseInsensitive(payload, "Header"), "Header");
  const optionContainers: unknown[] = [];
  for (const [container, key, label] of [
    [payload, "Options", "Options"],
    [header, "Option", "Header.Option"],
    [header, "Options", "Header.Options"],
  ] as const) {
    const field = findCaseInsensitive(container, key);
    if (!field.found) continue;
    optionContainers.push(...readCollection(field.value, "Option", label));
  }
  for (const value of optionContainers) {
    const option = requireRecord(value, "Options.Option[]");
    const name = requireBoundedString(readCaseInsensitive(option, "Name"), "Options.Option[].Name")
      .replaceAll(/[^a-z]/gi, "")
      .toLowerCase();
    if (name !== "noreportdata") continue;
    const rawValue = readCaseInsensitive(option, "Value");
    if (rawValue === true || rawValue === "true") return true;
    if (rawValue === false || rawValue === "false") return false;
    throw new ProviderRequestError(502, "QuickBooks Online returned an invalid NoReportData option.");
  }
  throw new ProviderRequestError(502, "QuickBooks Online response is missing NoReportData.");
}

function requireAccountingMethod(value: unknown): "Cash" | "Accrual" {
  if (value === "Cash" || value === "Accrual") return value;
  throw new ProviderRequestError(400, "accounting_method must be Cash or Accrual.");
}

function requireDate(value: unknown, fieldName: string): string {
  return requireGregorianDate(value, fieldName, 400);
}

function requireProviderDate(value: unknown, fieldName: string): string {
  return requireGregorianDate(value, fieldName, 502);
}

function requireGregorianDate(value: unknown, fieldName: string, status: number): string {
  const date = optionalString(value);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ProviderRequestError(status, `${fieldName} must be a Gregorian date in YYYY-MM-DD format.`);
  }
  const [year, month, day] = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month! - 1 || parsed.getUTCDate() !== day) {
    throw new ProviderRequestError(status, `${fieldName} must be a Gregorian date in YYYY-MM-DD format.`);
  }
  return date;
}

function assertProfitAndLossPeriod(startDate: string, endDate: string): void {
  if (endDate <= startDate) throw new ProviderRequestError(400, "start_date must be before end_date.");
  if (endDate >= addCalendarMonths(startDate, 6)) {
    throw new ProviderRequestError(400, "Profit and Loss periods must be shorter than six calendar months.");
  }
}

function addCalendarMonths(date: string, months: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const targetMonth = month! - 1 + months;
  const targetYear = year! + Math.floor(targetMonth / 12);
  const normalizedMonth = targetMonth % 12;
  const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, normalizedMonth, Math.min(day!, lastDay))).toISOString().slice(0, 10);
}

function assertCellBudget(cells: number): void {
  if (cells > maxReportCells) throw new ProviderResponseTooLargeError();
}

function assertProjectionSize(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maxProjectionBytes) throw new ProviderResponseTooLargeError();
}

function readCaseInsensitive(recordValue: Record<string, unknown>, key: string): unknown {
  const target = key.toLowerCase();
  for (const [candidate, value] of Object.entries(recordValue)) {
    if (candidate.toLowerCase() === target) return value;
  }
  return undefined;
}

function findCaseInsensitive(
  recordValue: Record<string, unknown>,
  key: string,
): { found: true; value: unknown } | { found: false } {
  const target = key.toLowerCase();
  for (const [candidate, value] of Object.entries(recordValue)) {
    if (candidate.toLowerCase() === target) return { found: true, value };
  }
  return { found: false };
}

function readCollection(value: unknown, itemKey: string, fieldName: string): unknown[] {
  if (Array.isArray(value)) return value;
  const container = requireRecord(value, fieldName);
  const itemField = findCaseInsensitive(container, itemKey);
  if (!itemField.found) {
    throw new ProviderRequestError(502, `QuickBooks Online response is missing ${fieldName}.${itemKey}.`);
  }
  return requireArray(itemField.value, `${fieldName}.${itemKey}`);
}

function addOptionalString(result: Record<string, unknown>, key: string, value: unknown): void {
  const normalized = boundedString(value);
  if (normalized != null) result[key] = normalized;
}

function addOptionalDate(result: Record<string, unknown>, key: string, value: unknown): void {
  const normalized = optionalString(value);
  if (normalized && /^\d{4}-\d{2}-\d{2}$/.test(normalized)) result[key] = normalized;
}

function requireRecord(value: unknown, fieldName: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderRequestError(502, `QuickBooks Online response is missing ${fieldName}.`);
  }
  return value as Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function requireArray(value: unknown, fieldName: string): unknown[] {
  if (!Array.isArray(value)) throw new ProviderRequestError(502, `QuickBooks Online response is missing ${fieldName}.`);
  return value;
}

function requireBoundedString(value: unknown, fieldName: string): string {
  const normalized = boundedString(value);
  if (!normalized) throw new ProviderRequestError(502, `QuickBooks Online response is missing ${fieldName}.`);
  return normalized;
}

function boundedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (normalized.length > maxCellLength) throw new ProviderResponseTooLargeError();
  return normalized || null;
}

function boundedCellString(value: unknown, fieldName = "ColData.value"): string {
  if (typeof value !== "string") {
    throw new ProviderRequestError(502, `QuickBooks Online response is missing ${fieldName}.`);
  }
  if (value.length > maxCellLength) throw new ProviderResponseTooLargeError();
  return value;
}
