import type { ResolvedCredential } from "../core/types.ts";
import type { IOAuthClientConfigStore, OAuthClientConfig } from "./oauth-client-config-service.ts";

import { afterEach, describe, expect, it, vi } from "vitest";
import { createCatalogStore } from "../catalog-store.ts";
import { provider } from "../providers/quickbooks_online/definition.ts";
import { OAuthClientConfigService } from "./oauth-client-config-service.ts";
import { OAuthCredentialRefreshService } from "./oauth-credential-refresh-service.ts";

type OAuthCredential = Extract<ResolvedCredential, { authType: "oauth2" }>;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OAuthCredentialRefreshService QuickBooks security", () => {
  it("maps provider-controlled refresh errors to a fixed local message", async () => {
    const { refresher } = await createService();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: "invalid_grant", error_description: "redaction-sentinel-provider-token-error" },
          { status: 400 },
        ),
      ),
    );

    await expect(refresher.refresh("quickbooks_online", credential())).rejects.toMatchObject({
      code: "oauth_token_refresh_failed",
      message: "OAuth token refresh failed.",
    });
    await expect(refresher.refresh("quickbooks_online", credential())).rejects.not.toThrow(
      "redaction-sentinel-provider-token-error",
    );
  });

  it("uses Intuit's exact JSON revoke request with Basic client authentication", async () => {
    const { refresher } = await createService();
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetcher);

    await refresher.revoke("quickbooks_online", credential());

    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://developer.api.intuit.com/v2/oauth2/tokens/revoke");
    const init = fetcher.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(init?.method).toBe("POST");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("authorization")).toBe(`Basic ${Buffer.from("client-id:client-secret").toString("base64")}`);
    expect(init?.body).toBe(JSON.stringify({ token: "refresh-token" }));
  });

  it("fails before lease or egress when the stored OAuth client identity changed", async () => {
    const { refresher } = await createService();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const mismatched = credential({ oauthClientId: "different-client-id" });

    await expect(refresher.preflightRefresh("quickbooks_online", mismatched)).rejects.toMatchObject({
      code: "oauth_client_mismatch",
    });
    await expect(refresher.preflightRevoke("quickbooks_online", mismatched)).rejects.toMatchObject({
      code: "oauth_client_mismatch",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("allows secret rotation when the OAuth client id remains unchanged", async () => {
    const { configs, refresher } = await createService();
    await configs.upsertConfig({
      service: "quickbooks_online",
      clientId: "client-id",
      clientSecret: "rotated-secret",
    });
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ access_token: "rotated-access", refresh_token: "rotated-refresh" }),
    );
    vi.stubGlobal("fetch", fetcher);

    await expect(refresher.refresh("quickbooks_online", credential())).resolves.toMatchObject({
      accessToken: "rotated-access",
      refreshToken: "rotated-refresh",
    });
    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe(`Basic ${Buffer.from("client-id:rotated-secret").toString("base64")}`);
  });
});

async function createService(): Promise<{
  configs: OAuthClientConfigService;
  refresher: OAuthCredentialRefreshService;
}> {
  const store = new MemoryOAuthClientConfigStore();
  const configs = new OAuthClientConfigService({
    catalog: createCatalogStore([provider]),
    origin: "http://localhost:3000",
    store,
  });
  await configs.upsertConfig({
    service: "quickbooks_online",
    clientId: "client-id",
    clientSecret: "client-secret",
  });
  return { configs, refresher: new OAuthCredentialRefreshService(configs) };
}

function credential(metadata: Record<string, unknown> = {}): OAuthCredential {
  return {
    authType: "oauth2",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    tokenType: "Bearer",
    providerSecret: { realmId: "12345" },
    profile: { accountId: "quickbooks_online:oauth2", displayName: "Example Co", grantedScopes: [] },
    metadata: {
      oauthClientId: "client-id",
      oauthClientExtra: { environment: "sandbox" },
      ...metadata,
    },
  };
}

class MemoryOAuthClientConfigStore implements IOAuthClientConfigStore {
  private readonly values = new Map<string, OAuthClientConfig>();

  async get(service: string): Promise<OAuthClientConfig | undefined> {
    return this.values.get(service);
  }

  async set(config: OAuthClientConfig): Promise<void> {
    this.values.set(config.service, config);
  }

  async delete(service: string): Promise<void> {
    this.values.delete(service);
  }

  async list(): Promise<OAuthClientConfig[]> {
    return [...this.values.values()];
  }
}
