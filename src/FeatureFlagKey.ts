/**
 * FeatureFlagKey
 *
 * Extendable enum representing feature flag keys.
 *
 * This class is used to define the feature flag keys that are available to the application.
 *
 * Feature flags are used to control the availability of features in the application,
 * allowing for gradual rollouts, A/B testing, and feature toggling.
 *
 * @example
 * ```typescript
 * const MyFeatureFlagKey = extendFeatureFlagKey({
 *     ENABLE_NEW_UI: 'ENABLE_NEW_UI',
 *     BETA_FEATURES: 'BETA_FEATURES',
 * } as const);
 *
 * export type MyFeatureFlagKey = InferFeatureFlagKeyType<typeof MyFeatureFlagKey>;
 * ```
 */
export const FeatureFlagKey = {
} as const;

export type FeatureFlagKey = (typeof FeatureFlagKey)[keyof typeof FeatureFlagKey];