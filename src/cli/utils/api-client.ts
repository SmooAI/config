/**
 * API client wrapper for CLI commands.
 *
 * SMOODEV-602: routes HTTP through `@smooai/fetch` so flaky-network retries,
 * 429 back-off, and clearer error surfaces apply to every CLI call.
 *
 * SMOODEV-643: adds OAuth2 client-credentials exchange. When credentials carry
 * a `clientId`/`clientSecret`, we mint an access token via auth.smoo.ai and
 * auto-refresh when it's within 60s of expiry. Legacy `apiKey` credentials are
 * still supported and used as a raw `Authorization: Bearer` header.
 */

import fetch from '@smooai/fetch';
import { isOAuthCredentials, saveCredentials, type Credentials, type OAuthCredentials } from './credentials';
import { exchangeClientCredentials, shouldRefreshToken } from './oauth';

export interface ConfigSchema {
    id: string;
    organizationId: string;
    name: string;
    description?: string | null;
    currentVersion: number;
    jsonSchema: Record<string, unknown>;
    createdBy: string;
    createdAt: string;
    updatedAt: string;
}

export interface ConfigEnvironment {
    id: string;
    organizationId: string;
    name: string;
    description?: string | null;
    createdBy: string;
    createdAt: string;
    updatedAt: string;
}

export interface PushVersionResponse {
    schema: ConfigSchema;
    version: {
        id: string;
        schemaId: string;
        version: number;
        jsonSchema: Record<string, unknown>;
        changeDescription?: string | null;
        pushedBy: string;
        pushedAt: string;
    };
}

export interface CliApiClientOptions {
    /**
     * Called after a successful token refresh so callers can persist the new
     * `accessToken` + `accessTokenExpiresAt` to disk. Defaults to writing
     * `~/.smooai/credentials.json` via `saveCredentials`.
     */
    onCredentialsChange?: (creds: Credentials) => void;
}

export class CliApiClient {
    private baseUrl: string;
    private orgId: string;
    private credentials: Credentials;
    private onCredentialsChange: (creds: Credentials) => void;

    constructor(credentials: Credentials, options: CliApiClientOptions = {}) {
        this.baseUrl = credentials.baseUrl.replace(/\/+$/, '');
        this.orgId = credentials.orgId;
        this.credentials = { ...credentials } as Credentials;
        this.onCredentialsChange = options.onCredentialsChange ?? ((c) => saveCredentials(c));
    }

    /** Return a shallow copy of the current credentials (including any refreshed token). */
    getCredentials(): Credentials {
        return { ...this.credentials } as Credentials;
    }

    private async ensureAccessToken(): Promise<string> {
        if (!isOAuthCredentials(this.credentials)) {
            // Legacy: apiKey is used directly.
            const apiKey = (this.credentials as { apiKey: string }).apiKey;
            if (!apiKey) throw new Error('Missing API key or OAuth client credentials');
            return apiKey;
        }

        const oauth = this.credentials;
        if (oauth.accessToken && !shouldRefreshToken(oauth.accessTokenExpiresAt)) {
            return oauth.accessToken;
        }

        const token = await exchangeClientCredentials({
            authUrl: oauth.authUrl,
            clientId: oauth.clientId,
            clientSecret: oauth.clientSecret,
        });

        const updated: OAuthCredentials = {
            ...oauth,
            accessToken: token.accessToken,
            accessTokenExpiresAt: token.expiresAt,
        };

        this.credentials = updated;
        try {
            this.onCredentialsChange(updated);
        } catch {
            // Non-fatal: we still have the in-memory token.
        }

        return token.accessToken;
    }

    private async fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
        const token = await this.ensureAccessToken();
        const response = await fetch(`${this.baseUrl}${path}`, {
            ...options,
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                ...options?.headers,
            },
        });
        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(`API error: HTTP ${response.status} ${response.statusText}${body ? ` — ${body}` : ''}`);
        }
        return response.json() as Promise<T>;
    }

    async listSchemas(): Promise<ConfigSchema[]> {
        return this.fetchJson<ConfigSchema[]>(`/organizations/${this.orgId}/config/schemas`);
    }

    async getSchema(schemaId: string): Promise<ConfigSchema> {
        return this.fetchJson<ConfigSchema>(`/organizations/${this.orgId}/config/schemas/${schemaId}`);
    }

    async createSchema(data: { name: string; jsonSchema: Record<string, unknown>; description?: string }): Promise<ConfigSchema> {
        return this.fetchJson<ConfigSchema>(`/organizations/${this.orgId}/config/schemas`, {
            method: 'POST',
            body: JSON.stringify(data),
        });
    }

    async pushSchemaVersion(schemaId: string, data: { jsonSchema: Record<string, unknown>; changeDescription?: string }): Promise<PushVersionResponse> {
        return this.fetchJson<PushVersionResponse>(`/organizations/${this.orgId}/config/schemas/${schemaId}/push`, {
            method: 'POST',
            body: JSON.stringify(data),
        });
    }

    async listEnvironments(): Promise<ConfigEnvironment[]> {
        return this.fetchJson<ConfigEnvironment[]>(`/organizations/${this.orgId}/config/environments`);
    }

    async getAllValues(environment: string): Promise<Record<string, unknown>> {
        // SMOODEV-643: the server may return wrapper envelopes like
        // `{ success: false, error: ... }` or legacy `{ values: ... }`. Surface
        // any explicit `success: false` as an error so debugging is loud, not
        // silent-empty-list.
        const result = await this.fetchJson<{ values?: Record<string, unknown>; success?: boolean; error?: string }>(
            `/organizations/${this.orgId}/config/values?environment=${encodeURIComponent(environment)}`,
        );
        if (result && typeof result === 'object' && result.success === false) {
            throw new Error(`API error: ${result.error ?? 'unknown error returned by values endpoint'}`);
        }
        return result.values ?? {};
    }

    async getValue(key: string, environment: string): Promise<unknown> {
        const result = await this.fetchJson<{ value: unknown }>(
            `/organizations/${this.orgId}/config/values/${encodeURIComponent(key)}?environment=${encodeURIComponent(environment)}`,
        );
        return result.value;
    }

    async setValue(data: { schemaId: string; environmentId: string; key: string; value: unknown; tier: string }): Promise<unknown> {
        return this.fetchJson(`/organizations/${this.orgId}/config/values`, {
            method: 'PUT',
            body: JSON.stringify(data),
        });
    }

    async getEnvironmentByName(envName: string): Promise<ConfigEnvironment | null> {
        const envs = await this.listEnvironments();
        return envs.find((e) => e.name === envName) ?? null;
    }

    async getSchemaByName(name: string): Promise<ConfigSchema | null> {
        const schemas = await this.listSchemas();
        return schemas.find((s) => s.name === name) ?? null;
    }
}
