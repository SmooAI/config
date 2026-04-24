import { render, Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';
import { Banner } from '../components/Banner';
import { BRAND } from '../components/brand';
import { ErrorPanel, SuccessPanel, SummaryPanel } from '../components/Panels';
import { TaskList, type TaskItem } from '../components/TaskList';
import { CliApiClient } from '../utils/api-client';
import { getCredentialsOrExit } from '../utils/credentials';
import { isInteractive, jsonOutput } from '../utils/output';
import { loadLocalSchema } from '../utils/schema-loader';
import { validateJsonSchema, validateSmooaiSchema } from '../utils/schema-validator';

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

export interface PushResolution {
    schemaName: string;
    source: 'flag' | 'config' | 'schema';
    /** Set when --schema-name disagrees with a name declared inside the config. */
    warning?: string;
}

/**
 * SMOODEV-643: resolve the schema name deterministically. Never fall back to
 * cwd basename — that silently created bogus schemas server-side. Either the
 * user passes `--schema-name`, or the config module exports a top-level
 * `schemaName` / `name`, or the JSON Schema carries `$smooaiName`. If neither
 * is present, fail with an actionable error.
 */
export function resolveSchemaName(flag: string | undefined, schemaNameFromFile: string | undefined): PushResolution {
    if (flag && schemaNameFromFile && flag !== schemaNameFromFile) {
        return {
            schemaName: flag,
            source: 'flag',
            warning: `--schema-name=${flag} overrides schemaName=${schemaNameFromFile} declared in the config file`,
        };
    }
    if (flag) return { schemaName: flag, source: 'flag' };
    if (schemaNameFromFile) return { schemaName: schemaNameFromFile, source: 'config' };
    throw new Error(
        'Schema name is required. Pass --schema-name <name> or export `schemaName` (or `$smooaiName` in schema.json) from your .smooai-config file. ' +
            'We no longer fall back to the directory name — that previously created bogus schemas server-side.',
    );
}

export interface PushLogicResult {
    success: boolean;
    schema?: unknown;
    version?: unknown;
    diff?: SchemaDiff;
    schemaName: string;
    created: boolean;
    warning?: string;
}

export async function pushLogic(options: PushOptions): Promise<PushLogicResult> {
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

    // Validate cross-language compatibility
    const smooaiValidation = validateSmooaiSchema(loaded.jsonSchema);
    if (!smooaiValidation.valid) {
        const errorMessages = smooaiValidation.errors.map((e) => `  ${e.path}: ${e.message}\n    Suggestion: ${e.suggestion}`);
        throw new Error(`Schema uses unsupported JSON Schema features:\n${errorMessages.join('\n')}`);
    }

    const resolution = resolveSchemaName(options.schemaName, loaded.schemaName);
    const schemaName = resolution.schemaName;

    // Check if schema already exists
    const existingSchema = await client.getSchemaByName(schemaName).catch(() => null);

    let diff: SchemaDiff | undefined;

    if (existingSchema) {
        diff = computeSchemaDiff(loaded.jsonSchema, existingSchema.jsonSchema);

        const result = await client.pushSchemaVersion(existingSchema.id, {
            jsonSchema: loaded.jsonSchema,
            changeDescription: options.description,
        });

        return { success: true, schema: result.schema, version: result.version, diff, schemaName, created: false, warning: resolution.warning };
    }

    const schema = await client.createSchema({
        name: schemaName,
        jsonSchema: loaded.jsonSchema,
        description: options.description,
    });

    return { success: true, schema, schemaName, created: true, warning: resolution.warning };
}

function DiffDisplay({ diff }: { diff: SchemaDiff }) {
    if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
        return (
            <Box marginTop={1}>
                <Text color={BRAND.gray}>No changes detected.</Text>
            </Box>
        );
    }

    return (
        <Box flexDirection="column" borderStyle="round" borderColor={BRAND.darkBlue} paddingX={1} marginY={1}>
            <Text color={BRAND.darkBlue} bold>
                Schema diff
            </Text>
            {diff.added.map((k) => (
                <Text key={k} color={BRAND.teal}>
                    {'  + '}
                    {k}
                </Text>
            ))}
            {diff.removed.map((k) => (
                <Text key={k} color={BRAND.red}>
                    {'  - '}
                    {k}
                </Text>
            ))}
            {diff.changed.map((k) => (
                <Text key={k} color={BRAND.yellow}>
                    {'  ~ '}
                    {k}
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
    const [result, setResult] = useState<PushLogicResult | null>(null);
    const [error, setError] = useState<{ message: string; hint?: string } | null>(null);

    useEffect(() => {
        (async () => {
            const now = Date.now();
            setTasks((t) => t.map((task, i) => (i === 0 ? { ...task, status: 'running', startedAt: now } : task)));
            try {
                setTasks((t) => [{ ...t[0], status: 'done' }, { ...t[1], status: 'running', startedAt: Date.now() }, t[2]]);
                const res = await pushLogic(options);
                setTasks([
                    { label: 'Loading local schema', status: 'done' },
                    { label: 'Validating schema', status: 'done' },
                    { label: 'Pushing to platform', status: 'done' },
                ]);
                setResult(res);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                setTasks((t) => t.map((task) => (task.status === 'running' ? { ...task, status: 'error', error: message } : task)));
                setError({
                    message,
                    hint: /schema name/i.test(message)
                        ? 'Pass --schema-name, or add `export const schemaName = "your-schema"` to .smooai-config/config.ts.'
                        : /Invalid JSON Schema/i.test(message)
                          ? 'Check .smooai-config/schema.json is a valid JSON Schema draft-07 document.'
                          : undefined,
                });
            }
        })();
    }, []);

    const keyCount = (() => {
        const schema = result?.schema as { jsonSchema?: { properties?: Record<string, unknown> } } | undefined;
        return Object.keys(schema?.jsonSchema?.properties ?? {}).length;
    })();

    return (
        <Box flexDirection="column">
            <Banner title="Push schema" subtitle={options.schemaName ?? '(auto-detected name)'} />
            <SummaryPanel
                title="Target"
                rows={[
                    { label: 'name', value: options.schemaName ?? '(from config.ts)', color: BRAND.teal },
                    ...(options.description ? [{ label: 'desc', value: options.description, color: BRAND.darkBlue }] : []),
                ]}
            />
            <TaskList tasks={tasks} />
            {result?.warning && (
                <Box marginTop={1}>
                    <Text color={BRAND.yellow}>{'⚠ '}</Text>
                    <Text color={BRAND.yellow}>{result.warning}</Text>
                </Box>
            )}
            {result?.diff && <DiffDisplay diff={result.diff} />}
            {result && (
                <SuccessPanel title={result.created ? 'Schema created' : 'Schema updated'}>
                    <Text>
                        <Text color={BRAND.gray}>{'name   '}</Text>
                        <Text color={BRAND.teal} bold>
                            {result.schemaName}
                        </Text>
                    </Text>
                    {keyCount > 0 && (
                        <Text>
                            <Text color={BRAND.gray}>{'keys   '}</Text>
                            <Text color={BRAND.orange}>{keyCount}</Text>
                        </Text>
                    )}
                </SuccessPanel>
            )}
            {error && <ErrorPanel title="Push failed" message={error.message} hint={error.hint} />}
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
