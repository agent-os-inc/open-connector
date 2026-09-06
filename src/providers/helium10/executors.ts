import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";

import { defineOAuthProviderExecutors } from "../provider-runtime.ts";
import { helium10ActionHandlers, validateHelium10Credential } from "./runtime.ts";

export const executors: ProviderExecutors = defineOAuthProviderExecutors("helium10", helium10ActionHandlers, {
  skipDnsValidation: true,
});

export const credentialValidators: CredentialValidators = {
  oauth2(input, { fetcher, signal }) {
    return validateHelium10Credential(input.accessToken, fetcher, signal);
  },
};
