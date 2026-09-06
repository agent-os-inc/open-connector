import type { CredentialValidators, ExecutionContext, ProviderExecutors } from "../../core/types.ts";

import { defineProviderExecutors, ProviderRequestError } from "../provider-runtime.ts";
import { clinicalKeyActionHandlers, createClinicalKeyActionContext, validateClinicalKeyCredential } from "./runtime.ts";
const service = "clinicalkey";
export const executors: ProviderExecutors = defineProviderExecutors({
  service,
  handlers: clinicalKeyActionHandlers,
  async createContext(context: ExecutionContext, fetcher: typeof fetch) {
    const credential = await context.getCredential(service);
    if (!credential || credential.authType != "api_key")
      throw new ProviderRequestError(401, "Configure ClinicalKey credentials.");
    return createClinicalKeyActionContext({ apiKey: credential.apiKey, ...credential.values }, fetcher);
  },
  skipDnsValidation: true,
});
export const credentialValidators: CredentialValidators = {
  apiKey(input, { fetcher }) {
    return validateClinicalKeyCredential({ apiKey: input.apiKey, ...input.values }, fetcher);
  },
};
