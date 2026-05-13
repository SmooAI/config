/**
 * OAuth2 client_credentials token provider for @smooai/config runtime clients.
 *
 * Exchanges (clientId, clientSecret) for an access token against `{authUrl}/token`
 * and caches the JWT in memory until it's within `refreshWindowSec` of expiry.
 *
 * Parity with the .NET `TokenProvider` (dotnet/src/SmooAI.Config/OAuth/TokenProvider.cs)
 * and the bootstrap `mintAccessToken` (src/bootstrap/index.ts). Extracted from
 * ConfigClient so the same logic can be shared, mocked in tests, and reused by
 * other in-package callers.
 *
 * Server contract:
 *
 *     POST {authUrl}/token
 *     Content-Type: application/x-www-form-urlencoded
 *
 *     grant_type=client_credentials
 *     provider=client_credentials
 *     client_id=<uuid>
 *     client_secret=sk_...
 */

import fetch from '@smooai/fetch';

export interface TokenProviderOptions {
    /** OAuth issuer base URL (no trailing slash required). E.g. `https://auth.smoo.ai`. */
    authUrl: string;
    /** OAuth client ID. */
    clientId: string;
    /** OAuth client secret. */
    clientSecret: string;
    /**
     * How many seconds before expiry to proactively refresh the token. Defaults to 60s.
     * Matches the .NET TokenProvider default.
     */
    refreshWindowSec?: number;
}

interface CachedToken {
    accessToken: string;
    /** Unix seconds. */
    expiresAt: number;
}

export class TokenProvider {
    private readonly authUrl: string;
    private readonly clientId: string;
    private readonly clientSecret: string;
    private readonly refreshWindowSec: number;
    private cached?: CachedToken;
    private inflight?: Promise<string>;
    // Test seam — overridden in unit tests.
    private nowMs: () => number = () => Date.now();

    constructor(options: TokenProviderOptions) {
        if (!options.authUrl) throw new Error('@smooai/config: TokenProvider requires authUrl');
        if (!options.clientId) throw new Error('@smooai/config: TokenProvider requires clientId');
        if (!options.clientSecret) throw new Error('@smooai/config: TokenProvider requires clientSecret');
        this.authUrl = options.authUrl.replace(/\/+$/, '');
        this.clientId = options.clientId;
        this.clientSecret = options.clientSecret;
        this.refreshWindowSec = options.refreshWindowSec ?? 60;
    }

    /**
     * Returns a valid OAuth access token, refreshing from the server if cached
     * value is missing, expired, or within the refresh window.
     *
     * Concurrent callers during a refresh share a single in-flight request to
     * avoid duplicate token exchanges.
     */
    async getAccessToken(): Promise<string> {
        if (!this.shouldRefresh()) return this.cached!.accessToken;
        if (this.inflight) return this.inflight;
        this.inflight = this.refresh().finally(() => {
            this.inflight = undefined;
        });
        return this.inflight;
    }

    /**
     * Invalidate the cached token so the next call re-exchanges.
     * Used by callers that observe a 401 to retry once with a fresh token.
     */
    invalidate(): void {
        this.cached = undefined;
    }

    private shouldRefresh(): boolean {
        if (!this.cached) return true;
        const nowSec = Math.floor(this.nowMs() / 1000);
        return nowSec >= this.cached.expiresAt - this.refreshWindowSec;
    }

    private async refresh(): Promise<string> {
        const res = await fetch(`${this.authUrl}/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'client_credentials',
                provider: 'client_credentials',
                client_id: this.clientId,
                client_secret: this.clientSecret,
            }).toString(),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '<unreadable>');
            throw new Error(`@smooai/config: OAuth token exchange failed: HTTP ${res.status} ${body}`);
        }
        const body = (await res.json()) as { access_token?: string; expires_in?: number };
        if (!body.access_token) {
            throw new Error('@smooai/config: OAuth token endpoint returned no access_token');
        }
        const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
        const nowSec = Math.floor(this.nowMs() / 1000);
        this.cached = {
            accessToken: body.access_token,
            expiresAt: nowSec + expiresIn,
        };
        return body.access_token;
    }

    /** @internal test seam — overrides the time source. */
    _setNowForTests(now: () => number): void {
        this.nowMs = now;
    }
}
