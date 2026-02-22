package config

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newTestServer(handler http.HandlerFunc) *httptest.Server {
	return httptest.NewServer(handler)
}

func TestNewConfigClient_TrimsTrailingSlash(t *testing.T) {
	client := NewConfigClient("https://api.example.com/", "key", "org-id")
	defer client.Close()

	assert.Equal(t, "https://api.example.com", client.baseURL)
}

func TestNewConfigClient_PreservesURL(t *testing.T) {
	client := NewConfigClient("https://api.example.com", "key", "org-id")
	defer client.Close()

	assert.Equal(t, "https://api.example.com", client.baseURL)
}

func TestNewConfigClient_StoresOrgID(t *testing.T) {
	client := NewConfigClient("https://api.example.com", "key", "my-org-123")
	defer client.Close()

	assert.Equal(t, "my-org-123", client.orgID)
}

func TestNewConfigClient_InitializesEmptyCache(t *testing.T) {
	client := NewConfigClient("https://api.example.com", "key", "org")
	defer client.Close()

	assert.Empty(t, client.cache)
}

func TestGetValue_FetchesSingleValue(t *testing.T) {
	server := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		assert.Contains(t, r.URL.Path, "/config/values/API_URL")
		assert.Equal(t, "Bearer test-key", r.Header.Get("Authorization"))
		json.NewEncoder(w).Encode(valueResponse{Value: "https://api.example.com"})
	})
	defer server.Close()

	client := NewConfigClient(server.URL, "test-key", "org-123")
	defer client.Close()

	val, err := client.GetValue("API_URL", "production")
	require.NoError(t, err)
	assert.Equal(t, "https://api.example.com", val)
}

func TestGetValue_CachesResult(t *testing.T) {
	callCount := 0
	server := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		json.NewEncoder(w).Encode(valueResponse{Value: "cached-value"})
	})
	defer server.Close()

	client := NewConfigClient(server.URL, "key", "org")
	defer client.Close()

	// First call hits server
	val1, err := client.GetValue("KEY", "prod")
	require.NoError(t, err)
	assert.Equal(t, "cached-value", val1)
	assert.Equal(t, 1, callCount)

	// Second call uses cache
	val2, err := client.GetValue("KEY", "prod")
	require.NoError(t, err)
	assert.Equal(t, "cached-value", val2)
	assert.Equal(t, 1, callCount) // No additional server call
}

func TestGetValue_SeparateCachePerEnvironment(t *testing.T) {
	server := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		env := r.URL.Query().Get("environment")
		json.NewEncoder(w).Encode(valueResponse{Value: "value-" + env})
	})
	defer server.Close()

	client := NewConfigClient(server.URL, "key", "org")
	defer client.Close()

	val1, err := client.GetValue("KEY", "prod")
	require.NoError(t, err)
	assert.Equal(t, "value-prod", val1)

	val2, err := client.GetValue("KEY", "staging")
	require.NoError(t, err)
	assert.Equal(t, "value-staging", val2)
}

func TestGetAllValues_FetchesAllValues(t *testing.T) {
	server := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		assert.Contains(t, r.URL.Path, "/config/values")
		json.NewEncoder(w).Encode(valuesResponse{
			Values: map[string]any{
				"API_URL":     "https://api.example.com",
				"MAX_RETRIES": float64(3),
				"DEBUG":       false,
			},
		})
	})
	defer server.Close()

	client := NewConfigClient(server.URL, "key", "org")
	defer client.Close()

	values, err := client.GetAllValues("production")
	require.NoError(t, err)
	assert.Len(t, values, 3)
	assert.Equal(t, "https://api.example.com", values["API_URL"])
	assert.Equal(t, float64(3), values["MAX_RETRIES"])
	assert.Equal(t, false, values["DEBUG"])
}

func TestGetAllValues_PopulatesCache(t *testing.T) {
	server := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(valuesResponse{
			Values: map[string]any{
				"KEY1": "val1",
				"KEY2": "val2",
			},
		})
	})
	defer server.Close()

	client := NewConfigClient(server.URL, "key", "org")
	defer client.Close()

	_, err := client.GetAllValues("prod")
	require.NoError(t, err)

	assert.Equal(t, "val1", client.cache["prod:KEY1"])
	assert.Equal(t, "val2", client.cache["prod:KEY2"])
}

func TestInvalidateCache_ClearsAll(t *testing.T) {
	client := NewConfigClient("https://example.com", "key", "org")
	defer client.Close()

	client.cache["prod:KEY"] = "value"
	client.cache["staging:KEY"] = "value2"
	assert.Len(t, client.cache, 2)

	client.InvalidateCache()
	assert.Empty(t, client.cache)
}

func TestInvalidateCache_EmptyIsNoop(t *testing.T) {
	client := NewConfigClient("https://example.com", "key", "org")
	defer client.Close()

	client.InvalidateCache()
	assert.Empty(t, client.cache)
}

func TestGetValue_ErrorOnServerError(t *testing.T) {
	server := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error": "Internal server error"}`))
	})
	defer server.Close()

	client := NewConfigClient(server.URL, "key", "org")
	defer client.Close()

	_, err := client.GetValue("KEY", "prod")
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "500")
}

func TestGetValue_ErrorOnUnauthorized(t *testing.T) {
	server := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"error": "Unauthorized"}`))
	})
	defer server.Close()

	client := NewConfigClient(server.URL, "bad-key", "org")
	defer client.Close()

	_, err := client.GetValue("KEY", "prod")
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "401")
}

func TestGetValue_ErrorOnNotFound(t *testing.T) {
	server := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"error": "Not found"}`))
	})
	defer server.Close()

	client := NewConfigClient(server.URL, "key", "org")
	defer client.Close()

	_, err := client.GetValue("nonexistent", "prod")
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "404")
}

func TestGetValue_SetsAuthorizationHeader(t *testing.T) {
	server := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "Bearer my-secret-api-key", r.Header.Get("Authorization"))
		json.NewEncoder(w).Encode(valueResponse{Value: "ok"})
	})
	defer server.Close()

	client := NewConfigClient(server.URL, "my-secret-api-key", "org")
	defer client.Close()

	_, err := client.GetValue("KEY", "prod")
	require.NoError(t, err)
}
