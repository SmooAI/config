import { basename } from 'path';
import { render, Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';
import { Banner } from '../components/Banner';
import { TaskList, type TaskItem } from '../components/TaskList';
import { CliApiClient } from '../utils/api-client';
import { getCredentialsOrExit } from '../utils/credentials';
import { isInteractive, jsonOutput } from '../utils/output';
import { loadLocalSchema } from '../utils/schema-loader';
import { validateJsonSchema } from '../utils/schema-validator';

interface PushOptions {
    json?: boolean;
    schemaName?: string;
    description?: string;
    yes?: boolean;
}

interface SchemaDiff {
    added: string[];
    removed: string[];
    changed: string[];
}

function computeSchemaDiff(local: Record<string, unknown>, remote: Record<string, unknown>): SchemaDiff {
    const localKeys = new Set(Object.keys(local));
    const remoteKeys = new Set(Object.keys(remote));

    const added = [...localKeys].filter((k) => !remoteKeys.has(k));
    const removed = [...remoteKeys].filter((k) => !localKeys.has(k));
    const changed = [...localKeys].filter((k) => {
        if (!remoteKeys.has(k)) return false;
        return JSON.stringify(local[k]) !== JSON.stringify(remote[k]);
    });

    return { added, removed, changed };
}

export async function pushLogic(options: PushOptions): Promise<{ success: boolean; schema?: unknown; version?: unknown; diff?: SchemaDiff }> {
    const creds = getCredentialsOrExit();
    const client = new CliApiClient(creds);

    // Load local schema
    const loaded = await loadLocalSchema();
    if (!loaded) {
        throw new Error('No local schema found. Run `smooai-config init` first or create .smooai-config/schema.json.');
    }

    // Validate the schema is well-formed
    const validation = validateJsonSchema(loaded.jsonSchema);
    if (!validation.valid) {
        throw new Error(`Invalid JSON Schema: ${validation.errors?.join(', ')}`);
    }

    const schemaName = options.schemaName ?? basename(process.cwd());

    // Check if schema already exists
    const existingSchema = await client.getSchemaByName(schemaName).catch(() => null);

    let diff: SchemaDiff | undefined;

    if (existingSchema) {
        diff = computeSchemaDiff(loaded.jsonSchema, existingSchema.jsonSchema);

        // Push new version
        const result = await client.pushSchemaVersion(existingSchema.id, {
            jsonSchema: loaded.jsonSchema,
            changeDescription: options.description,
        });

        return { success: true, schema: result.schema, version: result.version, diff };
    }

    // Create new schema
    const schema = await client.createSchema({
        name: schemaName,
        jsonSchema: loaded.jsonSchema,
        description: options.description,
    });

    return { success: true, schema };
}

function DiffDisplay({ diff }: { diff: SchemaDiff }) {
    if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
        return <Text color="gray">No changes detected.</Text>;
    }

    return (
        <Box flexDirection="column" marginTop={1}>
            <Text bold>Schema Changes:</Text>
            {diff.added.map((k) => (
                <Text key={k} color="green">
                    + {k}
                </Text>
            ))}
            {diff.removed.map((k) => (
                <Text key={k} color="red">
                    - {k}
                </Text>
            ))}
            {diff.changed.map((k) => (
                <Text key={k} color="yellow">
                    ~ {k}
                </Text>
            ))}
        </Box>
    );
}

function PushUI({ options }: { options: PushOptions }) {
    const [tasks, setTasks] = useState<TaskItem[]>([
        { label: 'Loading local schema', status: 'pending' },
        { label: 'Validating schema', status: 'pending' },
        { label: 'Pushing to platform', status: 'pending' },
    ]);
    const [result, setResult] = useState<{ schema?: unknown; version?: unknown; diff?: SchemaDiff } | null>(null);

    useEffect(() => {
        (async () => {
            setTasks((t) => t.map((task, i) => (i === 0 ? { ...task, status: 'running' } : task)));

            try {
                // Simulate step progression
                setTasks((t) => [{ ...t[0], status: 'done' }, { ...t[1], status: 'running' }, t[2]]);

                const res = await pushLogic(options);

                setTasks([
                    { label: 'Loading local schema', status: 'done' },
                    { label: 'Validating schema', status: 'done' },
                    { label: 'Pushing to platform', status: 'done' },
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
            <Banner title="Push Schema" />
            <TaskList tasks={tasks} />
            {result?.diff && <DiffDisplay diff={result.diff} />}
            {result && (
                <Box marginTop={1}>
                    <Text color="green" bold>
                        Schema pushed successfully!
                    </Text>
                </Box>
            )}
        </Box>
    );
}

export function runPush(options: PushOptions): void {
    if (!isInteractive(options.json)) {
        pushLogic(options).then(
            (result) => jsonOutput(result),
            (err) => jsonOutput({ success: false, error: err.message }, 1),
        );
        return;
    }
    render(<PushUI options={options} />);
}
