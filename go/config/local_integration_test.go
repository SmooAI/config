package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func makeTestConfigDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	configDir := filepath.Join(dir, ".smooai-config")
	require.NoError(t, os.MkdirAll(configDir, 0o755))

	files := map[string]any{
		"default.json": map[string]any{
			"API_URL": "http://localhost:3000", "MAX_RETRIES": 3,
			"ENABLE_DEBUG": true, "APP_NAME": "default-app",
			"DATABASE":         map[string]any{"host": "localhost", "port": 5432, "ssl": false},
			"API_KEY":          "default-api-key",
			"DB_PASSWORD":      "default-db-pass",
			"JWT_SECRET":       "default-jwt-secret",
			"ENABLE_NEW_UI":    false,
			"ENABLE_BETA":      false,
			"MAINTENANCE_MODE": false,
		},
		"development.json": map[string]any{
			"API_URL": "http://dev-api.example.com", "ENABLE_DEBUG": true,
			"APP_NAME": "dev-app", "ENABLE_NEW_UI": true, "ENABLE_BETA": true,
		},
		"production.json": map[string]any{
			"API_URL": "https://api.example.com", "MAX_RETRIES": 5,
			"ENABLE_DEBUG": false, "APP_NAME": "prod-app",
			"DATABASE":         map[string]any{"host": "prod-db.example.com", "port": 5432, "ssl": true},
			"API_KEY":          "prod-api-key-secret",
			"DB_PASSWORD":      "prod-db-pass-secret",
			"JWT_SECRET":       "prod-jwt-secret",
			"ENABLE_NEW_UI":    false,
			"ENABLE_BETA":      false,
			"MAINTENANCE_MODE": false,
		},
		"production.aws.json": map[string]any{
			"API_URL":  "https://aws-api.example.com",
			"DATABASE": map[string]any{"host": "aws-prod-db.example.com"},
		},
		"production.aws.us-east-1.json": map[string]any{
			"DATABASE": map[string]any{"host": "us-east-1-db.example.com"},
		},
	}

	for name, content := range files {
		b, err := json.Marshal(content)
		require.NoError(t, err)
		require.NoError(t, os.WriteFile(filepath.Join(configDir, name), b, 0o644))
	}

	return configDir
}

// --- Default config loading ---

func TestIntegration_DefaultLoadsAllTiers(t *testing.T) {
	configDir := makeTestConfigDir(t)
	mgr := NewLocalConfigManager(WithEnvOverride(map[string]string{
		"SMOOAI_ENV_CONFIG_DIR": configDir,
		"SMOOAI_CONFIG_ENV":     "test",
	}))

	v, err := mgr.GetPublicConfig("API_URL")
	require.NoError(t, err)
	assert.Equal(t, "http://localhost:3000", v)

	v, err = mgr.GetPublicConfig("MAX_RETRIES")
	require.NoError(t, err)
	assert.Equal(t, 3.0, v)

	v, err = mgr.GetPublicConfig("ENABLE_DEBUG")
	require.NoError(t, err)
	assert.Equal(t, true, v)

	v, err = mgr.GetPublicConfig("APP_NAME")
	require.NoError(t, err)
	assert.Equal(t, "default-app", v)

	v, err = mgr.GetPublicConfig("DATABASE")
	require.NoError(t, err)
	db := v.(map[string]any)
	assert.Equal(t, "localhost", db["host"])
	assert.Equal(t, 5432.0, db["port"])
	assert.Equal(t, false, db["ssl"])

	// Secrets
	v, err = mgr.GetSecretConfig("API_KEY")
	require.NoError(t, err)
	assert.Equal(t, "default-api-key", v)

	v, err = mgr.GetSecretConfig("DB_PASSWORD")
	require.NoError(t, err)
	assert.Equal(t, "default-db-pass", v)

	// Feature flags
	v, err = mgr.GetFeatureFlag("ENABLE_NEW_UI")
	require.NoError(t, err)
	assert.Equal(t, false, v)

	v, err = mgr.GetFeatureFlag("ENABLE_BETA")
	require.NoError(t, err)
	assert.Equal(t, false, v)

	v, err = mgr.GetFeatureFlag("MAINTENANCE_MODE")
	require.NoError(t, err)
	assert.Equal(t, false, v)
}

func TestIntegration_DefaultBuiltinConfig(t *testing.T) {
	configDir := makeTestConfigDir(t)
	mgr := NewLocalConfigManager(WithEnvOverride(map[string]string{
		"SMOOAI_ENV_CONFIG_DIR": configDir,
		"SMOOAI_CONFIG_ENV":     "test",
	}))

	v, _ := mgr.GetPublicConfig("ENV")
	assert.Equal(t, "test", v)

	v, _ = mgr.GetPublicConfig("IS_LOCAL")
	assert.Equal(t, false, v)

	v, _ = mgr.GetPublicConfig("CLOUD_PROVIDER")
	assert.Equal(t, "unknown", v)

	v, _ = mgr.GetPublicConfig("REGION")
	assert.Equal(t, "unknown", v)
}

func TestIntegration_DefaultNonexistentKey(t *testing.T) {
	configDir := makeTestConfigDir(t)
	mgr := NewLocalConfigManager(WithEnvOverride(map[string]string{
		"SMOOAI_ENV_CONFIG_DIR": configDir,
		"SMOOAI_CONFIG_ENV":     "test",
	}))

	v, err := mgr.GetPublicConfig("nonexistent")
	require.NoError(t, err)
	assert.Nil(t, v)
}

// --- Development merge ---

func TestIntegration_DevelopmentOverridesAndInherits(t *testing.T) {
	configDir := makeTestConfigDir(t)
	mgr := NewLocalConfigManager(WithEnvOverride(map[string]string{
		"SMOOAI_ENV_CONFIG_DIR": configDir,
		"SMOOAI_CONFIG_ENV":     "development",
	}))

	v, _ := mgr.GetPublicConfig("API_URL")
	assert.Equal(t, "http://dev-api.example.com", v)

	v, _ = mgr.GetPublicConfig("APP_NAME")
	assert.Equal(t, "dev-app", v)

	v, _ = mgr.GetPublicConfig("ENABLE_DEBUG")
	assert.Equal(t, true, v)

	// Inherited
	v, _ = mgr.GetPublicConfig("MAX_RETRIES")
	assert.Equal(t, 3.0, v)

	v, _ = mgr.GetPublicConfig("DATABASE")
	db := v.(map[string]any)
	assert.Equal(t, "localhost", db["host"])
	assert.Equal(t, 5432.0, db["port"])
	assert.Equal(t, false, db["ssl"])
}

func TestIntegration_DevelopmentFeatureFlags(t *testing.T) {
	configDir := makeTestConfigDir(t)
	mgr := NewLocalConfigManager(WithEnvOverride(map[string]string{
		"SMOOAI_ENV_CONFIG_DIR": configDir,
		"SMOOAI_CONFIG_ENV":     "development",
	}))

	v, _ := mgr.GetFeatureFlag("ENABLE_NEW_UI")
	assert.Equal(t, true, v)

	v, _ = mgr.GetFeatureFlag("ENABLE_BETA")
	assert.Equal(t, true, v)

	v, _ = mgr.GetFeatureFlag("MAINTENANCE_MODE")
	assert.Equal(t, false, v)
}

func TestIntegration_DevelopmentInheritsSecrets(t *testing.T) {
	configDir := makeTestConfigDir(t)
	mgr := NewLocalConfigManager(WithEnvOverride(map[string]string{
		"SMOOAI_ENV_CONFIG_DIR": configDir,
		"SMOOAI_CONFIG_ENV":     "development",
	}))

	v, _ := mgr.GetSecretConfig("API_KEY")
	assert.Equal(t, "default-api-key", v)

	v, _ = mgr.GetSecretConfig("DB_PASSWORD")
	assert.Equal(t, "default-db-pass", v)
}

// --- Production merge chain ---

func TestIntegration_ProductionMergeChain(t *testing.T) {
	configDir := makeTestConfigDir(t)
	mgr := NewLocalConfigManager(WithEnvOverride(map[string]string{
		"SMOOAI_ENV_CONFIG_DIR": configDir,
		"SMOOAI_CONFIG_ENV":     "production",
		"AWS_REGION":            "us-east-1",
	}))

	v, _ := mgr.GetPublicConfig("API_URL")
	assert.Equal(t, "https://aws-api.example.com", v)

	v, _ = mgr.GetPublicConfig("MAX_RETRIES")
	assert.Equal(t, 5.0, v)

	v, _ = mgr.GetPublicConfig("DATABASE")
	db := v.(map[string]any)
	assert.Equal(t, "us-east-1-db.example.com", db["host"])
	assert.Equal(t, true, db["ssl"])
	assert.Equal(t, 5432.0, db["port"])
}

func TestIntegration_ProductionSecrets(t *testing.T) {
	configDir := makeTestConfigDir(t)
	mgr := NewLocalConfigManager(WithEnvOverride(map[string]string{
		"SMOOAI_ENV_CONFIG_DIR": configDir,
		"SMOOAI_CONFIG_ENV":     "production",
		"AWS_REGION":            "us-east-1",
	}))

	v, _ := mgr.GetSecretConfig("API_KEY")
	assert.Equal(t, "prod-api-key-secret", v)

	v, _ = mgr.GetSecretConfig("DB_PASSWORD")
	assert.Equal(t, "prod-db-pass-secret", v)

	v, _ = mgr.GetSecretConfig("JWT_SECRET")
	assert.Equal(t, "prod-jwt-secret", v)
}

func TestIntegration_ProductionCloudDetection(t *testing.T) {
	configDir := makeTestConfigDir(t)
	mgr := NewLocalConfigManager(WithEnvOverride(map[string]string{
		"SMOOAI_ENV_CONFIG_DIR": configDir,
		"SMOOAI_CONFIG_ENV":     "production",
		"AWS_REGION":            "us-east-1",
	}))

	v, _ := mgr.GetPublicConfig("CLOUD_PROVIDER")
	assert.Equal(t, "aws", v)

	v, _ = mgr.GetPublicConfig("REGION")
	assert.Equal(t, "us-east-1", v)
}

func TestIntegration_ProductionEnableDebugFalse(t *testing.T) {
	configDir := makeTestConfigDir(t)
	mgr := NewLocalConfigManager(WithEnvOverride(map[string]string{
		"SMOOAI_ENV_CONFIG_DIR": configDir,
		"SMOOAI_CONFIG_ENV":     "production",
		"AWS_REGION":            "us-east-1",
	}))

	v, _ := mgr.GetPublicConfig("ENABLE_DEBUG")
	assert.Equal(t, false, v)
}

// --- Consistent results ---

func TestIntegration_ConsistentRepeatedCalls(t *testing.T) {
	configDir := makeTestConfigDir(t)
	mgr := NewLocalConfigManager(WithEnvOverride(map[string]string{
		"SMOOAI_ENV_CONFIG_DIR": configDir,
		"SMOOAI_CONFIG_ENV":     "test",
	}))

	r1, _ := mgr.GetPublicConfig("API_URL")
	r2, _ := mgr.GetPublicConfig("API_URL")
	r3, _ := mgr.GetPublicConfig("API_URL")
	assert.Equal(t, r1, r2)
	assert.Equal(t, r2, r3)
	assert.Equal(t, "http://localhost:3000", r1)
}

// --- Cloud region detection ---

func TestIntegration_DetectsAWSFromEnv(t *testing.T) {
	configDir := makeTestConfigDir(t)
	mgr := NewLocalConfigManager(WithEnvOverride(map[string]string{
		"SMOOAI_ENV_CONFIG_DIR": configDir,
		"SMOOAI_CONFIG_ENV":     "test",
		"AWS_REGION":            "eu-west-1",
	}))

	v, _ := mgr.GetPublicConfig("CLOUD_PROVIDER")
	assert.Equal(t, "aws", v)

	v, _ = mgr.GetPublicConfig("REGION")
	assert.Equal(t, "eu-west-1", v)
}

func TestIntegration_DetectsCustomProvider(t *testing.T) {
	configDir := makeTestConfigDir(t)
	mgr := NewLocalConfigManager(WithEnvOverride(map[string]string{
		"SMOOAI_ENV_CONFIG_DIR":        configDir,
		"SMOOAI_CONFIG_ENV":            "test",
		"SMOOAI_CONFIG_CLOUD_PROVIDER": "custom-cloud",
		"SMOOAI_CONFIG_CLOUD_REGION":   "custom-region-1",
	}))

	v, _ := mgr.GetPublicConfig("CLOUD_PROVIDER")
	assert.Equal(t, "custom-cloud", v)

	v, _ = mgr.GetPublicConfig("REGION")
	assert.Equal(t, "custom-region-1", v)
}

func TestIntegration_FallsBackToUnknown(t *testing.T) {
	configDir := makeTestConfigDir(t)
	mgr := NewLocalConfigManager(WithEnvOverride(map[string]string{
		"SMOOAI_ENV_CONFIG_DIR": configDir,
		"SMOOAI_CONFIG_ENV":     "test",
	}))

	v, _ := mgr.GetPublicConfig("CLOUD_PROVIDER")
	assert.Equal(t, "unknown", v)

	v, _ = mgr.GetPublicConfig("REGION")
	assert.Equal(t, "unknown", v)
}
