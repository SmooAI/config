package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type validCase struct {
	Name   string         `json:"name"`
	Schema map[string]any `json:"schema"`
}

type invalidCase struct {
	Name             string         `json:"name"`
	Schema           map[string]any `json:"schema"`
	ExpectedKeywords []string       `json:"expected_keywords"`
}

type testFixtures struct {
	Valid   []validCase   `json:"valid"`
	Invalid []invalidCase `json:"invalid"`
}

func loadFixtures(t *testing.T) testFixtures {
	t.Helper()
	_, filename, _, _ := runtime.Caller(0)
	fixturesPath := filepath.Join(filepath.Dir(filename), "../../test-fixtures/schema-validation-cases.json")
	data, err := os.ReadFile(fixturesPath)
	require.NoError(t, err, "Failed to read test fixtures")
	var fixtures testFixtures
	require.NoError(t, json.Unmarshal(data, &fixtures), "Failed to parse test fixtures")
	return fixtures
}

func TestValidSchemasFromFixtures(t *testing.T) {
	fixtures := loadFixtures(t)
	for _, tc := range fixtures.Valid {
		t.Run(tc.Name, func(t *testing.T) {
			result := ValidateSmooaiSchema(tc.Schema)
			keywords := make([]string, 0, len(result.Errors))
			for _, e := range result.Errors {
				keywords = append(keywords, e.Keyword)
			}
			assert.True(t, result.Valid, "Expected valid but got errors: %v", keywords)
			assert.Empty(t, result.Errors)
		})
	}
}

func TestInvalidSchemasFromFixtures(t *testing.T) {
	fixtures := loadFixtures(t)
	for _, tc := range fixtures.Invalid {
		t.Run(tc.Name, func(t *testing.T) {
			result := ValidateSmooaiSchema(tc.Schema)
			assert.False(t, result.Valid, "Expected invalid but got valid")
			assert.NotEmpty(t, result.Errors)

			reported := map[string]bool{}
			for _, e := range result.Errors {
				reported[e.Keyword] = true
			}
			for _, expected := range tc.ExpectedKeywords {
				assert.True(t, reported[expected],
					"Expected keyword %q in errors, got %v", expected, reported)
			}
		})
	}
}

func TestErrorStructure(t *testing.T) {
	schema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"value": map[string]any{
				"not": map[string]any{"type": "string"},
			},
		},
	}
	result := ValidateSmooaiSchema(schema)
	assert.False(t, result.Valid)
	require.Len(t, result.Errors, 1)
	err := result.Errors[0]
	assert.Equal(t, "/properties/value", err.Path)
	assert.Equal(t, "not", err.Keyword)
	assert.Contains(t, err.Message, "not")
	assert.NotEmpty(t, err.Suggestion)
}

func TestUnsupportedFormat(t *testing.T) {
	schema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"field": map[string]any{"type": "string", "format": "hostname"},
		},
	}
	result := ValidateSmooaiSchema(schema)
	assert.False(t, result.Valid)
	assert.Equal(t, "format", result.Errors[0].Keyword)
	assert.Contains(t, result.Errors[0].Message, "hostname")
}

func TestEmptySchema(t *testing.T) {
	result := ValidateSmooaiSchema(map[string]any{})
	assert.True(t, result.Valid)
}
