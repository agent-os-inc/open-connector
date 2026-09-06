import type { CredentialValidators, ExecutionContext, ProviderExecutors } from "../../core/types.ts";

import { defineProviderExecutors, ProviderRequestError } from "../provider-runtime.ts";
import { createEmbaseActionContext, embaseActionHandlers, validateEmbaseCredential } from "./runtime.ts";
const service = "embase";
export const executors: ProviderExecutors = defineProviderExecutors({
  service,
  handlers: embaseActionHandlers,
  async createContext(context: ExecutionContext, fetcher: typeof fetch) {
    const credential = await context.getCredential(service);
    if (!credential || credential.authType != "api_key")
      throw new ProviderRequestError(401, "Configure Embase credentials.");
    return createEmbaseActionContext({ apiKey: credential.apiKey, ...credential.values }, fetcher);
  },
  skipDnsValidation: true,
});
export const credentialValidators: CredentialValidators = {
  apiKey(input, { fetcher }) {
    return validateEmbaseCredential({ apiKey: input.apiKey, ...input.values }, fetcher);
  },
};
