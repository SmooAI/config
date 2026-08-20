#!/usr/bin/env node

/**
 * Synchronizes the version in root package.json to every version-bearing file
 * in the repo, across all seven language SDKs.
 *
 * Two modes, deliberately sharing one TARGETS list so the checker can never
 * drift from the syncer:
 *
 *   node scripts/sync-versions.mjs           rewrite the manifests
 *   node scripts/sync-versions.mjs --check   assert they already match (CI)
 *
 * --check fails on two distinct conditions, and the second one matters more:
 * a version mismatch, OR a pattern that no longer matches its file at all.
 * Kotlin sat at the default 0.1.0 while every other language rode 6.11.x
 * precisely because an unmatched pattern is silent — a no-op sync looks
 * exactly like an already-synced one.
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const checkOnly = process.argv.includes('--check');

const packageJson = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
const version = packageJson.version;

/**
 * Every version-bearing file, one entry per language. `pattern` must match
 * exactly the version token; `replacement` may use $1/$2 to preserve context.
 */
const TARGETS = [
    {
        language: 'Python',
        path: join(rootDir, 'python', 'pyproject.toml'),
        pattern: /^version = ".*"$/m,
        replacement: `version = "${version}"`,
    },
    {
        language: 'Rust',
        path: join(rootDir, 'rust', 'config', 'Cargo.toml'),
        pattern: /^version = ".*"$/m,
        replacement: `version = "${version}"`,
    },
    {
        language: '.NET',
        path: join(rootDir, 'dotnet', 'src', 'SmooAI.Config', 'SmooAI.Config.csproj'),
        // Match only the top-level <Version> (not <PackageReference Version="..." />).
        pattern: /<Version>[^<]*<\/Version>/,
        replacement: `<Version>${version}</Version>`,
    },
    {
        language: 'Go',
        path: join(rootDir, 'go', 'config', 'version.go'),
        pattern: /const Version = ".*"/,
        replacement: `const Version = "${version}"`,
    },
    {
        language: 'Kotlin',
        // JitPack and the Central publish both pass -Pversion=<x.y.z>, so this
        // literal is the local/dev fallback — but it is also what a consumer
        // building from source gets, so it has to track the release train.
        path: join(rootDir, 'kotlin', 'build.gradle.kts'),
        pattern: /^(version = .*\?: ")[^"]*(")$/m,
        replacement: `$1${version}$2`,
    },
    {
        language: 'Swift',
        // SPM takes its version from the git tag, so Package.swift has no field
        // to sync. This constant is the only version-bearing token Swift has —
        // it is what makes the SDK auditable by --check, and mirrors go/config/version.go.
        path: join(rootDir, 'swift', 'Sources', 'SmooAIConfig', 'Version.swift'),
        pattern: /public static let version = ".*"/,
        replacement: `public static let version = "${version}"`,
    },
];

if (!checkOnly) {
    console.log(`Syncing version ${version} to all sub-packages...`);
}

const failures = [];

for (const target of TARGETS) {
    const shortPath = relative(rootDir, target.path);
    let content;

    try {
        content = readFileSync(target.path, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') {
            // Never a soft skip: a missing manifest means a language dropped off
            // the release train, which is the whole defect this guards.
            failures.push(`${target.language}: ${shortPath} does not exist`);
            continue;
        }
        throw error;
    }

    if (!target.pattern.test(content)) {
        failures.push(
            `${target.language}: ${shortPath} — version pattern ${target.pattern} no longer matches; sync-versions.mjs needs updating for this file's format`,
        );
        continue;
    }

    const updated = content.replace(target.pattern, target.replacement);

    if (checkOnly) {
        if (content !== updated) {
            const found = content.match(target.pattern)?.[0] ?? '(unknown)';
            failures.push(`${target.language}: ${shortPath} — expected ${version}, found in \`${found.trim()}\``);
        }
        continue;
    }

    if (content !== updated) {
        writeFileSync(target.path, updated);
        console.log(`  ✅ Updated ${shortPath}`);
    } else {
        console.log(`  ✔ Already up to date: ${shortPath}`);
    }
}

if (checkOnly) {
    if (failures.length > 0) {
        console.error(`\n❌ Version drift — root package.json is ${version} but:\n`);
        for (const failure of failures) console.error(`  • ${failure}`);
        console.error(`\nRun \`pnpm run version:sync\` to fix.\n`);
        process.exit(1);
    }
    console.log(`✅ All ${TARGETS.length + 1} languages on ${version} (package.json + ${TARGETS.length} synced manifests).`);
    process.exit(0);
}

if (failures.length > 0) {
    console.error(`\n❌ Could not sync every manifest:\n`);
    for (const failure of failures) console.error(`  • ${failure}`);
    process.exit(1);
}

// Regenerate Cargo.lock to match updated Cargo.toml version
try {
    execSync('cargo generate-lockfile --manifest-path rust/config/Cargo.toml', {
        cwd: rootDir,
        stdio: 'inherit',
    });
    console.log('  ✅ Regenerated rust/config/Cargo.lock');
} catch {
    console.log('  ⚠ Could not regenerate Cargo.lock (cargo not available)');
}

console.log('Done!');
