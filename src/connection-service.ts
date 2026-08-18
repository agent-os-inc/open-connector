import type { CatalogStore, RuntimeProviderDefinition } from "./catalog-store.ts";
import type {
  ApiKeyAuthDefinition,
  AuthType,
  CredentialDefinition,
  CredentialProfile,
  CredentialValidationResult,
  CustomCredentialAuthDefinition,
  ProviderDefinition,
  ResolvedCredential,
  RuntimeLogger,
} from "./core/types.ts";
import type { IOAuthCredentialRefresher } from "./oauth/oauth-credential-refresh-service.ts";
import type { IProviderLoader } from "./providers/provider-loader.ts";

import { normalizeCredentialValues } from "./core/credential-fields.ts";
import { isDefinitiveOAuthTokenFailure } from "./oauth/oauth-token.ts";
import { providerFetch } from "./providers/provider-runtime.ts";

export const defaultConnectionName = "default";

/**
 * Connection summary returned to the local console.
 */
export interface ConnectionSummary {
  id: string;
  service: string;
  connectionName: string;
  authType: AuthType;
  configured: boolean;
  virtual: boolean;
  default: boolean;
  profile: CredentialProfile;
}

/**
 * Request body for local credential connections.
 */
export interface ConnectWithCredentialInput {
  connectionName?: string;
  values?: Record<string, unknown>;
}

export interface ConnectWithoutAuthInput {
  connectionName?: string;
}

export interface ConnectionServiceOptions {
  catalog: CatalogStore;
  oauthCredentials?: IOAuthCredentialRefresher;
  providerLoader: IProviderLoader;
  store: IConnectionStore;
  logger?: RuntimeLogger;
}

export interface StoredConnection {
  id: string;
  revision: string;
  service: string;
  connectionName: string;
  credential: ResolvedCredential;
}

export interface OAuthConnectionReservation {
  connection: StoredConnection;
  owner: string;
}

export interface DisconnectedConnectionSummary {
  service: string;
  connectionName: string;
  configured: false;
}

export interface ExecutionConnection {
  summary?: ConnectionSummary;
  getCredential(service: string): Promise<ResolvedCredential | undefined>;
  refreshOAuthCredential?(
    service: string,
    rejectedAccessToken: string,
  ): Promise<Extract<ResolvedCredential, { authType: "oauth2" }>>;
}

/**
 * Storage contract for local provider connections.
 */
export interface IConnectionStore {
  get(service: string, connectionName: string): Promise<StoredConnection | undefined>;
  /** Atomically create a connection, returning undefined when the alias exists. */
  create?(
    service: string,
    connectionName: string,
    credential: ResolvedCredential,
  ): Promise<StoredConnection | undefined>;
  set(service: string, connectionName: string, credential: ResolvedCredential): Promise<StoredConnection>;
  updateCredential(input: StoredConnection): Promise<boolean>;
  /** Delete only when the connection identity and revision still match. */
  deleteIfRevision?(input: StoredConnection): Promise<boolean>;
  delete(service: string, connectionName: string): Promise<void>;
  list(): Promise<StoredConnection[]>;
}

interface ServiceConnection {
  id: string;
  connectionName: string;
  credential: ResolvedCredential;
}

interface ApiKeyCredentialValidationInput {
  apiKey: string;
  values: Record<string, string>;
}

interface CustomCredentialValidationInput {
  values: Record<string, string>;
}

interface CredentialRuntimeData {
  profile: CredentialProfile;
  metadata: Record<string, unknown>;
}

interface PreviousCredentialRuntimeData {
  profile: CredentialProfile;
  metadata: Record<string, unknown>;
}

type CredentialValidatorCall = () => Promise<CredentialValidationResult | void> | undefined;
type OAuthCredential = Extract<ResolvedCredential, { authType: "oauth2" }>;
type OAuthLease = { owner: string; phase: "pre_egress" | "provider_call" | "outcome_unknown"; startedAt: string };

const oauthLeaseMaxAgeMs = 60_000;
const oauthRefreshWinnerBackoffMs = [50, 100, 200, 400, 800] as const;

/**
 * Coordinates local provider connection state.
 *
 * No-auth providers are treated as virtual connections so open-source users can
 * run public actions without configuration.
 */
export class ConnectionService {
  private readonly catalog: CatalogStore;
  private readonly oauthCredentialRefreshes = new Map<string, Promise<OAuthCredential>>();
  private readonly oauthCredentials?: IOAuthCredentialRefresher;
  private readonly providerLoader: IProviderLoader;
  private readonly store: IConnectionStore;
  private readonly logger?: RuntimeLogger;

  constructor(input: ConnectionServiceOptions) {
    this.catalog = input.catalog;
    this.oauthCredentials = input.oauthCredentials;
    this.providerLoader = input.providerLoader;
    this.store = input.store;
    this.logger = input.logger;
  }

  async listConnections(): Promise<ConnectionSummary[]> {
    const configured = await this.store.list();
    const configuredByService = new Map<string, ServiceConnection[]>();
    for (const connection of configured) {
      const serviceConnections = configuredByService.get(connection.service) ?? [];
      serviceConnections.push({
        id: connection.id,
        connectionName: connection.connectionName,
        credential: connection.credential,
      });
      configuredByService.set(connection.service, serviceConnections);
    }

    return this.catalog.providers.flatMap((provider) => {
      const connections = configuredByService.get(provider.service) ?? [];
      if (connections.length > 0) {
        return connections.map((connection) =>
          this.createConfiguredConnectionSummary(
            provider,
            connection.id,
            connection.connectionName,
            connection.credential,
          ),
        );
      }

      return this.supportsAuth(provider, "no_auth")
        ? [this.createNoAuthConnectionSummary(provider, defaultConnectionName)]
        : [];
    });
  }

  async listConnectionsByService(service: string): Promise<ConnectionSummary[]> {
    const provider = this.getProvider(service);
    const connections = (await this.store.list()).filter((connection) => connection.service === service);
    if (connections.length > 0) {
      return connections.map((connection) =>
        this.createConfiguredConnectionSummary(
          provider,
          connection.id,
          connection.connectionName,
          connection.credential,
        ),
      );
    }

    return this.supportsAuth(provider, "no_auth")
      ? [this.createNoAuthConnectionSummary(provider, defaultConnectionName)]
      : [];
  }

  async listAuthenticatedServices(services: string[]): Promise<string[]> {
    const configured = await this.store.list();
    const authenticated = new Set(
      configured
        .filter((connection) => connection.credential.authType !== "no_auth")
        .map((connection) => connection.service),
    );
    return services.filter((service) => authenticated.has(service));
  }

  async getConnectionSummary(service: string, connectionName?: string): Promise<ConnectionSummary | undefined> {
    const provider = this.getProvider(service);
    const name = normalizeConnectionName(connectionName);
    const stored = await this.store.get(service, name);
    if (!stored && connectionName && !this.supportsAuth(provider, "no_auth")) {
      throw new ConnectionError("connection_not_found", `${service} connection not found: ${name}.`);
    }

    return stored
      ? this.createConfiguredConnectionSummary(provider, stored.id, name, stored.credential)
      : this.supportsAuth(provider, "no_auth")
        ? this.createNoAuthConnectionSummary(provider, name)
        : undefined;
  }

  async resolveForExecution(service: string, connectionName?: string): Promise<ExecutionConnection> {
    const provider = this.getProvider(service);
    const name = normalizeConnectionName(connectionName);
    const stored = await this.store.get(service, name);
    if (!stored && connectionName && !this.supportsAuth(provider, "no_auth")) {
      throw new ConnectionError("connection_not_found", `${service} connection not found: ${name}.`);
    }

    let credential: ResolvedCredential | undefined = stored?.credential;
    if (stored?.credential.authType === "oauth2") {
      credential = await this.resolveOAuthCredential(stored, stored.credential);
    }
    credential ??= this.supportsAuth(provider, "no_auth") ? { authType: "no_auth" } : undefined;
    const summary = stored
      ? this.createConfiguredConnectionSummary(provider, stored.id, name, credential!)
      : credential
        ? this.createNoAuthConnectionSummary(provider, name)
        : undefined;

    const execution: ExecutionConnection = {
      summary,
      getCredential: async (requestedService) => (requestedService === service ? credential : undefined),
    };
    if (stored?.credential.authType === "oauth2") {
      execution.refreshOAuthCredential = async (requestedService, rejectedAccessToken) => {
        if (requestedService !== service) {
          throw new ConnectionError("connection_not_found", `Unknown OAuth service: ${requestedService}.`);
        }
        const current = await this.store.get(service, name);
        if (!current || current.id !== stored.id || current.credential.authType !== "oauth2") {
          throw new ConnectionError("connection_not_found", `${service} connection changed before OAuth refresh.`);
        }
        if (current.credential.accessToken !== rejectedAccessToken && !current.credential.metadata.oauthRefreshLease) {
          credential = current.credential;
          return current.credential;
        }
        credential = await this.resolveOAuthCredential(current, current.credential, true);
        return credential;
      };
    }
    return execution;
  }

  async getCredential(service: string, connectionName?: string): Promise<ResolvedCredential | undefined> {
    const provider = this.getProvider(service);
    const name = normalizeConnectionName(connectionName);
    const stored = await this.store.get(service, name);
    if (stored) {
      return stored.credential.authType === "oauth2"
        ? await this.resolveOAuthCredential(stored, stored.credential)
        : stored.credential;
    }

    if (connectionName && !this.supportsAuth(provider, "no_auth")) {
      throw new ConnectionError("connection_not_found", `${service} connection not found: ${name}.`);
    }

    return this.supportsAuth(provider, "no_auth") ? { authType: "no_auth" } : undefined;
  }

  forConnection(connectionName?: string): Pick<ConnectionService, "getCredential"> {
    return {
      getCredential: (service: string) => this.getCredential(service, connectionName),
    };
  }

  async connectWithoutAuth(service: string, input: ConnectWithoutAuthInput = {}): Promise<ConnectionSummary> {
    const provider = this.getAvailableProvider(service);
    if (!this.supportsAuth(provider, "no_auth")) {
      throw new ConnectionError("unsupported_auth_type", `${service} does not support no_auth.`);
    }

    return this.createNoAuthConnectionSummary(provider, normalizeConnectionName(input.connectionName));
  }

  async connectWithApiKey(service: string, input: ConnectWithCredentialInput): Promise<ConnectionSummary> {
    const provider = this.getAvailableProvider(service);
    if (!this.supportsAuth(provider, "api_key")) {
      throw new ConnectionError("unsupported_auth_type", `${service} does not support api_key.`);
    }

    const auth = this.getApiKeyDefinition(provider);
    const values = normalizeCredentialValues({
      fields: createApiKeyFields(auth),
      values: input.values ?? {},
      createError: (message) => new ConnectionError("invalid_input", message),
    });
    const apiKey = values.apiKey;

    const credential: ResolvedCredential = {
      authType: "api_key",
      apiKey,
      values,
      ...this.buildCredentialRuntimeData(
        provider,
        "api_key",
        createApiKeyFields(auth),
        values,
        await this.validateApiKeyCredential(service, { apiKey, values }),
      ),
    };
    const connectionName = normalizeConnectionName(input.connectionName);
    const stored = await this.store.set(service, connectionName, credential);

    return this.createStoredConnectionSummary(provider, stored.id, connectionName, credential);
  }

  async connectWithCustomCredential(service: string, input: ConnectWithCredentialInput): Promise<ConnectionSummary> {
    const provider = this.getAvailableProvider(service);
    if (!this.supportsAuth(provider, "custom_credential")) {
      throw new ConnectionError("unsupported_auth_type", `${service} does not support custom_credential.`);
    }

    const auth = this.getCustomCredentialDefinition(provider);
    const values = normalizeCredentialValues({
      fields: auth.fields,
      values: input.values ?? {},
      createError: (message) => new ConnectionError("invalid_input", message),
    });
    const credential: ResolvedCredential = {
      authType: "custom_credential",
      values,
      ...this.buildCredentialRuntimeData(
        provider,
        "custom_credential",
        auth.fields,
        values,
        await this.validateCustomCredential(service, { values }),
      ),
    };
    const connectionName = normalizeConnectionName(input.connectionName);
    const stored = await this.store.set(service, connectionName, credential);

    return this.createStoredConnectionSummary(provider, stored.id, connectionName, credential);
  }

  async setOAuthCredential(
    service: string,
    credential: Extract<ResolvedCredential, { authType: "oauth2" }>,
    connectionNameInput?: string,
  ): Promise<ConnectionSummary> {
    const provider = this.getAvailableProvider(service);
    if (!this.supportsAuth(provider, "oauth2")) {
      throw new ConnectionError("unsupported_auth_type", `${service} does not support oauth2.`);
    }

    const connectionName = normalizeConnectionName(connectionNameInput);
    const auth = provider.auth.find((definition) => definition.type === "oauth2");
    if (!auth || auth.type !== "oauth2") {
      throw new ConnectionError("unsupported_auth_type", `${service} does not support oauth2.`);
    }
    let validation: CredentialValidationResult = {};
    try {
      validation = await this.validateOAuthCredential(service, credential, auth.credentialVerification === "required");
    } catch (error) {
      if (
        auth.credentialVerification === "required" ||
        !(error instanceof ConnectionError && error.code === "credential_verification_failed")
      ) {
        throw error;
      }
    }
    const storedCredential = {
      ...credential,
      ...this.mergeCredentialRuntimeData(provider, "oauth2", credential, validation),
    };
    let stored: StoredConnection;
    if (auth.connectionWriteMode === "create_only") {
      if (!this.store.create) {
        throw new ConnectionError(
          "connection_store_unsupported",
          "Connection store does not support create-only OAuth.",
        );
      }
      const created = await this.store.create(service, connectionName, storedCredential);
      if (!created) {
        throw new ConnectionError("connection_already_exists", `${service} connection alias already exists.`);
      }
      stored = created;
    } else {
      stored = await this.store.set(service, connectionName, storedCredential);
    }
    return this.createStoredConnectionSummary(provider, stored.id, connectionName, storedCredential);
  }

  async assertOAuthAliasAvailable(service: string, connectionNameInput?: string): Promise<void> {
    const provider = this.getAvailableProvider(service);
    const auth = provider.auth.find((definition) => definition.type === "oauth2");
    if (auth?.type !== "oauth2" || auth.connectionWriteMode !== "create_only") return;
    const connectionName = normalizeConnectionName(connectionNameInput);
    if (await this.store.get(service, connectionName)) {
      throw new ConnectionError("connection_already_exists", `${service} connection alias already exists.`);
    }
  }

  async reserveOAuthCredential(service: string, connectionNameInput?: string): Promise<OAuthConnectionReservation> {
    const provider = this.getAvailableProvider(service);
    const auth = provider.auth.find((definition) => definition.type === "oauth2");
    if (auth?.type !== "oauth2" || auth.connectionWriteMode !== "create_only") {
      throw new ConnectionError("unsupported_auth_type", `${service} does not require OAuth reservation.`);
    }
    if (!this.store.create || !this.store.deleteIfRevision) {
      throw new ConnectionError("connection_store_unsupported", "Connection store does not support OAuth reservation.");
    }
    const connectionName = normalizeConnectionName(connectionNameInput);
    const owner = crypto.randomUUID();
    const credential: OAuthCredential = {
      authType: "oauth2",
      accessToken: "",
      tokenType: "Bearer",
      profile: {
        accountId: `${service}:pending`,
        displayName: `${provider.displayName} authorization pending`,
        grantedScopes: [],
      },
      metadata: {
        oauthAuthorizationLease: {
          owner,
          phase: "pre_egress",
          startedAt: new Date().toISOString(),
        } satisfies OAuthLease,
      },
    };
    const connection = await this.store.create(service, connectionName, credential);
    if (!connection) {
      throw new ConnectionError("connection_already_exists", `${service} connection alias already exists.`);
    }
    return { connection, owner };
  }

  async markOAuthReservationEgress(reservation: OAuthConnectionReservation): Promise<OAuthConnectionReservation> {
    if (reservation.connection.credential.authType !== "oauth2") {
      throw new ConnectionError("oauth_authorization_quarantined", "OAuth authorization reservation is invalid.");
    }
    const lease = readOAuthLease(reservation.connection.credential.metadata.oauthAuthorizationLease);
    if (!lease || lease.owner !== reservation.owner || lease.phase !== "pre_egress") {
      throw new ConnectionError("oauth_authorization_quarantined", "OAuth authorization reservation changed.");
    }
    const credential: OAuthCredential = {
      ...reservation.connection.credential,
      metadata: {
        ...reservation.connection.credential.metadata,
        oauthAuthorizationLease: { ...lease, phase: "provider_call" },
      },
    };
    if (!(await this.store.updateCredential({ ...reservation.connection, credential }))) {
      throw new ConnectionError("oauth_authorization_quarantined", "OAuth authorization reservation changed.");
    }
    const connection = await this.store.get(reservation.connection.service, reservation.connection.connectionName);
    if (!connection || connection.id !== reservation.connection.id || connection.credential.authType !== "oauth2") {
      throw new ConnectionError("oauth_authorization_quarantined", "OAuth authorization reservation changed.");
    }
    return { connection, owner: reservation.owner };
  }

  async stageReservedOAuthCredential(
    reservation: OAuthConnectionReservation,
    credential: OAuthCredential,
  ): Promise<StoredConnection> {
    if (reservation.connection.credential.authType !== "oauth2") {
      throw new ConnectionError("oauth_authorization_quarantined", "OAuth authorization reservation is invalid.");
    }
    const lease = readOAuthLease(reservation.connection.credential.metadata.oauthAuthorizationLease);
    if (!lease || lease.owner !== reservation.owner) {
      throw new ConnectionError("oauth_authorization_quarantined", "OAuth authorization reservation is invalid.");
    }
    const stagedCredential: OAuthCredential = {
      ...credential,
      metadata: { ...credential.metadata, oauthAuthorizationLease: lease },
    };
    if (!(await this.store.updateCredential({ ...reservation.connection, credential: stagedCredential }))) {
      throw new ConnectionError("oauth_authorization_quarantined", "OAuth authorization reservation changed.");
    }
    const staged = await this.store.get(reservation.connection.service, reservation.connection.connectionName);
    if (
      !staged ||
      staged.id !== reservation.connection.id ||
      staged.credential.authType !== "oauth2" ||
      readOAuthLease(staged.credential.metadata.oauthAuthorizationLease)?.owner !== reservation.owner
    ) {
      throw new ConnectionError("oauth_authorization_quarantined", "OAuth authorization could not be staged.");
    }
    return staged;
  }

  async activateReservedOAuthCredential(staged: StoredConnection): Promise<ConnectionSummary> {
    const provider = this.getAvailableProvider(staged.service);
    const auth = provider.auth.find((definition) => definition.type === "oauth2");
    if (auth?.type !== "oauth2" || staged.credential.authType !== "oauth2") {
      throw new ConnectionError("unsupported_auth_type", `${staged.service} does not support oauth2.`);
    }
    const lease = readOAuthLease(staged.credential.metadata.oauthAuthorizationLease);
    if (!lease) throw new ConnectionError("oauth_authorization_quarantined", "OAuth authorization is not staged.");
    const validation = await this.validateOAuthCredential(
      staged.service,
      staged.credential,
      auth.credentialVerification === "required",
    );
    const { oauthAuthorizationLease: _lease, ...metadata } = staged.credential.metadata;
    const credential: OAuthCredential = {
      ...staged.credential,
      ...this.mergeCredentialRuntimeData(provider, "oauth2", staged.credential, validation),
      metadata: { ...metadata, ...(validation.metadata ?? {}) },
    };
    if (!(await this.store.updateCredential({ ...staged, credential }))) {
      throw new ConnectionError("oauth_authorization_quarantined", "OAuth authorization changed before activation.");
    }
    return this.createStoredConnectionSummary(provider, staged.id, staged.connectionName, credential);
  }

  async discardReservedOAuthCredential(staged: StoredConnection): Promise<void> {
    if (!this.store.deleteIfRevision || !(await this.store.deleteIfRevision(staged))) {
      throw new ConnectionError("oauth_authorization_quarantined", "OAuth authorization quarantine changed.");
    }
  }

  async quarantineReservedOAuthCredential(staged: StoredConnection): Promise<void> {
    if (staged.credential.authType !== "oauth2") return;
    const lease = readOAuthLease(staged.credential.metadata.oauthAuthorizationLease);
    if (!lease) return;
    await this.store.updateCredential({
      ...staged,
      credential: {
        ...staged.credential,
        metadata: {
          ...staged.credential.metadata,
          oauthAuthorizationLease: { ...lease, phase: "outcome_unknown" },
        },
      },
    });
  }

  async revokeUnstoredOAuthCredential(service: string, credential: OAuthCredential): Promise<void> {
    if (!this.oauthCredentials?.revoke) {
      throw new ConnectionError("oauth_revocation_unavailable", `${service} OAuth revocation is unavailable.`);
    }
    await this.oauthCredentials.preflightRevoke?.(service, credential);
    await this.oauthCredentials.revoke(service, credential);
  }

  async disconnect(
    service: string,
    connectionNameInput?: string,
  ): Promise<ConnectionSummary | DisconnectedConnectionSummary> {
    const connectionName = normalizeConnectionName(connectionNameInput);
    const provider = this.catalog.providers.find((item) => item.service === service);
    const auth = provider?.auth.find((definition) => definition.type === "oauth2");
    const stored = await this.store.get(service, connectionName);
    if (auth?.type === "oauth2" && auth.revocationMode === "required" && stored?.credential.authType === "oauth2") {
      if (!this.oauthCredentials?.revoke || !this.store.deleteIfRevision) {
        throw new ConnectionError("oauth_revocation_unavailable", `${service} OAuth revocation is unavailable.`);
      }
      if (
        stored.credential.metadata.oauthDisconnectLease !== undefined ||
        stored.credential.metadata.oauthRefreshLease !== undefined
      ) {
        throw new ConnectionError(
          "oauth_revocation_quarantined",
          `${service} OAuth credential operation is in progress.`,
        );
      }
      await this.oauthCredentials.preflightRevoke?.(service, stored.credential);
      const disconnectLease: OAuthLease = {
        owner: crypto.randomUUID(),
        phase: "provider_call",
        startedAt: new Date().toISOString(),
      };
      const leasedCredential: OAuthCredential = {
        ...stored.credential,
        metadata: { ...stored.credential.metadata, oauthDisconnectLease: disconnectLease },
      };
      const leased = await this.store.updateCredential({ ...stored, credential: leasedCredential });
      if (!leased) {
        throw new ConnectionError("connection_not_found", `${service} connection changed before revocation.`);
      }
      const current = await this.store.get(service, connectionName);
      if (
        !current ||
        current.id !== stored.id ||
        current.credential.authType !== "oauth2" ||
        readOAuthLease(current.credential.metadata.oauthDisconnectLease)?.owner !== disconnectLease.owner
      ) {
        throw new ConnectionError(
          "oauth_revocation_quarantined",
          `${service} OAuth revocation lease could not be verified.`,
        );
      }
      try {
        await this.oauthCredentials.revoke(service, current.credential);
      } catch (error) {
        await this.store.updateCredential({
          ...current,
          credential: {
            ...current.credential,
            metadata: {
              ...current.credential.metadata,
              oauthDisconnectLease: { ...disconnectLease, phase: "outcome_unknown" },
            },
          },
        });
        throw error;
      }
      if (!(await this.store.deleteIfRevision(current))) {
        throw new ConnectionError(
          "oauth_revocation_quarantined",
          `${service} connection changed after provider revocation.`,
        );
      }
    } else {
      await this.store.delete(service, connectionName);
    }
    if (provider && this.supportsAuth(provider, "no_auth")) {
      return this.connectWithoutAuth(service, { connectionName });
    }

    return { service, connectionName, configured: false };
  }

  async forceDeleteQuarantined(
    service: string,
    connectionNameInput: string | undefined,
    expectedConnectionId: string,
    externalRevocationConfirmed: boolean,
  ): Promise<DisconnectedConnectionSummary> {
    const connectionName = normalizeConnectionName(connectionNameInput);
    const stored = await this.store.get(service, connectionName);
    if (!stored || stored.id !== expectedConnectionId || stored.credential.authType !== "oauth2") {
      throw new ConnectionError("connection_not_found", `${service} quarantined connection not found.`);
    }
    const disconnectLease = readOAuthLease(stored.credential.metadata.oauthDisconnectLease);
    const refreshLease = readOAuthLease(stored.credential.metadata.oauthRefreshLease);
    const authorizationLease = readOAuthLease(stored.credential.metadata.oauthAuthorizationLease);
    const lease = disconnectLease ?? refreshLease ?? authorizationLease;
    if (!lease || !isStaleOAuthLease(lease)) {
      throw new ConnectionError("oauth_quarantine_active", `${service} OAuth quarantine is not eligible for deletion.`);
    }
    const safePreEgressReservation = authorizationLease?.phase === "pre_egress" && !stored.credential.accessToken;
    if (!safePreEgressReservation && !externalRevocationConfirmed) {
      throw new ConnectionError(
        "oauth_external_revocation_required",
        `${service} must be externally revoked before quarantine deletion.`,
      );
    }
    if (!this.store.deleteIfRevision || !(await this.store.deleteIfRevision(stored))) {
      throw new ConnectionError("oauth_revocation_quarantined", `${service} quarantined connection changed.`);
    }
    return { service, connectionName, configured: false };
  }

  private createConfiguredConnectionSummary(
    provider: ProviderDefinition,
    id: string,
    connectionName: string,
    credential: ResolvedCredential,
  ): ConnectionSummary {
    if (credential.authType === "no_auth") {
      return {
        ...this.createNoAuthConnectionSummary(provider, connectionName),
        id,
        virtual: false,
      };
    }

    return this.createStoredConnectionSummary(provider, id, connectionName, credential);
  }

  private createStoredConnectionSummary(
    provider: ProviderDefinition,
    id: string,
    connectionName: string,
    credential: Exclude<ResolvedCredential, { authType: "no_auth" }>,
  ): ConnectionSummary {
    return {
      id,
      service: provider.service,
      connectionName,
      authType: credential.authType,
      configured: true,
      virtual: false,
      default: connectionName === defaultConnectionName,
      profile: credential.profile,
    };
  }

  private createNoAuthConnectionSummary(provider: ProviderDefinition, connectionName: string): ConnectionSummary {
    return {
      id: createConnectionId(provider.service, connectionName),
      service: provider.service,
      connectionName,
      authType: "no_auth",
      configured: true,
      virtual: true,
      default: connectionName === defaultConnectionName,
      profile: this.createNoAuthProfile(provider),
    };
  }

  /** Rejects provider setup when none of its catalog actions can execute in this runtime. */
  assertProviderAvailable(service: string): void {
    this.getAvailableProvider(service);
  }

  private getProvider(service: string): RuntimeProviderDefinition {
    const provider = this.catalog.providers.find((provider) => provider.service === service);
    if (!provider) {
      throw new ConnectionError("unknown_service", `Unknown service: ${service}.`);
    }

    return provider;
  }

  private getAvailableProvider(service: string): RuntimeProviderDefinition {
    const provider = this.getProvider(service);
    if (provider.actions.length > 0 && provider.execution.locallyExecutableActionCount === 0) {
      throw new ConnectionError("provider_unavailable", `${provider.displayName} is not available in this runtime.`);
    }

    return provider;
  }

  private supportsAuth(provider: ProviderDefinition, authType: AuthType): boolean {
    return provider.authTypes.includes(authType);
  }

  private getApiKeyDefinition(provider: ProviderDefinition): ApiKeyAuthDefinition {
    const auth = provider.auth.find((auth) => auth.type === "api_key");
    if (!auth || auth.type !== "api_key") {
      throw new ConnectionError("unsupported_auth_type", `${provider.service} does not support api_key.`);
    }

    return auth;
  }

  private getCustomCredentialDefinition(provider: ProviderDefinition): CustomCredentialAuthDefinition {
    const auth = provider.auth.find((auth) => auth.type === "custom_credential");
    if (!auth || auth.type !== "custom_credential") {
      throw new ConnectionError("unsupported_auth_type", `${provider.service} does not support custom_credential.`);
    }

    return auth;
  }

  private async validateApiKeyCredential(
    service: string,
    input: ApiKeyCredentialValidationInput,
  ): Promise<CredentialValidationResult> {
    const validators = await this.providerLoader.loadCredentialValidators(service);
    return this.runCredentialValidator(service, () => validators?.apiKey?.(input, this.createValidatorOptions()));
  }

  private async validateCustomCredential(
    service: string,
    input: CustomCredentialValidationInput,
  ): Promise<CredentialValidationResult> {
    const validators = await this.providerLoader.loadCredentialValidators(service);
    return this.runCredentialValidator(service, () =>
      validators?.customCredential?.(input, this.createValidatorOptions()),
    );
  }

  private async validateOAuthCredential(
    service: string,
    credential: Extract<ResolvedCredential, { authType: "oauth2" }>,
    required: boolean,
  ): Promise<CredentialValidationResult> {
    const validators = await this.providerLoader.loadCredentialValidators(service);
    if (required && !validators?.oauth2) {
      throw new ConnectionError("credential_verification_unavailable", `${service} OAuth verification is unavailable.`);
    }
    return this.runCredentialValidator(service, () => validators?.oauth2?.(credential, this.createValidatorOptions()));
  }

  private createValidatorOptions() {
    return {
      fetcher: providerFetch,
      logger: this.logger,
    };
  }

  private async resolveOAuthCredential(
    connection: StoredConnection,
    credential: OAuthCredential,
    forceRefresh: boolean = false,
  ): Promise<OAuthCredential> {
    const service = connection.service;
    if (credential.metadata.oauthAuthorizationLease !== undefined) {
      throw new ConnectionError(
        "oauth_authorization_quarantined",
        `${service} OAuth authorization is incomplete and non-executable.`,
      );
    }
    if (credential.metadata.oauthDisconnectLease !== undefined) {
      throw new ConnectionError(
        "oauth_revocation_quarantined",
        `${service} OAuth revocation has an unresolved provider outcome. Reconnect ${service}.`,
      );
    }
    if (credential.metadata.oauthRefreshLease !== undefined) {
      const lease = readOAuthLease(credential.metadata.oauthRefreshLease);
      if (!lease || lease.phase === "outcome_unknown" || isStaleOAuthLease(lease)) {
        throw new ConnectionError(
          "oauth_refresh_quarantined",
          `${service} OAuth refresh has an unresolved provider outcome. Reconnect ${service}.`,
        );
      }
      return this.waitForRefreshWinner(connection, credential.accessToken);
    }
    if (!forceRefresh && !isOAuthCredentialExpired(credential)) {
      return credential;
    }

    if (!credential.refreshToken) {
      throw new ConnectionError(
        "oauth_token_expired",
        `${service} OAuth access token expired and no refresh token is available. Reconnect ${service}.`,
      );
    }

    if (!this.oauthCredentials) {
      throw new ConnectionError(
        "oauth_refresh_unavailable",
        `${service} OAuth access token expired and this runtime cannot refresh it.`,
      );
    }
    await this.oauthCredentials.preflightRefresh?.(service, credential);

    const refreshKey = `${connection.id}:${connection.revision}`;
    const currentRefresh = this.oauthCredentialRefreshes.get(refreshKey);
    if (currentRefresh) {
      return currentRefresh;
    }

    const refresh = this.refreshOAuthCredential(connection, credential, this.oauthCredentials);
    this.oauthCredentialRefreshes.set(refreshKey, refresh);
    try {
      return await refresh;
    } finally {
      if (this.oauthCredentialRefreshes.get(refreshKey) === refresh) {
        this.oauthCredentialRefreshes.delete(refreshKey);
      }
    }
  }

  private async refreshOAuthCredential(
    connection: StoredConnection,
    credential: OAuthCredential,
    refresher: IOAuthCredentialRefresher,
  ): Promise<OAuthCredential> {
    const { id, revision, service, connectionName } = connection;
    if (credential.metadata.oauthDisconnectLease !== undefined || credential.metadata.oauthRefreshLease !== undefined) {
      throw new ConnectionError("oauth_refresh_in_progress", `${service} OAuth credential operation is in progress.`);
    }
    const lease: OAuthLease = {
      owner: crypto.randomUUID(),
      phase: "provider_call",
      startedAt: new Date().toISOString(),
    };
    const leasedCredential: OAuthCredential = {
      ...credential,
      metadata: {
        ...credential.metadata,
        oauthRefreshLease: lease,
      },
    };
    const leased = await this.store.updateCredential({
      id,
      revision,
      service,
      connectionName,
      credential: leasedCredential,
    });
    if (!leased) {
      return this.waitForRefreshWinner(connection, credential.accessToken);
    }
    const leasedConnection = await this.store.get(service, connectionName);
    if (
      !leasedConnection ||
      leasedConnection.id !== id ||
      leasedConnection.credential.authType !== "oauth2" ||
      readOAuthLease(leasedConnection.credential.metadata.oauthRefreshLease)?.owner !== lease.owner
    ) {
      throw new ConnectionError("oauth_refresh_quarantined", `${service} OAuth refresh lease could not be verified.`);
    }

    let refreshedCredential: OAuthCredential;
    try {
      refreshedCredential = await refresher.refresh(service, leasedConnection.credential);
    } catch (error) {
      const { oauthRefreshLease: _refreshLease, ...metadata } = leasedConnection.credential.metadata;
      await this.store.updateCredential({
        ...leasedConnection,
        credential: {
          ...leasedConnection.credential,
          metadata: isDefinitiveOAuthTokenFailure(error)
            ? metadata
            : { ...metadata, oauthRefreshLease: { ...lease, phase: "outcome_unknown" } },
        },
      });
      throw error;
    }
    const { oauthRefreshLease: _lease, ...metadata } = refreshedCredential.metadata;
    const nextCredential: OAuthCredential = { ...refreshedCredential, metadata };
    const updated = await this.store.updateCredential({
      ...leasedConnection,
      credential: nextCredential,
    });
    if (!updated) {
      throw new ConnectionError(
        "oauth_refresh_quarantined",
        `${service} OAuth credential changed after the provider refresh. Reconnect ${service}.`,
      );
    }
    return nextCredential;
  }

  private async waitForRefreshWinner(
    original: StoredConnection,
    rejectedAccessToken: string,
  ): Promise<OAuthCredential> {
    for (const backoffMs of oauthRefreshWinnerBackoffMs) {
      await delay(backoffMs);
      const current = await this.store.get(original.service, original.connectionName);
      if (!current || current.id !== original.id || current.credential.authType !== "oauth2") {
        throw new ConnectionError(
          "connection_not_found",
          `${original.service} connection changed during OAuth refresh.`,
        );
      }
      if (current.credential.metadata.oauthDisconnectLease !== undefined) {
        throw new ConnectionError(
          "oauth_revocation_quarantined",
          `${original.service} OAuth revocation is in progress.`,
        );
      }
      const leaseValue = current.credential.metadata.oauthRefreshLease;
      if (leaseValue === undefined && current.credential.accessToken !== rejectedAccessToken) {
        return current.credential;
      }
      const lease = readOAuthLease(leaseValue);
      if (!lease || lease.phase === "outcome_unknown" || isStaleOAuthLease(lease)) {
        throw new ConnectionError(
          "oauth_refresh_quarantined",
          `${original.service} OAuth refresh has an unresolved provider outcome. Reconnect ${original.service}.`,
        );
      }
    }
    throw new ConnectionError("oauth_refresh_in_progress", `${original.service} OAuth refresh is still in progress.`);
  }

  private async runCredentialValidator(
    service: string,
    validate: CredentialValidatorCall,
  ): Promise<CredentialValidationResult> {
    try {
      return (await validate()) ?? {};
    } catch (error) {
      throw new ConnectionError(
        "credential_verification_failed",
        error instanceof Error ? error.message : `${service} credential verification failed.`,
      );
    }
  }

  private buildCredentialRuntimeData(
    provider: ProviderDefinition,
    authType: Exclude<AuthType, "no_auth">,
    credentialFields: CredentialDefinition[],
    credentialValues: Record<string, string>,
    validation: CredentialValidationResult,
  ): CredentialRuntimeData {
    return {
      profile: this.createCredentialProfile(provider, authType, credentialFields, credentialValues, validation),
      metadata: validation.metadata ?? {},
    };
  }

  private mergeCredentialRuntimeData(
    provider: ProviderDefinition,
    authType: Exclude<AuthType, "no_auth">,
    credential: Extract<ResolvedCredential, { authType: "oauth2" }>,
    validation: CredentialValidationResult,
  ): CredentialRuntimeData {
    return {
      profile: this.createCredentialProfile(provider, authType, [], {}, validation, {
        profile: credential.profile,
        metadata: credential.metadata,
      }),
      metadata: {
        ...credential.metadata,
        ...(validation.metadata ?? {}),
      },
    };
  }

  private createCredentialProfile(
    provider: ProviderDefinition,
    authType: Exclude<AuthType, "no_auth">,
    credentialFields: CredentialDefinition[],
    credentialValues: Record<string, string>,
    validation: CredentialValidationResult,
    previous?: PreviousCredentialRuntimeData,
  ): CredentialProfile {
    const accountId =
      validation.profile?.accountId ??
      readLegacyString(validation.metadata, "providerAccountId") ??
      readLegacyString(validation.metadata, "accountId") ??
      previous?.profile.accountId ??
      this.createDefaultAccountId(provider, authType, credentialFields, credentialValues);
    const displayName =
      validation.profile?.displayName ??
      readLegacyString(validation.metadata, "accountLabel") ??
      readLegacyString(validation.metadata, "displayName") ??
      previous?.profile.displayName ??
      this.createDefaultDisplayName(provider, authType);

    const grantedScopes =
      validation.profile?.grantedScopes ??
      validation.grantedScopes ??
      parseScopeString(readLegacyString(validation.metadata, "scope")) ??
      parseScopeString(readLegacyString(previous?.metadata, "scope")) ??
      previous?.profile.grantedScopes;

    return {
      accountId,
      displayName,
      grantedScopes: normalizeGrantedScopes(grantedScopes),
    };
  }

  private createNoAuthProfile(provider: ProviderDefinition): CredentialProfile {
    return {
      accountId: `${provider.service}:public`,
      displayName: `${provider.displayName} Public`,
      grantedScopes: [],
    };
  }

  private createDefaultAccountId(
    provider: ProviderDefinition,
    authType: Exclude<AuthType, "no_auth">,
    credentialFields: CredentialDefinition[],
    credentialValues: Record<string, string>,
  ): string {
    const publicFields = new Set(credentialFields.filter((field) => !field.secret).map((field) => field.key));
    const visibleValues = Object.entries(credentialValues)
      .filter(([key]) => publicFields.has(key))
      .map(([key, value]) => `${key}:${value}`);
    return visibleValues.length > 0
      ? `${provider.service}:${visibleValues.join(":")}`
      : `${provider.service}:${authType}`;
  }

  private createDefaultDisplayName(provider: ProviderDefinition, authType: Exclude<AuthType, "no_auth">): string {
    return `${provider.displayName} ${authType === "api_key" ? "API Key" : "Credential"}`;
  }
}

function isOAuthCredentialExpired(credential: Extract<ResolvedCredential, { authType: "oauth2" }>): boolean {
  if (!credential.expiresAt) {
    return false;
  }

  const expiresAt = Date.parse(credential.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now() + 60_000;
}

function createApiKeyFields(auth: ApiKeyAuthDefinition): CredentialDefinition[] {
  return [
    {
      key: "apiKey",
      label: auth.label ?? "API key",
      inputType: "password",
      required: true,
      secret: true,
      placeholder: auth.placeholder,
      description: auth.description,
    },
    ...(auth.extraFields ?? []),
  ];
}

export function normalizeConnectionName(value: string | undefined): string {
  const name = value?.trim() || defaultConnectionName;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    throw new ConnectionError(
      "invalid_connection_name",
      "connectionName must start with a letter or digit, contain only letters, digits, underscores, or hyphens, and be at most 64 characters.",
    );
  }

  return name;
}

function createConnectionId(service: string, connectionName: string): string {
  return `${service}:${connectionName}`;
}

function normalizeGrantedScopes(value: string[] | undefined): string[] {
  return [...new Set((value ?? []).map((scope) => scope.trim()).filter(Boolean))];
}

function parseScopeString(value: string | undefined): string[] | undefined {
  return value ? value.split(/[,\s]+/) : undefined;
}

function readOAuthLease(value: unknown): OAuthLease | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const lease = value as Record<string, unknown>;
  return typeof lease.owner === "string" &&
    (lease.phase === "pre_egress" || lease.phase === "provider_call" || lease.phase === "outcome_unknown") &&
    typeof lease.startedAt === "string"
    ? { owner: lease.owner, phase: lease.phase, startedAt: lease.startedAt }
    : undefined;
}

function isStaleOAuthLease(lease: OAuthLease): boolean {
  const startedAt = Date.parse(lease.startedAt);
  return !Number.isFinite(startedAt) || Date.now() - startedAt >= oauthLeaseMaxAgeMs;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function readLegacyString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Error with a stable code suitable for HTTP responses.
 */
export class ConnectionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
