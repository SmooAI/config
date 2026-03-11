export { getConfig } from './getConfig';
export type { GetConfigOptions } from './getConfig';

// Client components re-exported for backwards compatibility.
// Prefer importing from '@smooai/config/nextjs/client' to avoid
// pulling React (createContext) into server bundles.
export { SmooConfigProvider } from './SmooConfigProvider';
export type { SmooConfigProviderProps } from './SmooConfigProvider';
export { usePublicConfig, useFeatureFlag } from './hooks';
