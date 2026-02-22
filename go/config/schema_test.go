package config

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDefineConfig_Empty(t *testing.T) {
	result := DefineConfig(nil, nil, nil)

	assert.Equal(t, map[string]any{}, result.PublicSchema)
	assert.Equal(t, map[string]any{}, result.SecretSchema)
	assert.Equal(t, map[string]any{}, result.FeatureFlagSchema)
	assert.Equal(t, "object", result.JSONSchema["type"])
	assert.Equal(t, "https://json-schema.org/draft/2020-12/schema", result.JSONSchema["$schema"])
}

func TestDefineConfig_EmptyHasAllTierProperties(t *testing.T) {
	result := DefineConfig(nil, nil, nil)

	props, ok := result.JSONSchema["properties"].(map[string]any)
	require.True(t, ok)

	assert.Contains(t, props, "public")
	assert.Contains(t, props, "secret")
	assert.Contains(t, props, "feature_flags")
}

func TestDefineConfig_PublicOnly(t *testing.T) {
	public := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"api_url":     map[string]any{"type": "string"},
			"max_retries": map[string]any{"type": "integer"},
		},
	}

	result := DefineConfig(public, nil, nil)

	assert.Equal(t, public, result.PublicSchema)
	assert.Equal(t, map[string]any{}, result.SecretSchema)
	assert.Equal(t, map[string]any{}, result.FeatureFlagSchema)

	props := result.JSONSchema["properties"].(map[string]any)
	assert.Equal(t, public, props["public"])
}

func TestDefineConfig_SecretOnly(t *testing.T) {
	secret := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"api_key":    map[string]any{"type": "string"},
			"jwt_secret": map[string]any{"type": "string"},
		},
	}

	result := DefineConfig(nil, secret, nil)

	assert.Equal(t, map[string]any{}, result.PublicSchema)
	assert.Equal(t, secret, result.SecretSchema)

	props := result.JSONSchema["properties"].(map[string]any)
	assert.Equal(t, secret, props["secret"])
}

func TestDefineConfig_FeatureFlagsOnly(t *testing.T) {
	flags := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"enable_new_ui": map[string]any{"type": "boolean"},
			"beta_features": map[string]any{"type": "boolean"},
		},
	}

	result := DefineConfig(nil, nil, flags)

	assert.Equal(t, flags, result.FeatureFlagSchema)

	props := result.JSONSchema["properties"].(map[string]any)
	assert.Equal(t, flags, props["feature_flags"])
}

func TestDefineConfig_AllTiers(t *testing.T) {
	public := map[string]any{"type": "object", "properties": map[string]any{"url": map[string]any{"type": "string"}}}
	secret := map[string]any{"type": "object", "properties": map[string]any{"key": map[string]any{"type": "string"}}}
	flags := map[string]any{"type": "object", "properties": map[string]any{"beta": map[string]any{"type": "boolean"}}}

	result := DefineConfig(public, secret, flags)

	assert.Equal(t, public, result.PublicSchema)
	assert.Equal(t, secret, result.SecretSchema)
	assert.Equal(t, flags, result.FeatureFlagSchema)

	props := result.JSONSchema["properties"].(map[string]any)
	assert.Equal(t, public, props["public"])
	assert.Equal(t, secret, props["secret"])
	assert.Equal(t, flags, props["feature_flags"])
}

func TestDefineConfig_ComplexNestedSchema(t *testing.T) {
	public := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"database": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"host": map[string]any{"type": "string", "default": "localhost"},
					"port": map[string]any{"type": "integer", "default": float64(5432)},
				},
			},
		},
	}

	result := DefineConfig(public, nil, nil)

	props := result.JSONSchema["properties"].(map[string]any)
	publicProps := props["public"].(map[string]any)["properties"].(map[string]any)
	dbProps := publicProps["database"].(map[string]any)["properties"].(map[string]any)
	assert.Equal(t, "string", dbProps["host"].(map[string]any)["type"])
}

func TestConfigTier_Values(t *testing.T) {
	assert.Equal(t, ConfigTier("public"), TierPublic)
	assert.Equal(t, ConfigTier("secret"), TierSecret)
	assert.Equal(t, ConfigTier("feature_flag"), TierFeatureFlag)
}

func TestConfigTier_IsValid(t *testing.T) {
	assert.True(t, TierPublic.IsValid())
	assert.True(t, TierSecret.IsValid())
	assert.True(t, TierFeatureFlag.IsValid())
	assert.False(t, ConfigTier("invalid").IsValid())
	assert.False(t, ConfigTier("").IsValid())
}

func TestConfigTier_JSONMarshal(t *testing.T) {
	data, err := json.Marshal(TierPublic)
	require.NoError(t, err)
	assert.Equal(t, `"public"`, string(data))

	data, err = json.Marshal(TierSecret)
	require.NoError(t, err)
	assert.Equal(t, `"secret"`, string(data))

	data, err = json.Marshal(TierFeatureFlag)
	require.NoError(t, err)
	assert.Equal(t, `"feature_flag"`, string(data))
}

func TestConfigTier_JSONUnmarshal(t *testing.T) {
	var tier ConfigTier

	err := json.Unmarshal([]byte(`"public"`), &tier)
	require.NoError(t, err)
	assert.Equal(t, TierPublic, tier)

	err = json.Unmarshal([]byte(`"secret"`), &tier)
	require.NoError(t, err)
	assert.Equal(t, TierSecret, tier)

	err = json.Unmarshal([]byte(`"feature_flag"`), &tier)
	require.NoError(t, err)
	assert.Equal(t, TierFeatureFlag, tier)
}

func TestConfigDefinition_JSONRoundtrip(t *testing.T) {
	public := map[string]any{"type": "object", "properties": map[string]any{"url": map[string]any{"type": "string"}}}
	original := DefineConfig(public, nil, nil)

	data, err := json.Marshal(original)
	require.NoError(t, err)

	var decoded ConfigDefinition
	err = json.Unmarshal(data, &decoded)
	require.NoError(t, err)

	assert.Equal(t, original.PublicSchema["type"], decoded.PublicSchema["type"])
	assert.Equal(t, original.JSONSchema["$schema"], decoded.JSONSchema["$schema"])
}
