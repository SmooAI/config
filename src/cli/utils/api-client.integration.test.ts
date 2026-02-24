import { CliApiClient, type ConfigEnvironment, type ConfigSchema, type PushVersionResponse } from '@/cli/utils/api-client';
/**
 * Integration tests for the CliApiClient using MSW (Mock Service Worker).
 *
 * These tests verify the client's behavior against a realistic mock of the
 * Smoo AI config API, including authentication, schema CRUD, environment
 * management, value operations, error handling, and helper methods.
 */
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------
const BASE_URL = 'https://config.smooai.test';
const API_KEY = 'test-api-key-12345';
const ORG_ID = '550e8400-e29b-41d4-a716-446655440000';
const SCHEMA_ID = 'schema-001';
const ENV_ID = 'env-001';

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------
const MOCK_SCHEMA: ConfigSchema = {
    id: SCHEMA_ID,
    organizationId: ORG_ID,
    name: 'app-settings',
    description: 'Application settings schema',
    currentVersion: 1,
    jsonSchema: {
        type: 'object',
        properties: {
            API_URL: { type: 'string' },
            MAX_RETRIES: { type: 'number' },
            DEBUG: { type: 'boolean' },
        },
        required: ['API_URL'],
    },
    createdBy: 'user-001',
    createdAt: '2025-01-15T10:00:00.000Z',
    updatedAt: '2025-01-15T10:00:00.000Z',
};

const MOCK_SCHEMA_2: ConfigSchema = {
    id: 'schema-002',
    organizationId: ORG_ID,
    name: 'feature-flags',
    description: 'Feature flag configuration',
    currentVersion: 3,
    jsonSchema: {
        type: 'object',
        properties: {
            DARK_MODE: { type: 'boolean' },
            BETA_FEATURES: { type: 'boolean' },
        },
    },
    createdBy: 'user-002',
    createdAt: '2025-02-01T12:00:00.000Z',
    updatedAt: '2025-02-10T08:30:00.000Z',
};

const MOCK_ENVIRONMENT: ConfigEnvironment = {
    id: ENV_ID,
    organizationId: ORG_ID,
    name: 'production',
    description: 'Production environment',
    createdBy: 'user-001',
    createdAt: '2025-01-10T09:00:00.000Z',
    updatedAt: '2025-01-10T09:00:00.000Z',
};

const MOCK_ENVIRONMENT_2: ConfigEnvironment = {
    id: 'env-002',
    organizationId: ORG_ID,
    name: 'staging',
    description: 'Staging environment',
    createdBy: 'user-001',
    createdAt: '2025-01-10T09:00:00.000Z',
    updatedAt: '2025-01-10T09:00:00.000Z',
};

const MOCK_ENVIRONMENT_3: ConfigEnvironment = {
    id: 'env-003',
    organizationId: ORG_ID,
    name: 'development',
    description: null,
    createdBy: 'user-002',
    createdAt: '2025-01-10T09:00:00.000Z',
    updatedAt: '2025-01-10T09:00:00.000Z',
};

const MOCK_VALUES: Record<string, unknown> = {
    API_URL: 'https://api.smooai.com',
    MAX_RETRIES: 3,
    DEBUG: false,
    NESTED_CONFIG: { database: { host: 'db.prod.smooai.com', port: 5432 } },
};

const MOCK_PUSH_VERSION_RESPONSE: PushVersionResponse = {
    schema: {
        ...MOCK_SCHEMA,
        currentVersion: 2,
        updatedAt: '2025-01-20T14:00:00.000Z',
    },
    version: {
        id: 'version-002',
        schemaId: SCHEMA_ID,
        version: 2,
        jsonSchema: {
            type: 'object',
            properties: {
                API_URL: { type: 'string' },
                MAX_RETRIES: { type: 'number' },
                DEBUG: { type: 'boolean' },
                TIMEOUT_MS: { type: 'number' },
            },
            required: ['API_URL'],
        },
        changeDescription: 'Added TIMEOUT_MS field',
        pushedBy: 'user-001',
        pushedAt: '2025-01-20T14:00:00.000Z',
    },
};

// ---------------------------------------------------------------------------
// Request logging for verification
// ---------------------------------------------------------------------------
let requestLog: { method: string; url: string; body?: unknown; timestamp: number }[] = [];

function logRequest(method: string, url: string, body?: unknown) {
    requestLog.push({ method, url, body, timestamp: Date.now() });
}

function getRequestCount(pathPattern?: string): number {
    if (!pathPattern) return requestLog.length;
    return requestLog.filter((r) => r.url.includes(pathPattern)).length;
}

// ---------------------------------------------------------------------------
// Auth and org validation helpers
// ---------------------------------------------------------------------------
function validateAuth(request: Request): ReturnType<typeof HttpResponse.json> | null {
    const auth = request.headers.get('Authorization');
    if (auth !== `Bearer ${API_KEY}`) {
        return HttpResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return null;
}

function validateOrg(orgId: string | readonly string[]): ReturnType<typeof HttpResponse.json> | null {
    if (orgId !== ORG_ID) {
        return HttpResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    return null;
}

// ---------------------------------------------------------------------------
// MSW Handlers
// ---------------------------------------------------------------------------
const handlers = [
    // --- Schema endpoints ---

    // List schemas: GET /organizations/:orgId/config/schemas
    http.get(`${BASE_URL}/organizations/:orgId/config/schemas`, ({ request, params }) => {
        logRequest('GET', request.url);

        const authError = validateAuth(request);
        if (authError) return authError;

        const orgError = validateOrg(params.orgId as string);
        if (orgError) return orgError;

        return HttpResponse.json([MOCK_SCHEMA, MOCK_SCHEMA_2]);
    }),

    // Get schema: GET /organizations/:orgId/config/schemas/:schemaId
    http.get(`${BASE_URL}/organizations/:orgId/config/schemas/:schemaId`, ({ request, params }) => {
        logRequest('GET', request.url);

        const authError = validateAuth(request);
        if (authError) return authError;

        const orgError = validateOrg(params.orgId as string);
        if (orgError) return orgError;

        const schemaId = params.schemaId as string;
        const schemas = [MOCK_SCHEMA, MOCK_SCHEMA_2];
        const schema = schemas.find((s) => s.id === schemaId);

        if (!schema) {
            return HttpResponse.json({ error: `Schema "${schemaId}" not found` }, { status: 404 });
        }

        return HttpResponse.json(schema);
    }),

    // Create schema: POST /organizations/:orgId/config/schemas
    http.post(`${BASE_URL}/organizations/:orgId/config/schemas`, async ({ request, params }) => {
        const body = await request.json();
        logRequest('POST', request.url, body);

        const authError = validateAuth(request);
        if (authError) return authError;

        const orgError = validateOrg(params.orgId as string);
        if (orgError) return orgError;

        const { name, jsonSchema, description } = body as { name: string; jsonSchema: Record<string, unknown>; description?: string };

        const newSchema: ConfigSchema = {
            id: 'schema-new-001',
            organizationId: ORG_ID,
            name,
            description: description ?? null,
            currentVersion: 1,
            jsonSchema,
            createdBy: 'user-001',
            createdAt: '2025-01-25T10:00:00.000Z',
            updatedAt: '2025-01-25T10:00:00.000Z',
        };

        return HttpResponse.json(newSchema, { status: 201 });
    }),

    // Push schema version: POST /organizations/:orgId/config/schemas/:schemaId/push
    http.post(`${BASE_URL}/organizations/:orgId/config/schemas/:schemaId/push`, async ({ request, params }) => {
        const body = await request.json();
        logRequest('POST', request.url, body);

        const authError = validateAuth(request);
        if (authError) return authError;

        const orgError = validateOrg(params.orgId as string);
        if (orgError) return orgError;

        const schemaId = params.schemaId as string;
        if (schemaId !== SCHEMA_ID) {
            return HttpResponse.json({ error: `Schema "${schemaId}" not found` }, { status: 404 });
        }

        return HttpResponse.json(MOCK_PUSH_VERSION_RESPONSE);
    }),

    // --- Environment endpoints ---

    // List environments: GET /organizations/:orgId/config/environments
    http.get(`${BASE_URL}/organizations/:orgId/config/environments`, ({ request, params }) => {
        logRequest('GET', request.url);

        const authError = validateAuth(request);
        if (authError) return authError;

        const orgError = validateOrg(params.orgId as string);
        if (orgError) return orgError;

        return HttpResponse.json([MOCK_ENVIRONMENT, MOCK_ENVIRONMENT_2, MOCK_ENVIRONMENT_3]);
    }),

    // --- Value endpoints ---

    // Get single value: GET /organizations/:orgId/config/values/:key
    http.get(`${BASE_URL}/organizations/:orgId/config/values/:key`, ({ request, params }) => {
        logRequest('GET', request.url);

        const authError = validateAuth(request);
        if (authError) return authError;

        const orgError = validateOrg(params.orgId as string);
        if (orgError) return orgError;

        const key = params.key as string;
        const url = new URL(request.url);
        const env = url.searchParams.get('environment') || 'development';

        if (env !== 'production') {
            return HttpResponse.json({ error: `Key "${key}" not found in environment "${env}"` }, { status: 404 });
        }

        if (!(key in MOCK_VALUES)) {
            return HttpResponse.json({ error: `Key "${key}" not found in environment "${env}"` }, { status: 404 });
        }

        return HttpResponse.json({ value: MOCK_VALUES[key] });
    }),

    // Get all values: GET /organizations/:orgId/config/values
    http.get(`${BASE_URL}/organizations/:orgId/config/values`, ({ request, params }) => {
        logRequest('GET', request.url);

        const authError = validateAuth(request);
        if (authError) return authError;

        const orgError = validateOrg(params.orgId as string);
        if (orgError) return orgError;

        const url = new URL(request.url);
        const env = url.searchParams.get('environment') || 'development';

        if (env !== 'production') {
            return HttpResponse.json({ values: {} });
        }

        return HttpResponse.json({ values: MOCK_VALUES });
    }),

    // Set value: PUT /organizations/:orgId/config/values
    http.put(`${BASE_URL}/organizations/:orgId/config/values`, async ({ request, params }) => {
        const body = await request.json();
        logRequest('PUT', request.url, body);

        const authError = validateAuth(request);
        if (authError) return authError;

        const orgError = validateOrg(params.orgId as string);
        if (orgError) return orgError;

        const { schemaId, environmentId, key, value, tier } = body as {
            schemaId: string;
            environmentId: string;
            key: string;
            value: unknown;
            tier: string;
        };

        return HttpResponse.json({
            id: 'value-001',
            schemaId,
            environmentId,
            key,
            value,
            tier,
            updatedBy: 'user-001',
            updatedAt: '2025-01-25T15:00:00.000Z',
        });
    }),
];

const server = setupServer(...handlers);

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());
beforeEach(() => {
    requestLog = [];
});
afterEach(() => server.resetHandlers());

function createClient(overrides: { apiKey?: string; orgId?: string; baseUrl?: string } = {}) {
    return new CliApiClient({
        baseUrl: overrides.baseUrl ?? BASE_URL,
        apiKey: overrides.apiKey ?? API_KEY,
        orgId: overrides.orgId ?? ORG_ID,
    });
}

// ===========================================================================
// Tests
// ===========================================================================

describe('CliApiClient Integration Tests', () => {
    // -----------------------------------------------------------------------
    // Authentication
    // -----------------------------------------------------------------------
    describe('authentication', () => {
        it('succeeds with a valid API key', async () => {
            const client = createClient();
            const schemas = await client.listSchemas();
            expect(schemas).toHaveLength(2);
        });

        it('throws on 401 when API key is invalid', async () => {
            const client = createClient({ apiKey: 'bad-key' });
            await expect(client.listSchemas()).rejects.toThrow('API error');
        });

        it('throws on 403 when org ID is wrong', async () => {
            const client = createClient({ orgId: 'wrong-org-id' });
            await expect(client.listSchemas()).rejects.toThrow('API error');
        });

        it('sends the correct Authorization header', async () => {
            const client = createClient();
            await client.listSchemas();
            expect(getRequestCount()).toBe(1);
            // If auth were wrong, we'd get a 401 error — success means the header was correct
        });

        it('strips trailing slashes from baseUrl', async () => {
            const client = createClient({ baseUrl: `${BASE_URL}/` });
            const schemas = await client.listSchemas();
            expect(schemas).toHaveLength(2);
        });
    });

    // -----------------------------------------------------------------------
    // Schema CRUD
    // -----------------------------------------------------------------------
    describe('schema CRUD', () => {
        it('listSchemas returns all schemas', async () => {
            const client = createClient();
            const schemas = await client.listSchemas();

            expect(schemas).toHaveLength(2);
            expect(schemas[0]).toEqual(MOCK_SCHEMA);
            expect(schemas[1]).toEqual(MOCK_SCHEMA_2);
        });

        it('getSchema returns a specific schema by ID', async () => {
            const client = createClient();
            const schema = await client.getSchema(SCHEMA_ID);

            expect(schema.id).toBe(SCHEMA_ID);
            expect(schema.name).toBe('app-settings');
            expect(schema.currentVersion).toBe(1);
            expect(schema.jsonSchema).toEqual(MOCK_SCHEMA.jsonSchema);
        });

        it('getSchema throws 404 for unknown schema ID', async () => {
            const client = createClient();
            await expect(client.getSchema('nonexistent-schema')).rejects.toThrow('API error');
        });

        it('createSchema sends correct payload and returns new schema', async () => {
            const client = createClient();
            const newJsonSchema = {
                type: 'object',
                properties: {
                    TIMEOUT: { type: 'number' },
                },
            };

            const created = await client.createSchema({
                name: 'timeout-config',
                jsonSchema: newJsonSchema,
                description: 'Timeout configuration',
            });

            expect(created.id).toBe('schema-new-001');
            expect(created.name).toBe('timeout-config');
            expect(created.description).toBe('Timeout configuration');
            expect(created.jsonSchema).toEqual(newJsonSchema);
            expect(created.currentVersion).toBe(1);

            // Verify the request was sent correctly
            const postRequests = requestLog.filter((r) => r.method === 'POST');
            expect(postRequests).toHaveLength(1);
            expect(postRequests[0].body).toEqual({
                name: 'timeout-config',
                jsonSchema: newJsonSchema,
                description: 'Timeout configuration',
            });
        });

        it('createSchema works without optional description', async () => {
            const client = createClient();
            const created = await client.createSchema({
                name: 'minimal-schema',
                jsonSchema: { type: 'object' },
            });

            expect(created.name).toBe('minimal-schema');
            expect(created.description).toBeNull();
        });

        it('pushSchemaVersion sends correct payload and returns version response', async () => {
            const client = createClient();
            const newJsonSchema = {
                type: 'object',
                properties: {
                    API_URL: { type: 'string' },
                    MAX_RETRIES: { type: 'number' },
                    DEBUG: { type: 'boolean' },
                    TIMEOUT_MS: { type: 'number' },
                },
                required: ['API_URL'],
            };

            const result = await client.pushSchemaVersion(SCHEMA_ID, {
                jsonSchema: newJsonSchema,
                changeDescription: 'Added TIMEOUT_MS field',
            });

            expect(result.schema.currentVersion).toBe(2);
            expect(result.version.version).toBe(2);
            expect(result.version.schemaId).toBe(SCHEMA_ID);
            expect(result.version.changeDescription).toBe('Added TIMEOUT_MS field');

            // Verify the request body
            const postRequests = requestLog.filter((r) => r.method === 'POST' && r.url.includes('/push'));
            expect(postRequests).toHaveLength(1);
            expect(postRequests[0].body).toEqual({
                jsonSchema: newJsonSchema,
                changeDescription: 'Added TIMEOUT_MS field',
            });
        });

        it('pushSchemaVersion throws 404 for unknown schema ID', async () => {
            const client = createClient();
            await expect(
                client.pushSchemaVersion('nonexistent-schema', {
                    jsonSchema: { type: 'object' },
                }),
            ).rejects.toThrow('API error');
        });
    });

    // -----------------------------------------------------------------------
    // Environments
    // -----------------------------------------------------------------------
    describe('environments', () => {
        it('listEnvironments returns all environments', async () => {
            const client = createClient();
            const envs = await client.listEnvironments();

            expect(envs).toHaveLength(3);
            expect(envs[0]).toEqual(MOCK_ENVIRONMENT);
            expect(envs[1]).toEqual(MOCK_ENVIRONMENT_2);
            expect(envs[2]).toEqual(MOCK_ENVIRONMENT_3);
        });

        it('listEnvironments includes environment metadata', async () => {
            const client = createClient();
            const envs = await client.listEnvironments();

            const production = envs.find((e) => e.name === 'production');
            expect(production).toBeDefined();
            expect(production!.id).toBe(ENV_ID);
            expect(production!.organizationId).toBe(ORG_ID);
            expect(production!.description).toBe('Production environment');
        });

        it('listEnvironments throws on 401', async () => {
            const client = createClient({ apiKey: 'invalid' });
            await expect(client.listEnvironments()).rejects.toThrow('API error');
        });

        it('listEnvironments throws on 403', async () => {
            const client = createClient({ orgId: 'wrong-org' });
            await expect(client.listEnvironments()).rejects.toThrow('API error');
        });
    });

    // -----------------------------------------------------------------------
    // Values
    // -----------------------------------------------------------------------
    describe('values', () => {
        it('getAllValues returns unwrapped values object', async () => {
            const client = createClient();
            const values = await client.getAllValues('production');

            expect(values).toEqual(MOCK_VALUES);
            expect(values.API_URL).toBe('https://api.smooai.com');
            expect(values.MAX_RETRIES).toBe(3);
            expect(values.DEBUG).toBe(false);
        });

        it('getAllValues returns empty object for unknown environment', async () => {
            const client = createClient();
            const values = await client.getAllValues('nonexistent');
            expect(values).toEqual({});
        });

        it('getAllValues throws on 401', async () => {
            const client = createClient({ apiKey: 'bad-key' });
            await expect(client.getAllValues('production')).rejects.toThrow('API error');
        });

        it('getAllValues throws on 403', async () => {
            const client = createClient({ orgId: 'wrong-org' });
            await expect(client.getAllValues('production')).rejects.toThrow('API error');
        });

        it('getValue returns unwrapped value for a string key', async () => {
            const client = createClient();
            const value = await client.getValue('API_URL', 'production');
            expect(value).toBe('https://api.smooai.com');
        });

        it('getValue returns unwrapped value for a numeric key', async () => {
            const client = createClient();
            const value = await client.getValue('MAX_RETRIES', 'production');
            expect(value).toBe(3);
        });

        it('getValue returns unwrapped value for a boolean key', async () => {
            const client = createClient();
            const value = await client.getValue('DEBUG', 'production');
            expect(value).toBe(false);
        });

        it('getValue returns unwrapped value for a nested object key', async () => {
            const client = createClient();
            const value = await client.getValue('NESTED_CONFIG', 'production');
            expect(value).toEqual({ database: { host: 'db.prod.smooai.com', port: 5432 } });
        });

        it('getValue throws 404 for unknown key', async () => {
            const client = createClient();
            await expect(client.getValue('NONEXISTENT', 'production')).rejects.toThrow('API error');
        });

        it('getValue throws 404 for unknown environment', async () => {
            const client = createClient();
            await expect(client.getValue('API_URL', 'nonexistent')).rejects.toThrow('API error');
        });

        it('setValue sends correct payload', async () => {
            const client = createClient();
            const result = await client.setValue({
                schemaId: SCHEMA_ID,
                environmentId: ENV_ID,
                key: 'API_URL',
                value: 'https://api.new.smooai.com',
                tier: 'default',
            });

            expect(result).toEqual(
                expect.objectContaining({
                    schemaId: SCHEMA_ID,
                    environmentId: ENV_ID,
                    key: 'API_URL',
                    value: 'https://api.new.smooai.com',
                    tier: 'default',
                }),
            );

            // Verify the PUT request body
            const putRequests = requestLog.filter((r) => r.method === 'PUT');
            expect(putRequests).toHaveLength(1);
            expect(putRequests[0].body).toEqual({
                schemaId: SCHEMA_ID,
                environmentId: ENV_ID,
                key: 'API_URL',
                value: 'https://api.new.smooai.com',
                tier: 'default',
            });
        });

        it('setValue handles complex object values', async () => {
            const client = createClient();
            const complexValue = { database: { host: 'new-db.smooai.com', port: 5433, ssl: true } };

            const result = await client.setValue({
                schemaId: SCHEMA_ID,
                environmentId: ENV_ID,
                key: 'NESTED_CONFIG',
                value: complexValue,
                tier: 'override',
            });

            expect(result).toEqual(
                expect.objectContaining({
                    key: 'NESTED_CONFIG',
                    value: complexValue,
                    tier: 'override',
                }),
            );
        });

        it('setValue throws on 401', async () => {
            const client = createClient({ apiKey: 'bad-key' });
            await expect(
                client.setValue({
                    schemaId: SCHEMA_ID,
                    environmentId: ENV_ID,
                    key: 'API_URL',
                    value: 'test',
                    tier: 'default',
                }),
            ).rejects.toThrow('API error');
        });
    });

    // -----------------------------------------------------------------------
    // Error handling
    // -----------------------------------------------------------------------
    describe('error handling', () => {
        it('includes HTTP status code in error message', async () => {
            const client = createClient({ apiKey: 'bad-key' });
            await expect(client.listSchemas()).rejects.toThrow(/HTTP 401/);
        });

        it('includes response body in error message when available', async () => {
            const client = createClient();
            await expect(client.getSchema('nonexistent-schema')).rejects.toThrow(/not found/i);
        });

        it('handles 500 server errors', async () => {
            server.use(
                http.get(`${BASE_URL}/organizations/:orgId/config/schemas`, () => {
                    return HttpResponse.json({ error: 'Internal server error' }, { status: 500 });
                }),
            );

            const client = createClient();
            await expect(client.listSchemas()).rejects.toThrow(/HTTP 500/);
        });

        it('handles network-level errors gracefully', async () => {
            server.use(
                http.get(`${BASE_URL}/organizations/:orgId/config/schemas`, () => {
                    return HttpResponse.error();
                }),
            );

            const client = createClient();
            await expect(client.listSchemas()).rejects.toThrow();
        });

        it('handles malformed JSON response body in error', async () => {
            server.use(
                http.get(`${BASE_URL}/organizations/:orgId/config/schemas`, () => {
                    return new HttpResponse('Not JSON', { status: 502, headers: { 'Content-Type': 'text/plain' } });
                }),
            );

            const client = createClient();
            await expect(client.listSchemas()).rejects.toThrow(/HTTP 502/);
        });
    });

    // -----------------------------------------------------------------------
    // Helper methods
    // -----------------------------------------------------------------------
    describe('helper methods', () => {
        describe('getSchemaByName', () => {
            it('returns schema when found by name', async () => {
                const client = createClient();
                const schema = await client.getSchemaByName('app-settings');

                expect(schema).not.toBeNull();
                expect(schema!.id).toBe(SCHEMA_ID);
                expect(schema!.name).toBe('app-settings');
            });

            it('returns second schema when found by name', async () => {
                const client = createClient();
                const schema = await client.getSchemaByName('feature-flags');

                expect(schema).not.toBeNull();
                expect(schema!.id).toBe('schema-002');
                expect(schema!.name).toBe('feature-flags');
            });

            it('returns null when schema name does not exist', async () => {
                const client = createClient();
                const schema = await client.getSchemaByName('nonexistent-schema');
                expect(schema).toBeNull();
            });

            it('calls listSchemas internally', async () => {
                const client = createClient();
                await client.getSchemaByName('app-settings');

                // Should have made one GET request to the schemas endpoint
                expect(getRequestCount('/config/schemas')).toBe(1);
            });
        });

        describe('getEnvironmentByName', () => {
            it('returns environment when found by name', async () => {
                const client = createClient();
                const env = await client.getEnvironmentByName('production');

                expect(env).not.toBeNull();
                expect(env!.id).toBe(ENV_ID);
                expect(env!.name).toBe('production');
            });

            it('returns staging environment when found by name', async () => {
                const client = createClient();
                const env = await client.getEnvironmentByName('staging');

                expect(env).not.toBeNull();
                expect(env!.id).toBe('env-002');
                expect(env!.name).toBe('staging');
            });

            it('returns null when environment name does not exist', async () => {
                const client = createClient();
                const env = await client.getEnvironmentByName('nonexistent-env');
                expect(env).toBeNull();
            });

            it('calls listEnvironments internally', async () => {
                const client = createClient();
                await client.getEnvironmentByName('production');

                // Should have made one GET request to the environments endpoint
                expect(getRequestCount('/config/environments')).toBe(1);
            });
        });
    });

    // -----------------------------------------------------------------------
    // Full workflow
    // -----------------------------------------------------------------------
    describe('full workflow', () => {
        it('createSchema -> pushSchemaVersion -> setValue -> getValue', async () => {
            // Override handlers to track the workflow state
            let createdSchemaId = '';
            const workflowValues: Record<string, unknown> = {};

            server.use(
                // Create schema returns the new schema
                http.post(`${BASE_URL}/organizations/:orgId/config/schemas`, async ({ request, params }) => {
                    const body = await request.json();
                    logRequest('POST', request.url, body);

                    const authError = validateAuth(request);
                    if (authError) return authError;
                    const orgError = validateOrg(params.orgId as string);
                    if (orgError) return orgError;

                    const { name, jsonSchema, description } = body as {
                        name: string;
                        jsonSchema: Record<string, unknown>;
                        description?: string;
                    };

                    createdSchemaId = 'schema-workflow-001';
                    const newSchema: ConfigSchema = {
                        id: createdSchemaId,
                        organizationId: ORG_ID,
                        name,
                        description: description ?? null,
                        currentVersion: 1,
                        jsonSchema,
                        createdBy: 'user-001',
                        createdAt: '2025-01-25T10:00:00.000Z',
                        updatedAt: '2025-01-25T10:00:00.000Z',
                    };
                    return HttpResponse.json(newSchema, { status: 201 });
                }),

                // Push version returns updated schema
                http.post(`${BASE_URL}/organizations/:orgId/config/schemas/:schemaId/push`, async ({ request, params }) => {
                    const body = await request.json();
                    logRequest('POST', request.url, body);

                    const authError = validateAuth(request);
                    if (authError) return authError;
                    const orgError = validateOrg(params.orgId as string);
                    if (orgError) return orgError;

                    const { jsonSchema, changeDescription } = body as {
                        jsonSchema: Record<string, unknown>;
                        changeDescription?: string;
                    };

                    const response: PushVersionResponse = {
                        schema: {
                            id: params.schemaId as string,
                            organizationId: ORG_ID,
                            name: 'workflow-schema',
                            description: 'Workflow test schema',
                            currentVersion: 2,
                            jsonSchema,
                            createdBy: 'user-001',
                            createdAt: '2025-01-25T10:00:00.000Z',
                            updatedAt: '2025-01-25T11:00:00.000Z',
                        },
                        version: {
                            id: 'version-workflow-002',
                            schemaId: params.schemaId as string,
                            version: 2,
                            jsonSchema,
                            changeDescription: changeDescription ?? null,
                            pushedBy: 'user-001',
                            pushedAt: '2025-01-25T11:00:00.000Z',
                        },
                    };
                    return HttpResponse.json(response);
                }),

                // Set value stores the value
                http.put(`${BASE_URL}/organizations/:orgId/config/values`, async ({ request, params }) => {
                    const body = await request.json();
                    logRequest('PUT', request.url, body);

                    const authError = validateAuth(request);
                    if (authError) return authError;
                    const orgError = validateOrg(params.orgId as string);
                    if (orgError) return orgError;

                    const { key, value } = body as { key: string; value: unknown };
                    workflowValues[key] = value;

                    return HttpResponse.json({ ...(body as Record<string, unknown>), id: 'value-workflow-001', updatedAt: '2025-01-25T12:00:00.000Z' });
                }),

                // Get value retrieves the stored value
                http.get(`${BASE_URL}/organizations/:orgId/config/values/:key`, ({ request, params }) => {
                    logRequest('GET', request.url);

                    const authError = validateAuth(request);
                    if (authError) return authError;
                    const orgError = validateOrg(params.orgId as string);
                    if (orgError) return orgError;

                    const key = params.key as string;
                    if (!(key in workflowValues)) {
                        return HttpResponse.json({ error: `Key "${key}" not found` }, { status: 404 });
                    }

                    return HttpResponse.json({ value: workflowValues[key] });
                }),
            );

            const client = createClient();

            // Step 1: Create a schema
            const schema = await client.createSchema({
                name: 'workflow-schema',
                jsonSchema: {
                    type: 'object',
                    properties: { RATE_LIMIT: { type: 'number' } },
                },
                description: 'Workflow test schema',
            });
            expect(schema.id).toBe('schema-workflow-001');
            expect(schema.name).toBe('workflow-schema');
            expect(schema.currentVersion).toBe(1);

            // Step 2: Push a new version
            const pushResult = await client.pushSchemaVersion(schema.id, {
                jsonSchema: {
                    type: 'object',
                    properties: {
                        RATE_LIMIT: { type: 'number' },
                        BURST_LIMIT: { type: 'number' },
                    },
                },
                changeDescription: 'Added BURST_LIMIT',
            });
            expect(pushResult.schema.currentVersion).toBe(2);
            expect(pushResult.version.version).toBe(2);
            expect(pushResult.version.changeDescription).toBe('Added BURST_LIMIT');

            // Step 3: Set a value
            await client.setValue({
                schemaId: schema.id,
                environmentId: ENV_ID,
                key: 'RATE_LIMIT',
                value: 100,
                tier: 'default',
            });

            // Step 4: Get the value back
            const value = await client.getValue('RATE_LIMIT', 'production');
            expect(value).toBe(100);

            // Verify the full request sequence
            expect(requestLog).toHaveLength(4);
            expect(requestLog[0].method).toBe('POST'); // createSchema
            expect(requestLog[1].method).toBe('POST'); // pushSchemaVersion
            expect(requestLog[2].method).toBe('PUT'); // setValue
            expect(requestLog[3].method).toBe('GET'); // getValue
        });

        it('listSchemas -> getSchemaByName -> getEnvironmentByName in sequence', async () => {
            const client = createClient();

            // List all schemas
            const schemas = await client.listSchemas();
            expect(schemas).toHaveLength(2);

            // Find a specific schema by name
            const appSettings = await client.getSchemaByName('app-settings');
            expect(appSettings).not.toBeNull();
            expect(appSettings!.id).toBe(SCHEMA_ID);

            // Find a specific environment by name
            const production = await client.getEnvironmentByName('production');
            expect(production).not.toBeNull();
            expect(production!.id).toBe(ENV_ID);

            // Verify requests: listSchemas, listSchemas (via getSchemaByName), listEnvironments (via getEnvironmentByName)
            expect(getRequestCount('/config/schemas')).toBe(2);
            expect(getRequestCount('/config/environments')).toBe(1);
        });
    });
});
