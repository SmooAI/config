#!/usr/bin/env node

/**
 * Asserts that whatever version npm has, the other four registries have too.
 *
 *   node scripts/check-registry-parity.mjs
 *
 * This repo's whole proposition is one version in lockstep across npm, PyPI,
 * crates.io, NuGet and the Go module proxy. Nothing checked that, and it broke
 * silently: bumping `@changesets/cli` to 3.x changed its publish output from
 * `🦋 New tag: …` to `◇ Successfully published:`, which `changesets/action@v1`
 * parses to set its `published` output. The output stayed false, every
 * non-npm publish step was gated on it, and so all four skipped — while the
 * release job reported success. Three releases (6.11.6, 6.11.7, 6.12.0) went to
 * npm alone before anyone noticed.
 *
 * Deliberately anchored on npm's latest rather than package.json: changesets
 * publishes npm first, so if npm does not have the version either, no claim is
 * made and this cannot false-fire on a run that legitimately published nothing.
 */

import { execFileSync } from 'child_process';

const PACKAGES = {
    npm: 'https://registry.npmjs.org/@smooai/config',
    pypi: 'https://pypi.org/pypi/smooai-config/json',
    crates: 'https://crates.io/api/v1/crates/smooai-config',
    nuget: 'https://api.nuget.org/v3-flatcontainer/smooai.config/index.json',
};

const HEADERS = { 'User-Agent': 'smooai-config-release-check (github.com/SmooAI/config)' };

async function fetchJson(url) {
    const response = await fetch(url, { headers: HEADERS });
    if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
    return response.json();
}

async function npmLatest() {
    const body = await fetchJson(PACKAGES.npm);
    return body['dist-tags']?.latest;
}

async function hasVersion(registry, version) {
    switch (registry) {
        case 'PyPI':
            return Object.hasOwn((await fetchJson(PACKAGES.pypi)).releases ?? {}, version);
        case 'crates.io':
            return ((await fetchJson(PACKAGES.crates)).versions ?? []).some((entry) => entry.num === version);
        case 'NuGet':
            // NuGet lowercases and normalizes versions in the flat container.
            return ((await fetchJson(PACKAGES.nuget)).versions ?? []).includes(version.toLowerCase());
        case 'Go module tag': {
            const tags = execFileSync('git', ['ls-remote', '--tags', 'origin', `refs/tags/go/config/v${version}`], { encoding: 'utf8' });
            return tags.trim().length > 0;
        }
        default:
            throw new Error(`unknown registry ${registry}`);
    }
}

const REGISTRIES = ['PyPI', 'crates.io', 'NuGet', 'Go module tag'];
const ATTEMPTS = 6;
const BACKOFF_MS = 20_000;

let version;
let missing = REGISTRIES;

// npm's own metadata is read INSIDE the loop, not once up front. It is served
// from a CDN and lags its own publish by seconds — the first run of this guard
// failed a green release because it read `latest` as the previous version and
// then dutifully reported four registries "missing" a version nobody had
// published. Re-reading makes a stale read self-correcting instead of fatal.
for (let attempt = 1; attempt <= ATTEMPTS && missing.length > 0; attempt++) {
    try {
        version = await npmLatest();
    } catch (error) {
        console.log(`… npm lookup failed (attempt ${attempt}): ${error.message}`);
        await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS));
        continue;
    }

    if (!version) {
        console.error('❌ Could not read the latest @smooai/config version from npm.');
        process.exit(1);
    }

    const stillMissing = [];
    for (const registry of missing) {
        try {
            if (!(await hasVersion(registry, version))) stillMissing.push(registry);
        } catch (error) {
            console.log(`… ${registry} lookup failed (attempt ${attempt}): ${error.message}`);
            stillMissing.push(registry);
        }
    }
    missing = stillMissing;

    console.log(`attempt ${attempt}: npm latest ${version} — missing from ${missing.length > 0 ? missing.join(', ') : 'nothing'}`);

    if (missing.length > 0 && attempt < ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS));
}

if (missing.length > 0) {
    console.error(`\n❌ npm published ${version} but ${missing.join(', ')} did not.`);
    console.error(`   The publish steps are gated on the changesets action's \`published\` output —`);
    console.error(`   if that output is false the steps SKIP and the job still reports success.`);
    console.error(`   Check that @changesets/cli's version still matches what changesets/action parses.\n`);
    process.exit(1);
}

console.log(`\n✅ All five registries are on ${version}.`);
