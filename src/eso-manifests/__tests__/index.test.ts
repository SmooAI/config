/**
 * SMOODEV-1524 — ESO manifest generator unit tests.
 */
import { describe, expect, it } from 'vitest';
import { buildClusterSecretStore, buildExternalSecret, resolveSecretMapping } from '../index';

describe('buildClusterSecretStore (SMOODEV-1524)', () => {
    const base = { apiUrl: 'https://api.smoo.ai', orgId: 'org-123', environment: 'production' };

    it('bakes org + environment into the webhook URL and templates only the key', () => {
        const store = buildClusterSecretStore(base) as any;
        expect(store.kind).toBe('ClusterSecretStore');
        expect(store.spec.provider.webhook.url).toBe('https://api.smoo.ai/organizations/org-123/config/values/{{ .remoteRef.key }}?environment=production');
        expect(store.spec.provider.webhook.result.jsonPath).toBe('$.value');
        expect(store.spec.provider.webhook.headers.Authorization).toBe('Bearer {{ .auth.token }}');
    });

    it('points at the real api.smoo.ai endpoint, never the hallucinated config.smoo.ai', () => {
        const store = buildClusterSecretStore(base) as any;
        expect(store.spec.provider.webhook.url).not.toContain('config.smoo.ai');
        expect(store.spec.provider.webhook.url).toContain('api.smoo.ai');
    });

    it('defaults the bootstrap Secret ref and strips trailing slashes from apiUrl', () => {
        const store = buildClusterSecretStore({ ...base, apiUrl: 'https://api.smoo.ai///' }) as any;
        expect(store.spec.provider.webhook.url.startsWith('https://api.smoo.ai/organizations')).toBe(true);
        const ref = store.spec.provider.webhook.secrets[0].secretRef;
        expect(ref).toEqual({ name: 'smooai-config-bootstrap', namespace: 'external-secrets', key: 'bearer-token' });
    });

    it('honors bootstrap Secret + name overrides and url-encodes the environment', () => {
        const store = buildClusterSecretStore({
            ...base,
            name: 'smooai-config-prod',
            environment: 'pre prod',
            bootstrapSecret: { name: 's', namespace: 'ns', key: 'k' },
        }) as any;
        expect(store.metadata.name).toBe('smooai-config-prod');
        expect(store.spec.provider.webhook.url).toContain('environment=pre%20prod');
        expect(store.spec.provider.webhook.secrets[0].secretRef).toEqual({ name: 's', namespace: 'ns', key: 'k' });
    });

    it('throws on missing required fields', () => {
        expect(() => buildClusterSecretStore({ ...base, apiUrl: '' })).toThrow(/apiUrl/);
        expect(() => buildClusterSecretStore({ ...base, orgId: '' })).toThrow(/orgId/);
        expect(() => buildClusterSecretStore({ ...base, environment: '' })).toThrow(/environment/);
    });
});

describe('resolveSecretMapping (SMOODEV-1524)', () => {
    it('snakecases the config key into an env-var name by default', () => {
        expect(resolveSecretMapping('mimoApiKey')).toEqual({ configKey: 'mimoApiKey', envVar: 'MIMO_API_KEY' });
    });

    it('honors an explicit env-var override (env name ≠ snakecase(key))', () => {
        expect(resolveSecretMapping({ configKey: 'alibabaModelStudioApiKey', envVar: 'DASHSCOPE_API_KEY' })).toEqual({
            configKey: 'alibabaModelStudioApiKey',
            envVar: 'DASHSCOPE_API_KEY',
        });
    });
});

describe('buildExternalSecret (SMOODEV-1524)', () => {
    it('maps each config key to its env-var (snakecase default + explicit override)', () => {
        const es = buildExternalSecret({
            name: 'litellm-config',
            namespace: 'smooai-litellm',
            secrets: ['mimoApiKey', { configKey: 'alibabaModelStudioApiKey', envVar: 'DASHSCOPE_API_KEY' }],
        }) as any;
        expect(es.kind).toBe('ExternalSecret');
        expect(es.spec.data).toEqual([
            { secretKey: 'MIMO_API_KEY', remoteRef: { key: 'mimoApiKey' } },
            { secretKey: 'DASHSCOPE_API_KEY', remoteRef: { key: 'alibabaModelStudioApiKey' } },
        ]);
    });

    it('defaults target Secret name to the resource name and store to smooai-config', () => {
        const es = buildExternalSecret({ name: 'litellm-config', namespace: 'smooai-litellm', secrets: ['mimoApiKey'] }) as any;
        expect(es.spec.target.name).toBe('litellm-config');
        expect(es.spec.target.creationPolicy).toBe('Owner');
        expect(es.spec.secretStoreRef).toEqual({ name: 'smooai-config', kind: 'ClusterSecretStore' });
        expect(es.spec.refreshInterval).toBe('1h');
    });

    it('supports a distinct target Secret name (safe migration: sync to a new Secret first)', () => {
        const es = buildExternalSecret({
            name: 'litellm-config-eso',
            namespace: 'smooai-litellm',
            targetSecretName: 'litellm-config-eso',
            secrets: ['mimoApiKey'],
        }) as any;
        expect(es.spec.target.name).toBe('litellm-config-eso');
    });

    it('rejects duplicate env-var names that would silently clobber', () => {
        expect(() =>
            buildExternalSecret({
                name: 'x',
                namespace: 'ns',
                secrets: ['mimoApiKey', { configKey: 'somethingElse', envVar: 'MIMO_API_KEY' }],
            }),
        ).toThrow(/duplicate env-var/);
    });

    it('throws on missing required fields', () => {
        expect(() => buildExternalSecret({ name: '', namespace: 'ns', secrets: ['k'] })).toThrow(/name/);
        expect(() => buildExternalSecret({ name: 'n', namespace: '', secrets: ['k'] })).toThrow(/namespace/);
        expect(() => buildExternalSecret({ name: 'n', namespace: 'ns', secrets: [] })).toThrow(/at least one/);
    });
});
