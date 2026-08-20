#!/usr/bin/env node

/**
 * Runs a command only if its toolchain is available.
 *
 *   node scripts/with-toolchain.mjs <bin> <command> [args...]
 *
 * Three outcomes, and the difference between them is the whole point:
 *
 *   1. Toolchain present            → run it.
 *   2. Missing, locally             → print "skipped", exit 0. A contributor
 *                                     without the .NET SDK / JDK / Swift can
 *                                     still run `check-all` and get a clear
 *                                     line saying what did not run.
 *   3. Missing, under CI            → HARD FAILURE, unless the workflow named
 *                                     it in SMOOAI_SKIP_TOOLCHAINS.
 *
 * (3) is the rule that matters. `check-all` claimed "full CI parity" while
 * .NET, Kotlin and Swift were never in it; a silent skip is indistinguishable
 * from a pass, so CI has to refuse one it was not told to expect.
 *
 * SMOOAI_SKIP_TOOLCHAINS is a comma-separated list of bins this job
 * deliberately does not own — swift/kotlin run in their own workflow jobs
 * (macOS runner, JDK setup). A declared skip is honoured even when the bin
 * happens to be present, so the owning job stays the single place it runs.
 */

import { spawnSync } from 'child_process';

const [bin, ...command] = process.argv.slice(2);

if (!bin || command.length === 0) {
    console.error('usage: with-toolchain.mjs <bin> <command> [args...]');
    process.exit(2);
}

const declaredSkips = (process.env.SMOOAI_SKIP_TOOLCHAINS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

if (declaredSkips.includes(bin)) {
    console.log(`⏭  skipped \`${bin}\`: declared in SMOOAI_SKIP_TOOLCHAINS (another job owns it).`);
    process.exit(0);
}

const installed = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' }).status === 0;

if (!installed) {
    if (process.env.CI) {
        console.error(`❌ \`${bin}\` is not on PATH and CI must never silently skip a language.`);
        console.error(`   Either add its setup step to this job, or name it in SMOOAI_SKIP_TOOLCHAINS`);
        console.error(`   to declare that another job owns it.`);
        process.exit(1);
    }
    console.log(`⏭  skipped: no \`${bin}\` on PATH — install it, or set CI=1 to make this a failure.`);
    process.exit(0);
}

const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit' });

if (result.error) {
    console.error(`❌ failed to run \`${command.join(' ')}\`: ${result.error.message}`);
    process.exit(1);
}

process.exit(result.status ?? 1);
