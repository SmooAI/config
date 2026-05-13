package config

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// SMOODEV-975: After the OAuth handshake, the runtime client carries this
// JWT on every downstream request. Unit tests inject a stub TokenProvider
// that mints this fixed token so the tests focus on ConfigClient behavior
// (caching, fetch, error mapping) without exercising the full OAuth flow —
// the handshake itself is covered by TestTokenProvider_* in token_provider_test.go.
const unitTestJWT = "stub-jwt-unit"

type fixedTokenRoundTripper struct{ token string }

func (f fixedTokenRoundTripper) RoundTrip(_ *http.Request) (*http.Response, error) {
	return &http.Response{
		StatusCode: 200,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body: io.NopCloser(strings.NewReader(
			fmt.Sprintf(`{"access_token":%q,"expires_in":3600}`, f.token),
		)),
	}, nil
}

func newFixedTokenProvider(t *testing.T, token string) *TokenProvider {
	t.Helper()
	tp, err := NewTokenProvider(
		"https://stub.invalid",
		"stub-client-id",
		"stub-client-secret",
		WithTokenProviderHTTPClient(&http.Client{Transport: fixedTokenRoundTripper{token: token}}),
	)
	require.NoError(t, err)
	return tp
}

// newUnitClient builds a ConfigClient with a stub TokenProvider, so the
// unit tests don't need a live OAuth issuer.
func newUnitClient(t *testing.T, baseURL string, opts ...ConfigClientOption) *ConfigClient {
	t.Helper()
	all := append([]ConfigClientOption{WithTokenProvider(newFixedTokenProvider(t, unitTestJWT))}, opts...)
	return NewConfigClient(baseURL, "test-client-id", "test-secret", "org-id", all...)
}

func newTestServer(handler http.HandlerFunc) *httptest.Server {
	return httptest.NewServer(handler)
}

func TestNewConfigClient_TrimsTrailingSlash(t *testing.T) {
	client := NewConfigClient("https://api.example.com/", "cid", "sec", "org-id")
	defer client.Close()

	assert.Equal(t, "https://api.example.com", client.baseURL)
}

func TestNewConfigClient_PreservesURL(t *testing.T) {
	client := NewConfigClient("https://api.example.com", "cid", "sec", "org-id")
	defer client.Close()

	assert.Equal(t, "https://api.example.com", client.baseURL)
}

func TestNewConfigClient_StoresOrgID(t *testing.T) {
	client := NewConfigClient("https://api.example.com", "cid", "sec", "my-org-123")
	defer client.Close()

	assert.Equal(t, "my-org-123", client.orgID)
}

func TestNewConfigClient_InitializesEmptyCache(t *testing.T) {
	client := NewConfigClient("https://api.example.com", "cid", "sec", "org")
	defer client.Close()

	assert.Empty(t, client.cache)
}

func TestGetValue_FetchesSingleValue(t *testing.T) {
	server := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		assert.Contains(t, r.URL.Path, "/config/values/API_URL")
		// SMOODEV-975: the runtime client sends the JWT minted by the
		// TokenProvider, not the raw secret.
		assert.Equal(t, "Bearer "+unitTestJWT, r.Header.Get("Authorization"))
		json.NewEncoder(w).Encode(valueResponse{Value: "https://api.example.com"})
	})
	defer server.Close()

	client := newUnitClient(t, server.URL)
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

	client := newUnitClient(t, server.URL)
	defer client.Close()

	val1, err := client.GetValue("KEY", "prod")
	require.NoError(t, err)
	assert.Equal(t, "cached-value", val1)
	assert.Equal(t, 1, callCount)

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

	client := newUnitClient(t, server.URL)
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

	client := newUnitClient(t, server.URL)
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

	client := newUnitClient(t, server.URL)
	defer client.Close()

	_, err := client.GetAllValues("prod")
	require.NoError(t, err)

	assert.Equal(t, "val1", client.cache["prod:KEY1"].value)
	assert.Equal(t, "val2", client.cache["prod:KEY2"].value)
}

func TestInvalidateCache_ClearsAll(t *testing.T) {
	client := NewConfigClient("https://example.com", "cid", "sec", "org")
	defer client.Close()

	client.cache["prod:KEY"] = cacheEntry{value: "value"}
	client.cache["staging:KEY"] = cacheEntry{value: "value2"}
	assert.Len(t, client.cache, 2)

	client.InvalidateCache()
	assert.Empty(t, client.cache)
}

func TestInvalidateCache_EmptyIsNoop(t *testing.T) {
	client := NewConfigClient("https://example.com", "cid", "sec", "org")
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

	client := newUnitClient(t, server.URL)
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

	// SMOODEV-975: when the server consistently returns 401, the client
	// invalidates+retries once but ultimately surfaces the 401.
	client := newUnitClient(t, server.URL)
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

	client := newUnitClient(t, server.URL)
	defer client.Close()

	_, err := client.GetValue("nonexistent", "prod")
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "404")
}

func TestGetValue_SetsAuthorizationHeader(t *testing.T) {
	server := newTestServer(func(w http.ResponseWriter, r *http.Request) {
		// SMOODEV-975: header is the OAuth-minted JWT.
		assert.Equal(t, "Bearer "+unitTestJWT, r.Header.Get("Authorization"))
		json.NewEncoder(w).Encode(valueResponse{Value: "ok"})
	})
	defer server.Close()

	client := newUnitClient(t, server.URL)
	defer client.Close()

	_, err := client.GetValue("KEY", "prod")
	require.NoError(t, err)
}

func TestNewConfigClient_FallsBackToEnvVars(t *testing.T) {
	t.Setenv("SMOOAI_CONFIG_API_URL", "https://env.example.com")
	t.Setenv("SMOOAI_CONFIG_CLIENT_ID", "env-cid")
	t.Setenv("SMOOAI_CONFIG_API_KEY", "env-key") // legacy → maps to clientSecret
	t.Setenv("SMOOAI_CONFIG_ORG_ID", "env-org")
	t.Setenv("SMOOAI_CONFIG_ENV", "staging")

	client := NewConfigClient("", "", "", "")
	defer client.Close()

	assert.Equal(t, "https://env.example.com", client.baseURL)
	assert.Equal(t, "env-org", client.orgID)
	assert.Equal(t, "staging", client.defaultEnvironment)
}

func TestNewConfigClient_ExplicitOverridesEnv(t *testing.T) {
	t.Setenv("SMOOAI_CONFIG_API_URL", "https://env.example.com")
	t.Setenv("SMOOAI_CONFIG_CLIENT_ID", "env-cid")
	t.Setenv("SMOOAI_CONFIG_API_KEY", "env-key")
	t.Setenv("SMOOAI_CONFIG_ORG_ID", "env-org")

	client := NewConfigClient("https://explicit.example.com", "explicit-cid", "explicit-secret", "explicit-org")
	defer client.Close()

	assert.Equal(t, "https://explicit.example.com", client.baseURL)
	assert.Equal(t, "explicit-org", client.orgID)
}

func TestNewConfigClientFromEnv(t *testing.T) {
	t.Setenv("SMOOAI_CONFIG_API_URL", "https://from-env.example.com")
	t.Setenv("SMOOAI_CONFIG_CLIENT_ID", "from-env-cid")
	t.Setenv("SMOOAI_CONFIG_CLIENT_SECRET", "from-env-secret")
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

	client := NewConfigClient("https://example.com", "cid", "sec", "org")
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

	client := newUnitClient(t, server.URL)
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

	client := newUnitClient(t, server.URL)
	defer client.Close()

	vals, err := client.GetAllValues("")
	require.NoError(t, err)
	assert.Equal(t, "val", vals["KEY"])
}
