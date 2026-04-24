import { render, Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';
import { Banner } from '../components/Banner';
import { BRAND } from '../components/brand';
import { ErrorPanel, SuccessPanel, SummaryPanel } from '../components/Panels';
import { TaskList, type TaskItem } from '../components/TaskList';
import { CliApiClient } from '../utils/api-client';
import { deriveAuthUrlFromBaseUrl, maskSecret, saveCredentials, type ApiKeyCredentials, type OAuthCredentials } from '../utils/credentials';
import { exchangeClientCredentials } from '../utils/oauth';
import { isInteractive, jsonOutput } from '../utils/output';

interface LoginOptions {
    json?: boolean;
    apiKey?: string;
    clientId?: string;
    clientSecret?: string;
    orgId?: string;
    baseUrl?: string;
    authUrl?: string;
}

const DEFAULT_BASE_URL = 'https://api.smoo.ai';

export interface LoginResult {
    success: true;
    orgId: string;
    mode: 'oauth' | 'api-key';
    authUrl?: string;
    expiresIn?: number;
}

export async function loginLogic(options: LoginOptions): Promise<LoginResult> {
    const orgId = options.orgId;
    const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');

    if (!orgId) throw new Error('Organization ID is required. Use --org-id flag.');

    // OAuth client-credentials (preferred)
    if (options.clientId && options.clientSecret) {
        const authUrl = (options.authUrl ?? deriveAuthUrlFromBaseUrl(baseUrl)).replace(/\/+$/, '');

        const token = await exchangeClientCredentials({
            authUrl,
            clientId: options.clientId,
            clientSecret: options.clientSecret,
        });

        const creds: OAuthCredentials = {
            clientId: options.clientId,
            clientSecret: options.clientSecret,
            orgId,
            baseUrl,
            authUrl,
            accessToken: token.accessToken,
            accessTokenExpiresAt: token.expiresAt,
        };

        // Validate by listing schemas with the minted token.
        const client = new CliApiClient(creds, { onCredentialsChange: () => {} });
        await client.listSchemas();

        saveCredentials(creds);
        return { success: true, orgId, mode: 'oauth', authUrl, expiresIn: token.expiresIn };
    }

    // Legacy API key fallback
    if (options.apiKey) {
        const creds: ApiKeyCredentials = { apiKey: options.apiKey, orgId, baseUrl };
        const client = new CliApiClient(creds, { onCredentialsChange: () => {} });
        await client.listSchemas();
        saveCredentials(creds);
        return { success: true, orgId, mode: 'api-key' };
    }

    throw new Error('Provide either --client-id + --client-secret (OAuth) or --api-key (legacy).');
}

function buildInitialTasks(mode: 'oauth' | 'api-key'): TaskItem[] {
    if (mode === 'oauth') {
        return [
            { label: 'Exchanging client credentials for access token', status: 'pending' },
            { label: 'Validating token against api.smoo.ai', status: 'pending' },
            { label: 'Saving to ~/.smooai/credentials.json', status: 'pending' },
        ];
    }
    return [
        { label: 'Validating API key against api.smoo.ai', status: 'pending' },
        { label: 'Saving to ~/.smooai/credentials.json', status: 'pending' },
    ];
}

function LoginUI({ options }: { options: LoginOptions }) {
    const mode: 'oauth' | 'api-key' = options.clientId && options.clientSecret ? 'oauth' : 'api-key';
    const [tasks, setTasks] = useState<TaskItem[]>(() => buildInitialTasks(mode));
    const [result, setResult] = useState<LoginResult | null>(null);
    const [error, setError] = useState<{ message: string; hint?: string } | null>(null);

    const resolvedBaseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const resolvedAuthUrl = (options.authUrl ?? deriveAuthUrlFromBaseUrl(resolvedBaseUrl)).replace(/\/+$/, '');

    useEffect(() => {
        (async () => {
            const now = Date.now();
            setTasks((t) => t.map((task, i) => (i === 0 ? { ...task, status: 'running', startedAt: now } : task)));

            try {
                if (mode === 'oauth') {
                    // Do the exchange + validate explicitly so the UI can show each step.
                    const token = await exchangeClientCredentials({
                        authUrl: resolvedAuthUrl,
                        clientId: options.clientId!,
                        clientSecret: options.clientSecret!,
                    });

                    setTasks((t) => [
                        { ...t[0], status: 'done', hint: `expires in ${token.expiresIn}s` },
                        { ...t[1], status: 'running', startedAt: Date.now() },
                        t[2],
                    ]);

                    const creds: OAuthCredentials = {
                        clientId: options.clientId!,
                        clientSecret: options.clientSecret!,
                        orgId: options.orgId!,
                        baseUrl: resolvedBaseUrl,
                        authUrl: resolvedAuthUrl,
                        accessToken: token.accessToken,
                        accessTokenExpiresAt: token.expiresAt,
                    };
                    const client = new CliApiClient(creds, { onCredentialsChange: () => {} });
                    const schemas = await client.listSchemas();

                    setTasks((t) => [
                        t[0],
                        { ...t[1], status: 'done', hint: `${schemas.length} schema(s) visible` },
                        { ...t[2], status: 'running', startedAt: Date.now() },
                    ]);

                    saveCredentials(creds);

                    setTasks((t) => [t[0], t[1], { ...t[2], status: 'done' }]);
                    setResult({ success: true, orgId: options.orgId!, mode, authUrl: resolvedAuthUrl, expiresIn: token.expiresIn });
                } else {
                    const res = await loginLogic(options);
                    setTasks((t) => [
                        { ...t[0], status: 'done' },
                        { ...t[1], status: 'done' },
                    ]);
                    setResult(res);
                }
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                setTasks((t) => t.map((task) => (task.status === 'running' ? { ...task, status: 'error', error: message } : task)));
                setError({
                    message,
                    hint:
                        mode === 'oauth'
                            ? 'Verify --client-id, --client-secret, and --auth-url. Run with --base-url https://api.smoo.ai to confirm prod target.'
                            : 'Verify --api-key is current and matches --org-id.',
                });
            }
        })();
    }, []);

    const redactedSecret = options.clientSecret ? maskSecret(options.clientSecret) : options.apiKey ? maskSecret(options.apiKey) : undefined;

    return (
        <Box flexDirection="column">
            <Banner title="Login" subtitle={mode === 'oauth' ? 'oauth2 client-credentials' : 'legacy api-key'} />
            <SummaryPanel
                title="Target"
                rows={[
                    { label: 'org', value: options.orgId ?? '(missing)', color: options.orgId ? BRAND.teal : BRAND.red },
                    { label: 'api', value: resolvedBaseUrl, color: BRAND.darkBlue },
                    ...(mode === 'oauth' ? [{ label: 'auth', value: resolvedAuthUrl, color: BRAND.darkBlue }] : []),
                    ...(mode === 'oauth' && options.clientId ? [{ label: 'id', value: options.clientId, color: BRAND.gray }] : []),
                    ...(redactedSecret ? [{ label: 'secret', value: redactedSecret, color: BRAND.gray }] : []),
                ]}
            />
            <TaskList tasks={tasks} />
            {result && (
                <SuccessPanel title="Logged in">
                    <Text>
                        <Text color={BRAND.gray}>{'mode   '}</Text>
                        <Text color={BRAND.orange} bold>
                            {result.mode}
                        </Text>
                    </Text>
                    <Text>
                        <Text color={BRAND.gray}>{'org    '}</Text>
                        <Text color={BRAND.teal}>{result.orgId}</Text>
                    </Text>
                    {result.expiresIn ? (
                        <Text>
                            <Text color={BRAND.gray}>{'token  '}</Text>
                            <Text color={BRAND.teal}>{`valid for ${result.expiresIn}s (auto-refreshes)`}</Text>
                        </Text>
                    ) : null}
                </SuccessPanel>
            )}
            {error && <ErrorPanel title="Login failed" message={error.message} hint={error.hint} />}
        </Box>
    );
}

export function runLogin(options: LoginOptions): void {
    if (!isInteractive(options.json)) {
        loginLogic(options).then(
            (result) => jsonOutput(result),
            (err) => jsonOutput({ success: false, error: err.message }, 1),
        );
        return;
    }
    render(<LoginUI options={options} />);
}
