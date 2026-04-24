import { render, Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';
import { Banner } from '../components/Banner';
import { BRAND } from '../components/brand';
import { ErrorPanel } from '../components/Panels';
import { TaskList, type TaskItem } from '../components/TaskList';
import { CliApiClient } from '../utils/api-client';
import { getCredentialsOrExit } from '../utils/credentials';
import { isInteractive, jsonOutput } from '../utils/output';

interface GetOptions {
    json?: boolean;
    environment?: string;
}

export async function getLogic(key: string, options: GetOptions): Promise<{ success: boolean; key: string; value: unknown; environment: string }> {
    const creds = getCredentialsOrExit();
    const client = new CliApiClient(creds);

    const environment = options.environment ?? 'development';
    const value = await client.getValue(key, environment);

    return { success: true, key, value, environment };
}

function GetUI({ configKey, options }: { configKey: string; options: GetOptions }) {
    const environment = options.environment ?? 'development';
    const [tasks, setTasks] = useState<TaskItem[]>([{ label: `Fetching ${configKey}`, status: 'pending' }]);
    const [result, setResult] = useState<{ key: string; value: unknown; environment: string } | null>(null);
    const [error, setError] = useState<{ message: string; hint?: string } | null>(null);

    useEffect(() => {
        (async () => {
            setTasks([{ label: `Fetching ${configKey}`, status: 'running', startedAt: Date.now() }]);
            try {
                const res = await getLogic(configKey, options);
                setTasks([{ label: `Fetching ${configKey}`, status: 'done' }]);
                setResult(res);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                setTasks([{ label: `Fetching ${configKey}`, status: 'error', error: message }]);
                setError({
                    message,
                    hint: /not found|404/i.test(message) ? `Use \`smooai-config list --environment ${environment}\` to see available keys.` : undefined,
                });
            }
        })();
    }, []);

    return (
        <Box flexDirection="column">
            <Banner title={`Get ${configKey}`} subtitle={environment} />
            <TaskList tasks={tasks} />
            {result && (
                <Box flexDirection="column" borderStyle="round" borderColor={BRAND.teal} paddingX={1} marginY={1}>
                    <Text color={BRAND.orange} bold>
                        {result.key}
                    </Text>
                    <Text>{typeof result.value === 'object' ? JSON.stringify(result.value, null, 2) : String(result.value)}</Text>
                    <Text color={BRAND.gray}>environment: {result.environment}</Text>
                </Box>
            )}
            {error && <ErrorPanel title="Get failed" message={error.message} hint={error.hint} />}
        </Box>
    );
}

export function runGet(key: string, options: GetOptions): void {
    if (!isInteractive(options.json)) {
        getLogic(key, options).then(
            (result) => jsonOutput(result),
            (err) => jsonOutput({ success: false, error: err.message }, 1),
        );
        return;
    }
    render(<GetUI configKey={key} options={options} />);
}
