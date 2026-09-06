import type { ConnectionService, OAuthConnectionReservation, StoredConnection } from "../connection-service.ts";
import type { OAuth2AuthDefinition } from "../core/types.ts";
import type { IProviderLoader } from "../providers/provider-loader.ts";
import type { ISecretCodec } from "../server/secrets/secret-codec-core.ts";
import type {
  OAuthClientConfig,
  OAuthClientConfigInput,
  OAuthClientConfigService,
} from "./oauth-client-config-service.ts";
import type { OAuthTokenResult } from "./oauth-token.ts";

import { createHash, randomBytes } from "node:crypto";
import { providerFetch } from "../providers/provider-runtime.ts";
import { isDefinitiveOAuthTokenFailure, requestAuthorizationCodeToken } from "./oauth-token.ts";

const gmailReadonlyScope = "https://www.googleapis.com/auth/gmail.readonly";

/**
 * Started OAuth authorization flow returned to the local console.
 */
export type OAuthAuthorizationStart = {
  authorizationUrl: string;
  state: string;
};

export interface OAuthAuthorizationStartInput {
  service: string;
  connectionName?: string;
  clientConfig?: OAuthClientConfigInput;
  authorizationOptionIds?: string[];
}

export interface OAuthAuthorizationCompleteInput {
  state: string;
  code: string;
  callbackParameters?: Record<string, string | string[]>;
  signal?: AbortSignal;
}

/**
 * Short-lived OAuth state stored while the browser completes authorization.
 */
export interface OAuthAuthorizationState {
  service: string;
  connectionName?: string;
  state: string;
  createdAt: string;
  pkceCodeVerifier?: string;
  authorizationScopes?: string[];
  clientConfig?: OAuthClientConfig;
}

export interface OAuthFlowServiceOptions {
  clientConfigs: OAuthClientConfigService;
  connections: ConnectionService;
  providerLoader: IProviderLoader;
  states: IOAuthStateStore;
  stateMaxAgeMs?: number;
  secretCodec?: ISecretCodec;
  isCustomClientConfigAllowed?: (service: string) => boolean;
}

/**
 * Storage contract for pending OAuth authorization states.
 */
export interface IOAuthStateStore {
  /** Deletes states whose creation timestamp is earlier than the cutoff. */
  deleteCreatedBefore(cutoff: string): Promise<void>;
  set(state: OAuthAuthorizationState): Promise<void>;
  take(state: string): Promise<OAuthAuthorizationState | undefined>;
}

/**
 * Coordinates runtime OAuth authorization and token exchange.
 */
export class OAuthFlowService {
  private readonly clientConfigs: OAuthClientConfigService;
  private readonly connections: ConnectionService;
  private readonly providerLoader: IProviderLoader;
  private readonly states: IOAuthStateStore;
  private readonly stateMaxAgeMs: number;
  private readonly secretCodec?: ISecretCodec;
  private readonly isCustomClientConfigAllowed: (service: string) => boolean;

  constructor(input: OAuthFlowServiceOptions) {
    this.clientConfigs = input.clientConfigs;
    this.connections = input.connections;
    this.providerLoader = input.providerLoader;
    this.states = input.states;
    this.stateMaxAgeMs = input.stateMaxAgeMs ?? 15 * 60 * 1000;
    this.secretCodec = input.secretCodec;
    this.isCustomClientConfigAllowed = input.isCustomClientConfigAllowed ?? (() => false);
  }

  async startAuthorization(input: OAuthAuthorizationStartInput): Promise<OAuthAuthorizationStart> {
    const { service, connectionName } = input;
    this.connections.assertProviderAvailable(service);
    await this.connections.assertOAuthAliasAvailable(service, connectionName);
    const auth = this.clientConfigs.getOAuthDefinition(service);
    const config = input.clientConfig
      ? this.resolveCustomClientConfig(service, input.clientConfig)
      : await this.clientConfigs.getConfig(service);
    if (!config) {
      throw new OAuthFlowError("oauth_client_config_required", `Configure an OAuth client for ${service} first.`);
    }

    const now = new Date();
    const state = crypto.randomUUID();
    const pkceCodeVerifier = auth.pkce ? createPkceCodeVerifier() : undefined;
    await this.states.deleteCreatedBefore(new Date(now.getTime() - this.stateMaxAgeMs).toISOString());
    const selectedScopes = resolveAuthorizationScopes(
      auth,
      input.authorizationOptionIds,
      this.clientConfigs.getEffectiveScopes(service, config),
    );
    const authorizationScopes = resolveAgentOSAuthorizationScopes(service, selectedScopes);
    await this.states.set({
      service,
      connectionName,
      state: digestOAuthState(state),
      createdAt: now.toISOString(),
      pkceCodeVerifier,
      authorizationScopes: auth.authorizationOptions ? authorizationScopes : undefined,
      clientConfig: input.clientConfig ? config : undefined,
    });

    const authorizationUrl = new URL(this.clientConfigs.resolveEndpointUrl(service, auth.authorizationUrl, config));
    for (const [key, value] of Object.entries(auth.authorizationParams ?? {})) {
      authorizationUrl.searchParams.set(key, value);
    }
    setAuthorizationParam(authorizationUrl, auth.authorizationRequestFields?.clientId, "client_id", config.clientId);
    setAuthorizationParam(
      authorizationUrl,
      auth.authorizationRequestFields?.redirectUri,
      "redirect_uri",
      this.clientConfigs.expectedRedirectUri(service),
    );
    setAuthorizationParam(authorizationUrl, auth.authorizationRequestFields?.responseType, "response_type", "code");
    setAuthorizationParam(authorizationUrl, auth.authorizationRequestFields?.state, "state", state);
    if (authorizationScopes.length > 0 && auth.authorizationRequestFields?.scope !== false) {
      authorizationUrl.searchParams.set(
        auth.authorizationRequestFields?.scope ?? "scope",
        authorizationScopes.join(auth.scopeSeparator ?? " "),
      );
    }
    if (pkceCodeVerifier) {
      authorizationUrl.searchParams.set("code_challenge", createPkceCodeChallenge(pkceCodeVerifier));
      authorizationUrl.searchParams.set("code_challenge_method", auth.pkce?.method ?? "S256");
    }

    return {
      authorizationUrl: authorizationUrl.toString(),
      state,
    };
  }

  async completeAuthorization(input: OAuthAuthorizationCompleteInput): Promise<{ service: string; connected: true }> {
    const pending = await this.states.take(digestOAuthState(input.state));
    if (!pending) {
      throw new OAuthFlowError("invalid_oauth_state", "OAuth state is missing or expired.");
    }
    if (isExpiredOAuthState(pending, this.stateMaxAgeMs)) {
      throw new OAuthFlowError("invalid_oauth_state", "OAuth state is missing or expired.");
    }

    const auth = this.clientConfigs.getOAuthDefinition(pending.service);
    const providerSecret = readCallbackCredentialFields(auth.callbackCredentialFields, input.callbackParameters);
    const config = pending.clientConfig ?? (await this.clientConfigs.getConfig(pending.service));
    if (!config) {
      throw new OAuthFlowError(
        "oauth_client_config_required",
        `Configure an OAuth client for ${pending.service} first.`,
      );
    }

    let reservation =
      auth.connectionWriteMode === "create_only"
        ? await this.connections.reserveOAuthCredential(pending.service, pending.connectionName)
        : undefined;
    if (reservation) reservation = await this.connections.markOAuthReservationEgress(reservation);
    const redirectUri = this.clientConfigs.expectedRedirectUri(pending.service);
    const tokenUrl = this.clientConfigs.resolveEndpointUrl(pending.service, auth.tokenUrl, config);
    const createError = (message: string): OAuthFlowError =>
      new OAuthFlowError(
        "oauth_token_exchange_failed",
        auth.redactTokenErrors ? "OAuth token exchange failed." : message,
      );
    const providerOAuth = await this.providerLoader.loadProviderOAuthRuntime?.(pending.service);
    let tokenResponse: OAuthTokenResult;
    try {
      if (providerOAuth?.exchangeCode) {
        tokenResponse = await providerOAuth.exchangeCode({
          code: input.code,
          clientConfig: config,
          redirectUri,
          tokenUrl,
          fetcher: providerFetch,
          signal: input.signal,
          createError,
        });
      } else {
        tokenResponse = await requestAuthorizationCodeToken({
          code: input.code,
          state: input.state,
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          redirectUri,
          responseEnvelope: auth.tokenResponseEnvelope,
          tokenRequestFields: auth.tokenRequestFields,
          tokenEndpointAuthMethod: auth.tokenEndpointAuthMethod,
          tokenRequestFormat: auth.tokenRequestFormat,
          tokenUrl,
          extraFields: createTokenExtraFields(pending, auth.tokenRequestCallbackParameters, input.callbackParameters),
          signal: input.signal,
          createError,
        });
      }
    } catch (error) {
      if (reservation) {
        if (isDefinitiveOAuthTokenFailure(error)) {
          await this.connections.discardReservedOAuthCredential(reservation.connection);
        } else {
          await this.connections.quarantineReservedOAuthCredential(reservation.connection);
        }
      }
      throw error;
    }
    const refreshParameters = readCallbackParameters(auth.tokenRequestCallbackParameters, input.callbackParameters);
    const oauthCredential = {
      authType: "oauth2" as const,
      ...tokenResponse,
      profile: {
        accountId: "oauth2",
        displayName: "OAuth Credential",
        grantedScopes: pending.authorizationScopes ?? [],
      },
      providerSecret:
        Object.keys(refreshParameters).length > 0
          ? { ...providerSecret, oauthRefreshParameters: refreshParameters }
          : providerSecret,
      metadata: {
        ...tokenResponse.metadata,
        oauthClientId: config.clientId,
        oauthClientExtra: config.extra,
        oauthClientSecretExtra: config.secretExtra,
        oauthClientConfig: pending.clientConfig ? config : undefined,
      },
    };

    if (reservation) {
      await this.completeReservedAuthorization(pending.service, oauthCredential, reservation, auth.revocationMode);
    } else {
      try {
        await this.connections.setOAuthCredential(
          pending.service,
          oauthCredential,
          pending.connectionName,
          input.signal,
        );
      } catch (error) {
        if (auth.revocationMode !== "required") throw error;
        try {
          await this.connections.revokeUnstoredOAuthCredential(pending.service, oauthCredential);
        } catch {
          throw new OAuthFlowError(
            "oauth_compensating_revocation_failed",
            "OAuth connection could not be stored and its issued credential could not be safely revoked.",
          );
        }
        throw error;
      }
    }
    return {
      service: pending.service,
      connected: true,
    };
  }

  private resolveCustomClientConfig(service: string, input: OAuthClientConfigInput): OAuthClientConfig {
    if (!this.isCustomClientConfigAllowed(service)) {
      throw new OAuthFlowError(
        "oauth_custom_app_not_allowed",
        `Custom OAuth apps are not enabled for ${service} on this runtime.`,
      );
    }
    if (!this.secretCodec?.encrypted) {
      throw new OAuthFlowError(
        "oauth_custom_app_encryption_required",
        "Configure OOMOL_CONNECT_ENCRYPTION_KEY before using a custom OAuth app.",
      );
    }
    return this.clientConfigs.normalizeConfig(service, input);
  }

  /** Consume a pending state when the provider returns an error or malformed callback. */
  async discardAuthorization(state: string | undefined): Promise<void> {
    if (state) await this.states.take(digestOAuthState(state));
  }

  private async completeReservedAuthorization(
    service: string,
    credential: Extract<import("../core/types.ts").ResolvedCredential, { authType: "oauth2" }>,
    reservation: OAuthConnectionReservation,
    revocationMode: "delete_only" | "required" | undefined,
  ): Promise<void> {
    let staged: StoredConnection;
    try {
      staged = await this.connections.stageReservedOAuthCredential(reservation, credential);
    } catch (error) {
      if (revocationMode !== "required") throw error;
      try {
        await this.connections.revokeUnstoredOAuthCredential(service, credential);
        await this.connections.discardReservedOAuthCredential(reservation.connection);
      } catch {
        throw new OAuthFlowError(
          "oauth_compensating_revocation_failed",
          "OAuth connection could not be staged and its issued credential could not be safely revoked.",
        );
      }
      throw error;
    }
    try {
      await this.connections.activateReservedOAuthCredential(staged);
    } catch (error) {
      if (revocationMode !== "required") throw error;
      try {
        await this.connections.revokeUnstoredOAuthCredential(service, credential);
        await this.connections.discardReservedOAuthCredential(staged);
      } catch {
        await this.connections.quarantineReservedOAuthCredential(staged);
        throw new OAuthFlowError(
          "oauth_compensating_revocation_failed",
          "OAuth connection could not be stored and its issued credential could not be safely revoked.",
        );
      }
      throw error;
    }
  }
}

function resolveAgentOSAuthorizationScopes(service: string, declaredScopes: string[]): string[] {
  if (service !== "gmail") {
    return declaredScopes;
  }
  if (!declaredScopes.includes(gmailReadonlyScope)) {
    throw new OAuthFlowError(
      "invalid_oauth_definition",
      `Gmail OAuth must declare the required read-only scope ${gmailReadonlyScope}.`,
    );
  }
  return [gmailReadonlyScope];
}

function readCallbackCredentialFields(
  fields: OAuth2AuthDefinition["callbackCredentialFields"],
  callbackParameters: Record<string, string | string[]> | undefined,
): Record<string, string> | undefined {
  if (!fields?.length) {
    return undefined;
  }

  const result: Record<string, string> = {};
  const seenKeys = new Set<string>();
  for (const field of fields) {
    if (!field.parameter || !field.key || seenKeys.has(field.key)) {
      throw new OAuthFlowError("invalid_oauth_definition", "OAuth callback credential fields are invalid.");
    }
    seenKeys.add(field.key);

    const raw = callbackParameters?.[field.parameter];
    const values = typeof raw === "string" ? [raw] : (raw ?? []);
    if (values.length > 1) {
      throw new OAuthFlowError("invalid_oauth_callback", `OAuth callback parameter ${field.parameter} is ambiguous.`);
    }
    const value = values[0]?.trim();
    if (!value) {
      if (field.required) {
        throw new OAuthFlowError("invalid_oauth_callback", `OAuth callback requires ${field.parameter}.`);
      }
      continue;
    }
    if (value.length > (field.maxLength ?? 255)) {
      throw new OAuthFlowError("invalid_oauth_callback", `OAuth callback parameter ${field.parameter} is invalid.`);
    }
    if (field.pattern) {
      let pattern: RegExp;
      try {
        pattern = new RegExp(field.pattern, "u");
      } catch {
        throw new OAuthFlowError("invalid_oauth_definition", "OAuth callback credential fields are invalid.");
      }
      if (!pattern.test(value)) {
        throw new OAuthFlowError("invalid_oauth_callback", `OAuth callback parameter ${field.parameter} is invalid.`);
      }
    }
    result[field.key] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function setAuthorizationParam(
  url: URL,
  fieldName: string | false | undefined,
  defaultFieldName: string,
  value: string,
): void {
  if (fieldName !== false) {
    url.searchParams.set(fieldName ?? defaultFieldName, value);
  }
}

function digestOAuthState(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

function createTokenExtraFields(
  state: OAuthAuthorizationState,
  parameterNames: readonly string[] | undefined,
  callbackParameters: Record<string, string | string[]> | undefined,
): Record<string, string> | undefined {
  const fields = readCallbackParameters(parameterNames, callbackParameters);
  if (state.pkceCodeVerifier) fields.code_verifier = state.pkceCodeVerifier;
  return Object.keys(fields).length > 0 ? fields : undefined;
}

function readCallbackParameters(
  parameterNames: readonly string[] | undefined,
  values: Record<string, string | string[]> | undefined,
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const name of parameterNames ?? []) {
    const raw = values?.[name];
    if (Array.isArray(raw) && raw.length > 1)
      throw new OAuthFlowError("invalid_oauth_callback", "OAuth callback parameter is ambiguous.");
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value) fields[name] = value;
  }
  return fields;
}

function isExpiredOAuthState(state: OAuthAuthorizationState, maxAgeMs: number): boolean {
  const createdAt = Date.parse(state.createdAt);
  return !Number.isFinite(createdAt) || Date.now() - createdAt > maxAgeMs;
}

function createPkceCodeVerifier(): string {
  return randomBytes(48).toString("base64url");
}

function createPkceCodeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

function resolveAuthorizationScopes(
  auth: OAuth2AuthDefinition,
  optionIds: string[] | undefined,
  fallback: string[],
): string[] {
  const options = auth.authorizationOptions;
  if (!options) return fallback;
  if (optionIds === undefined) return fallback;
  const byId = new Map(options.map((option) => [option.id, option]));
  const selected = new Set(optionIds);
  for (const option of options) if (option.required) selected.add(option.id);
  for (const id of selected) {
    const option = byId.get(id);
    if (!option) throw new OAuthFlowError("invalid_input", `Unknown OAuth authorization option: ${id}.`);
    for (const required of option.requires ?? []) selected.add(required);
  }
  return options.filter((option) => selected.has(option.id)).map((option) => option.id);
}

/**
 * Error with a stable code suitable for HTTP responses.
 */
export class OAuthFlowError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
