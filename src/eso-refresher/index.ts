import { ConfigBootstrapError } from '@/container/errors';
import { TokenProvider } from '@/platform/TokenProvider';
/**
 * `@smooai/config/eso-refresher` — ExternalSecrets Operator (ESO) bearer-token
 * refresher (SMOODEV-1523, epic SMOODEV-1522).
 *
 * ## Why this exists
 *
 * ESO's `webhook` provider authenticates to the @smooai/config HTTP API with a
 * **static** bearer token read from a Kubernetes Secret
 * (`external-secrets/smooai-config-bootstrap`, key `bearer-token`). But the
 * config API issues short-lived OAuth2 `client_credentials` JWTs (~1h TTL).
 * A static token therefore goes stale within the hour and every ESO sync
 * silently starts 401-ing — which is exactly why workload secrets were
 * Pulumi-baked at SST deploy time instead (SMOODEV-1347), coupling every
 * secret-value change to a ~1h platform deploy.
 *
 * This sidecar closes that gap: it re-mints a fresh access token on a short
 * interval (well under the JWT TTL) using the **same** `TokenProvider` the
 * runtime SDK uses, and writes it into the bootstrap Secret. ESO then always
 * reads a fresh bearer, so a `th config set …` becomes live on ESO's next
 * `refreshInterval` + a `kubectl rollout restart` — no platform deploy.
 *
 * ## Env contract (mirrors container mode §1, minus orgId/env)
 *
 *   SMOOAI_CONFIG_AUTH_URL      OAuth issuer base URL (default https://auth.smoo.ai).
 *   SMOOAI_CONFIG_CLIENT_ID     (required) M2M OAuth client id (config-read scoped).
 *   SMOOAI_CONFIG_CLIENT_SECRET (required) M2M OAuth client secret
 *                               (legacy alias SMOOAI_CONFIG_API_KEY accepted).
 *
 *   SMOOAI_ESO_SECRET_NAMESPACE        Namespace of the bootstrap Secret (default `external-secrets`).
 *   SMOOAI_ESO_SECRET_NAME             Bootstrap Secret name (default `smooai-config-bootstrap`).
 *   SMOOAI_ESO_SECRET_KEY              Data key to write the bearer into (default `bearer-token`).
 *   SMOOAI_ESO_REFRESH_INTERVAL_SECONDS  How often to re-mint + write (default 900 = 15m).
 *
 * orgId/env are NOT needed here — they are query params ESO supplies when it
 * calls the config API; the token itself is org-agnostic.
 *
 * Fail-loud: the initial mint+write runs synchronously at startup and throws on
 * failure so the pod crash-loops visibly rather than running blind. Subsequent
 * loop failures are logged and retried on the next tick (the existing Secret is
 * still valid for the remainder of its TTL), never silently swallowed.
 */
import { CoreV1Api, KubeConfig, PatchStrategy, setHeaderOptions } from '@kubernetes/client-node';
import Logger from '@smooai/logger/Logger';

const logger = new Logger({ name: '@smooai/config/eso-refresher' });

function readEnv(name: string): string | undefined {
    if (typeof process !== 'undefined' && process.env) return process.env[name];
    return undefined;
}

/** Blank-aware presence check — a set-but-empty var counts as missing. */
function nonBlank(v: string | undefined): string | undefined {
    if (v === undefined) return undefined;
    return v.trim().length > 0 ? v : undefined;
}

export const ESO_REFRESHER_DEFAULTS = {
    namespace: 'external-secrets',
    secretName: 'smooai-config-bootstrap',
    secretKey: 'bearer-token',
    intervalSeconds: 900,
} as const;

/**
 * Writes the freshly-minted bearer token into the target Kubernetes Secret.
 * Abstracted behind an interface so the refresh loop can be unit-tested
 * without a live cluster (inject a fake writer).
 */
export interface SecretWriter {
    /** Patch the configured Secret's data key with `token` (writer base64-encodes). */
    patchBearerToken(token: string): Promise<void>;
}

/**
 * Default {@link SecretWriter} backed by `@kubernetes/client-node`. Uses an
 * in-cluster KubeConfig (falls back to the local kubeconfig for dev) and a
 * JSON merge-patch so only the one data key is touched — the Secret's other
 * keys (if any) are left intact.
 */
export class K8sSecretWriter implements SecretWriter {
    private readonly core: CoreV1Api;

    constructor(
        private readonly namespace: string,
        private readonly secretName: string,
        private readonly secretKey: string,
        core?: CoreV1Api,
    ) {
        if (core) {
            this.core = core;
        } else {
            const kc = new KubeConfig();
            // In-cluster when the ServiceAccount token is mounted; otherwise
            // the developer's local kubeconfig (handy for dry-runs).
            kc.loadFromDefault();
            this.core = kc.makeApiClient(CoreV1Api);
        }
    }

    async patchBearerToken(token: string): Promise<void> {
        const base64 = Buffer.from(token, 'utf8').toString('base64');
        await this.core.patchNamespacedSecret(
            {
                name: this.secretName,
                namespace: this.namespace,
                body: { data: { [this.secretKey]: base64 } },
                // fieldManager — identifies us as the owner of this field.
                fieldManager: 'smooai-config-eso-refresher',
            },
            setHeaderOptions('Content-Type', PatchStrategy.MergePatch),
        );
    }
}

export interface EsoRefresherOptions {
    /** OAuth issuer base URL. Falls back to `SMOOAI_CONFIG_AUTH_URL`, then `https://auth.smoo.ai`. */
    authUrl?: string;
    /** M2M OAuth client id. Falls back to `SMOOAI_CONFIG_CLIENT_ID`. */
    clientId?: string;
    /** M2M OAuth client secret. Falls back to `SMOOAI_CONFIG_CLIENT_SECRET`, then `SMOOAI_CONFIG_API_KEY`. */
    clientSecret?: string;
    /** Target Secret namespace. Falls back to `SMOOAI_ESO_SECRET_NAMESPACE` / default. */
    namespace?: string;
    /** Target Secret name. Falls back to `SMOOAI_ESO_SECRET_NAME` / default. */
    secretName?: string;
    /** Target Secret data key. Falls back to `SMOOAI_ESO_SECRET_KEY` / default. */
    secretKey?: string;
    /** Re-mint + write interval in ms. Falls back to `SMOOAI_ESO_REFRESH_INTERVAL_SECONDS` / default. */
    intervalMs?: number;
    /** Test/embedding seam — inject a pre-built `TokenProvider`. */
    tokenProvider?: TokenProvider;
    /** Test/embedding seam — inject a `SecretWriter` (skips k8s client construction). */
    secretWriter?: SecretWriter;
    /** Test seam — override the scheduler (default `setInterval`). */
    scheduler?: (fn: () => void, ms: number) => { clear: () => void };
}

export interface EsoRefresherHandle {
    /** Force an immediate re-mint + write (also used by tests). */
    refreshNow: () => Promise<void>;
    /** Stop the refresh loop. Idempotent. */
    stop: () => void;
}

function defaultScheduler(fn: () => void, ms: number): { clear: () => void } {
    const t = setInterval(fn, ms);
    // Don't keep the event loop alive solely for the timer in tests/CLI teardown.
    if (typeof t.unref === 'function') t.unref();
    return { clear: () => clearInterval(t) };
}

/**
 * Start the ESO bearer-token refresher.
 *
 * Performs an initial mint+write **synchronously** (awaited) so startup fails
 * loud on misconfiguration, then schedules periodic refreshes. Returns a handle
 * to force a refresh or stop the loop.
 */
export async function runEsoRefresher(options: EsoRefresherOptions = {}): Promise<EsoRefresherHandle> {
    const authUrl = nonBlank(options.authUrl) ?? nonBlank(readEnv('SMOOAI_CONFIG_AUTH_URL')) ?? 'https://auth.smoo.ai';
    const clientId = nonBlank(options.clientId) ?? nonBlank(readEnv('SMOOAI_CONFIG_CLIENT_ID'));
    const clientSecret = nonBlank(options.clientSecret) ?? nonBlank(readEnv('SMOOAI_CONFIG_CLIENT_SECRET')) ?? nonBlank(readEnv('SMOOAI_CONFIG_API_KEY'));

    // Validate required env up front with the same fail-loud contract as container mode.
    if (!options.tokenProvider) {
        const missing: string[] = [];
        if (!clientId) missing.push('SMOOAI_CONFIG_CLIENT_ID');
        if (!clientSecret) missing.push('SMOOAI_CONFIG_CLIENT_SECRET');
        if (missing.length > 0) throw new ConfigBootstrapError(missing);
    }

    const namespace = nonBlank(options.namespace) ?? nonBlank(readEnv('SMOOAI_ESO_SECRET_NAMESPACE')) ?? ESO_REFRESHER_DEFAULTS.namespace;
    const secretName = nonBlank(options.secretName) ?? nonBlank(readEnv('SMOOAI_ESO_SECRET_NAME')) ?? ESO_REFRESHER_DEFAULTS.secretName;
    const secretKey = nonBlank(options.secretKey) ?? nonBlank(readEnv('SMOOAI_ESO_SECRET_KEY')) ?? ESO_REFRESHER_DEFAULTS.secretKey;

    const intervalSecondsEnv = Number(nonBlank(readEnv('SMOOAI_ESO_REFRESH_INTERVAL_SECONDS')) ?? '');
    const intervalMs =
        options.intervalMs ??
        (Number.isFinite(intervalSecondsEnv) && intervalSecondsEnv > 0 ? intervalSecondsEnv * 1000 : ESO_REFRESHER_DEFAULTS.intervalSeconds * 1000);

    const tokenProvider =
        options.tokenProvider ??
        new TokenProvider({
            authUrl,
            clientId: clientId!,
            clientSecret: clientSecret!,
        });

    const writer = options.secretWriter ?? new K8sSecretWriter(namespace, secretName, secretKey);
    const schedule = options.scheduler ?? defaultScheduler;

    const refreshNow = async (): Promise<void> => {
        // Force a brand-new token each cycle so the Secret always holds one with
        // (close to) a full TTL ahead — ESO must never read a token about to expire.
        tokenProvider.invalidate();
        const token = await tokenProvider.getAccessToken();
        await writer.patchBearerToken(token);
        logger.info('Refreshed ESO bootstrap bearer token', { namespace, secretName, secretKey });
    };

    // Initial mint+write — fail-loud (caller exits non-zero → visible crash-loop).
    await refreshNow();

    const handle = schedule(() => {
        refreshNow().catch((err) => {
            // Loop failures are non-fatal: the current Secret token is still
            // valid for the rest of its TTL. Log and retry next tick.
            logger.error('ESO bearer refresh tick failed (will retry next interval)', err as Error, { namespace, secretName });
        });
    }, intervalMs);

    let stopped = false;
    return {
        refreshNow,
        stop: () => {
            if (stopped) return;
            stopped = true;
            handle.clear();
        },
    };
}

/**
 * CLI/container entrypoint. Starts the refresher, wires graceful shutdown, and
 * keeps the process alive. Exits non-zero if the initial mint+write fails.
 */
export async function main(): Promise<void> {
    let handle: EsoRefresherHandle;
    try {
        handle = await runEsoRefresher();
    } catch (err) {
        logger.error('ESO refresher failed to start', err as Error);
        process.exitCode = 1;
        return;
    }

    const shutdown = (signal: string) => {
        logger.info(`Received ${signal}, stopping ESO refresher`);
        handle.stop();
        process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Keep alive — the interval timer is unref'd, so hold the loop open explicitly.
    await new Promise<never>(() => {});
}
