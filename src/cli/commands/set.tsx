import { render, Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';
import { Banner } from '../components/Banner';
import { TaskList, type TaskItem } from '../components/TaskList';
import { CliApiClient } from '../utils/api-client';
import { getCredentialsOrExit } from '../utils/credentials';
import { isInteractive, jsonOutput } from '../utils/output';
import { validateValue } from '../utils/schema-validator';

interface SetOptions {
    json?: boolean;
    environment?: string;
    tier?: string;
    schemaName?: string;
}

function parseValue(raw: string): unknown {
    // Try JSON parse first for objects, arrays, booleans, numbers
    try {
        return JSON.parse(raw);
    } catch {
        return raw; // Keep as string
    }
}

export async function setLogic(
    key: string,
    rawValue: string,
    options: SetOptions,
): Promise<{ success: boolean; key: string; value: unknown; tier: string; environment: string }> {
    const creds = getCredentialsOrExit();
    const client = new CliApiClient(creds);

    const environment = options.environment ?? 'development';
    const tier = options.tier ?? 'public';
    const value = parseValue(rawValue);

    // Find the environment
    const env = await client.getEnvironmentByName(environment);
    if (!env) {
        throw new Error(`Environment "${environment}" not found. Create it first.`);
    }

    // Find the schema (optional validation)
    const schemas = await client.listSchemas();
    if (schemas.length > 0) {
        const schema = options.schemaName ? schemas.find((s) => s.name === options.schemaName) : schemas[0];

        if (schema?.jsonSchema) {
            const validation = validateValue(schema.jsonSchema, key, value);
            if (!validation.valid) {
                throw new Error(`Validation failed for "${key}": ${validation.errors?.join(', ')}`);
            }
        }

        if (schema) {
            await client.setValue({
                schemaId: schema.id,
                environmentId: env.id,
                key,
                value,
                tier,
            });

            return { success: true, key, value, tier, environment };
        }
    }

    throw new Error('No schemas found. Push a schema first with `smooai-config push`.');
}

function SetUI({ configKey, value, options }: { configKey: string; value: string; options: SetOptions }) {
    const [tasks, setTasks] = useState<TaskItem[]>([
        { label: 'Validating value', status: 'pending' },
        { label: `Setting ${configKey}`, status: 'pending' },
    ]);
    const [result, setResult] = useState<{ key: string; value: unknown; tier: string; environment: string } | null>(null);

    useEffect(() => {
        (async () => {
            setTasks((t) => t.map((task, i) => (i === 0 ? { ...task, status: 'running' } : task)));

            try {
                const res = await setLogic(configKey, value, options);

                setTasks([
                    { label: 'Validating value', status: 'done' },
                    { label: `Setting ${configKey}`, status: 'done' },
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
            <Banner title="Set Config Value" />
            <TaskList tasks={tasks} />
            {result && (
                <Box marginTop={1} flexDirection="column">
                    <Text color="green" bold>
                        Value set successfully!
                    </Text>
                    <Text>
                        {result.key} = {JSON.stringify(result.value)} [{result.tier}] ({result.environment})
                    </Text>
                </Box>
            )}
        </Box>
    );
}

export function runSet(key: string, value: string, options: SetOptions): void {
    if (!isInteractive(options.json)) {
        setLogic(key, value, options).then(
            (result) => jsonOutput(result),
            (err) => jsonOutput({ success: false, error: err.message }, 1),
        );
        return;
    }
    render(<SetUI configKey={key} value={value} options={options} />);
}
