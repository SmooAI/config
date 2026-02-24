/**
 * Dual-mode output utilities for CLI commands.
 * Supports both interactive (Ink TUI) and non-interactive (JSON) output.
 */

export function isInteractive(jsonFlag?: boolean): boolean {
    if (jsonFlag) return false;
    return Boolean(process.stdout.isTTY);
}

export function jsonOutput(data: unknown, exitCode = 0): never {
    console.log(JSON.stringify(data, null, 2));
    process.exit(exitCode);
}

export function errorOutput(message: string, details?: unknown): never {
    if (isInteractive()) {
        console.error(`Error: ${message}`);
        if (details) console.error(details);
        process.exit(1);
    }
    jsonOutput({ success: false, error: message, details }, 1);
}
