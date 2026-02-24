import { Command } from 'commander';

const program = new Command();

program.name('smooai-config').description('Smoo AI Configuration Management CLI').version('1.1.0');

// Global --json flag
program.option('--json', 'Output in JSON format (auto-enabled when no TTY detected)');

program
    .command('init')
    .description('Initialize a project with .smooai-config/ directory')
    .option('--language <lang>', 'Project language: typescript, python, go, rust, other', 'typescript')
    .action(async (opts) => {
        const { runInit } = await import('./commands/init');
        runInit({ ...opts, json: program.opts().json ?? opts.json });
    });

program
    .command('login')
    .description('Store credentials for CLI access')
    .option('--api-key <key>', 'API key for authentication')
    .option('--org-id <id>', 'Organization ID')
    .option('--base-url <url>', 'API base URL', 'https://api.smoo.ai')
    .action(async (opts) => {
        const { runLogin } = await import('./commands/login');
        runLogin({ ...opts, json: program.opts().json ?? opts.json });
    });

program
    .command('push')
    .description('Push local config schema to the remote platform')
    .option('--schema-name <name>', 'Schema name (default: project directory name)')
    .option('--description <desc>', 'Change description for this version')
    .option('--yes', 'Skip confirmation prompt')
    .action(async (opts) => {
        const { runPush } = await import('./commands/push');
        runPush({ ...opts, json: program.opts().json ?? opts.json });
    });

program
    .command('pull')
    .description('Pull remote config values to local files')
    .option('--environment <env>', 'Environment name', 'development')
    .action(async (opts) => {
        const { runPull } = await import('./commands/pull');
        runPull({ ...opts, json: program.opts().json ?? opts.json });
    });

program
    .command('set <key> <value>')
    .description('Set a config value on the remote platform')
    .option('--environment <env>', 'Environment name', 'development')
    .option('--tier <tier>', 'Value tier: public, secret, feature_flag', 'public')
    .option('--schema-name <name>', 'Schema name to use for validation')
    .action(async (key: string, value: string, opts) => {
        const { runSet } = await import('./commands/set');
        runSet(key, value, { ...opts, json: program.opts().json ?? opts.json });
    });

program
    .command('get <key>')
    .description('Get a config value from the remote platform')
    .option('--environment <env>', 'Environment name', 'development')
    .action(async (key: string, opts) => {
        const { runGet } = await import('./commands/get');
        runGet(key, { ...opts, json: program.opts().json ?? opts.json });
    });

program
    .command('list')
    .description('List all config values for an environment')
    .option('--environment <env>', 'Environment name', 'development')
    .action(async (opts) => {
        const { runList } = await import('./commands/list');
        runList({ ...opts, json: program.opts().json ?? opts.json });
    });

program
    .command('diff')
    .description('Compare local config schema vs remote')
    .option('--schema-name <name>', 'Schema name to compare against')
    .action(async (opts) => {
        const { runDiff } = await import('./commands/diff');
        runDiff({ ...opts, json: program.opts().json ?? opts.json });
    });

program.parse();
