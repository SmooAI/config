package config

import (
	"fmt"
	"strings"
	"unicode"
)

// ConfigError represents a configuration error.
type ConfigError struct {
	Message string
}

func (e *ConfigError) Error() string {
	return e.Message
}

// NewConfigError creates a new config error with the standard prefix.
func NewConfigError(message string) *ConfigError {
	return &ConfigError{Message: fmt.Sprintf("[Smooai Config] %s", message)}
}

// CamelToUpperSnake converts a camelCase string to UPPER_SNAKE_CASE.
//
// One-pass conversion:
//   - Early exit if already UPPER_SNAKE_CASE
//   - Drops underscores/spaces
//   - Splits on lower→Upper and Acronym→Word boundaries
func CamelToUpperSnake(input string) string {
	if input == "" {
		return ""
	}

	if isUpperSnakeCase(input) {
		return input
	}

	runes := []rune(input)
	length := len(runes)
	var out strings.Builder
	out.Grow(length + 4)

	for i := 0; i < length; i++ {
		ch := runes[i]

		// Skip underscores and spaces
		if ch == '_' || ch == ' ' {
			continue
		}

		if unicode.IsUpper(ch) {
			if i > 0 {
				prev := runes[i-1]
				prevIsLower := unicode.IsLower(prev)
				nextIsLower := i+1 < length && unicode.IsLower(runes[i+1])
				if prevIsLower || nextIsLower {
					out.WriteRune('_')
				}
			}
			out.WriteRune(ch)
		} else if unicode.IsLower(ch) {
			out.WriteRune(unicode.ToUpper(ch))
		} else {
			// digits and other chars
			out.WriteRune(ch)
		}
	}

	return out.String()
}

// isUpperSnakeCase checks if a string matches ^[A-Z0-9]+(_[A-Z0-9]+)*$.
func isUpperSnakeCase(s string) bool {
	if s == "" {
		return false
	}
	runes := []rune(s)
	if runes[0] == '_' || runes[len(runes)-1] == '_' {
		return false
	}
	prevUnderscore := false
	for _, r := range runes {
		if r == '_' {
			if prevUnderscore {
				return false
			}
			prevUnderscore = true
			continue
		}
		prevUnderscore = false
		if !unicode.IsUpper(r) && !unicode.IsDigit(r) {
			return false
		}
	}
	return true
}

// CoerceBoolean coerces a string value to boolean.
// "true", "1" → true; everything else → false.
func CoerceBoolean(value string) bool {
	lower := strings.ToLower(strings.TrimSpace(value))
	return lower == "true" || lower == "1"
}
