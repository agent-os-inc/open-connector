import type { ConnectionService, OAuthConnectionReservation, StoredConnection } from "../connection-service.ts";
import type { OAuth2AuthDefinition } from "../core/types.ts";
import type { OAuthClientConfigService } from "./oauth-client-config-service.ts";

import { createHash, randomBytes } from "node:crypto";
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
}

export interface OAuthAuthorizationCompleteInput {
  state: string;
  code: string;
  /** Raw callback query values. Only provider-declared fields are consumed. */
  callbackParameters?: Record<string, string[]>;
}

/**
 * Short-lived OAuth state stored while the browser completes authorization.
 */
export type OAuthAuthorizationState = {
  service: string;
  connectionName?: string;
  state: string;
  createdAt: string;
  pkceCodeVerifier?: string;
};

/**
 * Storage contract for pending OAuth authorization states.
 */
export interface IOAuthStateStore {
  set(state: OAuthAuthorizationState): Promise<void>;
  take(state: string): Promise<OAuthAuthorizationState | undefined>;
}

/**
 * Coordinates localhost OAuth authorization and token exchange.
 */
export class OAuthFlowService {
  private readonly clientConfigs: OAuthClientConfigService;
  private readonly connections: ConnectionService;
  private readonly states: IOAuthStateStore;
  private readonly stateMaxAgeMs: number;

  constructor(input: {
    clientConfigs: OAuthClientConfigService;
    connections: ConnectionService;
    states: IOAuthStateStore;
    stateMaxAgeMs?: number;
  }) {
    this.clientConfigs = input.clientConfigs;
    this.connections = input.connections;
    this.states = input.states;
    this.stateMaxAgeMs = input.stateMaxAgeMs ?? 15 * 60 * 1000;
  }

  async startAuthorization(input: OAuthAuthorizationStartInput): Promise<OAuthAuthorizationStart> {
    const { service, connectionName } = input;
    this.connections.assertProviderAvailable(service);
    await this.connections.assertOAuthAliasAvailable(service, connectionName);
    const auth = this.clientConfigs.getOAuthDefinition(service);
    const authorizationScopes = resolveAuthorizationScopes(service, auth.scopes);
    const config = await this.clientConfigs.getConfig(service);
    if (!config) {
      throw new OAuthFlowError("oauth_client_config_required", `Configure an OAuth client for ${service} first.`);
    }

    const state = crypto.randomUUID();
    const pkceCodeVerifier = auth.pkce ? createPkceCodeVerifier() : undefined;
    await this.states.set({
      service,
      connectionName,
      state: digestOAuthState(state),
      createdAt: new Date().toISOString(),
      pkceCodeVerifier,
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
    const config = await this.clientConfigs.getConfig(pending.service);
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
    let tokenResponse: Awaited<ReturnType<typeof requestAuthorizationCodeToken>>;
    try {
      tokenResponse = await requestAuthorizationCodeToken({
        code: input.code,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        redirectUri: this.clientConfigs.expectedRedirectUri(pending.service),
        responseEnvelope: auth.tokenResponseEnvelope,
        tokenRequestFields: auth.tokenRequestFields,
        tokenEndpointAuthMethod: auth.tokenEndpointAuthMethod,
        tokenRequestFormat: auth.tokenRequestFormat,
        tokenUrl: this.clientConfigs.resolveEndpointUrl(pending.service, auth.tokenUrl, config),
        extraFields: createTokenExtraFields(pending),
        createError: (message) =>
          new OAuthFlowError(
            "oauth_token_exchange_failed",
            auth.redactTokenErrors ? "OAuth token exchange failed." : message,
          ),
      });
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
    const oauthCredential = {
      ...tokenResponse,
      ...(providerSecret ? { providerSecret } : {}),
      metadata: {
        ...tokenResponse.metadata,
        oauthClientId: config.clientId,
        oauthClientExtra: config.extra,
        oauthClientSecretExtra: config.secretExtra,
      },
    };

    if (reservation) {
      await this.completeReservedAuthorization(pending.service, oauthCredential, reservation, auth.revocationMode);
    } else {
      try {
        await this.connections.setOAuthCredential(pending.service, oauthCredential, pending.connectionName);
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

  /** Consume a pending state when the provider returns an error or malformed callback. */
  async discardAuthorization(state: string | undefined): Promise<void> {
    if (state) await this.states.take(digestOAuthState(state));
  }

  private async completeReservedAuthorization(
    service: string,
    credential: Extract<Awaited<ReturnType<typeof requestAuthorizationCodeToken>>, { authType: "oauth2" }>,
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

function resolveAuthorizationScopes(service: string, declaredScopes: string[]): string[] {
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
  callbackParameters: Record<string, string[]> | undefined,
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

    const values = callbackParameters?.[field.parameter] ?? [];
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

function createTokenExtraFields(state: OAuthAuthorizationState): Record<string, string> | undefined {
  if (!state.pkceCodeVerifier) {
    return undefined;
  }

  return {
    code_verifier: state.pkceCodeVerifier,
  };
}

function isExpiredOAuthState(state: OAuthAuthorizationState, maxAgeMs: number): boolean {
  const createdAt = Date.parse(state.createdAt);
  return !Number.isFinite(createdAt) || Date.now() - createdAt > maxAgeMs;
}

function createPkceCodeVerifier(): string {
  return encodeBase64Url(randomBytes(48));
}

function createPkceCodeChallenge(codeVerifier: string): string {
  return encodeBase64Url(createHash("sha256").update(codeVerifier).digest());
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
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
