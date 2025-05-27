/* eslint-disable @typescript-eslint/no-explicit-any -- ok */
import { runAsWorker } from 'synckit';
import buildConfigObject from './server.async';

runAsWorker(async function getPublicConfigSync(...args: any[]) {
    const configSchema = args[0];
    const key = args[1] as any;
    const config = buildConfigObject(configSchema);
    return config.getPublicConfig(key as never);
});
