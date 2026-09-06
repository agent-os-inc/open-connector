import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";

import { defineApiKeyProviderExecutors } from "../provider-runtime.ts";
import { doubaoSpeechActionHandlers, validateDoubaoSpeechCredential } from "./runtime.ts";

const service = "doubao_speech";

export const executors: ProviderExecutors = defineApiKeyProviderExecutors(service, doubaoSpeechActionHandlers, {
  skipDnsValidation: true,
});

export const credentialValidators: CredentialValidators = {
  apiKey(input, { fetcher, signal }) {
    return validateDoubaoSpeechCredential(input.apiKey, fetcher, signal);
  },
};
