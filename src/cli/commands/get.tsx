import { render, Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';
import { Banner } from '../components/Banner';
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
    const [tasks, setTasks] = useState<TaskItem[]>([{ label: `Fetching ${configKey}`, status: 'pending' }]);
    const [result, setResult] = useState<{ key: string; value: unknown; environment: string } | null>(null);

    useEffect(() => {
        (async () => {
            setTasks([{ label: `Fetching ${configKey}`, status: 'running' }]);

            try {
                const res = await getLogic(configKey, options);

                setTasks([{ label: `Fetching ${configKey}`, status: 'done' }]);
                setResult(res);
            } catch (err) {
                setTasks([
                    {
                        label: `Fetching ${configKey}`,
                        status: 'error',
                        error: err instanceof Error ? err.message : String(err),
                    },
                ]);
            }
        })();
    }, []);

    return (
        <Box flexDirection="column">
            <Banner title="Get Config Value" />
            <TaskList tasks={tasks} />
            {result && (
                <Box marginTop={1} flexDirection="column">
                    <Text bold>{result.key}</Text>
                    <Text>{typeof result.value === 'object' ? JSON.stringify(result.value, null, 2) : String(result.value)}</Text>
                    <Text color="gray">Environment: {result.environment}</Text>
                </Box>
            )}
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
