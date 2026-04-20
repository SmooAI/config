// Ambient declaration for the build-time-generated worker source.
//
// The actual `sync-worker-source.generated.ts` is emitted by
// `scripts/build-sync-worker.mjs` before `tsup` runs, and gitignored
// because it carries the full bundled worker source (~1.5 MiB). This
// tiny `.d.ts` stub lets `pnpm typecheck` find the module before the
// generator has run.
export const WORKER_SOURCE: string;
