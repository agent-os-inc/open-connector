import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";

import { defineApiKeyProviderExecutors } from "../provider-runtime.ts";
import { klingActionHandlers, validateKlingCredential } from "./runtime.ts";

const service = "kling";

export const executors: ProviderExecutors = defineApiKeyProviderExecutors(service, klingActionHandlers, {
  skipDnsValidation: true,
});

export const credentialValidators: CredentialValidators = {
  apiKey(input, { fetcher, signal }) {
    return validateKlingCredential(input.apiKey, fetcher, signal);
  },
};
