import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";

import { defineApiKeyProviderExecutors } from "../provider-runtime.ts";
import { validateDoubaoSeedreamCredential, doubaoSeedreamActionHandlers } from "./runtime.ts";

const service = "doubao_seedream";

export const executors: ProviderExecutors = defineApiKeyProviderExecutors(service, doubaoSeedreamActionHandlers, {
  skipDnsValidation: true,
});

export const credentialValidators: CredentialValidators = {
  apiKey(input, { fetcher, signal }) {
    return validateDoubaoSeedreamCredential(input.apiKey, fetcher, signal);
  },
};
