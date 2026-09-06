import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";

import { defineApiKeyProviderExecutors } from "../provider-runtime.ts";
import { validateSeedanceCredential, seedanceActionHandlers } from "./runtime.ts";

const service = "seedance";

export const executors: ProviderExecutors = defineApiKeyProviderExecutors(service, seedanceActionHandlers, {
  skipDnsValidation: true,
});

export const credentialValidators: CredentialValidators = {
  apiKey(input, { fetcher, signal }) {
    return validateSeedanceCredential(input.apiKey, fetcher, signal);
  },
};
