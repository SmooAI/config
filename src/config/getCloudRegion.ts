type CloudProvider = 'aws' | 'azure' | 'gcp' | 'unknown';

interface CloudRegionResult {
    provider: CloudProvider | string;
    region: string | null;
}

export function getCloudRegion(env = process?.env ?? {}): CloudRegionResult {
    if (env.SMOO_CONFIG_CLOUD_REGION || env.SMOO_CONFIG_CLOUD_PROVIDER) {
        return {
            provider: env.SMOO_CONFIG_CLOUD_PROVIDER || 'Unknown',
            region: env.SMOO_CONFIG_CLOUD_REGION || null,
        };
    }
    // Check for AWS region
    if (env.AWS_REGION || env.AWS_DEFAULT_REGION) {
        return {
            provider: 'aws',
            region: env.AWS_REGION || env.AWS_DEFAULT_REGION || null,
        };
    }

    // Check for Azure region (custom conventions)
    if (env.AZURE_REGION || env.AZURE_LOCATION) {
        return {
            provider: 'azure',
            region: env.AZURE_REGION || env.AZURE_LOCATION || null,
        };
    }

    // Check for GCP region
    if (env.GOOGLE_CLOUD_REGION || env.CLOUDSDK_COMPUTE_REGION) {
        return {
            provider: 'gcp',
            region: env.GOOGLE_CLOUD_REGION || env.CLOUDSDK_COMPUTE_REGION || null,
        };
    }

    // Default fallback for unrecognized environments
    return {
        provider: 'unknown',
        region: null,
    };
}
