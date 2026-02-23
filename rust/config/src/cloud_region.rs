//! Cloud provider and region detection from environment variables.

use std::collections::HashMap;
use std::env;

/// Result of cloud provider/region detection.
#[derive(Debug, Clone, PartialEq)]
pub struct CloudRegionResult {
    pub provider: String,
    pub region: String,
}

/// Detect cloud provider and region from process environment variables.
pub fn get_cloud_region() -> CloudRegionResult {
    get_cloud_region_from_env(&env_map())
}

/// Detect cloud provider and region from a provided env map.
///
/// Detection order:
/// 1. SMOOAI_CONFIG_CLOUD_REGION / SMOOAI_CONFIG_CLOUD_PROVIDER (custom override)
/// 2. AWS_REGION / AWS_DEFAULT_REGION
/// 3. AZURE_REGION / AZURE_LOCATION
/// 4. GOOGLE_CLOUD_REGION / CLOUDSDK_COMPUTE_REGION
/// 5. Default: unknown/unknown
pub fn get_cloud_region_from_env(env: &HashMap<String, String>) -> CloudRegionResult {
    // 1. Custom override
    if env.contains_key("SMOOAI_CONFIG_CLOUD_REGION") || env.contains_key("SMOOAI_CONFIG_CLOUD_PROVIDER") {
        return CloudRegionResult {
            provider: env
                .get("SMOOAI_CONFIG_CLOUD_PROVIDER")
                .cloned()
                .unwrap_or_else(|| "unknown".to_string()),
            region: env
                .get("SMOOAI_CONFIG_CLOUD_REGION")
                .cloned()
                .unwrap_or_else(|| "unknown".to_string()),
        };
    }

    // 2. AWS
    if let Some(region) = env.get("AWS_REGION").or_else(|| env.get("AWS_DEFAULT_REGION")) {
        return CloudRegionResult {
            provider: "aws".to_string(),
            region: region.clone(),
        };
    }

    // 3. Azure
    if let Some(region) = env.get("AZURE_REGION").or_else(|| env.get("AZURE_LOCATION")) {
        return CloudRegionResult {
            provider: "azure".to_string(),
            region: region.clone(),
        };
    }

    // 4. GCP
    if let Some(region) = env
        .get("GOOGLE_CLOUD_REGION")
        .or_else(|| env.get("CLOUDSDK_COMPUTE_REGION"))
    {
        return CloudRegionResult {
            provider: "gcp".to_string(),
            region: region.clone(),
        };
    }

    // 5. Default
    CloudRegionResult {
        provider: "unknown".to_string(),
        region: "unknown".to_string(),
    }
}

fn env_map() -> HashMap<String, String> {
    env::vars().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn test_custom_override_both() {
        let env = make_env(&[
            ("SMOOAI_CONFIG_CLOUD_PROVIDER", "custom-cloud"),
            ("SMOOAI_CONFIG_CLOUD_REGION", "custom-region-1"),
        ]);
        let result = get_cloud_region_from_env(&env);
        assert_eq!(result.provider, "custom-cloud");
        assert_eq!(result.region, "custom-region-1");
    }

    #[test]
    fn test_custom_provider_only() {
        let env = make_env(&[("SMOOAI_CONFIG_CLOUD_PROVIDER", "my-cloud")]);
        let result = get_cloud_region_from_env(&env);
        assert_eq!(result.provider, "my-cloud");
        assert_eq!(result.region, "unknown");
    }

    #[test]
    fn test_custom_region_only() {
        let env = make_env(&[("SMOOAI_CONFIG_CLOUD_REGION", "my-region")]);
        let result = get_cloud_region_from_env(&env);
        assert_eq!(result.provider, "unknown");
        assert_eq!(result.region, "my-region");
    }

    #[test]
    fn test_aws_region() {
        let env = make_env(&[("AWS_REGION", "us-east-1")]);
        let result = get_cloud_region_from_env(&env);
        assert_eq!(result.provider, "aws");
        assert_eq!(result.region, "us-east-1");
    }

    #[test]
    fn test_aws_default_region_fallback() {
        let env = make_env(&[("AWS_DEFAULT_REGION", "eu-west-1")]);
        let result = get_cloud_region_from_env(&env);
        assert_eq!(result.provider, "aws");
        assert_eq!(result.region, "eu-west-1");
    }

    #[test]
    fn test_azure_region() {
        let env = make_env(&[("AZURE_REGION", "eastus")]);
        let result = get_cloud_region_from_env(&env);
        assert_eq!(result.provider, "azure");
        assert_eq!(result.region, "eastus");
    }

    #[test]
    fn test_azure_location_fallback() {
        let env = make_env(&[("AZURE_LOCATION", "westeurope")]);
        let result = get_cloud_region_from_env(&env);
        assert_eq!(result.provider, "azure");
        assert_eq!(result.region, "westeurope");
    }

    #[test]
    fn test_gcp_region() {
        let env = make_env(&[("GOOGLE_CLOUD_REGION", "us-central1")]);
        let result = get_cloud_region_from_env(&env);
        assert_eq!(result.provider, "gcp");
        assert_eq!(result.region, "us-central1");
    }

    #[test]
    fn test_gcp_cloudsdk_fallback() {
        let env = make_env(&[("CLOUDSDK_COMPUTE_REGION", "europe-west1")]);
        let result = get_cloud_region_from_env(&env);
        assert_eq!(result.provider, "gcp");
        assert_eq!(result.region, "europe-west1");
    }

    #[test]
    fn test_empty_env() {
        let env = HashMap::new();
        let result = get_cloud_region_from_env(&env);
        assert_eq!(result.provider, "unknown");
        assert_eq!(result.region, "unknown");
    }

    #[test]
    fn test_custom_overrides_aws() {
        let env = make_env(&[
            ("SMOOAI_CONFIG_CLOUD_PROVIDER", "custom"),
            ("SMOOAI_CONFIG_CLOUD_REGION", "custom-1"),
            ("AWS_REGION", "us-east-1"),
        ]);
        let result = get_cloud_region_from_env(&env);
        assert_eq!(result.provider, "custom");
        assert_eq!(result.region, "custom-1");
    }

    #[test]
    fn test_aws_priority_over_azure() {
        let env = make_env(&[("AWS_REGION", "us-east-1"), ("AZURE_REGION", "eastus")]);
        let result = get_cloud_region_from_env(&env);
        assert_eq!(result.provider, "aws");
    }
}
