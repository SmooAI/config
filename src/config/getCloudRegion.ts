import { isRunningInBrowser } from '@smooai/utils/env/env';
import { envToUse } from '@/utils';
type CloudProvider = 'aws' | 'azure' | 'gcp' | 'unknown';

interface CloudRegionResult {
    provider: CloudProvider | 'browser' | string;
    region: string;
}

export function getCloudRegion(env = envToUse()): CloudRegionResult {
    if (env.SMOOAI_CONFIG_CLOUD_REGION || env.SMOOAI_CONFIG_CLOUD_PROVIDER) {
        return {
            provider: env.SMOOAI_CONFIG_CLOUD_PROVIDER ?? 'unknown',
            region: env.SMOOAI_CONFIG_CLOUD_REGION ?? 'unknown',
        };
    }
    // Check for AWS region
    if (env.AWS_REGION ?? env.AWS_DEFAULT_REGION) {
        return {
            provider: 'aws',
            region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? 'unknown',
        };
    }

    // Check for Azure region (custom conventions)
    if (env.AZURE_REGION ?? env.AZURE_LOCATION) {
        return {
            provider: 'azure',
            region: env.AZURE_REGION ?? env.AZURE_LOCATION ?? 'unknown',
        };
    }

    // Check for GCP region
    if (env.GOOGLE_CLOUD_REGION ?? env.CLOUDSDK_COMPUTE_REGION) {
        return {
            provider: 'gcp',
            region: env.GOOGLE_CLOUD_REGION ?? env.CLOUDSDK_COMPUTE_REGION ?? 'unknown',
        };
    }

    if (isRunningInBrowser()) {
        return {
            provider: 'browser',
            region: 'unknown',
        };
    }

    // Default fallback for unrecognized environments
    return {
        provider: 'unknown',
        region: 'unknown',
    };
}
