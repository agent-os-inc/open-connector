import type { ResolvedCredential } from "../core/types.ts";
import type { OAuthClientConfigService } from "./oauth-client-config-service.ts";

import { ConnectionError } from "../connection-service.ts";
import { providerFetch } from "../providers/provider-runtime.ts";
import { requestRefreshToken } from "./oauth-token.ts";

type OAuthCredential = Extract<ResolvedCredential, { authType: "oauth2" }>;

export interface IOAuthCredentialRefresher {
  preflightRefresh?(service: string, credential: OAuthCredential): Promise<void>;
  refresh(service: string, credential: OAuthCredential): Promise<OAuthCredential>;
  preflightRevoke?(service: string, credential: OAuthCredential): Promise<void>;
  revoke?(service: string, credential: OAuthCredential): Promise<void>;
}

/**
 * Refreshes stored OAuth credentials using the user-provided local OAuth app.
 */
export class OAuthCredentialRefreshService implements IOAuthCredentialRefresher {
  private readonly clientConfigs: OAuthClientConfigService;

  constructor(clientConfigs: OAuthClientConfigService) {
    this.clientConfigs = clientConfigs;
  }

  async preflightRefresh(service: string, credential: OAuthCredential): Promise<void> {
    this.clientConfigs.getOAuthDefinition(service);
    if (!credential.refreshToken) {
      throw new ConnectionError("oauth_token_expired", `${service} OAuth refresh token is unavailable.`);
    }
    const config = await this.clientConfigs.getConfig(service);
    if (!config) {
      throw new ConnectionError(
        "oauth_client_config_required",
        `Configure an OAuth client for ${service} before refreshing its token.`,
      );
    }
    assertMatchingOAuthClient(service, credential, config.clientId);
  }

  async preflightRevoke(service: string, credential: OAuthCredential): Promise<void> {
    const auth = this.clientConfigs.getOAuthDefinition(service);
    if (!auth.revocationUrl) {
      throw new ConnectionError("oauth_revocation_unavailable", `${service} OAuth revocation is unavailable.`);
    }
    if (!credential.refreshToken && !credential.accessToken) {
      throw new ConnectionError("oauth_revocation_unavailable", `${service} OAuth token is unavailable.`);
    }
    const config = await this.clientConfigs.getConfig(service);
    if (!config) {
      throw new ConnectionError("oauth_client_config_required", `Configure an OAuth client for ${service} first.`);
    }
    assertMatchingOAuthClient(service, credential, config.clientId);
  }

  async refresh(service: string, credential: OAuthCredential): Promise<OAuthCredential> {
    const auth = this.clientConfigs.getOAuthDefinition(service);
    const config = await this.clientConfigs.getConfig(service);
    if (!config) {
      throw new ConnectionError(
        "oauth_client_config_required",
        `Configure an OAuth client for ${service} before refreshing its token.`,
      );
    }
    assertMatchingOAuthClient(service, credential, config.clientId);

    const refreshed = await requestRefreshToken({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      responseEnvelope: auth.tokenResponseEnvelope,
      refreshToken: credential.refreshToken ?? "",
      tokenRequestFields: auth.tokenRequestFields,
      tokenEndpointAuthMethod: auth.tokenEndpointAuthMethod,
      tokenRequestFormat: auth.tokenRequestFormat,
      tokenUrl: this.clientConfigs.resolveEndpointUrl(service, auth.refreshTokenUrl ?? auth.tokenUrl, config),
      createError: (message) =>
        new ConnectionError(
          "oauth_token_refresh_failed",
          auth.redactTokenErrors ? "OAuth token refresh failed." : message,
        ),
    });

    return {
      ...refreshed,
      refreshToken: refreshed.refreshToken ?? credential.refreshToken,
      providerSecret: credential.providerSecret,
      profile: credential.profile,
      metadata: {
        ...credential.metadata,
        ...refreshed.metadata,
        refreshedAt: new Date().toISOString(),
      },
    };
  }

  async revoke(service: string, credential: OAuthCredential): Promise<void> {
    const auth = this.clientConfigs.getOAuthDefinition(service);
    if (!auth.revocationUrl) {
      throw new ConnectionError("oauth_revocation_unavailable", `${service} OAuth revocation is unavailable.`);
    }
    const config = await this.clientConfigs.getConfig(service);
    if (!config) {
      throw new ConnectionError("oauth_client_config_required", `Configure an OAuth client for ${service} first.`);
    }
    assertMatchingOAuthClient(service, credential, config.clientId);
    const token = credential.refreshToken ?? credential.accessToken;
    let response: Response;
    try {
      response = await providerFetch(this.clientConfigs.resolveEndpointUrl(service, auth.revocationUrl, config), {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Basic ${Buffer.from(`${encodeOAuthBasicCredential(config.clientId)}:${encodeOAuthBasicCredential(config.clientSecret)}`).toString("base64")}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ token }),
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new ConnectionError("oauth_revocation_quarantined", `${service} OAuth revocation outcome is unknown.`);
    }
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) {
      throw new ConnectionError("oauth_revocation_failed", `${service} OAuth revocation failed.`);
    }
  }
}

function encodeOAuthBasicCredential(value: string): string {
  return new URLSearchParams({ value }).toString().slice("value=".length);
}

function assertMatchingOAuthClient(service: string, credential: OAuthCredential, currentClientId: string): void {
  if (credential.metadata.oauthClientId !== currentClientId) {
    throw new ConnectionError(
      "oauth_client_mismatch",
      `${service} OAuth client identity changed; reconnect before token operations.`,
    );
  }
}
