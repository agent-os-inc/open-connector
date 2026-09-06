import type { CredentialValidators, ProviderExecutors } from "../../core/types.ts";

import { defineApiKeyProviderExecutors, ProviderRequestError } from "../provider-runtime.ts";
import { zipArchiveApiActionHandlers } from "./runtime.ts";

export const executors: ProviderExecutors = defineApiKeyProviderExecutors(
  "zip_archive_api",
  zipArchiveApiActionHandlers,
  {
    skipDnsValidation: true,
  },
);
export const credentialValidators: CredentialValidators = {
  async apiKey(input) {
    if (!input.apiKey.trim()) throw new ProviderRequestError(400, "ArchiveAPI secret key is required");
    return {
      profile: { displayName: "ArchiveAPI Secret Key" },
      grantedScopes: [],
      metadata: { apiBaseUrl: "https://api.archiveapi.com", credentialValidation: "non_empty_only" },
    };
  },
};
