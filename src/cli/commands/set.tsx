import { render, Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';
import { Banner } from '../components/Banner';
import { BRAND } from '../components/brand';
import { ErrorPanel, SuccessPanel } from '../components/Panels';
import { TaskList, type TaskItem } from '../components/TaskList';
import { CliApiClient } from '../utils/api-client';
import { getCredentialsOrExit, maskSecret } from '../utils/credentials';
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

function displayValue(value: unknown, tier: string): string {
    const raw = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
    if (tier === 'secret') return maskSecret(raw);
    return raw;
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

    const env = await client.getEnvironmentByName(environment);
    if (!env) {
        throw new Error(`Environment "${environment}" not found. Create it first.`);
    }

    const schemas = await client.listSchemas();
    if (schemas.length === 0) {
        throw new Error('No schemas found. Push a schema first with `smooai-config push`.');
    }

    const schema = options.schemaName ? schemas.find((s) => s.name === options.schemaName) : schemas[0];
    if (!schema) {
        throw new Error(`Schema "${options.schemaName}" not found. Available: ${schemas.map((s) => s.name).join(', ')}`);
    }

    if (schema.jsonSchema) {
        const validation = validateValue(schema.jsonSchema, key, value);
        if (!validation.valid) {
            throw new Error(`Validation failed for "${key}": ${validation.errors?.join(', ')}`);
        }
    }

    await client.setValue({ schemaId: schema.id, environmentId: env.id, key, value, tier });
    return { success: true, key, value, tier, environment };
}

function SetUI({ configKey, value, options }: { configKey: string; value: string; options: SetOptions }) {
    const tier = options.tier ?? 'public';
    const [tasks, setTasks] = useState<TaskItem[]>([
        { label: 'Resolving environment + schema', status: 'pending' },
        { label: `Validating value for ${configKey}`, status: 'pending' },
        { label: `Writing ${configKey}`, status: 'pending' },
    ]);
    const [result, setResult] = useState<{ key: string; value: unknown; tier: string; environment: string } | null>(null);
    const [error, setError] = useState<{ message: string; hint?: string } | null>(null);

    useEffect(() => {
        (async () => {
            setTasks((t) => t.map((task, i) => (i === 0 ? { ...task, status: 'running', startedAt: Date.now() } : task)));
            try {
                setTasks((t) => [{ ...t[0], status: 'done' }, { ...t[1], status: 'running', startedAt: Date.now() }, t[2]]);
                await new Promise((r) => setTimeout(r, 0));
                setTasks((t) => [t[0], { ...t[1], status: 'done' }, { ...t[2], status: 'running', startedAt: Date.now() }]);
                const res = await setLogic(configKey, value, options);
                setTasks([
                    { label: 'Resolving environment + schema', status: 'done' },
                    { label: `Validating value for ${configKey}`, status: 'done' },
                    { label: `Writing ${configKey}`, status: 'done' },
                ]);
                setResult(res);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                setTasks((t) => t.map((task) => (task.status === 'running' ? { ...task, status: 'error', error: message } : task)));
                setError({
                    message,
                    hint: /Validation failed/i.test(message)
                        ? 'Use `smooai-config diff` to check the remote schema matches your local one.'
                        : /not found/i.test(message)
                          ? 'Run `smooai-config push` to publish your schema, then retry.'
                          : undefined,
                });
            }
        })();
    }, []);

    return (
        <Box flexDirection="column">
            <Banner title={`Set ${configKey}`} subtitle={options.environment ?? 'development'} />
            <TaskList tasks={tasks} />
            {result && (
                <SuccessPanel title="Value written">
                    <Text>
                        <Text color={BRAND.gray}>{'key    '}</Text>
                        <Text color={BRAND.orange} bold>
                            {result.key}
                        </Text>
                    </Text>
                    <Text>
                        <Text color={BRAND.gray}>{'value  '}</Text>
                        <Text color={tier === 'secret' ? BRAND.mutedOrange : undefined}>{displayValue(result.value, tier)}</Text>
                        {tier === 'secret' ? <Text color={BRAND.gray}> (masked)</Text> : null}
                    </Text>
                    <Text>
                        <Text color={BRAND.gray}>{'tier   '}</Text>
                        <Text color={tier === 'secret' ? BRAND.red : BRAND.teal}>{tier}</Text>
                    </Text>
                    <Text>
                        <Text color={BRAND.gray}>{'env    '}</Text>
                        <Text color={BRAND.teal}>{result.environment}</Text>
                    </Text>
                </SuccessPanel>
            )}
            {error && <ErrorPanel title="Set failed" message={error.message} hint={error.hint} />}
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
