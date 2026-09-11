import type { ProviderActionDefinition } from "../../core/provider-definition.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";
import { quickBooksOnlineAccountingScope } from "./scopes.ts";

const service = "quickbooks_online";
const permissions = [quickBooksOnlineAccountingScope] as const;

const date = s.string({
  format: "date",
  pattern: "^\\d{4}-\\d{2}-\\d{2}$",
  description: "A calendar date in YYYY-MM-DD format.",
});
const accountingMethod = s.stringEnum(["Cash", "Accrual"], {
  description: "The report accounting method.",
});

const companyInfoOutput = s.object(
  "A redacted QuickBooks company summary.",
  {
    company_name: s.nonEmptyString("The company display name."),
    country: s.string("The company country code when available."),
    company_start_date: date,
    fiscal_year_start_month: s.string("The fiscal year start month when available."),
    default_time_zone: s.string("The default company time zone when available."),
    observed_at: s.dateTime("The time this projection was observed."),
  },
  { optional: ["country", "company_start_date", "fiscal_year_start_month", "default_time_zone"] },
);

const reportColumn = s.object("One normalized QuickBooks report column.", {
  title: s.string("The provider column title."),
  type: s.string("The provider column type."),
});

const reportRow = s.object(
  "One normalized QuickBooks report row.",
  {
    kind: s.stringEnum(["section", "data"], { description: "The normalized row kind." }),
    group: s.string("The QuickBooks grouping identifier when available."),
    header: s.array(s.string("A report section header cell."), { description: "The section header cells." }),
    cells: s.array(s.string("A report data cell."), { description: "The data row cells." }),
    children: { type: "array", items: { $ref: "#/$defs/reportRow" } },
    summary: s.array(s.string("A report summary cell."), { description: "The section summary cells." }),
  },
  { optional: ["group", "header", "cells", "children", "summary"] },
);

const reportOutput = s.object(
  "A bounded, normalized QuickBooks financial report.",
  {
    report_name: s.stringEnum(["ProfitAndLoss", "BalanceSheet"], { description: "The exact report name." }),
    accounting_method: accountingMethod,
    start_date: date,
    end_date: date,
    as_of_date: date,
    currency: s.string("The report currency code when supplied by QuickBooks."),
    observed_at: s.dateTime("The time this projection was observed."),
    no_data: s.boolean("Whether QuickBooks explicitly reported no report data."),
    columns: s.array(reportColumn, { description: "The normalized report columns." }),
    rows: { type: "array", items: { $ref: "#/$defs/reportRow" } },
  },
  { optional: ["as_of_date", "currency"], defs: { reportRow } },
);

const trialBalanceOutput = s.unknownObject(
  "Intuit's TrialBalance report response as received, including its Debit and Credit columns.",
);

export const quickBooksOnlineActions: readonly ProviderActionDefinition[] = [
  defineProviderAction(service, {
    name: "get_company_info",
    description: "Get a redacted summary of the connected QuickBooks Online company.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false, maxProperties: 0 },
    outputSchema: companyInfoOutput,
    requiredScopes: permissions,
    providerPermissions: permissions,
  }),
  defineProviderAction(service, {
    name: "get_profit_and_loss",
    description: "Get a bounded, normalized QuickBooks Online Profit and Loss report.",
    inputSchema: s.object(
      "Required Profit and Loss report parameters.",
      { start_date: date, end_date: date, accounting_method: accountingMethod },
      { required: ["start_date", "end_date", "accounting_method"] },
    ),
    outputSchema: reportOutput,
    requiredScopes: permissions,
    providerPermissions: permissions,
  }),
  defineProviderAction(service, {
    name: "get_balance_sheet",
    description: "Get a bounded, normalized QuickBooks Online Balance Sheet report.",
    inputSchema: s.object(
      "Required Balance Sheet report parameters.",
      { as_of_date: date, accounting_method: accountingMethod },
      { required: ["as_of_date", "accounting_method"] },
    ),
    outputSchema: reportOutput,
    requiredScopes: permissions,
    providerPermissions: permissions,
  }),
  defineProviderAction(service, {
    name: "get_trial_balance",
    description:
      "Get a QuickBooks Online Trial Balance report in the provider's own report shape. " +
      "The response is Intuit's report body as received, with its Debit and Credit columns and " +
      "nested row structure intact, because the consumer of a trial balance parses that shape " +
      "directly. Unlike the Profit and Loss and Balance Sheet actions, this action performs no " +
      "normalization, and normalizing it would break that consumer. The request covers January 1 " +
      "of the as-of year through as_of_date. A trial balance's income and expense rows are " +
      "period-scoped, so read Header.StartPeriod for the window Intuit actually applied; it may " +
      "differ for a company whose financial year starts in another month. Only the 2 MiB response " +
      "cap bounds the body: row depth, cell count and cell length are unbounded within it, and " +
      "account identifiers Intuit puts on report rows are returned rather than redacted.",
    inputSchema: s.object(
      "Required Trial Balance report parameters.",
      { as_of_date: date, accounting_method: accountingMethod },
      { required: ["as_of_date", "accounting_method"] },
    ),
    outputSchema: trialBalanceOutput,
    requiredScopes: permissions,
    providerPermissions: permissions,
  }),
];
