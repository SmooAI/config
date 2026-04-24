import { render, Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';
import { Banner } from '../components/Banner';
import { BRAND } from '../components/brand';
import { ErrorPanel } from '../components/Panels';
import { TaskList, type TaskItem } from '../components/TaskList';
import { CliApiClient } from '../utils/api-client';
import { getCredentialsOrExit, maskSecret } from '../utils/credentials';
import { isInteractive, jsonOutput } from '../utils/output';

interface ListOptions {
    json?: boolean;
    environment?: string;
    showSecrets?: boolean;
}

export async function listLogic(options: ListOptions): Promise<{ success: boolean; environment: string; values: Record<string, unknown> }> {
    const creds = getCredentialsOrExit();
    const client = new CliApiClient(creds);

    const environment = options.environment ?? 'development';
    const values = await client.getAllValues(environment);

    return { success: true, environment, values };
}

function formatValue(value: unknown): string {
    if (typeof value === 'object' && value !== null) return JSON.stringify(value);
    if (typeof value === 'string') return value;
    return String(value);
}

function ListUI({ options }: { options: ListOptions }) {
    const environment = options.environment ?? 'development';
    const [tasks, setTasks] = useState<TaskItem[]>([{ label: `Fetching values for ${environment}`, status: 'pending' }]);
    const [result, setResult] = useState<{ environment: string; values: Record<string, unknown> } | null>(null);
    const [error, setError] = useState<{ message: string; hint?: string } | null>(null);

    useEffect(() => {
        (async () => {
            setTasks([{ label: `Fetching values for ${environment}`, status: 'running', startedAt: Date.now() }]);
            try {
                const res = await listLogic(options);
                setTasks([{ label: `Fetching values for ${res.environment}`, status: 'done', hint: `${Object.keys(res.values).length} value(s)` }]);
                setResult(res);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                setTasks([{ label: `Fetching values for ${environment}`, status: 'error', error: message }]);
                setError({
                    message,
                    hint: /401|403|HTTP 4/i.test(message)
                        ? 'Run `smooai-config login` again — your credentials may have expired.'
                        : /not found|404/i.test(message)
                          ? `Environment "${environment}" may not exist. Run \`smooai-config list --environment production\` to try another.`
                          : undefined,
                });
            }
        })();
    }, []);

    const entries = result ? Object.entries(result.values) : [];

    return (
        <Box flexDirection="column">
            <Banner title="List values" subtitle={environment} />
            <TaskList tasks={tasks} />
            {result && entries.length > 0 && (
                <Box flexDirection="column" borderStyle="round" borderColor={BRAND.teal} paddingX={1} marginY={1}>
                    <Text color={BRAND.teal} bold>
                        {result.environment} · {entries.length} value(s)
                    </Text>
                    {entries.map(([key, value]) => {
                        const raw = formatValue(value);
                        const looksSecret = /secret|token|key|password|credential/i.test(key);
                        const display = looksSecret && !options.showSecrets ? maskSecret(raw) : raw;
                        return (
                            <Box key={key}>
                                <Text color={BRAND.orange} bold>
                                    {key}
                                </Text>
                                <Text color={BRAND.gray}> = </Text>
                                <Text color={looksSecret && !options.showSecrets ? BRAND.mutedOrange : undefined}>{display}</Text>
                                {looksSecret && !options.showSecrets ? <Text color={BRAND.gray}> (masked — pass --show-secrets to reveal)</Text> : null}
                            </Box>
                        );
                    })}
                </Box>
            )}
            {result && entries.length === 0 && (
                <Box marginTop={1}>
                    <Text color={BRAND.gray}>No values set for environment </Text>
                    <Text color={BRAND.darkBlue} bold>
                        {result.environment}
                    </Text>
                    <Text color={BRAND.gray}>. Use </Text>
                    <Text color={BRAND.orange} bold>
                        smooai-config set
                    </Text>
                    <Text color={BRAND.gray}> to add one.</Text>
                </Box>
            )}
            {error && <ErrorPanel title="List failed" message={error.message} hint={error.hint} />}
        </Box>
    );
}

export function runList(options: ListOptions): void {
    if (!isInteractive(options.json)) {
        listLogic(options).then(
            (result) => jsonOutput(result),
            (err) => jsonOutput({ success: false, error: err.message }, 1),
        );
        return;
    }
    render(<ListUI options={options} />);
}
