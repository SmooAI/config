/**
 * Client-safe feature flag utilities.
 *
 * These functions read feature flags from build-time environment variables
 * (NEXT_PUBLIC_FEATURE_FLAG_* or VITE_FEATURE_FLAG_*) and can be used
 * in both server and client components.
 *
 * This module re-exports from `@smooai/config/client` for backward compatibility.
 * New code should import directly from `@smooai/config/client`.
 *
 * @example
 * ```tsx
 * import { getClientFeatureFlag } from '@smooai/config/feature-flags';
 *
 * if (getClientFeatureFlag('aboutPage')) {
 *     // show the feature
 * }
 * ```
 */

export { getClientFeatureFlag, createFeatureFlagChecker } from '../client';
