package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func writeJSON(t *testing.T, dir, filename string, data any) {
	t.Helper()
	b, err := json.Marshal(data)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(dir, filename), b, 0o644))
}

func TestFindConfigDirectoryWithEnv_ViaEnvVar(t *testing.T) {
	dir := t.TempDir()
	configDir := filepath.Join(dir, "my-config")
	require.NoError(t, os.MkdirAll(configDir, 0o755))

	env := map[string]string{"SMOOAI_ENV_CONFIG_DIR": configDir}
	result, err := findConfigDirectoryWithEnv(false, env)
	require.NoError(t, err)
	assert.Equal(t, configDir, result)
}

func TestFindConfigDirectoryWithEnv_EnvVarNotExist(t *testing.T) {
	env := map[string]string{"SMOOAI_ENV_CONFIG_DIR": "/nonexistent/path"}
	_, err := findConfigDirectoryWithEnv(false, env)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "does not exist")
}

func TestFindAndProcessFileConfigWithEnv_LoadsDefault(t *testing.T) {
	dir := t.TempDir()
	configDir := filepath.Join(dir, ".smooai-config")
	require.NoError(t, os.MkdirAll(configDir, 0o755))
	writeJSON(t, configDir, "default.json", map[string]any{"API_URL": "http://localhost:3000", "MAX_RETRIES": 3})

	env := map[string]string{"SMOOAI_ENV_CONFIG_DIR": configDir, "SMOOAI_CONFIG_ENV": "test"}
	result, err := findAndProcessFileConfigWithEnv(env)
	require.NoError(t, err)
	assert.Equal(t, "http://localhost:3000", result["API_URL"])
	assert.Equal(t, 3.0, result["MAX_RETRIES"]) // JSON numbers are float64 in Go
}

func TestFindAndProcessFileConfigWithEnv_RaisesWithoutDefault(t *testing.T) {
	dir := t.TempDir()
	configDir := filepath.Join(dir, ".smooai-config")
	require.NoError(t, os.MkdirAll(configDir, 0o755))

	env := map[string]string{"SMOOAI_ENV_CONFIG_DIR": configDir, "SMOOAI_CONFIG_ENV": "test"}
	_, err := findAndProcessFileConfigWithEnv(env)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "default.json")
}

func TestFindAndProcessFileConfigWithEnv_MergesEnvSpecific(t *testing.T) {
	dir := t.TempDir()
	configDir := filepath.Join(dir, ".smooai-config")
	require.NoError(t, os.MkdirAll(configDir, 0o755))
	writeJSON(t, configDir, "default.json", map[string]any{"API_URL": "http://localhost", "MAX_RETRIES": 3})
	writeJSON(t, configDir, "development.json", map[string]any{"API_URL": "http://dev-api.example.com"})

	env := map[string]string{"SMOOAI_ENV_CONFIG_DIR": configDir, "SMOOAI_CONFIG_ENV": "development"}
	result, err := findAndProcessFileConfigWithEnv(env)
	require.NoError(t, err)
	assert.Equal(t, "http://dev-api.example.com", result["API_URL"])
	assert.Equal(t, 3.0, result["MAX_RETRIES"])
}

func TestFindAndProcessFileConfigWithEnv_SetsBuiltinKeys(t *testing.T) {
	dir := t.TempDir()
	configDir := filepath.Join(dir, ".smooai-config")
	require.NoError(t, os.MkdirAll(configDir, 0o755))
	writeJSON(t, configDir, "default.json", map[string]any{"API_URL": "test"})

	env := map[string]string{
		"SMOOAI_ENV_CONFIG_DIR": configDir,
		"SMOOAI_CONFIG_ENV":     "production",
		"AWS_REGION":            "us-east-1",
	}
	result, err := findAndProcessFileConfigWithEnv(env)
	require.NoError(t, err)
	assert.Equal(t, "production", result["ENV"])
	assert.Equal(t, false, result["IS_LOCAL"])
	assert.Equal(t, "aws", result["CLOUD_PROVIDER"])
	assert.Equal(t, "us-east-1", result["REGION"])
}

func TestFindAndProcessFileConfigWithEnv_SkipsOptionalFiles(t *testing.T) {
	dir := t.TempDir()
	configDir := filepath.Join(dir, ".smooai-config")
	require.NoError(t, os.MkdirAll(configDir, 0o755))
	writeJSON(t, configDir, "default.json", map[string]any{"API_URL": "test"})

	env := map[string]string{"SMOOAI_ENV_CONFIG_DIR": configDir, "SMOOAI_CONFIG_ENV": "nonexistent"}
	result, err := findAndProcessFileConfigWithEnv(env)
	require.NoError(t, err)
	assert.Equal(t, "test", result["API_URL"])
}
