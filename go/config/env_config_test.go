package config

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestEnvConfig_ExtractsMatchingKeys(t *testing.T) {
	schemaKeys := map[string]bool{"API_URL": true, "MAX_RETRIES": true}
	env := map[string]string{"API_URL": "http://localhost:3000", "MAX_RETRIES": "3", "UNRELATED": "ignored"}
	result := findAndProcessEnvConfigWithEnv(schemaKeys, "", nil, env)
	assert.Equal(t, "http://localhost:3000", result["API_URL"])
	assert.Equal(t, "3", result["MAX_RETRIES"])
	_, exists := result["UNRELATED"]
	assert.False(t, exists)
}

func TestEnvConfig_StripsPrefix(t *testing.T) {
	schemaKeys := map[string]bool{"API_URL": true}
	env := map[string]string{"NEXT_PUBLIC_API_URL": "http://example.com"}
	result := findAndProcessEnvConfigWithEnv(schemaKeys, "NEXT_PUBLIC_", nil, env)
	assert.Equal(t, "http://example.com", result["API_URL"])
}

func TestEnvConfig_CoercesBoolean(t *testing.T) {
	schemaKeys := map[string]bool{"ENABLE_DEBUG": true}
	schemaTypes := map[string]string{"ENABLE_DEBUG": "boolean"}
	env := map[string]string{"ENABLE_DEBUG": "true"}
	result := findAndProcessEnvConfigWithEnv(schemaKeys, "", schemaTypes, env)
	assert.Equal(t, true, result["ENABLE_DEBUG"])
}

func TestEnvConfig_CoercesNumberInt(t *testing.T) {
	schemaKeys := map[string]bool{"MAX_RETRIES": true}
	schemaTypes := map[string]string{"MAX_RETRIES": "number"}
	env := map[string]string{"MAX_RETRIES": "5"}
	result := findAndProcessEnvConfigWithEnv(schemaKeys, "", schemaTypes, env)
	assert.Equal(t, 5, result["MAX_RETRIES"])
}

func TestEnvConfig_CoercesNumberFloat(t *testing.T) {
	schemaKeys := map[string]bool{"TIMEOUT": true}
	schemaTypes := map[string]string{"TIMEOUT": "number"}
	env := map[string]string{"TIMEOUT": "3.14"}
	result := findAndProcessEnvConfigWithEnv(schemaKeys, "", schemaTypes, env)
	assert.InDelta(t, 3.14, result["TIMEOUT"], 0.001)
}

func TestEnvConfig_CoercesJSON(t *testing.T) {
	schemaKeys := map[string]bool{"DATABASE": true}
	schemaTypes := map[string]string{"DATABASE": "json"}
	env := map[string]string{"DATABASE": `{"host":"localhost","port":5432}`}
	result := findAndProcessEnvConfigWithEnv(schemaKeys, "", schemaTypes, env)
	db, ok := result["DATABASE"].(map[string]any)
	assert.True(t, ok)
	assert.Equal(t, "localhost", db["host"])
	assert.Equal(t, 5432.0, db["port"])
}

func TestEnvConfig_SetsBuiltinKeys(t *testing.T) {
	env := map[string]string{"SMOOAI_CONFIG_ENV": "production", "AWS_REGION": "us-east-1"}
	result := findAndProcessEnvConfigWithEnv(map[string]bool{}, "", nil, env)
	assert.Equal(t, "production", result["ENV"])
	assert.Equal(t, false, result["IS_LOCAL"])
	assert.Equal(t, "aws", result["CLOUD_PROVIDER"])
	assert.Equal(t, "us-east-1", result["REGION"])
}

func TestEnvConfig_DefaultsEnvToDevelopment(t *testing.T) {
	result := findAndProcessEnvConfigWithEnv(map[string]bool{}, "", nil, map[string]string{})
	assert.Equal(t, "development", result["ENV"])
}
