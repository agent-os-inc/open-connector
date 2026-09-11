# QuickBooks Online

The `quickbooks_online` provider offers a deliberately small read-only pilot:

- `quickbooks_online.get_company_info`
- `quickbooks_online.get_profit_and_loss`
- `quickbooks_online.get_balance_sheet`
- `quickbooks_online.get_trial_balance`

It uses Intuit OAuth 2.0 with the `com.intuit.quickbooks.accounting` scope. That
scope is broader than these operations, so OpenConnector's exact four-action
allowlist is the read-only enforcement boundary. There is no raw QuickBooks
proxy and no write action in this provider.

Configure an Intuit OAuth application with this runtime's displayed callback
URL. The OAuth callback must include one numeric `realmId`; OpenConnector binds
that company identifier to the one-time authorization state, stores it only in
the encrypted credential, and verifies it against the matching CompanyInfo
endpoint before the connection becomes usable.

## Normalized reads

Company info, Profit and Loss and Balance Sheet responses are normalized and
bounded. Company identifiers, contact, address, tax, email, web, admin, token,
and raw metadata fields are not returned. Report projections preserve money as
strings and reject rather than truncate if they exceed 16 row levels, 10,000
cells, or 2 MiB. Profit and Loss periods must be shorter than six calendar
months. Balance Sheet reads use January 1 through the requested as-of date. Both
reports are fixed to a `Total` column summary.

Those guarantees are properties of the projection, so they stop at the
normalized reads. The Trial Balance read below is passthrough and therefore
carries none of them except the byte cap.

## The Trial Balance read is passthrough

`get_trial_balance` returns Intuit's report body as received, and its action
description says so. It is the one QuickBooks action that emits the provider's
own report shape rather than the normalized column-and-row tree, for two
reasons:

- A trial balance carries its amounts in native `Debit` and `Credit` columns,
  and is summed with an accounting sign convention read from those two columns.
  The read therefore omits `summarize_column_by`, which would collapse them into
  a single money column, and the normalized shape has nowhere to carry two money
  columns per row.
- Its consumer already parses Intuit's raw report shape, including the rule that
  only leaf rows are trial-balance lines and the checks that a report's own basis
  and period labels agree with what was requested. Projecting here would mean a
  second parser against a second shape for no behavioural gain.

Intuit's report shape for this read has an untitled first column of type
`Account`, `Debit` and `Credit` money columns, one leaf row per account, and a
trailing `GrandTotal` section row.

### What bounds and redactions apply

The 2 MiB response byte cap is the only bound that survives, and it rejects an
oversized body with `provider_response_too_large` before anything is returned.
Row depth, cell count and cell length are unbounded within that cap, because
those limits live in the projection this read skips. A caller that walks the
rows owns its own traversal bounds.

Redaction likewise does not apply. Intuit puts an account identifier on each
report row (`ColData[].id`), and this read returns it, as it returns every other
field Intuit sends.

One assertion survives: the response must carry a `Header.ReportName` of
`TrialBalance`. Without it an empty or non-report 200 body would reach a caller
as a successful, empty trial balance instead of failing as a provider error.
Asserting the report identity does not reshape the response.

The same request timeout, single transient retry, and OAuth refresh-and-replay
handling cover this action, because it shares the read path with the normalized
reads.

### Period window

The read requests January 1 of the as-of year through the requested as-of date,
matching Balance Sheet, because Intuit's report service requires an explicit
period or a date macro rather than a bare as-of date.

Account balances are as-of values, but a trial balance also lists period-scoped
income and expense accounts, so the window is load-bearing for those rows in a
way it is not for a balance sheet. For a company whose financial year does not
start in January, whether those rows follow the requested `start_date` or the
company's own financial-year start is Intuit's behaviour to determine, and
`get_company_info` exposes `fiscal_year_start_month` so a caller can see when
the two differ. Confirming which one Intuit applies needs one request against a
company with a non-January year start, comparing an expense account's amount and
the returned `Header.StartPeriod` across two `start_date` values.

References:

- [Intuit OAuth 2.0](https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0)
- [Intuit OAuth security requirements](https://developer.intuit.com/app/developer/qbo/docs/go-live/publish-app/security-requirements)
- [QuickBooks Online reports](https://developer.intuit.com/app/developer/qbo/docs/workflows/run-reports)
- [Intuit TrialBalance report](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/report-entities/trialbalance)
