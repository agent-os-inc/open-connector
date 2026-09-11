import type { ExecutionContext, ResolvedCredential } from "../../core/types.ts";

import { afterEach, describe, expect, it, vi } from "vitest";
import { quickBooksOnlineActions } from "./actions.ts";
import { credentialValidators, executors } from "./executors.ts";

const realmId = "123456789";

function credential(
  overrides: Partial<Extract<ResolvedCredential, { authType: "oauth2" }>> = {},
): Extract<ResolvedCredential, { authType: "oauth2" }> {
  return {
    authType: "oauth2" as const,
    accessToken: "access-token",
    tokenType: "Bearer",
    refreshToken: "refresh-token",
    providerSecret: { realmId },
    profile: { accountId: "quickbooks_online:oauth2", displayName: "Example Co", grantedScopes: [] },
    metadata: { oauthClientExtra: { environment: "sandbox" } },
    ...overrides,
  };
}

function context(value = credential()): ExecutionContext {
  return { getCredential: async () => value };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return Response.json(payload, { status });
}

function reportFixture(
  reportName: "ProfitAndLoss" | "BalanceSheet",
  options: { startDate: string; endDate: string; basis?: "Cash" | "Accrual"; v2?: boolean } = {
    startDate: "2026-01-01",
    endDate: "2026-03-31",
  },
) {
  const dataRow = options.v2
    ? {
        Type: "Data",
        ColData: [
          { value: "Checking", id: "redaction-sentinel-id", href: "https://secret.invalid" },
          { value: "100.00", qzurl: "redaction-sentinel-qzurl" },
        ],
      }
    : { type: "Data", ColData: [{ value: "Checking", id: "secret-id" }, { value: "100.00" }] };
  return {
    Header: {
      ReportName: reportName,
      ReportBasis: options.basis ?? "Accrual",
      StartPeriod: options.startDate,
      EndPeriod: options.endDate,
      SummarizeColumnsBy: "Total",
      Currency: "USD",
      MetaData: { secret: "redaction-sentinel-metadata" },
    },
    Columns: options.v2
      ? [
          { coltitle: "Account", coltype: "Account" },
          { coltitle: "Total", coltype: "Money" },
        ]
      : {
          Column: [
            { ColTitle: options.v2 ? "Account" : "account", ColType: "Account" },
            { ColTitle: "Total", ColType: "Money" },
          ],
        },
    Rows: options.v2
      ? [
          {
            Type: "Section",
            Group: "Assets",
            Header: [{ value: "Current Assets" }],
            Rows: [dataRow],
            Summary: [{ value: "Total Assets" }, { value: "100.00" }],
            qzurl: "redaction-sentinel-row-qzurl",
          },
        ]
      : {
          Row: [
            {
              type: "Section",
              group: "Assets",
              Header: { ColData: [{ value: options.v2 ? "Current Assets" : "CURRENT ASSETS" }] },
              Rows: { Row: [dataRow] },
              Summary: { ColData: [{ value: "Total Assets" }, { value: "100.00" }] },
              qzurl: "redaction-sentinel-row-qzurl",
            },
          ],
        },
    Options: options.v2
      ? { Option: [{ name: "No Report Data", value: false, secret: "redaction-sentinel-option" }] }
      : [{ Name: "NoReportData", Value: "false", secret: "redaction-sentinel-option" }],
  };
}

/**
 * A TrialBalance response body, captured verbatim from Intuit.
 *
 * Taken from a live `GET /v3/company/{realmId}/reports/TrialBalance` against a
 * QuickBooks Online sandbox company. Every key, container form and value
 * spelling below is what the service returned: the account column carries an
 * **empty** `ColTitle` and identifies itself by `ColType`, `Columns` and `Rows`
 * each wrap their list in a single-key object, the money columns are titled
 * `Debit` and `Credit`, an account with no balance is `"0.00"` rather than an
 * empty string, a row's unused money column is an empty string, each row carries
 * Intuit's account identifier, sub-accounts appear as colon-joined paths, and
 * the report ends in a `GrandTotal` section row whose `Summary` wraps its cells
 * in `ColData`.
 *
 * The row set is the captured report's first three accounts plus three later
 * rows chosen so that both money columns and both sides of the ledger are
 * exercised: credit-balance rows and a non-asset debit row. Rows between them
 * are omitted, so the retained rows do not reconcile to the captured
 * `GrandTotal`, which is reproduced as returned rather than recomputed.
 *
 * `Header.StartPeriod` echoes the requested `start_date` rather than reporting a
 * window the service applied, and `Header.SummarizeColumnsBy` reads `Total` even
 * though this report keeps its two money columns.
 */
function trialBalanceFixture() {
  return {
    Header: {
      Time: "2026-09-11T12:30:00-07:00",
      ReportName: "TrialBalance",
      ReportBasis: "Accrual",
      StartPeriod: "2026-01-01",
      EndPeriod: "2026-05-31",
      SummarizeColumnsBy: "Total",
      Currency: "USD",
      Option: [{ Name: "NoReportData", Value: "false" }],
    },
    Columns: {
      Column: [
        { ColTitle: "", ColType: "Account" },
        { ColTitle: "Debit", ColType: "Money" },
        { ColTitle: "Credit", ColType: "Money" },
      ],
    },
    Rows: {
      Row: [
        { ColData: [{ value: "Checking", id: "35" }, { value: "4875.00" }, { value: "" }] },
        { ColData: [{ value: "Accounts Receivable (A/R)", id: "84" }, { value: "0.00" }, { value: "" }] },
        { ColData: [{ value: "Undeposited Funds", id: "4" }, { value: "226.75" }, { value: "" }] },
        {
          ColData: [
            { value: "Landscaping Services:Job Materials:Plants and Soil", id: "49" },
            { value: "" },
            { value: "131.25" },
          ],
        },
        { ColData: [{ value: "Pest Control Services", id: "54" }, { value: "" }, { value: "70.00" }] },
        { ColData: [{ value: "Legal & Professional Fees:Lawyer", id: "71" }, { value: "300.00" }, { value: "" }] },
        {
          Summary: { ColData: [{ value: "TOTAL" }, { value: "5401.75" }, { value: "5401.75" }] },
          type: "Section",
          group: "GrandTotal",
        },
      ],
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("QuickBooks Online read-only pilot", () => {
  it("returns only the approved redacted company projection", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        CompanyInfo: {
          Id: "1",
          CompanyName: "Example Co",
          LegalName: "SENTINEL LEGAL",
          EmployerId: "SENTINEL TAX",
          Country: "US",
          CompanyStartDate: "2020-02-29",
          FiscalYearStartMonth: "January",
          DefaultTimeZone: "America/Los_Angeles",
          Email: { Address: "secret@example.com" },
          CompanyAddr: { Line1: "SENTINEL ADDRESS" },
          MetaData: { CreateTime: "SENTINEL META" },
        },
      }),
    );
    vi.stubGlobal("fetch", fetch);

    const result = await executors["quickbooks_online.get_company_info"]!({}, context());

    expect(result).toMatchObject({
      ok: true,
      output: {
        company_name: "Example Co",
        country: "US",
        company_start_date: "2020-02-29",
        fiscal_year_start_month: "January",
        default_time_zone: "America/Los_Angeles",
        observed_at: expect.any(String),
      },
    });
    expect(Object.keys(result.output as object).sort()).toEqual([
      "company_name",
      "company_start_date",
      "country",
      "default_time_zone",
      "fiscal_year_start_month",
      "observed_at",
    ]);
    expect(JSON.stringify(result.output)).not.toMatch(/SENTINEL|secret@|EmployerId|CompanyAddr|MetaData/);
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      `https://sandbox-quickbooks.api.intuit.com/v3/company/${realmId}/companyinfo/${realmId}`,
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
  });

  it.each([false, true])("normalizes current and reports-v2-style P&L fixtures (v2=%s)", async (v2) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(reportFixture("ProfitAndLoss", { startDate: "2026-01-01", endDate: "2026-03-31", v2 })),
      ),
    );

    const result = await executors["quickbooks_online.get_profit_and_loss"]!(
      { start_date: "2026-01-01", end_date: "2026-03-31", accounting_method: "Accrual" },
      context(),
    );

    expect(result).toMatchObject({
      ok: true,
      output: {
        report_name: "ProfitAndLoss",
        accounting_method: "Accrual",
        start_date: "2026-01-01",
        end_date: "2026-03-31",
        currency: "USD",
        no_data: false,
        columns: [{ type: "Account" }, { title: "Total", type: "Money" }],
        rows: [
          {
            kind: "section",
            group: "Assets",
            children: [{ kind: "data", cells: ["Checking", "100.00"] }],
            summary: ["Total Assets", "100.00"],
          },
        ],
      },
    });
    expect(JSON.stringify(result.output)).not.toMatch(/redaction-sentinel|secret-id|href|qzurl|MetaData/);
  });

  it("maps Balance Sheet inputs to the fixed annual period and Total summary", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(reportFixture("BalanceSheet", { startDate: "2026-01-01", endDate: "2026-05-31", basis: "Cash" })),
    );
    vi.stubGlobal("fetch", fetch);

    const result = await executors["quickbooks_online.get_balance_sheet"]!(
      { as_of_date: "2026-05-31", accounting_method: "Cash" },
      context(),
    );

    expect(result).toMatchObject({ ok: true, output: { as_of_date: "2026-05-31", accounting_method: "Cash" } });
    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      start_date: "2026-01-01",
      end_date: "2026-05-31",
      accounting_method: "Cash",
      summarize_column_by: "Total",
    });
  });

  it("returns the Trial Balance report body as received", async () => {
    const fixture = trialBalanceFixture();
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(fixture));
    vi.stubGlobal("fetch", fetch);

    const result = await executors["quickbooks_online.get_trial_balance"]!(
      { as_of_date: "2026-05-31", accounting_method: "Accrual" },
      context(),
    );

    expect(result).toEqual({ ok: true, output: fixture });
    expect(result.output).not.toHaveProperty("rows");
    expect(result.output).not.toHaveProperty("columns");
  });

  it("preserves the untitled account column and both money columns", async () => {
    const fixture = trialBalanceFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(fixture)),
    );

    const result = await executors["quickbooks_online.get_trial_balance"]!(
      { as_of_date: "2026-05-31", accounting_method: "Accrual" },
      context(),
    );

    expect(
      (result.output as { Columns: { Column: Array<{ ColTitle: string; ColType: string }> } }).Columns.Column,
    ).toEqual([
      { ColTitle: "", ColType: "Account" },
      { ColTitle: "Debit", ColType: "Money" },
      { ColTitle: "Credit", ColType: "Money" },
    ]);
  });

  it("preserves credit-side amounts, not just the Credit column heading", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(trialBalanceFixture())),
    );

    const result = await executors["quickbooks_online.get_trial_balance"]!(
      { as_of_date: "2026-05-31", accounting_method: "Accrual" },
      context(),
    );

    const rows = (result.output as { Rows: { Row: Array<{ ColData?: Array<{ value: string }> }> } }).Rows.Row;
    const amounts = rows
      .filter((row) => row.ColData !== undefined)
      .map((row) => [row.ColData![0]!.value, row.ColData![1]!.value, row.ColData![2]!.value]);

    expect(amounts).toContainEqual(["Pest Control Services", "", "70.00"]);
    expect(amounts).toContainEqual(["Landscaping Services:Job Materials:Plants and Soil", "", "131.25"]);
    expect(amounts).toContainEqual(["Legal & Professional Fees:Lawyer", "300.00", ""]);
    expect(amounts.filter(([, debit]) => debit !== "").length).toBeGreaterThan(0);
    expect(amounts.filter(([, , credit]) => credit !== "").length).toBeGreaterThan(0);
  });

  it("preserves the GrandTotal row and its ColData-wrapped summary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(trialBalanceFixture())),
    );

    const result = await executors["quickbooks_online.get_trial_balance"]!(
      { as_of_date: "2026-05-31", accounting_method: "Accrual" },
      context(),
    );

    const rows = (result.output as { Rows: { Row: Array<Record<string, unknown>> } }).Rows.Row;
    expect(rows.at(-1)).toEqual({
      Summary: { ColData: [{ value: "TOTAL" }, { value: "5401.75" }, { value: "5401.75" }] },
      type: "Section",
      group: "GrandTotal",
    });
  });

  it("requests the connection's realm without collapsing the two money columns", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(trialBalanceFixture()));
    vi.stubGlobal("fetch", fetch);

    await executors["quickbooks_online.get_trial_balance"]!(
      { as_of_date: "2026-05-31", accounting_method: "Cash" },
      context(),
    );

    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(url.origin + url.pathname).toBe(
      `https://sandbox-quickbooks.api.intuit.com/v3/company/${realmId}/reports/TrialBalance`,
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      start_date: "2026-01-01",
      end_date: "2026-05-31",
      accounting_method: "Cash",
    });
    expect(url.searchParams.has("summarize_column_by")).toBe(false);
  });

  it("sends a range start that Intuit ignores, so the as-of date alone selects the data", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(trialBalanceFixture()));
    vi.stubGlobal("fetch", fetch);

    await executors["quickbooks_online.get_trial_balance"]!(
      { as_of_date: "2026-05-31", accounting_method: "Accrual" },
      context(),
    );

    // Intuit rejects a report request carrying no period, and then ignores the
    // start it was given: the same as-of date returns the same rows whatever the
    // range start, so the start exists to make the request valid and nothing
    // more. Sending the as-of year's January 1 keeps it obviously inert rather
    // than implying a window a reader might try to tune.
    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(url.searchParams.get("start_date")).toBe("2026-01-01");
    expect(url.searchParams.get("end_date")).toBe("2026-05-31");
  });

  it("rejects an oversized Trial Balance response rather than returning it", async () => {
    const oversized = { ...trialBalanceFixture(), ignored: "x".repeat(2 * 1024 * 1024) };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(oversized)),
    );

    const result = await executors["quickbooks_online.get_trial_balance"]!(
      { as_of_date: "2026-05-31", accounting_method: "Accrual" },
      context(),
    );

    expect(result).toMatchObject({ ok: false, error: { code: "provider_response_too_large" } });
  });

  it.each([
    { label: "an empty body", payload: {} },
    { label: "another report", payload: { Header: { ReportName: "BalanceSheet" } } },
  ])("fails a Trial Balance read that comes back as $label", async ({ payload }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(payload)),
    );

    const result = await executors["quickbooks_online.get_trial_balance"]!(
      { as_of_date: "2026-05-31", accounting_method: "Accrual" },
      context(),
    );

    expect(result).toMatchObject({ ok: false, error: { code: "provider_error", details: { status: 502 } } });
  });

  it("carries deeply nested rows and long cells through, bounded only by the response cap", async () => {
    const deepRow = (levels: number): Record<string, unknown> =>
      levels === 1
        ? { ColData: [{ value: "x".repeat(5_000) }, { value: "1.00" }, { value: "" }] }
        : { type: "Section", Rows: { Row: [deepRow(levels - 1)] } };
    const body = { ...trialBalanceFixture(), Rows: { Row: [deepRow(40)] } };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(body)),
    );

    const result = await executors["quickbooks_online.get_trial_balance"]!(
      { as_of_date: "2026-05-31", accounting_method: "Accrual" },
      context(),
    );

    expect(result).toEqual({ ok: true, output: body });
  });

  it("returns the account identifiers Intuit puts on report rows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(trialBalanceFixture())),
    );

    const result = await executors["quickbooks_online.get_trial_balance"]!(
      { as_of_date: "2026-05-31", accounting_method: "Accrual" },
      context(),
    );

    expect(JSON.stringify(result.output)).toContain('"id":"35"');
  });

  it("refuses a Trial Balance read without a QuickBooks connection", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const result = await executors["quickbooks_online.get_trial_balance"]!(
      { as_of_date: "2026-05-31", accounting_method: "Accrual" },
      { getCredential: async () => undefined },
    );

    expect(result).toMatchObject({ ok: false, error: { code: "authorization_failed" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the trusted production host only when the stored provider environment selects it", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ CompanyInfo: { Id: "1", CompanyName: "Example Co" } }),
    );
    vi.stubGlobal("fetch", fetch);

    await executors["quickbooks_online.get_company_info"]!(
      {},
      context(credential({ metadata: { oauthClientExtra: { environment: "production" } } })),
    );

    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      `https://quickbooks.api.intuit.com/v3/company/${realmId}/companyinfo/${realmId}`,
    );
  });

  it("refreshes once after a 401 and replays the read with the rotated access token", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({ CompanyInfo: { Id: "1", CompanyName: "Example Co" } }));
    const refreshOAuthCredential = vi.fn(async (_service: string, _rejectedAccessToken: string) =>
      credential({ accessToken: "access-rotated" }),
    );
    vi.stubGlobal("fetch", fetch);

    const result = await executors["quickbooks_online.get_company_info"]!(
      {},
      {
        ...context(),
        refreshOAuthCredential,
      },
    );

    expect(result.ok).toBe(true);
    expect(refreshOAuthCredential).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get("authorization")).toBe("Bearer access-rotated");
  });

  it("preserves a stable OAuth quarantine result when a 401 refresh cannot be proven", async () => {
    const fetch = vi.fn(async () => jsonResponse({}, 401));
    const refreshError = Object.assign(new Error("redaction-sentinel-refresh-detail"), {
      code: "oauth_refresh_quarantined",
    });
    vi.stubGlobal("fetch", fetch);

    const result = await executors["quickbooks_online.get_company_info"]!(
      {},
      {
        ...context(),
        refreshOAuthCredential: async () => {
          throw refreshError;
        },
      },
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: "oauth_refresh_quarantined",
        message: "OAuth credential refresh could not be proven; reconnect before retrying.",
      },
    });
    expect(JSON.stringify(result)).not.toContain("redaction-sentinel-refresh-detail");
  });

  it.each([500, 502, 503])("retries a transient HTTP %s response exactly once", async (status) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, status))
      .mockResolvedValueOnce(jsonResponse({ CompanyInfo: { Id: "1", CompanyName: "Example Co" } }));
    vi.stubGlobal("fetch", fetch);

    const result = await executors["quickbooks_online.get_company_info"]!({}, context());

    expect(result.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not immediately replay a 429 response", async () => {
    const fetch = vi.fn(async () => jsonResponse({ error: "redaction-sentinel-rate-limit" }, 429));
    vi.stubGlobal("fetch", fetch);

    const result = await executors["quickbooks_online.get_company_info"]!({}, context());

    expect(result).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("60 seconds") },
    });
    expect(JSON.stringify(result)).not.toContain("redaction-sentinel-rate-limit");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("fails a provider call after the fixed timeout and forwards an abort signal", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
            once: true,
          });
        }),
    );
    vi.stubGlobal("fetch", fetch);

    const pending = executors["quickbooks_online.get_company_info"]!({}, context());
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: "provider_error" } });
    expect(fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects invalid or six-calendar-month P&L periods before provider egress", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const invalidDate = await executors["quickbooks_online.get_profit_and_loss"]!(
      { start_date: "2026-02-30", end_date: "2026-03-01", accounting_method: "Cash" },
      context(),
    );
    const tooLong = await executors["quickbooks_online.get_profit_and_loss"]!(
      { start_date: "2026-01-31", end_date: "2026-07-31", accounting_method: "Cash" },
      context(),
    );

    expect(invalidDate).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(tooLong).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed on HTTP errors, 200 Fault envelopes, or mismatched report metadata", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ secret: "raw-provider-error" }, 500))
      .mockResolvedValueOnce(jsonResponse({ Fault: { Error: [{ Message: "raw-fault-secret" }] } }))
      .mockResolvedValueOnce(
        jsonResponse(reportFixture("ProfitAndLoss", { startDate: "2025-01-01", endDate: "2025-03-31" })),
      );
    vi.stubGlobal("fetch", fetch);
    const input = { start_date: "2026-01-01", end_date: "2026-03-31", accounting_method: "Accrual" };

    const outcomes = await Promise.all([
      executors["quickbooks_online.get_profit_and_loss"]!(input, context()),
      executors["quickbooks_online.get_profit_and_loss"]!(input, context()),
      executors["quickbooks_online.get_profit_and_loss"]!(input, context()),
    ]);

    expect(outcomes.every((outcome) => !outcome.ok)).toBe(true);
    expect(JSON.stringify(outcomes)).not.toMatch(/raw-provider-error|raw-fault-secret/);
  });

  it("rejects missing or malformed NoReportData and malformed report containers", async () => {
    const missingOption = reportFixture("ProfitAndLoss");
    delete (missingOption as { Options?: unknown }).Options;
    const malformedRows = reportFixture("ProfitAndLoss");
    (malformedRows as { Rows: unknown }).Rows = { Row: "not-an-array" };
    const malformedNoData = reportFixture("ProfitAndLoss");
    (malformedNoData as { Options: unknown }).Options = [{ Name: "NoReportData", Value: "maybe" }];
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(missingOption))
      .mockResolvedValueOnce(jsonResponse(malformedRows))
      .mockResolvedValueOnce(jsonResponse(malformedNoData));
    vi.stubGlobal("fetch", fetch);
    const input = { start_date: "2026-01-01", end_date: "2026-03-31", accounting_method: "Accrual" };

    for (let index = 0; index < 3; index += 1) {
      await expect(executors["quickbooks_online.get_profit_and_loss"]!(input, context())).resolves.toMatchObject({
        ok: false,
        error: { code: "provider_error" },
      });
    }
  });

  it("classifies malformed provider Header dates as a 502 provider failure", async () => {
    const fixture = reportFixture("ProfitAndLoss");
    fixture.Header.StartPeriod = "2026-02-30";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(fixture)),
    );

    const result = await executors["quickbooks_online.get_profit_and_loss"]!(
      { start_date: "2026-01-01", end_date: "2026-03-31", accounting_method: "Accrual" },
      context(),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "provider_error", details: { status: 502 } },
    });
  });

  it.each([
    { label: "unknown type", row: { type: "Other", ColData: [{ value: "x" }] } },
    { label: "missing type", row: { ColData: [{ value: "x" }] } },
    { label: "Data with children", row: { type: "Data", Rows: { Row: [] }, ColData: [{ value: "x" }] } },
    { label: "Section without children", row: { type: "Section", Header: { ColData: [{ value: "x" }] } } },
  ])("rejects a report row with $label", async ({ row }) => {
    const fixture = reportFixture("ProfitAndLoss");
    (fixture as { Rows: unknown }).Rows = { Row: [row] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(fixture)),
    );

    const result = await executors["quickbooks_online.get_profit_and_loss"]!(
      { start_date: "2026-01-01", end_date: "2026-03-31", accounting_method: "Accrual" },
      context(),
    );

    expect(result).toMatchObject({ ok: false, error: { code: "provider_error", details: { status: 502 } } });
  });

  it("accepts exactly 16 report-row levels and rejects level 17", async () => {
    const fixture16 = reportFixture("ProfitAndLoss");
    (fixture16 as { Rows: unknown }).Rows = { Row: [nestedReportRow(16)] };
    const fixture17 = reportFixture("ProfitAndLoss");
    (fixture17 as { Rows: unknown }).Rows = { Row: [nestedReportRow(17)] };
    const fetch = vi.fn().mockResolvedValueOnce(jsonResponse(fixture16)).mockResolvedValueOnce(jsonResponse(fixture17));
    vi.stubGlobal("fetch", fetch);
    const input = { start_date: "2026-01-01", end_date: "2026-03-31", accounting_method: "Accrual" };

    await expect(executors["quickbooks_online.get_profit_and_loss"]!(input, context())).resolves.toMatchObject({
      ok: true,
    });
    await expect(executors["quickbooks_online.get_profit_and_loss"]!(input, context())).resolves.toMatchObject({
      ok: false,
      error: { code: "provider_response_too_large" },
    });
  });

  it("rejects rather than truncating overlong provider strings", async () => {
    const fixture = reportFixture("ProfitAndLoss");
    const rows = (fixture.Rows as { Row: Array<{ Rows: { Row: Array<{ ColData: Array<{ value: string }> }> } }> }).Row;
    rows[0]!.Rows.Row[0]!.ColData[0]!.value = "x".repeat(2_049);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(fixture)),
    );

    const result = await executors["quickbooks_online.get_profit_and_loss"]!(
      { start_date: "2026-01-01", end_date: "2026-03-31", accounting_method: "Accrual" },
      context(),
    );

    expect(result).toMatchObject({ ok: false, error: { code: "provider_response_too_large" } });
  });

  it("rejects reports above the 10,000-cell or 2 MiB response boundaries", async () => {
    const tooManyCells = reportFixture("ProfitAndLoss");
    const rows = (tooManyCells.Rows as { Row: Array<{ Rows: { Row: Array<{ ColData: Array<{ value: string }> }> } }> })
      .Row;
    rows[0]!.Rows.Row[0]!.ColData = Array.from({ length: 10_001 }, () => ({ value: "" }));
    const oversizedResponse = {
      CompanyInfo: { Id: "1", CompanyName: "Example Co", ignored: "x".repeat(2 * 1024 * 1024) },
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(tooManyCells))
      .mockResolvedValueOnce(jsonResponse(oversizedResponse));
    vi.stubGlobal("fetch", fetch);

    await expect(
      executors["quickbooks_online.get_profit_and_loss"]!(
        { start_date: "2026-01-01", end_date: "2026-03-31", accounting_method: "Accrual" },
        context(),
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: "provider_response_too_large" } });
    await expect(executors["quickbooks_online.get_company_info"]!({}, context())).resolves.toMatchObject({
      ok: false,
      error: { code: "provider_response_too_large" },
    });
  });

  it("verifies the callback-bound realm URL without treating CompanyInfo.Id as the realm", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ CompanyInfo: { Id: "1", CompanyName: "Verified Co" } }),
    );

    const result = await credentialValidators.oauth2!(credential(), { fetcher: fetch as typeof globalThis.fetch });

    expect(result).toEqual({
      profile: { displayName: "Verified Co" },
      grantedScopes: ["com.intuit.quickbooks.accounting"],
    });
    expect(JSON.stringify(result)).not.toContain(realmId);
    expect(String(fetch.mock.calls[0]?.[0])).toContain(`/company/${realmId}/companyinfo/${realmId}`);
  });

  it("publishes required report inputs in the action catalog", () => {
    expect(
      quickBooksOnlineActions.find((action) => action.id.endsWith("get_profit_and_loss"))?.inputSchema,
    ).toMatchObject({
      required: ["start_date", "end_date", "accounting_method"],
    });
    expect(
      quickBooksOnlineActions.find((action) => action.id.endsWith("get_balance_sheet"))?.inputSchema,
    ).toMatchObject({
      required: ["as_of_date", "accounting_method"],
    });
    for (const action of quickBooksOnlineActions.filter(
      (item) => item.id.includes("get_profit_and_loss") || item.id.includes("get_balance_sheet"),
    )) {
      expect(action.outputSchema).toMatchObject({
        required: expect.arrayContaining(["report_name", "accounting_method", "start_date", "end_date"]),
      });
    }
  });

  it("publishes the Trial Balance action with the shared accounting scope and a passthrough output", () => {
    const action = quickBooksOnlineActions.find((item) => item.name === "get_trial_balance");

    expect(action?.id).toBe("quickbooks_online.get_trial_balance");
    expect(action?.inputSchema).toMatchObject({
      properties: {
        as_of_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        accounting_method: { enum: ["Cash", "Accrual"] },
      },
      required: ["as_of_date", "accounting_method"],
    });
    expect(action?.requiredScopes).toEqual(["com.intuit.quickbooks.accounting"]);
    expect(action?.providerPermissions).toEqual(["com.intuit.quickbooks.accounting"]);
    expect(action?.outputSchema).toMatchObject({ type: "object", additionalProperties: true });
    expect(action?.outputSchema).not.toHaveProperty("properties");
    expect(action?.description).toMatch(/provider's own report shape/);
    expect(action?.description).toMatch(/financial year containing as_of_date/);
    expect(action?.description).toMatch(/2 MiB response cap/);
  });
});

function nestedReportRow(levels: number): Record<string, unknown> {
  if (levels === 1) return { type: "Data", ColData: [{ value: "leaf" }, { value: "1.00" }] };
  return { type: "Section", Rows: { Row: [nestedReportRow(levels - 1)] } };
}
