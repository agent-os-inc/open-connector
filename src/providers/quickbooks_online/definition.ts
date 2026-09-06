import type { ProviderDefinition } from "../../core/types.ts";

import { quickBooksOnlineActions } from "./actions.ts";
import { quickBooksOnlineAccountingScope } from "./scopes.ts";

export const provider: ProviderDefinition = {
  service: "quickbooks_online",
  displayName: "QuickBooks Online",
  description: "Read company information and core financial reports from a connected QuickBooks Online company.",
  categories: ["Finance", "Data"],
  authTypes: ["oauth2"],
  auth: [
    {
      type: "oauth2",
      authorizationUrl: "https://appcenter.intuit.com/connect/oauth2",
      tokenUrl: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
      refreshTokenUrl: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
      revocationUrl: "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
      revocationMode: "required",
      scopes: [quickBooksOnlineAccountingScope],
      tokenEndpointAuthMethod: "client_secret_basic",
      credentialVerification: "required",
      connectionWriteMode: "create_only",
      redactTokenErrors: true,
      clientConfigFields: [
        {
          key: "environment",
          label: "QuickBooks environment",
          inputType: "text",
          required: true,
          secret: false,
          location: "extra",
          defaultValue: "sandbox",
          description: "Trusted deployment selector: sandbox or production.",
        },
      ],
      callbackCredentialFields: [
        {
          parameter: "realmId",
          key: "realmId",
          required: true,
          maxLength: 255,
          pattern: "^[0-9]+$",
        },
      ],
    },
  ],
  homepageUrl: "https://quickbooks.intuit.com/online/",
  actions: quickBooksOnlineActions,
};
