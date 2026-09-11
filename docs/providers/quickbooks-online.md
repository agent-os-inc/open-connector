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

The response bounds the normalized reads enforce still apply: the shared read
path rejects a body over the 2 MiB cap with the same
`provider_response_too_large` error, and the same request timeout and OAuth
refresh handling cover this action, so an oversized report is never returned.

The read spans January 1 through the requested as-of date, matching Balance
Sheet, because Intuit's report service requires an explicit period or a date
macro.

References:

- [Intuit OAuth 2.0](https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0)
- [Intuit OAuth security requirements](https://developer.intuit.com/app/developer/qbo/docs/go-live/publish-app/security-requirements)
- [QuickBooks Online reports](https://developer.intuit.com/app/developer/qbo/docs/workflows/run-reports)
- [Intuit TrialBalance report](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/report-entities/trialbalance)
