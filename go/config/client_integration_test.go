package config

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ---------------------------------------------------------------------------
// Test data — mirrors the API contract from packages/backend/src/routes/config
// ---------------------------------------------------------------------------

const testAPIKey = "test-api-key-abc123"
const testOrgID = "550e8400-e29b-41d4-a716-446655440000"

var configStoreData = map[string]map[string]any{
	"production": {
		"API_URL":       "https://api.smooai.com",
		"MAX_RETRIES":   float64(3),
		"ENABLE_NEW_UI": true,
		"DATABASE_URL":  "postgres://prod:secret@db.smooai.com/prod",
		"COMPLEX_VALUE": map[string]any{"nested": map[string]any{"deep": true}, "list": []any{float64(1), float64(2), float64(3)}},
	},
	"staging": {
		"API_URL":       "https://staging-api.smooai.com",
		"MAX_RETRIES":   float64(5),
		"ENABLE_NEW_UI": false,
		"DATABASE_URL":  "postgres://staging:secret@db.smooai.com/staging",
	},
	"development": {
		"API_URL":       "http://localhost:3000",
		"MAX_RETRIES":   float64(10),
		"ENABLE_NEW_UI": true,
	},
}

// ---------------------------------------------------------------------------
// Realistic mock server matching the backend API behavior
// ---------------------------------------------------------------------------

type mockConfigServer struct {
	requestCount atomic.Int64
	server       *httptest.Server
}

func newMockConfigServer() *mockConfigServer {
	m := &mockConfigServer{}

	mux := http.NewServeMux()

	// GET /organizations/{org_id}/config/values/{key}?environment=...
	// GET /organizations/{org_id}/config/values?environment=...
	mux.HandleFunc("/organizations/", func(w http.ResponseWriter, r *http.Request) {
		m.requestCount.Add(1)

		// Auth check
		auth := r.Header.Get("Authorization")
		if auth != "Bearer "+testAPIKey {
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(map[string]string{"error": "Unauthorized", "message": "Invalid or missing API key"})
			return
		}

		// Parse path: /organizations/{org_id}/config/values[/{key}]
		path := r.URL.Path
		prefix := fmt.Sprintf("/organizations/%s/config/values", testOrgID)

		// Check org_id
		if !strings.HasPrefix(path, fmt.Sprintf("/organizations/%s/", testOrgID)) {
			w.WriteHeader(http.StatusForbidden)
			json.NewEncoder(w).Encode(map[string]string{"error": "Forbidden", "message": "Not authorized for this organization"})
			return
		}

		environment := r.URL.Query().Get("environment")
		if environment == "" {
			environment = "development"
		}

		// Single value: /organizations/{org_id}/config/values/{key}
		if strings.HasPrefix(path, prefix+"/") {
			key, _ := url.PathUnescape(strings.TrimPrefix(path, prefix+"/"))
			envStore, exists := configStoreData[environment]
			if !exists {
				w.WriteHeader(http.StatusNotFound)
				json.NewEncoder(w).Encode(map[string]string{
					"error":   "Not found",
					"message": fmt.Sprintf("Config key %q not found in environment %q", key, environment),
				})
				return
			}
			value, ok := envStore[key]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				json.NewEncoder(w).Encode(map[string]string{
					"error":   "Not found",
					"message": fmt.Sprintf("Config key %q not found in environment %q", key, environment),
				})
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"value": value})
			return
		}

		// All values: /organizations/{org_id}/config/values
		if path == prefix {
			envStore, exists := configStoreData[environment]
			if !exists {
				json.NewEncoder(w).Encode(map[string]any{"values": map[string]any{}})
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"values": envStore})
			return
		}

		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{"error": "Not found"})
	})

	m.server = httptest.NewServer(mux)
	return m
}

func (m *mockConfigServer) close() {
	m.server.Close()
}

func (m *mockConfigServer) resetCount() {
	m.requestCount.Store(0)
}

func (m *mockConfigServer) count() int {
	return int(m.requestCount.Load())
}

func (m *mockConfigServer) newClient(environment string) *ConfigClient {
	return NewConfigClient(m.server.URL, testAPIKey, testOrgID)
}

func (m *mockConfigServer) newClientWithEnv(environment string) *ConfigClient {
	c := NewConfigClient(m.server.URL, testAPIKey, testOrgID)
	c.defaultEnvironment = environment
	return c
}

// ---------------------------------------------------------------------------
// getValue integration tests
// ---------------------------------------------------------------------------

func TestIntegration_GetValue_FetchesStringValue(t *testing.T) {
	m := newMockConfigServer()
	defer m.close()
	client := m.newClientWithEnv("production")
	defer client.Close()

	val, err := client.GetValue("API_URL", "production")
	require.NoError(t, err)
	assert.Equal(t, "https://api.smooai.com", val)
}

func TestIntegration_GetValue_FetchesNumericValue(t *testing.T) {
	m := newMockConfigServer()
	defer m.close()
	client := m.newClientWithEnv("production")
	defer client.Close()

	val, err := client.GetValue("MAX_RETRIES", "production")
	require.NoError(t, err)
	assert.Equal(t, float64(3), val)
}

func TestIntegration_GetValue_FetchesBooleanValue(t *testing.T) {
	m := newMockConfigServer()
	defer m.close()
	client := m.newClientWithEnv("production")
	defer client.Close()

	val, err := client.GetValue("ENABLE_NEW_UI", "production")
	require.NoError(t, err)
	assert.Equal(t, true, val)
}

func TestIntegration_GetValue_FetchesComplexNestedJSON(t *testing.T) {
	m := newMockConfigServer()
	defer m.close()
	client := m.newClientWithEnv("production")
	defer client.Close()

	val, err := client.GetValue("COMPLEX_VALUE", "production")
	require.NoError(t, err)
	valMap, ok := val.(map[string]any)
	require.True(t, ok)
	nested, ok := valMap["nested"].(map[string]any)
	require.True(t, ok)
	assert.Equal(t, true, nested["deep"])
}

func TestIntegration_GetValue_ExplicitEnvironmentOverridesDefault(t *testing.T) {
	m := newMockConfigServer()
	defer m.close()
	client := m.newClientWithEnv("production")
	defer client.Close()

	val, err := client.GetValue("API_URL", "staging")
	require.NoError(t, err)
	assert.Equal(t, "https://staging-api.smooai.com", val)
}

func TestIntegration_GetValue_UsesDefaultEnvironment(t *testing.T) {
	m := newMockConfigServer()
	defer m.close()
	client := m.newClientWithEnv("development")
	defer client.Close()

	val, err := client.GetValue("API_URL", "")
	require.NoError(t, err)
	assert.Equal(t, "http://localhost:3000", val)
}

func TestIntegration_GetValue_SendsAuthHeader(t *testing.T) {
	var receivedAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedAuth = r.Header.Get("Authorization")
		json.NewEncoder(w).Encode(map[string]any{"value": "ok"})
	}))
	defer server.Close()

	client := NewConfigClient(server.URL, testAPIKey, testOrgID)
	defer client.Close()
	_, _ = client.GetValue("KEY", "prod")

	assert.Equal(t, "Bearer "+testAPIKey, receivedAuth)
}

func TestIntegration_GetValue_ErrorOn401(t *testing.T) {
	m := newMockConfigServer()
	defer m.close()
	client := NewConfigClient(m.server.URL, "bad-key", testOrgID)
	defer client.Close()

	_, err := client.GetValue("API_URL", "production")
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "401")
}

func TestIntegration_GetValue_ErrorOn403(t *testing.T) {
	m := newMockConfigServer()
	defer m.close()
	client := NewConfigClient(m.server.URL, testAPIKey, "wrong-org-id")
	defer client.Close()

	_, err := client.GetValue("API_URL", "production")
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "403")
}

func TestIntegration_GetValue_ErrorOn404(t *testing.T) {
	m := newMockConfigServer()
	defer m.close()
	client := m.newClientWithEnv("production")
	defer client.Close()

	_, err := client.GetValue("NONEXISTENT_KEY", "production")
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "404")
}

func TestIntegration_GetValue_ErrorOn500(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": "Internal server error"})
	}))
	defer server.Close()

	client := NewConfigClient(server.URL, testAPIKey, testOrgID)
	defer client.Close()
	_, err := client.GetValue("API_URL", "production")
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "500")
}

// ---------------------------------------------------------------------------
// getAllValues integration tests
// ---------------------------------------------------------------------------

func TestIntegration_GetAllValues_FetchesAllProduction(t *testing.T) {
	m := newMockConfigServer()
	defer m.close()
	client := m.newClientWithEnv("production")
	defer client.Close()

	vals, err := client.GetAllValues("production")
	require.NoError(t, err)
	assert.Len(t, vals, 5)
	assert.Equal(t, "https://api.smooai.com", vals["API_URL"])
	assert.Equal(t, float64(3), vals["MAX_RETRIES"])
	assert.Equal(t, true, vals["ENABLE_NEW_UI"])
}

func TestIntegration_GetAllValues_FetchesStaging(t *testing.T) {
	m := newMockConfigServer()
	defer m.close()
	client := m.newClientWithEnv("staging")
	defer client.Close()

	vals, err := client.GetAllValues("staging")
	require.NoError(t, err)
	assert.Len(t, vals, 4)
	assert.Equal(t, "https://staging-api.smooai.com", vals["API_URL"])
}

func TestIntegration_GetAllValues_ExplicitEnvOverridesDefault(t *testing.T) {
	m := newMockConfigServer()
	defer m.close()
	client := m.newClientWithEnv("production")
	defer client.Close()

	vals, err := client.GetAllValues("staging")
	require.NoError(t, err)
	assert.Equal(t, "https://staging-api.smooai.com", vals["API_URL"])
}

func TestIntegration_GetAllValues_EmptyForUnknownEnv(t *testing.T) {
	m := newMockConfigServer()
	defer m.close()
	client := m.newClientWithEnv("production")
	defer client.Close()

	vals, err := client.GetAllValues("nonexistent")
	require.NoError(t, err)
	assert.Empty(t, vals)
}

func TestIntegration_GetAllValues_ErrorOn401(t *testing.T) {
	m := newMockConfigServer()
	defer m.close()
	client := NewConfigClient(m.server.URL, "bad-key", testOrgID)
	defer client.Close()

	_, err := client.GetAllValues("production")
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "401")
}

// ---------------------------------------------------------------------------
// Caching integration tests
// ---------------------------------------------------------------------------

func TestIntegration_Cache_GetValueCachesResult(t *testing.T) {
	m := newMockConfigServer()
	defer m.close()
	client := m.newClientWithEnv("production")
	defer client.Close()

	val1, err := client.GetValue("API_URL", "production")
	require.NoError(t, err)
	assert.Equal(t, "https://api.smooai.com", val1)
	assert.Equal(t, 1, m.count())

	val2, err := client.GetValue("API_URL", "production")
	require.NoError(t, err)
	assert.Equal(t, "https://api.smooai.com", val2)
	assert.Equal(t, 1, m.count()) // No additional request
}

func TestIntegration_Cache_PerEnvironment(t *testing.T) {
	m := newMockConfigServer()
	defer m.close()
	client := m.newClientWithEnv("production")
	defer client.Close()

	_, err := client.GetValue("API_URL", "production")
	require.NoError(t, err)
	assert.Equal(t, 1, m.count())

	_, err = client.GetValue("API_URL", "staging")
	require.NoError(t, err)
	assert.Equal(t, 2, m.count()) // Different env = new request
}

func TestIntegration_Cache_GetAllValuesPopulatesForGetValue(t *testing.T) {
	m := newMockConfigServer()
	defer m.close()
	client := m.newClientWithEnv("production")
	defer client.Close()

	_, err := client.GetAllValues("production")
	require.NoError(t, err)
	assert.Equal(t, 1, m.count())

	// Individual reads should come from cache
	val, err := client.GetValue("API_URL", "production")
	require.NoError(t, err)
	assert.Equal(t, "https://api.smooai.com", val)

	val2, err := client.GetValue("MAX_RETRIES", "production")
	require.NoError(t, err)
	assert.Equal(t, float64(3), val2)

	assert.Equal(t, 1, m.count()) // Still just 1 request
}

func TestIntegration_Cache_InvalidateForcesRefetch(t *testing.T) {
	m := newMockConfigServer()
	defer m.close()
	client := m.newClientWithEnv("production")
	defer client.Close()

	_, err := client.GetValue("API_URL", "production")
	require.NoError(t, err)
	assert.Equal(t, 1, m.count())

	client.InvalidateCache()

	_, err = client.GetValue("API_URL", "production")
	require.NoError(t, err)
	assert.Equal(t, 2, m.count()) // Re-fetched after invalidation
}

func TestIntegration_Cache_InvalidateClearsAllEnvironments(t *testing.T) {
	m := newMockConfigServer()
	defer m.close()
	client := m.newClientWithEnv("production")
	defer client.Close()

	_, _ = client.GetValue("API_URL", "production")
	_, _ = client.GetValue("API_URL", "staging")
	assert.Equal(t, 2, m.count())

	client.InvalidateCache()

	_, _ = client.GetValue("API_URL", "production")
	_, _ = client.GetValue("API_URL", "staging")
	assert.Equal(t, 4, m.count()) // Both re-fetched
}

func TestIntegration_Cache_GetAllForOneEnvDoesNotCacheAnother(t *testing.T) {
	m := newMockConfigServer()
	defer m.close()
	client := m.newClientWithEnv("production")
	defer client.Close()

	_, err := client.GetAllValues("production")
	require.NoError(t, err)
	assert.Equal(t, 1, m.count())

	// Different environment needs new fetch
	_, err = client.GetValue("API_URL", "staging")
	require.NoError(t, err)
	assert.Equal(t, 2, m.count())
}

// ---------------------------------------------------------------------------
// Thread safety tests
// ---------------------------------------------------------------------------

func TestIntegration_Cache_ConcurrentGetValue(t *testing.T) {
	m := newMockConfigServer()
	defer m.close()
	client := m.newClientWithEnv("production")
	defer client.Close()

	// Pre-populate cache
	_, err := client.GetValue("API_URL", "production")
	require.NoError(t, err)

	// Concurrent reads from cache
	done := make(chan bool, 10)
	for i := 0; i < 10; i++ {
		go func() {
			val, err := client.GetValue("API_URL", "production")
			assert.NoError(t, err)
			assert.Equal(t, "https://api.smooai.com", val)
			done <- true
		}()
	}

	for i := 0; i < 10; i++ {
		<-done
	}

	// Only the initial fetch should have hit the server
	assert.Equal(t, 1, m.count())
}

func TestIntegration_Cache_ConcurrentInvalidateAndRead(t *testing.T) {
	m := newMockConfigServer()
	defer m.close()
	client := m.newClientWithEnv("production")
	defer client.Close()

	// Pre-populate
	_, _ = client.GetValue("API_URL", "production")

	// Concurrent invalidate + reads should not panic
	done := make(chan bool, 20)
	for i := 0; i < 10; i++ {
		go func() {
			client.InvalidateCache()
			done <- true
		}()
		go func() {
			_, _ = client.GetValue("API_URL", "production")
			done <- true
		}()
	}

	for i := 0; i < 20; i++ {
		<-done
	}
}

// ---------------------------------------------------------------------------
// Full workflow tests
// ---------------------------------------------------------------------------

func TestIntegration_FullWorkflow_FetchAllThenReadIndividual(t *testing.T) {
	m := newMockConfigServer()
	defer m.close()
	client := m.newClientWithEnv("production")
	defer client.Close()

	// 1. Fetch all
	vals, err := client.GetAllValues("production")
	require.NoError(t, err)
	assert.Len(t, vals, 5)
	assert.Equal(t, 1, m.count())

	// 2. Read individuals from cache
	val, err := client.GetValue("API_URL", "production")
	require.NoError(t, err)
	assert.Equal(t, "https://api.smooai.com", val)

	val2, err := client.GetValue("DATABASE_URL", "production")
	require.NoError(t, err)
	assert.Equal(t, "postgres://prod:secret@db.smooai.com/prod", val2)
	assert.Equal(t, 1, m.count()) // No new requests

	// 3. Invalidate and re-fetch
	client.InvalidateCache()
	_, err = client.GetValue("API_URL", "production")
	require.NoError(t, err)
	assert.Equal(t, 2, m.count())
}

func TestIntegration_FullWorkflow_MultiEnvironment(t *testing.T) {
	m := newMockConfigServer()
	defer m.close()
	client := m.newClientWithEnv("production")
	defer client.Close()

	prod, err := client.GetValue("API_URL", "production")
	require.NoError(t, err)
	assert.Equal(t, "https://api.smooai.com", prod)

	staging, err := client.GetValue("API_URL", "staging")
	require.NoError(t, err)
	assert.Equal(t, "https://staging-api.smooai.com", staging)

	dev, err := client.GetValue("API_URL", "development")
	require.NoError(t, err)
	assert.Equal(t, "http://localhost:3000", dev)

	assert.Equal(t, 3, m.count())

	// All cached
	_, _ = client.GetValue("API_URL", "production")
	_, _ = client.GetValue("API_URL", "staging")
	_, _ = client.GetValue("API_URL", "development")
	assert.Equal(t, 3, m.count()) // No new requests
}
