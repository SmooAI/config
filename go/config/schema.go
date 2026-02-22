// Package config provides configuration schema definition and runtime client
// for the Smoo AI configuration management platform.
package config

import "encoding/json"

// ConfigTier represents the tier of a configuration value.
type ConfigTier string

const (
	// TierPublic is for public configuration values visible to all.
	TierPublic ConfigTier = "public"
	// TierSecret is for secret configuration values (encrypted at rest).
	TierSecret ConfigTier = "secret"
	// TierFeatureFlag is for feature flag values.
	TierFeatureFlag ConfigTier = "feature_flag"
)

// ConfigDefinition holds the schema definition result from DefineConfig.
type ConfigDefinition struct {
	PublicSchema      map[string]any `json:"public_schema"`
	SecretSchema      map[string]any `json:"secret_schema"`
	FeatureFlagSchema map[string]any `json:"feature_flag_schema"`
	JSONSchema        map[string]any `json:"json_schema"`
}

// DefineConfig creates a configuration definition from optional tier schemas.
// Each schema should be a JSON Schema object describing that tier's configuration.
func DefineConfig(publicSchema, secretSchema, featureFlagSchema map[string]any) *ConfigDefinition {
	emptyObj := map[string]any{"type": "object", "properties": map[string]any{}}

	public := publicSchema
	if public == nil {
		public = map[string]any{}
	}
	secret := secretSchema
	if secret == nil {
		secret = map[string]any{}
	}
	flags := featureFlagSchema
	if flags == nil {
		flags = map[string]any{}
	}

	publicProp := publicSchema
	if publicProp == nil {
		publicProp = emptyObj
	}
	secretProp := secretSchema
	if secretProp == nil {
		secretProp = emptyObj
	}
	flagsProp := featureFlagSchema
	if flagsProp == nil {
		flagsProp = emptyObj
	}

	jsonSchema := map[string]any{
		"$schema": "https://json-schema.org/draft/2020-12/schema",
		"type":    "object",
		"properties": map[string]any{
			"public":        publicProp,
			"secret":        secretProp,
			"feature_flags": flagsProp,
		},
	}

	return &ConfigDefinition{
		PublicSchema:      public,
		SecretSchema:      secret,
		FeatureFlagSchema: flags,
		JSONSchema:        jsonSchema,
	}
}

// MarshalJSON implements custom JSON marshaling for ConfigTier.
func (t ConfigTier) MarshalJSON() ([]byte, error) {
	return json.Marshal(string(t))
}

// UnmarshalJSON implements custom JSON unmarshaling for ConfigTier.
func (t *ConfigTier) UnmarshalJSON(data []byte) error {
	var s string
	if err := json.Unmarshal(data, &s); err != nil {
		return err
	}
	*t = ConfigTier(s)
	return nil
}

// IsValid returns true if the tier is one of the known values.
func (t ConfigTier) IsValid() bool {
	switch t {
	case TierPublic, TierSecret, TierFeatureFlag:
		return true
	}
	return false
}
