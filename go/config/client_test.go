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

func TestNewConfigClient_FallsBackToEnvVars(t *testing.T) {
	t.Setenv("SMOOAI_CONFIG_API_URL", "https://env.example.com")
	t.Setenv("SMOOAI_CONFIG_API_KEY", "env-key")
	t.Setenv("SMOOAI_CONFIG_ORG_ID", "env-org")
	t.Setenv("SMOOAI_CONFIG_ENV", "staging")

	client := NewConfigClient("", "", "")
	defer client.Close()

	assert.Equal(t, "https://env.example.com", client.baseURL)
	assert.Equal(t, "env-org", client.orgID)
	assert.Equal(t, "staging", client.defaultEnvironment)
}

func TestNewConfigClient_ExplicitOverridesEnv(t *testing.T) {
	t.Setenv("SMOOAI_CONFIG_API_URL", "https://env.example.com")
	t.Setenv("SMOOAI_CONFIG_API_KEY", "env-key")
	t.Setenv("SMOOAI_CONFIG_ORG_ID", "env-org")

	client := NewConfigClient("https://explicit.example.com", "explicit-key", "explicit-org")
	defer client.Close()

	assert.Equal(t, "https://explicit.example.com", client.baseURL)
	assert.Equal(t, "explicit-org", client.orgID)
}

func TestNewConfigClientFromEnv(t *testing.T) {
	t.Setenv("SMOOAI_CONFIG_API_URL", "https://from-env.example.com")
	t.Setenv("SMOOAI_CONFIG_API_KEY", "from-env-key")
	t.Setenv("SMOOAI_CONFIG_ORG_ID", "from-env-org")
	t.Setenv("SMOOAI_CONFIG_ENV", "production")

	client := NewConfigClientFromEnv()
	defer client.Close()

	assert.Equal(t, "https://from-env.example.com", client.baseURL)
	assert.Equal(t, "from-env-org", client.orgID)
	assert.Equal(t, "production", client.defaultEnvironment)
}

func TestNewConfigClient_DefaultEnvironment(t *testing.T) {
	// Without SMOOAI_CONFIG_ENV set, default should be "development"
	t.Setenv("SMOOAI_CONFIG_ENV", "")

	client := NewConfigClient("https://example.com", "key", "org")
	defer client.Close()

	assert.Equal(t, "development", client.defaultEnvironment)
}

func TestGetValue_UsesDefaultEnvironment(t *testing.T) {
	t.Setenv("SMOOAI_CONFIG_ENV", "staging")

	server := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "staging", r.URL.Query().Get("environment"))
		json.NewEncoder(w).Encode(valueResponse{Value: "staging-value"})
	})
	defer server.Close()

	client := NewConfigClient(server.URL, "key", "org")
	defer client.Close()

	val, err := client.GetValue("KEY", "")
	require.NoError(t, err)
	assert.Equal(t, "staging-value", val)
}

func TestGetAllValues_UsesDefaultEnvironment(t *testing.T) {
	t.Setenv("SMOOAI_CONFIG_ENV", "production")

	server := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "production", r.URL.Query().Get("environment"))
		json.NewEncoder(w).Encode(valuesResponse{
			Values: map[string]any{"KEY": "val"},
		})
	})
	defer server.Close()

	client := NewConfigClient(server.URL, "key", "org")
	defer client.Close()

	vals, err := client.GetAllValues("")
	require.NoError(t, err)
	assert.Equal(t, "val", vals["KEY"])
}
