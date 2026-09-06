import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";

import { defineApiKeyProviderExecutors } from "../provider-runtime.ts";
import { imagetranslateAiActionHandlers, validateCredential } from "./runtime.ts";

const service = "imagetranslate_ai";

export const executors: ProviderExecutors = defineApiKeyProviderExecutors(service, imagetranslateAiActionHandlers, {
  skipDnsValidation: true,
});

export const credentialValidators: CredentialValidators = {
  async apiKey(input) {
    return validateCredential(input.apiKey);
  },
};
