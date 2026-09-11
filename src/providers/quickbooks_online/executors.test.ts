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
 * A TrialBalance response body.
 *
 * `v2` selects Intuit's modernized report service, which serves every report
 * response: empty strings rather than zeroes for absent values, `Section` as
 * the row type of an enclosing section whether or not it is empty, Title Case
 * column titles, `StartPeriod` and `EndPeriod` always present, and no `qzurl`.
 * The container shape and key casing follow the convention the sibling report
 * fixture already uses for its v2 variant. Neither variant is a captured live
 * body, so the v1 variant's untitled account column is what the pre-modern
 * service documented rather than a claim about what arrives today.
 */
function trialBalanceFixture(options: { v2?: boolean } = {}) {
  const accountColumn = options.v2 ? { coltype: "Account", coltitle: "Account" } : { ColType: "Account", ColTitle: "" };
  const rows = [
    { ColData: [{ id: "35", value: "Checking" }, { value: "4151.74" }, { value: "" }] },
    { ColData: [{ id: "13", value: "Meals and Entertainment" }, { value: "" }, { value: "46.00" }] },
  ];
  const grandTotal = {
    group: "GrandTotal",
    type: "Section",
    Summary: { ColData: [{ value: "TOTAL" }, { value: "4197.74" }, { value: "4197.74" }] },
  };
  return {
    Header: {
      ReportName: "TrialBalance",
      Option: [{ Name: "NoReportData", Value: "false" }],
      ReportBasis: "Accrual",
      StartPeriod: "2026-01-01",
      EndPeriod: "2026-05-31",
      Currency: "USD",
      Time: "2026-06-01T10:11:07-07:00",
    },
    Columns: options.v2
      ? [accountColumn, { coltype: "Money", coltitle: "Debit" }, { coltype: "Money", coltitle: "Credit" }]
      : {
          Column: [accountColumn, { ColType: "Money", ColTitle: "Debit" }, { ColType: "Money", ColTitle: "Credit" }],
        },
    Rows: options.v2
      ? [...rows.map((row) => ({ Type: "Data", ...row })), { ...grandTotal, Type: "Section" }]
      : { Row: [...rows, grandTotal] },
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

  it.each([false, true])(
    "returns the Trial Balance report body as received, with Debit and Credit columns intact (v2=%s)",
    async (v2) => {
      const fixture = trialBalanceFixture({ v2 });
      const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(fixture));
      vi.stubGlobal("fetch", fetch);

      const result = await executors["quickbooks_online.get_trial_balance"]!(
        { as_of_date: "2026-05-31", accounting_method: "Accrual" },
        context(),
      );

      expect(result).toEqual({ ok: true, output: fixture });
      expect(result.output).not.toHaveProperty("rows");
      expect(result.output).not.toHaveProperty("columns");
    },
  );

  it("preserves each money column of an untitled-account v1 body", async () => {
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
      { ColType: "Account", ColTitle: "" },
      { ColType: "Money", ColTitle: "Debit" },
      { ColType: "Money", ColTitle: "Credit" },
    ]);
  });

  it("preserves each money column of a modernized-service body", async () => {
    const fixture = trialBalanceFixture({ v2: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(fixture)),
    );

    const result = await executors["quickbooks_online.get_trial_balance"]!(
      { as_of_date: "2026-05-31", accounting_method: "Accrual" },
      context(),
    );

    expect(result.output).toHaveProperty("Columns", [
      { coltype: "Account", coltitle: "Account" },
      { coltype: "Money", coltitle: "Debit" },
      { coltype: "Money", coltitle: "Credit" },
    ]);
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
    expect(action?.description).toMatch(/read Header\.StartPeriod for the window Intuit actually applied/);
    expect(action?.description).toMatch(/2 MiB response cap/);
  });
});

function nestedReportRow(levels: number): Record<string, unknown> {
  if (levels === 1) return { type: "Data", ColData: [{ value: "leaf" }, { value: "1.00" }] };
  return { type: "Section", Rows: { Row: [nestedReportRow(levels - 1)] } };
}
