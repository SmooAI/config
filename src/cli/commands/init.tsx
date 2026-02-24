import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { render, Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';
import { Banner } from '../components/Banner';
import { TaskList, type TaskItem } from '../components/TaskList';
import { isInteractive, jsonOutput } from '../utils/output';

interface InitOptions {
    json?: boolean;
    language?: string;
}

const TS_DEFAULT_CONFIG = `import { defineConfig, StringSchema, BooleanSchema, NumberSchema } from '@smooai/config';

// Define your configuration schema
export default defineConfig({
    publicConfigSchema: {
        // Add your public config keys here
        // Example: apiUrl: StringSchema,
    },
    secretConfigSchema: {
        // Add your secret config keys here
        // Example: databaseUrl: StringSchema,
    },
    featureFlagSchema: {
        // Add your feature flag keys here
        // Example: enableNewFeature: BooleanSchema,
    },
});
`;

const TS_ENV_CONFIG = `// Environment-specific overrides for development
// Import your config definition to get type-safe keys
// import config from './config';

export default {
    // Override config values for this environment
};
`;

const JSON_SCHEMA_STARTER = JSON.stringify(
    {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {
            public: {
                type: 'object',
                properties: {},
                description: 'Public configuration values',
            },
            secret: {
                type: 'object',
                properties: {},
                description: 'Secret configuration values',
            },
            featureFlags: {
                type: 'object',
                properties: {},
                description: 'Feature flag values',
            },
        },
    },
    null,
    2,
);

const JSON_ENV_STARTER = JSON.stringify(
    {
        public: {},
        secret: {},
        featureFlags: {},
    },
    null,
    2,
);

export async function initLogic(options: InitOptions): Promise<{ success: boolean; filesCreated: string[] }> {
    const configDir = join(process.cwd(), '.smooai-config');
    const filesCreated: string[] = [];
    const language = options.language ?? 'typescript';
    const isTs = language === 'typescript';

    // Create config directory
    if (!existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true });
        filesCreated.push('.smooai-config/');
    }

    if (isTs) {
        // Create default.ts
        const defaultPath = join(configDir, 'default.ts');
        if (!existsSync(defaultPath)) {
            writeFileSync(defaultPath, TS_DEFAULT_CONFIG);
            filesCreated.push('.smooai-config/default.ts');
        }

        // Create development.ts stub
        const devPath = join(configDir, 'development.ts');
        if (!existsSync(devPath)) {
            writeFileSync(devPath, TS_ENV_CONFIG);
            filesCreated.push('.smooai-config/development.ts');
        }
    } else {
        // Create schema.json
        const schemaPath = join(configDir, 'schema.json');
        if (!existsSync(schemaPath)) {
            writeFileSync(schemaPath, JSON_SCHEMA_STARTER);
            filesCreated.push('.smooai-config/schema.json');
        }

        // Create development.json stub
        const devPath = join(configDir, 'development.json');
        if (!existsSync(devPath)) {
            writeFileSync(devPath, JSON_ENV_STARTER);
            filesCreated.push('.smooai-config/development.json');
        }
    }

    // Add local.* to .gitignore
    const gitignorePath = join(process.cwd(), '.gitignore');
    const localPattern = '.smooai-config/local.*';
    if (existsSync(gitignorePath)) {
        const content = readFileSync(gitignorePath, 'utf-8');
        if (!content.includes(localPattern)) {
            appendFileSync(gitignorePath, `\n# Smoo AI local config\n${localPattern}\n`);
            filesCreated.push('.gitignore (updated)');
        }
    }

    return { success: true, filesCreated };
}

function InitUI({ options }: { options: InitOptions }) {
    const [tasks, setTasks] = useState<TaskItem[]>([
        { label: 'Creating .smooai-config/ directory', status: 'pending' },
        { label: 'Writing config files', status: 'pending' },
        { label: 'Updating .gitignore', status: 'pending' },
    ]);
    const [result, setResult] = useState<{ filesCreated: string[] } | null>(null);

    useEffect(() => {
        (async () => {
            setTasks((t) => t.map((task, i) => (i === 0 ? { ...task, status: 'running' } : task)));

            try {
                const res = await initLogic(options);

                setTasks([
                    { label: 'Creating .smooai-config/ directory', status: 'done' },
                    { label: 'Writing config files', status: 'done' },
                    { label: 'Updating .gitignore', status: 'done' },
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
            <Banner title="Initialize Project" />
            <TaskList tasks={tasks} />
            {result && (
                <Box marginTop={1} flexDirection="column">
                    <Text color="green" bold>
                        Project initialized!
                    </Text>
                    {result.filesCreated.map((f, i) => (
                        <Text key={i} color="gray">
                            {' '}
                            Created: {f}
                        </Text>
                    ))}
                </Box>
            )}
        </Box>
    );
}

export function runInit(options: InitOptions): void {
    if (!isInteractive(options.json)) {
        initLogic(options).then(
            (result) => jsonOutput(result),
            (err) => jsonOutput({ success: false, error: err.message }, 1),
        );
        return;
    }
    render(<InitUI options={options} />);
}
