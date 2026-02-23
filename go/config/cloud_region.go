package config

import "os"

// CloudRegionResult holds the detected cloud provider and region.
type CloudRegionResult struct {
	Provider string
	Region   string
}

// GetCloudRegion detects cloud provider and region from os environment variables.
func GetCloudRegion() CloudRegionResult {
	return GetCloudRegionFromEnv(osEnvMap())
}

// GetCloudRegionFromEnv detects cloud provider and region from a provided env map.
//
// Detection order:
//  1. SMOOAI_CONFIG_CLOUD_REGION / SMOOAI_CONFIG_CLOUD_PROVIDER (custom override)
//  2. AWS_REGION / AWS_DEFAULT_REGION
//  3. AZURE_REGION / AZURE_LOCATION
//  4. GOOGLE_CLOUD_REGION / CLOUDSDK_COMPUTE_REGION
//  5. Default: unknown/unknown
func GetCloudRegionFromEnv(env map[string]string) CloudRegionResult {
	// 1. Custom override
	if env["SMOOAI_CONFIG_CLOUD_REGION"] != "" || env["SMOOAI_CONFIG_CLOUD_PROVIDER"] != "" {
		return CloudRegionResult{
			Provider: coalesceStr(env["SMOOAI_CONFIG_CLOUD_PROVIDER"], "unknown"),
			Region:   coalesceStr(env["SMOOAI_CONFIG_CLOUD_REGION"], "unknown"),
		}
	}

	// 2. AWS
	if r := coalesceStr(env["AWS_REGION"], env["AWS_DEFAULT_REGION"]); r != "" {
		return CloudRegionResult{Provider: "aws", Region: r}
	}

	// 3. Azure
	if r := coalesceStr(env["AZURE_REGION"], env["AZURE_LOCATION"]); r != "" {
		return CloudRegionResult{Provider: "azure", Region: r}
	}

	// 4. GCP
	if r := coalesceStr(env["GOOGLE_CLOUD_REGION"], env["CLOUDSDK_COMPUTE_REGION"]); r != "" {
		return CloudRegionResult{Provider: "gcp", Region: r}
	}

	// 5. Default
	return CloudRegionResult{Provider: "unknown", Region: "unknown"}
}

// coalesceStr returns the first non-empty string from the arguments.
func coalesceStr(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// osEnvMap converts os.Environ() to a map.
func osEnvMap() map[string]string {
	result := make(map[string]string)
	for _, e := range os.Environ() {
		for i := range len(e) {
			if e[i] == '=' {
				result[e[:i]] = e[i+1:]
				break
			}
		}
	}
	return result
}
