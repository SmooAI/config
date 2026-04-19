/**
 * API client wrapper for CLI commands.
 * Extends ConfigClient with schema and environment management methods.
 */

import fetch from '@smooai/fetch';
import { type Credentials } from './credentials';

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

export class CliApiClient {
    private baseUrl: string;
    private apiKey: string;
    private orgId: string;

    constructor(credentials: Credentials) {
        this.baseUrl = credentials.baseUrl.replace(/\/+$/, '');
        this.apiKey = credentials.apiKey;
        this.orgId = credentials.orgId;
    }

    private async fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
        const response = await fetch(`${this.baseUrl}${path}`, {
            ...options,
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
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
        const result = await this.fetchJson<{ values: Record<string, unknown> }>(
            `/organizations/${this.orgId}/config/values?environment=${encodeURIComponent(environment)}`,
        );
        return result.values;
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
