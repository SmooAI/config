// Package config provides configuration schema definition and runtime client
// for the Smoo AI configuration management platform.
package config

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/invopop/jsonschema"
)

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
// Validates each tier's schema for cross-language compatibility and prints
// warnings for unsupported features.
func DefineConfig(publicSchema, secretSchema, featureFlagSchema map[string]any) *ConfigDefinition {
	// Validate cross-language compatibility
	for _, tier := range []struct {
		name   string
		schema map[string]any
	}{
		{"public", publicSchema},
		{"secret", secretSchema},
		{"feature_flags", featureFlagSchema},
	} {
		if tier.schema != nil {
			result := ValidateSmooaiSchema(tier.schema)
			if !result.Valid {
				for _, e := range result.Errors {
					fmt.Fprintf(os.Stderr, "[Smooai Config] Warning: [%s] %s: %s Suggestion: %s\n",
						tier.name, e.Path, e.Message, e.Suggestion)
				}
			}
		}
	}

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

// DefineConfigTyped creates a configuration definition from Go struct types.
// Each parameter should be a pointer to a struct (or nil for empty tiers).
// The struct's JSON schema is generated via reflection using struct tags.
//
// Example:
//
//	type PublicConfig struct {
//	    APIUrl     string `json:"api_url"`
//	    MaxRetries int    `json:"max_retries" jsonschema:"minimum=0"`
//	}
//
//	config, err := DefineConfigTyped(&PublicConfig{}, nil, nil)
func DefineConfigTyped(publicType, secretType, featureFlagType any) (*ConfigDefinition, error) {
	publicSchema, err := reflectSchema(publicType)
	if err != nil {
		return nil, fmt.Errorf("public schema: %w", err)
	}

	secretSchema, err := reflectSchema(secretType)
	if err != nil {
		return nil, fmt.Errorf("secret schema: %w", err)
	}

	featureFlagSchema, err := reflectSchema(featureFlagType)
	if err != nil {
		return nil, fmt.Errorf("feature flag schema: %w", err)
	}

	return DefineConfig(publicSchema, secretSchema, featureFlagSchema), nil
}

// reflectSchema generates a JSON Schema map from a Go struct type.
// Returns nil for nil inputs (empty schema tiers).
//
// The invopop/jsonschema reflector wraps the schema in $ref + $defs.
// This function inlines the top-level $ref to produce a flat schema
// with "type", "properties", "required" etc. at the top level.
func reflectSchema(v any) (map[string]any, error) {
	if v == nil {
		return nil, nil
	}

	r := &jsonschema.Reflector{}
	schema := r.Reflect(v)
	if schema == nil {
		return nil, nil
	}

	// Convert to map[string]any via JSON roundtrip
	data, err := json.Marshal(schema)
	if err != nil {
		return nil, fmt.Errorf("marshal schema: %w", err)
	}

	var result map[string]any
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("unmarshal schema: %w", err)
	}

	// Inline the top-level $ref if present
	result = inlineTopLevelRef(result)

	return result, nil
}

// inlineTopLevelRef resolves a top-level "$ref": "#/$defs/TypeName" by
// replacing the root schema with the referenced definition.
func inlineTopLevelRef(schema map[string]any) map[string]any {
	ref, hasRef := schema["$ref"].(string)
	if !hasRef {
		return schema
	}

	defs, hasDefs := schema["$defs"].(map[string]any)
	if !hasDefs {
		return schema
	}

	// Parse "#/$defs/TypeName"
	const prefix = "#/$defs/"
	if len(ref) <= len(prefix) || ref[:len(prefix)] != prefix {
		return schema
	}
	typeName := ref[len(prefix):]

	def, found := defs[typeName].(map[string]any)
	if !found {
		return schema
	}

	// Build the inlined schema: copy the definition, then add remaining $defs
	// (for schemas that reference other types)
	inlined := make(map[string]any, len(def)+1)
	for k, v := range def {
		inlined[k] = v
	}

	// Copy any remaining $defs (excluding the inlined one) for nested references
	remaining := make(map[string]any)
	for k, v := range defs {
		if k != typeName {
			remaining[k] = v
		}
	}
	if len(remaining) > 0 {
		inlined["$defs"] = remaining
	}

	return inlined
}
