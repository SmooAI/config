/* eslint-disable @typescript-eslint/no-explicit-any -- ok */
import { runAsWorker } from 'synckit';
import buildConfigObject from './server.async';
import { defineConfig } from '@/config/config';

runAsWorker(async function getFeatureFlagSync<Schema extends ReturnType<typeof defineConfig>>(...args: any[]) {
    const configSchema = args[0];
    const key = args[1] as any;
    const config = buildConfigObject(configSchema);
    return config.getFeatureFlag<never>(key as never);
});
