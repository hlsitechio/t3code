/**
 * GitHub OAuth Device Flow implementation.
 *
 * Implements the standard GitHub device authorization grant:
 * 1. Request a device code from GitHub
 * 2. Return user_code + verification_uri to the client
 * 3. Poll GitHub for token exchange while user authorizes
 * 4. Return the access token on success
 *
 * @see https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
 */

// GitHub OAuth App client ID for T3Code (public by design — not a secret).
// Device Flow apps do not use a client_secret per RFC 8628.
// Override via the clientId parameter for self-hosted deployments.
const GITHUB_CLIENT_ID = "Ov23liUkPZWQWkOyadxd";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const SCOPES = "repo read:org read:user";

export interface GitHubDeviceCodeResult {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export interface GitHubDeviceFlowTokenResult {
  accessToken: string;
  tokenType: string;
  scope: string;
}

/**
 * Request a device code from GitHub.
 * Returns both the device_code (kept server-side) and user_code (shown to user).
 */
export async function requestGitHubDeviceCode(
  clientId?: string,
): Promise<GitHubDeviceCodeResult> {
  const effectiveClientId = clientId || GITHUB_CLIENT_ID;

  const response = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: effectiveClientId,
      scope: SCOPES,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub device code request failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    expires_in?: number;
    interval?: number;
  };

  if (!data.user_code || !data.device_code) {
    throw new Error("GitHub returned an invalid device code response.");
  }

  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri ?? "https://github.com/login/device",
    expiresIn: data.expires_in ?? 900,
    interval: data.interval ?? 5,
  };
}

/**
 * Poll GitHub for the access token after the user has entered their code.
 * Resolves when the user completes authorization or rejects on expiry/error.
 */
export async function pollGitHubDeviceFlow(
  deviceCode: string,
  interval: number,
  expiresIn: number,
  clientId?: string,
): Promise<GitHubDeviceFlowTokenResult> {
  const effectiveClientId = clientId || GITHUB_CLIENT_ID;
  const expiresAt = Date.now() + expiresIn * 1000;
  let pollIntervalMs = Math.max(interval, 5) * 1000;

  return new Promise<GitHubDeviceFlowTokenResult>((resolve, reject) => {
    const poll = async () => {
      if (Date.now() >= expiresAt) {
        reject(new Error("Device code expired. Please restart the authorization flow."));
        return;
      }

      try {
        const response = await fetch(ACCESS_TOKEN_URL, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            client_id: effectiveClientId,
            device_code: deviceCode,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          }),
        });

        const data = (await response.json()) as {
          access_token?: string;
          token_type?: string;
          scope?: string;
          error?: string;
          error_description?: string;
          interval?: number;
        };

        if (data.access_token) {
          resolve({
            accessToken: data.access_token,
            tokenType: data.token_type ?? "bearer",
            scope: data.scope ?? "",
          });
          return;
        }

        if (data.error === "authorization_pending") {
          setTimeout(poll, pollIntervalMs);
          return;
        }

        if (data.error === "slow_down") {
          pollIntervalMs += 5000;
          setTimeout(poll, pollIntervalMs);
          return;
        }

        if (data.error === "expired_token") {
          reject(new Error("Device code expired. Please restart the authorization flow."));
          return;
        }

        if (data.error === "access_denied") {
          reject(new Error("Authorization was denied by the user."));
          return;
        }

        reject(
          new Error(
            data.error_description ?? data.error ?? "Unknown error during GitHub authorization.",
          ),
        );
      } catch {
        // Network error — retry after interval
        setTimeout(poll, pollIntervalMs);
      }
    };

    setTimeout(poll, pollIntervalMs);
  });
}
