import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";

import { defineApiKeyProviderExecutors } from "../provider-runtime.ts";
import { validateWanxCredential, wanxActionHandlers } from "./runtime.ts";

const service = "wanx";

export const executors: ProviderExecutors = defineApiKeyProviderExecutors(service, wanxActionHandlers, {
  skipDnsValidation: true,
});

export const credentialValidators: CredentialValidators = {
  apiKey(input, { fetcher, signal }) {
    return validateWanxCredential(input.apiKey, fetcher, signal);
  },
};
