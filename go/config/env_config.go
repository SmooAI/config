package config

import (
	"encoding/json"
	"strconv"
	"strings"
)

// FindAndProcessEnvConfig extracts config values from environment variables.
func FindAndProcessEnvConfig(schemaKeys map[string]bool, prefix string, schemaTypes map[string]string) map[string]any {
	return findAndProcessEnvConfigWithEnv(schemaKeys, prefix, schemaTypes, osEnvMap())
}

func findAndProcessEnvConfigWithEnv(schemaKeys map[string]bool, prefix string, schemaTypes map[string]string, env map[string]string) map[string]any {
	result := make(map[string]any)
	cloudRegion := GetCloudRegionFromEnv(env)

	envName := env["SMOOAI_CONFIG_ENV"]
	if envName == "" {
		envName = "development"
	}
	isLocal := CoerceBoolean(env["IS_LOCAL"])

	for key, value := range env {
		keyToUse := key
		if prefix != "" && strings.HasPrefix(key, prefix) {
			keyToUse = key[len(prefix):]
		}

		if !schemaKeys[keyToUse] {
			continue
		}

		// Type coercion
		if schemaTypes != nil {
			if typ, ok := schemaTypes[keyToUse]; ok {
				switch typ {
				case "boolean":
					result[keyToUse] = CoerceBoolean(value)
					continue
				case "number":
					if strings.Contains(value, ".") {
						if f, err := strconv.ParseFloat(value, 64); err == nil {
							result[keyToUse] = f
							continue
						}
					} else {
						if n, err := strconv.Atoi(value); err == nil {
							result[keyToUse] = n
							continue
						}
					}
				case "json", "object":
					var parsed any
					if err := json.Unmarshal([]byte(value), &parsed); err == nil {
						result[keyToUse] = parsed
						continue
					}
				}
			}
		}
		result[keyToUse] = value
	}

	// Set built-in keys
	result["ENV"] = envName
	result["IS_LOCAL"] = isLocal
	result["REGION"] = cloudRegion.Region
	result["CLOUD_PROVIDER"] = cloudRegion.Provider

	return result
}
