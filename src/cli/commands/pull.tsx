import { writeFileSync } from 'fs';
import { join } from 'path';
import { render, Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';
import { Banner } from '../components/Banner';
import { TaskList, type TaskItem } from '../components/TaskList';
import { CliApiClient } from '../utils/api-client';
import { getCredentialsOrExit } from '../utils/credentials';
import { isInteractive, jsonOutput } from '../utils/output';
import { findLocalConfigDir } from '../utils/schema-loader';

interface PullOptions {
    json?: boolean;
    environment?: string;
}

export async function pullLogic(options: PullOptions): Promise<{ success: boolean; values: Record<string, unknown>; environment: string; filePath?: string }> {
    const creds = getCredentialsOrExit();
    const client = new CliApiClient(creds);

    const environment = options.environment ?? 'development';

    // Fetch all values for the environment
    const values = await client.getAllValues(environment);

    // Write to local config directory if it exists
    const configDir = findLocalConfigDir();
    let filePath: string | undefined;

    if (configDir) {
        // Determine file format based on what exists in the directory
        const jsonPath = join(configDir, `${environment}.json`);
        writeFileSync(jsonPath, JSON.stringify(values, null, 2));
        filePath = jsonPath;
    }

    return { success: true, values, environment, filePath };
}

function PullUI({ options }: { options: PullOptions }) {
    const [tasks, setTasks] = useState<TaskItem[]>([
        { label: `Fetching values for ${options.environment ?? 'development'}`, status: 'pending' },
        { label: 'Writing to local config', status: 'pending' },
    ]);
    const [result, setResult] = useState<{
        values: Record<string, unknown>;
        environment: string;
        filePath?: string;
    } | null>(null);

    useEffect(() => {
        (async () => {
            setTasks((t) => t.map((task, i) => (i === 0 ? { ...task, status: 'running' } : task)));

            try {
                const res = await pullLogic(options);

                setTasks([
                    { label: `Fetching values for ${res.environment}`, status: 'done' },
                    { label: 'Writing to local config', status: res.filePath ? 'done' : 'pending' },
                ]);
                setResult(res);
            } catch (err) {
                setTasks((t) =>
                    t.map((task) => (task.status === 'running' ? { ...task, status: 'error', error: err instanceof Error ? err.message : String(err) } : task)),
                );
            }
        })();
    }, []);

    return (
        <Box flexDirection="column">
            <Banner title="Pull Config" />
            <TaskList tasks={tasks} />
            {result && (
                <Box marginTop={1} flexDirection="column">
                    <Text color="green" bold>
                        Pulled {Object.keys(result.values).length} values for {result.environment}
                    </Text>
                    {result.filePath && <Text color="gray">Written to: {result.filePath}</Text>}
                </Box>
            )}
        </Box>
    );
}

export function runPull(options: PullOptions): void {
    if (!isInteractive(options.json)) {
        pullLogic(options).then(
            (result) => jsonOutput(result),
            (err) => jsonOutput({ success: false, error: err.message }, 1),
        );
        return;
    }
    render(<PullUI options={options} />);
}
