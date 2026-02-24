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

const PYTHON_SCHEMA_GEN = `"""Schema generator for Smoo AI config.

Run this file to generate JSON Schema output:
    python3 schema_gen.py
"""

import json
import sys

from pydantic import BaseModel

from smooai_config.schema import define_config


class PublicConfig(BaseModel):
    # Add your public config fields here
    # Example: api_url: str = "https://api.example.com"
    pass


class SecretConfig(BaseModel):
    # Add your secret config fields here
    # Example: database_url: str
    pass


class FeatureFlags(BaseModel):
    # Add your feature flag fields here
    # Example: enable_new_feature: bool = False
    pass


config = define_config(
    public=PublicConfig,
    secret=SecretConfig,
    feature_flags=FeatureFlags,
)

# Print JSON Schema to stdout for CLI consumption
json.dump(config.json_schema, sys.stdout, indent=2)
`;

const GO_SCHEMA_GEN = [
    '// Schema generator for Smoo AI config.',
    '//',
    '// Run this file to generate JSON Schema output:',
    '//     go run main.go',
    'package main',
    '',
    'import (',
    '\t"encoding/json"',
    '\t"fmt"',
    '\t"log"',
    '',
    '\tconfig "github.com/SmooAI/config/go/config"',
    ')',
    '',
    '// PublicConfig defines public configuration values.',
    'type PublicConfig struct {',
    '\t// Add your public config fields here',
    '\t// Example: APIUrl string `json:"api_url"`',
    '}',
    '',
    '// SecretConfig defines secret configuration values.',
    'type SecretConfig struct {',
    '\t// Add your secret config fields here',
    '}',
    '',
    '// FeatureFlags defines feature flag values.',
    'type FeatureFlags struct {',
    '\t// Add your feature flag fields here',
    '}',
    '',
    'func main() {',
    '\tresult, err := config.DefineConfigTyped(&PublicConfig{}, &SecretConfig{}, &FeatureFlags{})',
    '\tif err != nil {',
    '\t\tlog.Fatal(err)',
    '\t}',
    '',
    '\tdata, err := json.MarshalIndent(result.JSONSchema, "", "  ")',
    '\tif err != nil {',
    '\t\tlog.Fatal(err)',
    '\t}',
    '\tfmt.Println(string(data))',
    '}',
    '',
].join('\n');

const RUST_CARGO_TOML = `[package]
name = "smooai-config-gen"
version = "0.1.0"
edition = "2021"

[dependencies]
smooai-config = "1"
schemars = { version = "0.8", features = ["derive"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
`;

const RUST_MAIN_RS = `//! Schema generator for Smoo AI config.
//!
//! Run this to generate JSON Schema output:
//!     cargo run --manifest-path .smooai-config/Cargo.toml

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use smooai_config::schema::{define_config_typed, EmptySchema};

/// Public configuration values.
#[derive(Default, Serialize, Deserialize, JsonSchema)]
struct PublicConfig {
    // Add your public config fields here
    // Example: api_url: String,
}

/// Secret configuration values.
#[derive(Default, Serialize, Deserialize, JsonSchema)]
struct SecretConfig {
    // Add your secret config fields here
}

/// Feature flag values.
#[derive(Default, Serialize, Deserialize, JsonSchema)]
struct FeatureFlags {
    // Add your feature flag fields here
}

fn main() {
    let config = define_config_typed::<PublicConfig, SecretConfig, FeatureFlags>();
    let json = serde_json::to_string_pretty(&config.json_schema).unwrap();
    println!("{}", json);
}
`;

export async function initLogic(options: InitOptions): Promise<{ success: boolean; filesCreated: string[] }> {
    const configDir = join(process.cwd(), '.smooai-config');
    const filesCreated: string[] = [];
    const language = options.language ?? 'typescript';

    // Create config directory
    if (!existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true });
        filesCreated.push('.smooai-config/');
    }

    switch (language) {
        case 'typescript': {
            const defaultPath = join(configDir, 'default.ts');
            if (!existsSync(defaultPath)) {
                writeFileSync(defaultPath, TS_DEFAULT_CONFIG);
                filesCreated.push('.smooai-config/default.ts');
            }
            const devPath = join(configDir, 'development.ts');
            if (!existsSync(devPath)) {
                writeFileSync(devPath, TS_ENV_CONFIG);
                filesCreated.push('.smooai-config/development.ts');
            }
            break;
        }
        case 'python': {
            const genPath = join(configDir, 'schema_gen.py');
            if (!existsSync(genPath)) {
                writeFileSync(genPath, PYTHON_SCHEMA_GEN);
                filesCreated.push('.smooai-config/schema_gen.py');
            }
            const devPath = join(configDir, 'development.json');
            if (!existsSync(devPath)) {
                writeFileSync(devPath, JSON_ENV_STARTER);
                filesCreated.push('.smooai-config/development.json');
            }
            break;
        }
        case 'go': {
            const genPath = join(configDir, 'main.go');
            if (!existsSync(genPath)) {
                writeFileSync(genPath, GO_SCHEMA_GEN);
                filesCreated.push('.smooai-config/main.go');
            }
            const devPath = join(configDir, 'development.json');
            if (!existsSync(devPath)) {
                writeFileSync(devPath, JSON_ENV_STARTER);
                filesCreated.push('.smooai-config/development.json');
            }
            break;
        }
        case 'rust': {
            // Rust needs a Cargo.toml + src/main.rs structure
            const cargoPath = join(configDir, 'Cargo.toml');
            if (!existsSync(cargoPath)) {
                writeFileSync(cargoPath, RUST_CARGO_TOML);
                filesCreated.push('.smooai-config/Cargo.toml');
            }
            const srcDir = join(configDir, 'src');
            if (!existsSync(srcDir)) {
                mkdirSync(srcDir, { recursive: true });
            }
            const mainPath = join(srcDir, 'main.rs');
            if (!existsSync(mainPath)) {
                writeFileSync(mainPath, RUST_MAIN_RS);
                filesCreated.push('.smooai-config/src/main.rs');
            }
            const devPath = join(configDir, 'development.json');
            if (!existsSync(devPath)) {
                writeFileSync(devPath, JSON_ENV_STARTER);
                filesCreated.push('.smooai-config/development.json');
            }
            break;
        }
        default: {
            // Fallback: JSON schema (language-agnostic)
            const schemaPath = join(configDir, 'schema.json');
            if (!existsSync(schemaPath)) {
                writeFileSync(schemaPath, JSON_SCHEMA_STARTER);
                filesCreated.push('.smooai-config/schema.json');
            }
            const devPath = join(configDir, 'development.json');
            if (!existsSync(devPath)) {
                writeFileSync(devPath, JSON_ENV_STARTER);
                filesCreated.push('.smooai-config/development.json');
            }
            break;
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
