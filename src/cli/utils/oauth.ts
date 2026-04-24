/**
 * OAuth2 client-credentials exchange against auth.smoo.ai.
 *
 * Server contract (SMOODEV-643):
 *   POST {authUrl}/token
 *   Content-Type: application/x-www-form-urlencoded
 *   Body: grant_type=client_credentials
 *         provider=client_credentials  (non-standard but required)
 *         client_id=<uuid>
 *         client_secret=sk_...
 *   Response: { access_token, token_type, expires_in }
 *
 * Uses native `fetch` rather than `@smooai/fetch` — the latter wraps non-2xx
 * responses in retry-happy error types which makes status handling noisy, and
 * auth failures shouldn't silently retry.
 */

export interface TokenExchangeResult {
    accessToken: string;
    /** Absolute epoch seconds when the token expires. */
    expiresAt: number;
    expiresIn: number;
    tokenType: string;
}

export interface TokenExchangeInput {
    authUrl: string;
    clientId: string;
    clientSecret: string;
}

/**
 * Exchange client credentials for an access token.
 * Throws with a descriptive message on network failure or non-2xx response.
 */
export async function exchangeClientCredentials({ authUrl, clientId, clientSecret }: TokenExchangeInput): Promise<TokenExchangeResult> {
    const body = new URLSearchParams({
        grant_type: 'client_credentials',
        provider: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
    });

    const tokenEndpoint = `${authUrl.replace(/\/+$/, '')}/token`;

    let response: Response;
    try {
        response = await fetch(tokenEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Token exchange failed: could not reach ${tokenEndpoint} (${msg}). Try: check your internet connection or --auth-url flag.`);
    }

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        if (response.status === 401 || response.status === 403) {
            throw new Error(
                `Token exchange rejected (HTTP ${response.status}): check --client-id and --client-secret are correct and belong to this organization.${
                    text ? ` Server said: ${text}` : ''
                }`,
            );
        }
        throw new Error(`Token exchange failed: HTTP ${response.status} ${response.statusText}${text ? ` — ${text}` : ''}`);
    }

    const json = (await response.json().catch(() => null)) as {
        access_token?: string;
        token_type?: string;
        expires_in?: number;
    } | null;

    if (!json?.access_token) {
        throw new Error(`Token exchange returned malformed response — missing access_token`);
    }

    const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3600;
    const nowSec = Math.floor(Date.now() / 1000);

    return {
        accessToken: json.access_token,
        tokenType: json.token_type ?? 'Bearer',
        expiresIn,
        expiresAt: nowSec + expiresIn,
    };
}

/**
 * Returns true when a stored access token needs to be refreshed — either
 * missing entirely or within the refresh window of expiry.
 */
export function shouldRefreshToken(expiresAt: number | undefined, refreshWindowSec = 60): boolean {
    if (!expiresAt) return true;
    const nowSec = Math.floor(Date.now() / 1000);
    return nowSec >= expiresAt - refreshWindowSec;
}
