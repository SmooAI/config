/**
 * `@smooai/config/eso-manifests` — ExternalSecrets Operator (ESO) manifest
 * generator (SMOODEV-1524, epic SMOODEV-1522).
 *
 * Emits the two ESO resources that let a Kubernetes workload pull its secrets
 * from the @smooai/config HTTP API (`api.smoo.ai`) instead of having them
 * Pulumi-baked at SST deploy time:
 *
 *   1. {@link buildClusterSecretStore} — a `ClusterSecretStore` whose `webhook`
 *      provider points at the REAL config-values endpoint, with org + env baked
 *      into the URL and the bearer sourced from the bootstrap Secret that the
 *      eso-refresher (SMOODEV-1523) keeps fresh.
 *
 *   2. {@link buildExternalSecret} — a per-workload `ExternalSecret` mapping the
 *      consumer's secret-tier config keys to the env-var names the workload
 *      reads (`UPPER_SNAKE_CASE(key)` by default, matching the SDK's env tier).
 *
 * Pure data — returns plain manifest objects (cdk8s / ArgoCD / `kubectl apply`
 * all accept them). No cluster or network access. The smooai monorepo
 * (SMOODEV-1525) consumes these to replace the stripped-out hand YAML.
 *
 * Endpoint contract (see packages/backend/src/routes/config/config-values.ts):
 *   GET {apiUrl}/organizations/{orgId}/config/values/{key}?environment={env}
 *   Authorization: Bearer <token>
 *   200 → { "value": <any> }      (jsonPath `$.value`)
 */
import { snakecase } from '@/utils';

/** A reference to the Kubernetes Secret + key holding the ESO bearer token. */
export interface BootstrapSecretRef {
    /** Secret name. Default `smooai-config-bootstrap`. */
    name?: string;
    /** Secret namespace. Default `external-secrets`. */
    namespace?: string;
    /** Data key holding the bearer. Default `bearer-token`. */
    key?: string;
}

export interface ClusterSecretStoreOptions {
    /** ClusterSecretStore name. Default `smooai-config`. */
    name?: string;
    /** Config API base URL, no trailing slash. E.g. `https://api.smoo.ai`. */
    apiUrl: string;
    /** Org id whose config this store reads. */
    orgId: string;
    /** Environment name baked into the query string. E.g. `production`. */
    environment: string;
    /** Bootstrap bearer Secret reference (kept fresh by the eso-refresher). */
    bootstrapSecret?: BootstrapSecretRef;
}

export const ESO_DEFAULTS = {
    clusterSecretStoreName: 'smooai-config',
    bootstrapSecretName: 'smooai-config-bootstrap',
    bootstrapSecretNamespace: 'external-secrets',
    bootstrapSecretKey: 'bearer-token',
    refreshInterval: '1h',
    apiVersion: 'external-secrets.io/v1beta1',
} as const;

function stripTrailingSlashes(s: string): string {
    return s.replace(/\/+$/, '');
}

/**
 * Build a `ClusterSecretStore` backed by the @smooai/config webhook provider.
 *
 * org + environment are baked into the URL because ESO's webhook only templates
 * `{{ .remoteRef.key }}` per-secret — so a store is scoped to one (org, env)
 * pair. Use one store per environment.
 */
export function buildClusterSecretStore(opts: ClusterSecretStoreOptions): Record<string, unknown> {
    if (!opts.apiUrl) throw new Error('buildClusterSecretStore: apiUrl is required');
    if (!opts.orgId) throw new Error('buildClusterSecretStore: orgId is required');
    if (!opts.environment) throw new Error('buildClusterSecretStore: environment is required');

    const name = opts.name ?? ESO_DEFAULTS.clusterSecretStoreName;
    const apiUrl = stripTrailingSlashes(opts.apiUrl);
    const env = encodeURIComponent(opts.environment);
    const secretName = opts.bootstrapSecret?.name ?? ESO_DEFAULTS.bootstrapSecretName;
    const secretNamespace = opts.bootstrapSecret?.namespace ?? ESO_DEFAULTS.bootstrapSecretNamespace;
    const secretKey = opts.bootstrapSecret?.key ?? ESO_DEFAULTS.bootstrapSecretKey;

    return {
        apiVersion: ESO_DEFAULTS.apiVersion,
        kind: 'ClusterSecretStore',
        metadata: { name },
        spec: {
            provider: {
                webhook: {
                    // `{{ .remoteRef.key }}` is the only per-secret variable ESO
                    // substitutes; org + env are fixed for this store.
                    url: `${apiUrl}/organizations/${opts.orgId}/config/values/{{ .remoteRef.key }}?environment=${env}`,
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: 'Bearer {{ .auth.token }}',
                    },
                    result: { jsonPath: '$.value' },
                    secrets: [
                        {
                            name: 'auth',
                            secretRef: {
                                name: secretName,
                                namespace: secretNamespace,
                                key: secretKey,
                            },
                        },
                    ],
                },
            },
        },
    };
}

/** One mapped secret: a config key → the env-var name the workload reads. */
export interface SecretMapping {
    /** The @smooai/config secret-tier key (camelCase), e.g. `mimoApiKey`. */
    configKey: string;
    /**
     * The env-var name the workload's Secret exposes. Defaults to
     * `UPPER_SNAKE_CASE(configKey)` (matching the SDK env tier). Override when
     * the workload reads a different name (e.g. `DASHSCOPE_API_KEY` ←
     * `alibabaModelStudioApiKey`).
     */
    envVar?: string;
}

export interface ExternalSecretOptions {
    /** ExternalSecret resource name (and default target Secret name). */
    name: string;
    /** Namespace the ExternalSecret + target Secret live in. */
    namespace: string;
    /** The secrets this workload needs — config keys (+ optional env-var override). */
    secrets: Array<SecretMapping | string>;
    /** Target k8s Secret name the workload mounts via envFrom. Default = `name`. */
    targetSecretName?: string;
    /** ClusterSecretStore to read from. Default `smooai-config`. */
    clusterSecretStoreName?: string;
    /** ESO refresh interval. Default `1h`. */
    refreshInterval?: string;
    /** Labels for the ExternalSecret resource. */
    labels?: Record<string, string>;
}

/** Normalize a mapping entry to `{ configKey, envVar }` with the snakecase default. */
export function resolveSecretMapping(entry: SecretMapping | string): { configKey: string; envVar: string } {
    const m: SecretMapping = typeof entry === 'string' ? { configKey: entry } : entry;
    if (!m.configKey) throw new Error('resolveSecretMapping: configKey is required');
    return { configKey: m.configKey, envVar: m.envVar ?? snakecase(m.configKey) };
}

/**
 * Build a per-workload `ExternalSecret`. Each entry becomes a `data` mapping of
 * `secretKey` (the env-var name in the synced Secret) ← `remoteRef.key` (the
 * @smooai/config key). The workload mounts the target Secret via `envFrom`.
 */
export function buildExternalSecret(opts: ExternalSecretOptions): Record<string, unknown> {
    if (!opts.name) throw new Error('buildExternalSecret: name is required');
    if (!opts.namespace) throw new Error('buildExternalSecret: namespace is required');
    if (!opts.secrets?.length) throw new Error('buildExternalSecret: at least one secret mapping is required');

    const data = opts.secrets.map((entry) => {
        const { configKey, envVar } = resolveSecretMapping(entry);
        return { secretKey: envVar, remoteRef: { key: configKey } };
    });

    // Guard against duplicate env-var names silently clobbering each other.
    const envVars = data.map((d) => d.secretKey);
    const dupes = envVars.filter((v, i) => envVars.indexOf(v) !== i);
    if (dupes.length > 0) {
        throw new Error(`buildExternalSecret: duplicate env-var names: ${[...new Set(dupes)].join(', ')}`);
    }

    return {
        apiVersion: ESO_DEFAULTS.apiVersion,
        kind: 'ExternalSecret',
        metadata: {
            name: opts.name,
            namespace: opts.namespace,
            ...(opts.labels ? { labels: opts.labels } : {}),
        },
        spec: {
            refreshInterval: opts.refreshInterval ?? ESO_DEFAULTS.refreshInterval,
            secretStoreRef: {
                name: opts.clusterSecretStoreName ?? ESO_DEFAULTS.clusterSecretStoreName,
                kind: 'ClusterSecretStore',
            },
            target: {
                name: opts.targetSecretName ?? opts.name,
                creationPolicy: 'Owner',
            },
            data,
        },
    };
}
