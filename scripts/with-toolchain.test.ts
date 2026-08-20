import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('./with-toolchain.mjs', import.meta.url));

function run(args: string[], env: Record<string, string> = {}) {
    const result = spawnSync(process.execPath, [script, ...args], {
        encoding: 'utf8',
        // Strip any ambient CI so a local run and a CI run exercise the same branches.
        env: { ...process.env, CI: '', ...env },
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('with-toolchain', () => {
    it('skips a missing toolchain locally so check-all still runs', () => {
        const { status, output } = run(['nosuchbin', 'echo', 'ran']);
        expect(status).toBe(0);
        expect(output).toContain('skipped');
        expect(output).not.toContain('ran');
    });

    // The rule the whole script exists for: a silent skip is indistinguishable
    // from a pass, so CI has to refuse a toolchain it was not told to expect.
    it('FAILS on a missing toolchain under CI', () => {
        const { status, output } = run(['nosuchbin', 'echo', 'ran'], { CI: '1' });
        expect(status).toBe(1);
        expect(output).toContain('must never silently skip');
    });

    it('allows a skip that the workflow declared', () => {
        const { status, output } = run(['nosuchbin', 'echo', 'ran'], { CI: '1', SMOOAI_SKIP_TOOLCHAINS: 'a, nosuchbin ,b' });
        expect(status).toBe(0);
        expect(output).toContain('declared in SMOOAI_SKIP_TOOLCHAINS');
    });

    it('honours a declared skip even when the toolchain is present, so the owning job stays the only one that runs it', () => {
        const { status, output } = run(['echo', 'echo', 'ran'], { CI: '1', SMOOAI_SKIP_TOOLCHAINS: 'echo' });
        expect(status).toBe(0);
        expect(output).not.toContain('ran');
    });

    it('runs the command when the toolchain is present', () => {
        const { status, output } = run(['echo', 'echo', 'ran'], { CI: '1' });
        expect(status).toBe(0);
        expect(output).toContain('ran');
    });

    it('propagates a non-zero exit rather than swallowing it', () => {
        const { status } = run(['sh', 'sh', '-c', 'exit 3'], { CI: '1' });
        expect(status).toBe(3);
    });
});
