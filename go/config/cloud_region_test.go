package config

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestGetCloudRegionFromEnv_CustomOverrideBoth(t *testing.T) {
	env := map[string]string{
		"SMOOAI_CONFIG_CLOUD_PROVIDER": "custom-cloud",
		"SMOOAI_CONFIG_CLOUD_REGION":   "custom-region-1",
	}
	result := GetCloudRegionFromEnv(env)
	assert.Equal(t, "custom-cloud", result.Provider)
	assert.Equal(t, "custom-region-1", result.Region)
}

func TestGetCloudRegionFromEnv_CustomProviderOnly(t *testing.T) {
	env := map[string]string{"SMOOAI_CONFIG_CLOUD_PROVIDER": "my-cloud"}
	result := GetCloudRegionFromEnv(env)
	assert.Equal(t, "my-cloud", result.Provider)
	assert.Equal(t, "unknown", result.Region)
}

func TestGetCloudRegionFromEnv_CustomRegionOnly(t *testing.T) {
	env := map[string]string{"SMOOAI_CONFIG_CLOUD_REGION": "my-region"}
	result := GetCloudRegionFromEnv(env)
	assert.Equal(t, "unknown", result.Provider)
	assert.Equal(t, "my-region", result.Region)
}

func TestGetCloudRegionFromEnv_AWS(t *testing.T) {
	env := map[string]string{"AWS_REGION": "us-east-1"}
	result := GetCloudRegionFromEnv(env)
	assert.Equal(t, "aws", result.Provider)
	assert.Equal(t, "us-east-1", result.Region)
}

func TestGetCloudRegionFromEnv_AWSDefaultFallback(t *testing.T) {
	env := map[string]string{"AWS_DEFAULT_REGION": "eu-west-1"}
	result := GetCloudRegionFromEnv(env)
	assert.Equal(t, "aws", result.Provider)
	assert.Equal(t, "eu-west-1", result.Region)
}

func TestGetCloudRegionFromEnv_Azure(t *testing.T) {
	env := map[string]string{"AZURE_REGION": "eastus"}
	result := GetCloudRegionFromEnv(env)
	assert.Equal(t, "azure", result.Provider)
	assert.Equal(t, "eastus", result.Region)
}

func TestGetCloudRegionFromEnv_AzureLocationFallback(t *testing.T) {
	env := map[string]string{"AZURE_LOCATION": "westeurope"}
	result := GetCloudRegionFromEnv(env)
	assert.Equal(t, "azure", result.Provider)
	assert.Equal(t, "westeurope", result.Region)
}

func TestGetCloudRegionFromEnv_GCP(t *testing.T) {
	env := map[string]string{"GOOGLE_CLOUD_REGION": "us-central1"}
	result := GetCloudRegionFromEnv(env)
	assert.Equal(t, "gcp", result.Provider)
	assert.Equal(t, "us-central1", result.Region)
}

func TestGetCloudRegionFromEnv_GCPClousdkFallback(t *testing.T) {
	env := map[string]string{"CLOUDSDK_COMPUTE_REGION": "europe-west1"}
	result := GetCloudRegionFromEnv(env)
	assert.Equal(t, "gcp", result.Provider)
	assert.Equal(t, "europe-west1", result.Region)
}

func TestGetCloudRegionFromEnv_EmptyEnv(t *testing.T) {
	result := GetCloudRegionFromEnv(map[string]string{})
	assert.Equal(t, "unknown", result.Provider)
	assert.Equal(t, "unknown", result.Region)
}

func TestGetCloudRegionFromEnv_CustomOverridesAWS(t *testing.T) {
	env := map[string]string{
		"SMOOAI_CONFIG_CLOUD_PROVIDER": "custom",
		"SMOOAI_CONFIG_CLOUD_REGION":   "custom-1",
		"AWS_REGION":                   "us-east-1",
	}
	result := GetCloudRegionFromEnv(env)
	assert.Equal(t, "custom", result.Provider)
	assert.Equal(t, "custom-1", result.Region)
}

func TestGetCloudRegionFromEnv_AWSPriorityOverAzure(t *testing.T) {
	env := map[string]string{
		"AWS_REGION":   "us-east-1",
		"AZURE_REGION": "eastus",
	}
	result := GetCloudRegionFromEnv(env)
	assert.Equal(t, "aws", result.Provider)
}
