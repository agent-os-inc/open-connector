# QuickBooks Online

The `quickbooks_online` provider offers a deliberately small read-only pilot:

- `quickbooks_online.get_company_info`
- `quickbooks_online.get_profit_and_loss`
- `quickbooks_online.get_balance_sheet`

It uses Intuit OAuth 2.0 with the `com.intuit.quickbooks.accounting` scope. That
scope is broader than these operations, so OpenConnector's exact three-action
allowlist is the read-only enforcement boundary. There is no raw QuickBooks
proxy and no write action in this provider.

Configure an Intuit OAuth application with this runtime's displayed callback
URL. The OAuth callback must include one numeric `realmId`; OpenConnector binds
that company identifier to the one-time authorization state, stores it only in
the encrypted credential, and verifies it against the matching CompanyInfo
endpoint before the connection becomes usable.

Responses are normalized and bounded. Company identifiers, contact, address,
tax, email, web, admin, token, and raw metadata fields are not returned. Report
projections preserve money as strings and reject rather than truncate if they
exceed 16 row levels, 10,000 cells, or 2 MiB. Profit and Loss periods must be
shorter than six calendar months. Balance Sheet reads use January 1 through the
requested as-of date. Both reports are fixed to a `Total` column summary.

References:

- [Intuit OAuth 2.0](https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0)
- [Intuit OAuth security requirements](https://developer.intuit.com/app/developer/qbo/docs/go-live/publish-app/security-requirements)
- [QuickBooks Online reports](https://developer.intuit.com/app/developer/qbo/docs/workflows/run-reports)
