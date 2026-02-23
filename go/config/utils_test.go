package config

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestCamelToUpperSnake(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"apiUrl", "API_URL"},
		{"maxRetries", "MAX_RETRIES"},
		{"enableDebug", "ENABLE_DEBUG"},
		{"appName", "APP_NAME"},
		{"database", "DATABASE"},
		{"apiKey", "API_KEY"},
		{"dbPassword", "DB_PASSWORD"},
		{"jwtSecret", "JWT_SECRET"},
		{"enableNewUI", "ENABLE_NEW_UI"},
		{"enableBeta", "ENABLE_BETA"},
		{"maintenanceMode", "MAINTENANCE_MODE"},
		// Already UPPER_SNAKE_CASE
		{"API_URL", "API_URL"},
		{"MAX_RETRIES", "MAX_RETRIES"},
		{"DATABASE", "DATABASE"},
		// Acronym handling
		{"apiURL", "API_URL"},
		// Edge cases
		{"", ""},
		{"a", "A"},
		{"A", "A"},
		{"hello", "HELLO"},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			assert.Equal(t, tt.expected, CamelToUpperSnake(tt.input))
		})
	}
}

func TestCoerceBoolean(t *testing.T) {
	assert.True(t, CoerceBoolean("true"))
	assert.True(t, CoerceBoolean("TRUE"))
	assert.True(t, CoerceBoolean("True"))
	assert.True(t, CoerceBoolean("1"))
	assert.False(t, CoerceBoolean("false"))
	assert.False(t, CoerceBoolean("0"))
	assert.False(t, CoerceBoolean(""))
	assert.False(t, CoerceBoolean("yes"))
}

func TestConfigError(t *testing.T) {
	err := NewConfigError("test error")
	assert.Equal(t, "[Smooai Config] test error", err.Error())
	assert.Error(t, err)
}
