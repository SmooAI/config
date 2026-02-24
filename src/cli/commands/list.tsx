import { render, Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';
import { Banner } from '../components/Banner';
import { TaskList, type TaskItem } from '../components/TaskList';
import { CliApiClient } from '../utils/api-client';
import { getCredentialsOrExit } from '../utils/credentials';
import { isInteractive, jsonOutput } from '../utils/output';

interface ListOptions {
    json?: boolean;
    environment?: string;
}

export async function listLogic(options: ListOptions): Promise<{ success: boolean; environment: string; values: Record<string, unknown> }> {
    const creds = getCredentialsOrExit();
    const client = new CliApiClient(creds);

    const environment = options.environment ?? 'development';
    const values = await client.getAllValues(environment);

    return { success: true, environment, values };
}

function ListUI({ options }: { options: ListOptions }) {
    const [tasks, setTasks] = useState<TaskItem[]>([{ label: `Fetching values for ${options.environment ?? 'development'}`, status: 'pending' }]);
    const [result, setResult] = useState<{
        environment: string;
        values: Record<string, unknown>;
    } | null>(null);

    useEffect(() => {
        (async () => {
            setTasks([{ label: `Fetching values for ${options.environment ?? 'development'}`, status: 'running' }]);

            try {
                const res = await listLogic(options);

                setTasks([{ label: `Fetching values for ${res.environment}`, status: 'done' }]);
                setResult(res);
            } catch (err) {
                setTasks([
                    {
                        label: `Fetching values for ${options.environment ?? 'development'}`,
                        status: 'error',
                        error: err instanceof Error ? err.message : String(err),
                    },
                ]);
            }
        })();
    }, []);

    return (
        <Box flexDirection="column">
            <Banner title="List Config Values" />
            <TaskList tasks={tasks} />
            {result && (
                <Box marginTop={1} flexDirection="column">
                    <Text bold>
                        Environment: {result.environment} ({Object.keys(result.values).length} values)
                    </Text>
                    <Box marginTop={1} flexDirection="column">
                        {Object.entries(result.values).map(([key, value]) => (
                            <Box key={key}>
                                <Text bold color="cyan">
                                    {key}
                                </Text>
                                <Text> = </Text>
                                <Text>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</Text>
                            </Box>
                        ))}
                    </Box>
                    {Object.keys(result.values).length === 0 && <Text color="gray">No values found for this environment.</Text>}
                </Box>
            )}
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
