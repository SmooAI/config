export default class Logger {
    constructor(..._args: unknown[]) {}
    info() {}
    warn() {}
    error() {}
    debug() {}
}
export function createEsmUtils() {
    return { __dirname: '', __filename: '' };
}
