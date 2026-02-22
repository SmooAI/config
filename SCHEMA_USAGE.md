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
