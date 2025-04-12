import { describe, it, expect } from 'vitest';
import { getCloudRegion } from './getCloudRegion';

describe('getCloudRegion', () => {
    it('should return custom cloud region and provider when specified', () => {
        const env = {
            SMOOAI_CONFIG_CLOUD_REGION: 'custom-region',
            SMOOAI_CONFIG_CLOUD_PROVIDER: 'custom-provider'
        };
        expect(getCloudRegion(env)).toEqual({
            provider: 'custom-provider',
            region: 'custom-region'
        });
    });

    it('should return AWS region when AWS environment variables are present', () => {
        const env = {
            AWS_REGION: 'us-east-1'
        };
        expect(getCloudRegion(env)).toEqual({
            provider: 'aws',
            region: 'us-east-1'
        });

        const envWithDefault = {
            AWS_DEFAULT_REGION: 'eu-west-1'
        };
        expect(getCloudRegion(envWithDefault)).toEqual({
            provider: 'aws',
            region: 'eu-west-1'
        });
    });

    it('should return Azure region when Azure environment variables are present', () => {
        const env = {
            AZURE_REGION: 'eastus'
        };
        expect(getCloudRegion(env)).toEqual({
            provider: 'azure',
            region: 'eastus'
        });

        const envWithLocation = {
            AZURE_LOCATION: 'westeurope'
        };
        expect(getCloudRegion(envWithLocation)).toEqual({
            provider: 'azure',
            region: 'westeurope'
        });
    });

    it('should return GCP region when GCP environment variables are present', () => {
        const env = {
            GOOGLE_CLOUD_REGION: 'us-central1'
        };
        expect(getCloudRegion(env)).toEqual({
            provider: 'gcp',
            region: 'us-central1'
        });

        const envWithCloudSdk = {
            CLOUDSDK_COMPUTE_REGION: 'europe-west1'
        };
        expect(getCloudRegion(envWithCloudSdk)).toEqual({
            provider: 'gcp',
            region: 'europe-west1'
        });
    });

    it('should return unknown provider and null region when no cloud environment variables are present', () => {
        const env = {};
        expect(getCloudRegion(env)).toEqual({
            provider: 'unknown',
            region: null
        });
    });

    it('should handle empty environment object', () => {
        expect(getCloudRegion({})).toEqual({
            provider: 'unknown',
            region: null
        });
    });

    it('should handle undefined environment', () => {
        expect(getCloudRegion()).toEqual({
            provider: 'unknown',
            region: null
        });
    });
}); 