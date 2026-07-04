# Schema Usage Examples

This library supports multiple schema validation libraries through the [StandardSchema](https://github.com/standard-schema/standard-schema) specification.

## Supported Schema Types

### Built-in Schema Types

```typescript
import { defineConfig, StringSchema, BooleanSchema, NumberSchema } from '@smooai/config';

const config = defineConfig({
    publicConfigSchema: {
        apiUrl: StringSchema, // string
        enableDebug: BooleanSchema, // boolean
        maxRetries: NumberSchema, // number
    },
});
```

### Zod Schemas (v4)

```typescript
import { z } from 'zod';
import { defineConfig } from '@smooai/config';

const config = defineConfig({
    publicConfigSchema: {
        apiUrl: z.string().url(),
        database: z.object({
            host: z.string(),
            port: z.number().int().positive(),
            ssl: z.boolean(),
        }),
        retryConfig: z.object({
            maxAttempts: z.number().min(1).max(10),
            delay: z.number().positive(),
        }),
    },
});
```

### Valibot Schemas

```typescript
import * as v from 'valibot';
import { defineConfig } from '@smooai/config';

const config = defineConfig({
    publicConfigSchema: {
        apiUrl: v.pipe(v.string(), v.url()),
        userPreferences: v.object({
            theme: v.picklist(['light', 'dark']),
            language: v.string(),
        }),
    },
});
```

### ArkType Schemas

```typescript
import { type } from 'arktype';
import { defineConfig } from '@smooai/config';

const config = defineConfig({
    publicConfigSchema: {
        apiUrl: type('string'),
        config: type({
            enabled: 'boolean',
            priority: 'number',
        }),
    },
});
```

## Limits (the fourth config kind) — SMOODEV-2306

Limits are **numeric, segment-resolved, clamp-aware** config values. Unlike a
hard cap, a limit is a soft, tunable target: the consuming code always applies
its own hard clamp, and the config value only tunes within `[min, max]`.
Limits resolve **live** through the same server-side segment evaluator as
feature flags (never baked), so they flip without a redeploy.

Declare them with `defineLimit` in a `limitsSchema` tier:

```typescript
import { defineConfig, defineLimit } from '@smooai/config';

const config = defineConfig({
    limitsSchema: {
        // server resolves the raw/segmented number; the CLIENT clamps into
        // [min, max], falling back to `default`.
        agentMaxIterations: defineLimit({ default: 12, min: 1, max: 50 }),
        maxTokens: defineLimit({ default: 4096, step: 256 }),
    },
});

config.LimitKeys; // { AGENT_MAX_ITERATIONS: 'agentMaxIterations', MAX_TOKENS: 'maxTokens' }
```

`defineLimit` fields: `default` (fallback + `getLimit()` value), `min`/`max`
(inclusive clamp bounds), `step` (snap to nearest multiple before clamping).

Read them via the `limit` tier (or the raw client + `clampLimit`):

```typescript
import { buildClientConfig, clampLimit } from '@smooai/config/client';

const client = buildClientConfig(config);

// Sync fallback — baked/env value or the schema default, clamped:
const iterations = client.limit.getLimit('agentMaxIterations'); // number

// Live, segment-resolved, clamped into [min, max]:
const { value, rawValue, source } = await client.limit.evaluateLimit('agentMaxIterations', {
    orgId,
    agentId,
});
```

Full design + polyglot surface (Rust / Python / Go / .NET `evaluate_limit` +
clamp): see [`DESIGN-limits.md`](./DESIGN-limits.md).

## Mixed Schema Usage

You can mix different schema types within the same configuration:

```typescript
import { z } from 'zod';
import * as v from 'valibot';
import { defineConfig, StringSchema, BooleanSchema } from '@smooai/config';

const config = defineConfig({
    publicConfigSchema: {
        // Built-in types
        simpleApiKey: StringSchema,
        debugMode: BooleanSchema,

        // Zod schemas
        database: z.object({
            host: z.string(),
            port: z.number(),
        }),

        // Valibot schemas
        userSettings: v.object({
            notifications: v.boolean(),
            language: v.string(),
        }),
    },
});
```

## Key Benefits

1. **StandardSchema Compatibility**: Any validation library that implements StandardSchema works automatically
2. **Type Safety**: Full TypeScript inference for all schema types
3. **Performance**: Synchronous validation for fast configuration loading
4. **Flexibility**: Use your preferred validation library without restrictions
5. **Ecosystem**: Works with Zod, Valibot, ArkType, Effect Schema, and more

## Adding New Schema Libraries

To use a new StandardSchema-compliant library:

1. Install the library: `npm install your-schema-lib`
2. Import and use directly in your config schemas
3. The library will automatically handle validation through the StandardSchema interface

No additional setup or adapters required!
