import type { CredentialValidators, ExecutionContext, ProviderExecutors } from "../../core/types.ts";

import { defineProviderExecutors, ProviderRequestError } from "../provider-runtime.ts";
import { executeOpenfdaAction, validateOpenfdaCredential } from "./runtime.ts";

const service = "openfda";

interface OpenfdaContext {
  apiKey?: string;
  fetcher: typeof fetch;
}

const handlers = {
  search_drug_records(input: Record<string, unknown>, context: OpenfdaContext): Promise<unknown> {
    return executeOpenfdaAction("search_drug_records", input, context.fetcher, context.apiKey);
  },
  count_drug_values(input: Record<string, unknown>, context: OpenfdaContext): Promise<unknown> {
    return executeOpenfdaAction("count_drug_values", input, context.fetcher, context.apiKey);
  },
};

export const executors: ProviderExecutors = defineProviderExecutors<OpenfdaContext>({
  service,
  handlers,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<OpenfdaContext> {
    const credential = await context.getCredential(service);
    if (!credential || credential.authType === "no_auth") {
      return { fetcher };
    }
    if (credential.authType === "api_key") {
      return { apiKey: credential.apiKey, fetcher };
    }
    throw new ProviderRequestError(401, "Connect openFDA without authentication or configure an API key.");
  },
  skipDnsValidation: true,
});

export const credentialValidators: CredentialValidators = {
  apiKey(input, { fetcher }) {
    return validateOpenfdaCredential({ apiKey: input.apiKey, ...input.values }, fetcher);
  },
};
