import { render, Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';
import { Banner } from '../components/Banner';
import { TaskList, type TaskItem } from '../components/TaskList';
import { CliApiClient } from '../utils/api-client';
import { getCredentialsOrExit } from '../utils/credentials';
import { isInteractive, jsonOutput } from '../utils/output';
import { loadLocalSchema } from '../utils/schema-loader';

interface DiffOptions {
    json?: boolean;
    schemaName?: string;
}

interface SchemaDiff {
    added: string[];
    removed: string[];
    changed: string[];
}

function computeDiff(local: Record<string, unknown>, remote: Record<string, unknown>): SchemaDiff {
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

export async function diffLogic(options: DiffOptions): Promise<{ success: boolean; diff: SchemaDiff; hasChanges: boolean }> {
    const creds = getCredentialsOrExit();
    const client = new CliApiClient(creds);

    // Load local schema
    const loaded = await loadLocalSchema();
    if (!loaded) {
        throw new Error('No local schema found. Run `smooai-config init` first.');
    }

    // Fetch remote schema
    const schemas = await client.listSchemas();
    const schemaName = options.schemaName;
    const remoteSchema = schemaName ? schemas.find((s) => s.name === schemaName) : schemas[0];

    if (!remoteSchema) {
        // No remote schema — everything is "added"
        const added = Object.keys(loaded.jsonSchema);
        return {
            success: true,
            diff: { added, removed: [], changed: [] },
            hasChanges: added.length > 0,
        };
    }

    const diff = computeDiff(loaded.jsonSchema, remoteSchema.jsonSchema);
    const hasChanges = diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0;

    return { success: true, diff, hasChanges };
}

function DiffUI({ options }: { options: DiffOptions }) {
    const [tasks, setTasks] = useState<TaskItem[]>([
        { label: 'Loading local schema', status: 'pending' },
        { label: 'Fetching remote schema', status: 'pending' },
        { label: 'Computing diff', status: 'pending' },
    ]);
    const [result, setResult] = useState<{ diff: SchemaDiff; hasChanges: boolean } | null>(null);

    useEffect(() => {
        (async () => {
            setTasks((t) => t.map((task, i) => (i === 0 ? { ...task, status: 'running' } : task)));

            try {
                const res = await diffLogic(options);

                setTasks([
                    { label: 'Loading local schema', status: 'done' },
                    { label: 'Fetching remote schema', status: 'done' },
                    { label: 'Computing diff', status: 'done' },
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
            <Banner title="Schema Diff" />
            <TaskList tasks={tasks} />
            {result && (
                <Box marginTop={1} flexDirection="column">
                    {!result.hasChanges ? (
                        <Text color="green" bold>
                            Schemas are in sync. No changes detected.
                        </Text>
                    ) : (
                        <>
                            <Text bold>Changes:</Text>
                            {result.diff.added.map((k) => (
                                <Text key={k} color="green">
                                    + {k} (new)
                                </Text>
                            ))}
                            {result.diff.removed.map((k) => (
                                <Text key={k} color="red">
                                    - {k} (removed)
                                </Text>
                            ))}
                            {result.diff.changed.map((k) => (
                                <Text key={k} color="yellow">
                                    ~ {k} (modified)
                                </Text>
                            ))}
                        </>
                    )}
                </Box>
            )}
        </Box>
    );
}

export function runDiff(options: DiffOptions): void {
    if (!isInteractive(options.json)) {
        diffLogic(options).then(
            (result) => jsonOutput(result),
            (err) => jsonOutput({ success: false, error: err.message }, 1),
        );
        return;
    }
    render(<DiffUI options={options} />);
}
