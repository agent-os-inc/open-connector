import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";

import { defineApiKeyProviderExecutors } from "../provider-runtime.ts";
import { qwenActionHandlers, validateQwenCredential } from "./runtime.ts";

const service = "qwen";

export const executors: ProviderExecutors = defineApiKeyProviderExecutors(service, qwenActionHandlers, {
  skipDnsValidation: true,
});

export const credentialValidators: CredentialValidators = {
  apiKey(input, { fetcher, signal }) {
    return validateQwenCredential(input.apiKey, fetcher, signal);
  },
};
