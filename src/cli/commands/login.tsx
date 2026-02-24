import { render, Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';
import { Banner } from '../components/Banner';
import { TaskList, type TaskItem } from '../components/TaskList';
import { CliApiClient } from '../utils/api-client';
import { saveCredentials } from '../utils/credentials';
import { isInteractive, jsonOutput } from '../utils/output';

interface LoginOptions {
    json?: boolean;
    apiKey?: string;
    orgId?: string;
    baseUrl?: string;
}

const DEFAULT_BASE_URL = 'https://api.smoo.ai';

export async function loginLogic(options: LoginOptions): Promise<{ success: boolean; orgId: string }> {
    const apiKey = options.apiKey;
    const orgId = options.orgId;
    const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;

    if (!apiKey) throw new Error('API key is required. Use --api-key flag.');
    if (!orgId) throw new Error('Organization ID is required. Use --org-id flag.');

    // Validate credentials by calling the API
    const client = new CliApiClient({ apiKey, orgId, baseUrl });
    await client.listSchemas(); // Throws on auth failure

    // Save credentials
    saveCredentials({ apiKey, orgId, baseUrl });

    return { success: true, orgId };
}

function LoginUI({ options }: { options: LoginOptions }) {
    const [tasks, setTasks] = useState<TaskItem[]>([
        { label: 'Validating credentials', status: 'pending' },
        { label: 'Saving to ~/.smooai/credentials.json', status: 'pending' },
    ]);
    const [result, setResult] = useState<{ orgId: string } | null>(null);

    useEffect(() => {
        (async () => {
            setTasks((t) => t.map((task, i) => (i === 0 ? { ...task, status: 'running' } : task)));

            try {
                const res = await loginLogic(options);

                setTasks([
                    { label: 'Validating credentials', status: 'done' },
                    { label: 'Saving to ~/.smooai/credentials.json', status: 'done' },
                ]);
                setResult({ orgId: res.orgId });
            } catch (err) {
                setTasks((t) =>
                    t.map((task) => (task.status === 'running' ? { ...task, status: 'error', error: err instanceof Error ? err.message : String(err) } : task)),
                );
            }
        })();
    }, []);

    return (
        <Box flexDirection="column">
            <Banner title="Login" />
            <TaskList tasks={tasks} />
            {result && (
                <Box marginTop={1}>
                    <Text color="green" bold>
                        Logged in successfully! Organization: {result.orgId}
                    </Text>
                </Box>
            )}
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
