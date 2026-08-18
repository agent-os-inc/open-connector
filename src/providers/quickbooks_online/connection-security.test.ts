import type { IConnectionStore, StoredConnection } from "../../connection-service.ts";
import type { ActionExecutor, CredentialValidators, ResolvedCredential } from "../../core/types.ts";
import type { IOAuthCredentialRefresher } from "../../oauth/oauth-credential-refresh-service.ts";
import type { IProviderLoader } from "../provider-loader.ts";

import { describe, expect, it, vi } from "vitest";
import { createCatalogStore } from "../../catalog-store.ts";
import { ConnectionService } from "../../connection-service.ts";
import { provider } from "./definition.ts";

type OAuthCredential = Extract<ResolvedCredential, { authType: "oauth2" }>;

function oauthCredential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    authType: "oauth2",
    accessToken: "access-old",
    tokenType: "Bearer",
    refreshToken: "refresh-old",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    providerSecret: { realmId: "12345" },
    profile: { accountId: "quickbooks_online:oauth2", displayName: "Example Co", grantedScopes: [] },
    metadata: { oauthClientExtra: { environment: "sandbox" } },
    ...overrides,
  };
}

function createService(
  options: { store?: MemoryStore; refresher?: IOAuthCredentialRefresher; loader?: IProviderLoader } = {},
) {
  const store = options.store ?? new MemoryStore();
  const refresher = options.refresher ?? new FakeRefresher();
  const service = new ConnectionService({
    catalog: createCatalogStore([provider], { executableActionIds: provider.actions.map((action) => action.id) }),
    providerLoader: options.loader ?? new QuickBooksLoader(),
    oauthCredentials: refresher,
    store,
  });
  return { service, store, refresher };
}

describe("QuickBooks OAuth connection lifecycle", () => {
  it("requires successful CompanyInfo verification before any credential write", async () => {
    const store = new MemoryStore();
    const loader = new QuickBooksLoader(async () => {
      throw new Error("QuickBooks Online request failed.");
    });
    const { service } = createService({ store, loader });

    await expect(service.setOAuthCredential("quickbooks_online", oauthCredential(), "finance")).rejects.toMatchObject({
      code: "credential_verification_failed",
    });
    await expect(store.get("quickbooks_online", "finance")).resolves.toBeUndefined();
  });

  it("creates an alias once and never overwrites its bound realm", async () => {
    const { service, store } = createService();

    const summary = await service.setOAuthCredential("quickbooks_online", oauthCredential(), "finance");
    await expect(
      service.setOAuthCredential(
        "quickbooks_online",
        oauthCredential({ providerSecret: { realmId: "99999" } }),
        "finance",
      ),
    ).rejects.toMatchObject({ code: "connection_already_exists" });

    await expect(store.get("quickbooks_online", "finance")).resolves.toMatchObject({
      credential: { providerSecret: { realmId: "12345" } },
    });
    expect(JSON.stringify(summary)).not.toContain("12345");
  });

  it("persists a pre-call refresh lease then atomically stores the rotated token", async () => {
    const store = new MemoryStore();
    const refresh = vi.fn(async (_service: string, credential: OAuthCredential): Promise<OAuthCredential> => {
      expect(credential.metadata.oauthRefreshLease).toMatchObject({
        owner: expect.any(String),
        phase: "provider_call",
        startedAt: expect.any(String),
      });
      return { ...credential, accessToken: "access-new", refreshToken: "refresh-new" };
    });
    const { service } = createService({ store, refresher: { refresh } });
    await service.setOAuthCredential(
      "quickbooks_online",
      oauthCredential({ expiresAt: new Date(0).toISOString() }),
      "finance",
    );

    const execution = await service.resolveForExecution("quickbooks_online", "finance");

    await expect(execution.getCredential("quickbooks_online")).resolves.toMatchObject({
      accessToken: "access-new",
      refreshToken: "refresh-new",
      providerSecret: { realmId: "12345" },
      metadata: { oauthClientExtra: { environment: "sandbox" } },
    });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("quarantines an ambiguous refresh outcome and never retries it", async () => {
    const refresh = vi.fn(async () => {
      throw new Error("ambiguous transport failure");
    });
    const { service, store } = createService({ refresher: { refresh } });
    await service.setOAuthCredential(
      "quickbooks_online",
      oauthCredential({ expiresAt: new Date(0).toISOString() }),
      "finance",
    );

    await expect(service.resolveForExecution("quickbooks_online", "finance")).rejects.toThrow(
      "ambiguous transport failure",
    );
    await expect(service.resolveForExecution("quickbooks_online", "finance")).rejects.toMatchObject({
      code: "oauth_refresh_quarantined",
    });
    expect(refresh).toHaveBeenCalledOnce();
    await expect(store.get("quickbooks_online", "finance")).resolves.toMatchObject({
      credential: { metadata: { oauthRefreshLease: { phase: "outcome_unknown" } } },
    });
  });

  it("deletes only after proven provider revocation", async () => {
    const revoke = vi.fn(async (_service: string, credential: OAuthCredential) => {
      expect(credential.metadata.oauthDisconnectLease).toMatchObject({
        owner: expect.any(String),
        phase: "provider_call",
        startedAt: expect.any(String),
      });
    });
    const { service, store } = createService({ refresher: { refresh: async (_service, value) => value, revoke } });
    await service.setOAuthCredential("quickbooks_online", oauthCredential(), "finance");

    await service.disconnect("quickbooks_online", "finance");

    expect(revoke).toHaveBeenCalledOnce();
    await expect(store.get("quickbooks_online", "finance")).resolves.toBeUndefined();
  });

  it("retains and quarantines a connection when revocation is not proven", async () => {
    const revoke = vi.fn(async () => {
      throw new Error("timeout");
    });
    const { service, store } = createService({ refresher: { refresh: async (_service, value) => value, revoke } });
    await service.setOAuthCredential("quickbooks_online", oauthCredential(), "finance");

    await expect(service.disconnect("quickbooks_online", "finance")).rejects.toThrow("timeout");
    await expect(service.resolveForExecution("quickbooks_online", "finance")).rejects.toMatchObject({
      code: "oauth_revocation_quarantined",
    });
    await expect(store.get("quickbooks_online", "finance")).resolves.toMatchObject({
      credential: { metadata: { oauthDisconnectLease: { phase: "outcome_unknown" } } },
    });
  });

  it("lets a cross-replica CAS loser reuse the winner's rotated token", async () => {
    const store = new MemoryStore();
    let releaseRefresh!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let allowRefresh!: () => void;
    const refreshAllowed = new Promise<void>((resolve) => {
      allowRefresh = resolve;
    });
    const refresh = vi.fn(async (_service: string, value: OAuthCredential) => {
      releaseRefresh();
      await refreshAllowed;
      return { ...value, accessToken: "winner-access", refreshToken: "winner-refresh" };
    });
    const first = createService({ store, refresher: { refresh } }).service;
    const second = createService({ store, refresher: { refresh } }).service;
    await first.setOAuthCredential(
      "quickbooks_online",
      oauthCredential({ expiresAt: new Date(0).toISOString() }),
      "finance",
    );

    const winner = first.resolveForExecution("quickbooks_online", "finance");
    await refreshStarted;
    const follower = second.resolveForExecution("quickbooks_online", "finance");
    allowRefresh();

    const [winnerExecution, followerExecution] = await Promise.all([winner, follower]);
    await expect(winnerExecution.getCredential("quickbooks_online")).resolves.toMatchObject({
      accessToken: "winner-access",
      refreshToken: "winner-refresh",
    });
    await expect(followerExecution.getCredential("quickbooks_online")).resolves.toMatchObject({
      accessToken: "winner-access",
      refreshToken: "winner-refresh",
    });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("does not persist a refresh lease when the OAuth client identity preflight fails", async () => {
    const refresh = vi.fn(async (_service: string, value: OAuthCredential) => value);
    const preflightRefresh = vi.fn(async () => {
      throw Object.assign(new Error("OAuth client identity changed"), { code: "oauth_client_mismatch" });
    });
    const { service, store } = createService({ refresher: { refresh, preflightRefresh } });
    await service.setOAuthCredential(
      "quickbooks_online",
      oauthCredential({ expiresAt: new Date(0).toISOString() }),
      "finance",
    );

    await expect(service.resolveForExecution("quickbooks_online", "finance")).rejects.toMatchObject({
      code: "oauth_client_mismatch",
    });
    expect(refresh).not.toHaveBeenCalled();
    await expect(store.get("quickbooks_online", "finance")).resolves.not.toMatchObject({
      credential: { metadata: { oauthRefreshLease: expect.anything() } },
    });
  });

  it("never deletes a newly reconnected credential after delayed revocation", async () => {
    const store = new MemoryStore();
    const revoke = vi.fn(async () => {
      await store.delete("quickbooks_online", "finance");
      await store.create("quickbooks_online", "finance", oauthCredential({ accessToken: "replacement-access" }));
    });
    const { service } = createService({
      store,
      refresher: { refresh: async (_service, value) => value, revoke },
    });
    await service.setOAuthCredential("quickbooks_online", oauthCredential(), "finance");

    await expect(service.disconnect("quickbooks_online", "finance")).rejects.toMatchObject({
      code: "oauth_revocation_quarantined",
    });
    await expect(store.get("quickbooks_online", "finance")).resolves.toMatchObject({
      credential: { accessToken: "replacement-access" },
    });
  });

  it("requires explicit external revocation proof before deleting a stale refresh quarantine", async () => {
    const refresh = vi.fn(async () => {
      throw new Error("ambiguous transport failure");
    });
    const { service, store } = createService({ refresher: { refresh } });
    await service.setOAuthCredential(
      "quickbooks_online",
      oauthCredential({ expiresAt: new Date(0).toISOString() }),
      "finance",
    );
    await expect(service.resolveForExecution("quickbooks_online", "finance")).rejects.toThrow(
      "ambiguous transport failure",
    );
    const current = (await store.get("quickbooks_online", "finance"))!;
    if (current.credential.authType !== "oauth2") throw new Error("expected OAuth credential");

    await expect(
      service.forceDeleteQuarantined("quickbooks_online", "finance", current.id, false),
    ).rejects.toMatchObject({
      code: "oauth_quarantine_active",
    });
    const lease = current.credential.metadata.oauthRefreshLease as Record<string, unknown>;
    await store.updateCredential({
      ...current,
      credential: {
        ...current.credential,
        metadata: {
          ...current.credential.metadata,
          oauthRefreshLease: { ...lease, startedAt: new Date(0).toISOString() },
        },
      },
    });
    await expect(
      service.forceDeleteQuarantined("quickbooks_online", "finance", "wrong-id", true),
    ).rejects.toMatchObject({
      code: "connection_not_found",
    });

    await expect(
      service.forceDeleteQuarantined("quickbooks_online", "finance", current.id, false),
    ).rejects.toMatchObject({
      code: "oauth_external_revocation_required",
    });
    await expect(
      service.forceDeleteQuarantined("quickbooks_online", "finance", current.id, true),
    ).resolves.toMatchObject({
      configured: false,
    });
    await expect(store.get("quickbooks_online", "finance")).resolves.toBeUndefined();
  });

  it("force-deletes only a stale revocation quarantine with the exact connection id", async () => {
    const revoke = vi.fn(async () => {
      throw new Error("ambiguous revoke");
    });
    const { service, store } = createService({
      refresher: { refresh: async (_service, value) => value, revoke },
    });
    await service.setOAuthCredential("quickbooks_online", oauthCredential(), "finance");
    await expect(service.disconnect("quickbooks_online", "finance")).rejects.toThrow("ambiguous revoke");
    const current = (await store.get("quickbooks_online", "finance"))!;
    if (current.credential.authType !== "oauth2") throw new Error("expected OAuth credential");
    const lease = current.credential.metadata.oauthDisconnectLease as Record<string, unknown>;
    await store.updateCredential({
      ...current,
      credential: {
        ...current.credential,
        metadata: {
          ...current.credential.metadata,
          oauthDisconnectLease: { ...lease, startedAt: new Date(0).toISOString() },
        },
      },
    });

    await expect(
      service.forceDeleteQuarantined("quickbooks_online", "finance", "wrong-id", true),
    ).rejects.toMatchObject({
      code: "connection_not_found",
    });
    await expect(
      service.forceDeleteQuarantined("quickbooks_online", "finance", current.id, false),
    ).rejects.toMatchObject({
      code: "oauth_external_revocation_required",
    });
    await expect(service.forceDeleteQuarantined("quickbooks_online", "finance", current.id, true)).resolves.toEqual({
      service: "quickbooks_online",
      connectionName: "finance",
      configured: false,
    });
  });

  it("safely releases only a stale pre-egress tokenless authorization reservation", async () => {
    const { service, store } = createService();
    const reservation = await service.reserveOAuthCredential("quickbooks_online", "finance");
    if (reservation.connection.credential.authType !== "oauth2") throw new Error("expected OAuth credential");
    const lease = reservation.connection.credential.metadata.oauthAuthorizationLease as Record<string, unknown>;
    await store.updateCredential({
      ...reservation.connection,
      credential: {
        ...reservation.connection.credential,
        metadata: {
          ...reservation.connection.credential.metadata,
          oauthAuthorizationLease: { ...lease, startedAt: new Date(0).toISOString() },
        },
      },
    });

    await expect(
      service.forceDeleteQuarantined("quickbooks_online", "finance", reservation.connection.id, false),
    ).resolves.toMatchObject({ configured: false });
  });
});

class QuickBooksLoader implements IProviderLoader {
  private readonly validate: NonNullable<CredentialValidators["oauth2"]>;

  constructor(validate?: NonNullable<CredentialValidators["oauth2"]>) {
    this.validate =
      validate ??
      (async (credential) => ({
        profile: { displayName: credential.providerSecret ? "Example Co" : "Unavailable" },
      }));
  }

  async loadActionExecutor(): Promise<ActionExecutor | undefined> {
    return undefined;
  }

  async loadProxyExecutor(): Promise<undefined> {
    return undefined;
  }

  async loadCredentialValidators(): Promise<CredentialValidators> {
    return { oauth2: this.validate };
  }
}

class FakeRefresher implements IOAuthCredentialRefresher {
  async refresh(_service: string, credential: OAuthCredential): Promise<OAuthCredential> {
    return credential;
  }

  async revoke(): Promise<void> {}
}

class MemoryStore implements IConnectionStore {
  private readonly values = new Map<string, StoredConnection>();

  async get(service: string, connectionName: string): Promise<StoredConnection | undefined> {
    return this.values.get(`${service}:${connectionName}`);
  }

  async create(
    service: string,
    connectionName: string,
    credential: ResolvedCredential,
  ): Promise<StoredConnection | undefined> {
    const key = `${service}:${connectionName}`;
    if (this.values.has(key)) return undefined;
    const connection = { id: crypto.randomUUID(), revision: crypto.randomUUID(), service, connectionName, credential };
    this.values.set(key, connection);
    return connection;
  }

  async set(service: string, connectionName: string, credential: ResolvedCredential): Promise<StoredConnection> {
    const key = `${service}:${connectionName}`;
    const connection = {
      id: this.values.get(key)?.id ?? crypto.randomUUID(),
      revision: crypto.randomUUID(),
      service,
      connectionName,
      credential,
    };
    this.values.set(key, connection);
    return connection;
  }

  async updateCredential(input: StoredConnection): Promise<boolean> {
    const key = `${input.service}:${input.connectionName}`;
    const current = this.values.get(key);
    if (!current || current.id !== input.id || current.revision !== input.revision) return false;
    this.values.set(key, { ...input, revision: crypto.randomUUID() });
    return true;
  }

  async deleteIfRevision(input: StoredConnection): Promise<boolean> {
    const key = `${input.service}:${input.connectionName}`;
    const current = this.values.get(key);
    if (!current || current.id !== input.id || current.revision !== input.revision) return false;
    this.values.delete(key);
    return true;
  }

  async delete(service: string, connectionName: string): Promise<void> {
    this.values.delete(`${service}:${connectionName}`);
  }

  async list(): Promise<StoredConnection[]> {
    return [...this.values.values()];
  }
}
