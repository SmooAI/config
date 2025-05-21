import { describe, it, expect, vi, beforeEach } from 'vitest';
import { findAndProcessEnvConfig } from './findAndProcessEnvConfig';
import { defineConfig, StringSchema, NumberSchema, BooleanSchema } from './config';
import { PublicConfigKey } from './PublicConfigKey';
import { envToUse } from '@/utils';
import { getCloudRegion } from './getCloudRegion';

// Mock dependencies
vi.mock('@/utils', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils')>();
    return {
        ...actual,
        envToUse: vi.fn(),
    };
});

vi.mock('./getCloudRegion', () => ({
    getCloudRegion: vi.fn(),
}));

describe('findAndProcessEnvConfig', () => {
    const mockConfigSchema = defineConfig({
        publicConfigSchema: {
            TEST_STRING: StringSchema,
            TEST_NUMBER: NumberSchema,
            TEST_BOOLEAN: BooleanSchema,
        },
    });

    beforeEach(() => {
        vi.clearAllMocks();
        // Reset environment
        process.env = {};
    });

    it('should process environment variables with prefix', () => {
        // Mock environment variables
        const mockEnv = {
            NEXT_PUBLIC_TEST_STRING: 'test',
            NEXT_PUBLIC_TEST_NUMBER: '42',
            NEXT_PUBLIC_TEST_BOOLEAN: 'true',
            SMOOAI_CONFIG_ENV: 'test',
        };

        vi.mocked(envToUse).mockReturnValue(mockEnv);
        vi.mocked(getCloudRegion).mockReturnValue({ provider: 'aws', region: 'us-west-2' });

        const result = findAndProcessEnvConfig(mockConfigSchema, 'NEXT_PUBLIC_');

        expect(result.config).toEqual({
            TEST_STRING: 'test',
            TEST_NUMBER: 42,
            TEST_BOOLEAN: true,
            [PublicConfigKey.ENV]: 'test',
            [PublicConfigKey.REGION]: 'us-west-2',
            [PublicConfigKey.CLOUD_PROVIDER]: 'aws',
            [PublicConfigKey.IS_LOCAL]: false,
        });
    });

    it('should process environment variables without prefix', () => {
        const mockEnv = {
            TEST_STRING: 'test',
            TEST_NUMBER: '42',
            TEST_BOOLEAN: 'true',
            SMOOAI_CONFIG_ENV: 'test',
        };

        vi.mocked(envToUse).mockReturnValue(mockEnv);
        vi.mocked(getCloudRegion).mockReturnValue({ provider: 'aws', region: 'us-west-2' });

        const result = findAndProcessEnvConfig(mockConfigSchema);

        expect(result.config).toEqual({
            TEST_STRING: 'test',
            TEST_NUMBER: 42,
            TEST_BOOLEAN: true,
            [PublicConfigKey.ENV]: 'test',
            [PublicConfigKey.REGION]: 'us-west-2',
            [PublicConfigKey.CLOUD_PROVIDER]: 'aws',
            [PublicConfigKey.IS_LOCAL]: false,
        });
    });

    it('should handle invalid environment variables gracefully', () => {
        const mockEnv = {
            NEXT_PUBLIC_TEST_STRING: 'test',
            NEXT_PUBLIC_TEST_NUMBER: 'not-a-number', // Invalid number
            NEXT_PUBLIC_TEST_BOOLEAN: 'not-a-boolean', // Invalid boolean
            SMOOAI_CONFIG_ENV: 'test',
        };

        vi.mocked(envToUse).mockReturnValue(mockEnv);
        vi.mocked(getCloudRegion).mockReturnValue({ provider: 'aws', region: 'us-west-2' });

        const result = findAndProcessEnvConfig(mockConfigSchema, 'NEXT_PUBLIC_');

        // Should only include valid values
        expect(result.config).toEqual({
            TEST_STRING: 'test',
            TEST_BOOLEAN: false,
            [PublicConfigKey.ENV]: 'test',
            [PublicConfigKey.REGION]: 'us-west-2',
            [PublicConfigKey.CLOUD_PROVIDER]: 'aws',
            [PublicConfigKey.IS_LOCAL]: false,
        });
    });

    it('should handle local environment correctly', () => {
        const mockEnv = {
            IS_LOCAL: 'true',
            SMOOAI_CONFIG_ENV: 'test',
        };

        vi.mocked(envToUse).mockReturnValue(mockEnv);
        vi.mocked(getCloudRegion).mockReturnValue({ provider: 'aws', region: 'us-west-2' });

        const result = findAndProcessEnvConfig(mockConfigSchema);

        expect(result.config[PublicConfigKey.IS_LOCAL]).toBe(true);
    });

    it('should throw error when envToUse fails', () => {
        vi.mocked(envToUse).mockImplementation(() => {
            throw new Error('Failed to get environment');
        });

        expect(() => findAndProcessEnvConfig(mockConfigSchema)).toThrow('Failed to get environment');
    });
});
