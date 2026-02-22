#!/usr/bin/env node

/**
 * Synchronizes version from package.json to all sub-package manifests.
 * Following the pattern from @smooai/logger.
 */

import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

// Read version from root package.json
const packageJson = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
const version = packageJson.version;

console.log(`Syncing version ${version} to all sub-packages...`);

// Files to update
const files = [
    {
        path: join(rootDir, 'python', 'pyproject.toml'),
        pattern: /^version = ".*"$/m,
        replacement: `version = "${version}"`,
    },
    {
        path: join(rootDir, 'rust', 'config', 'Cargo.toml'),
        pattern: /^version = ".*"$/m,
        replacement: `version = "${version}"`,
    },
]

// Go doesn't have a version file in go.mod, but we can add a version.go constant
const goVersionFile = join(rootDir, 'go', 'config', 'version.go');
files.push({
    path: goVersionFile,
    pattern: /const Version = ".*"/,
    replacement: `const Version = "${version}"`,
});

for (const file of files) {
    try {
        const content = readFileSync(file.path, 'utf8');
        const updated = content.replace(file.pattern, file.replacement);
        if (content !== updated) {
            writeFileSync(file.path, updated);
            console.log(`  ✅ Updated ${file.path}`);
        } else {
            console.log(`  ✔ Already up to date: ${file.path}`);
        }
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log(`  ⚠ Skipped (not found): ${file.path}`);
        } else {
            throw error;
        }
    }
}

console.log('Done!');
