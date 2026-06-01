package container

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	config "github.com/SmooAI/config/go/config"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// stubClient is an in-memory ConfigClient for the injection-seam tests. It
// records the env-tier seed and serves values without a network round-trip.
type stubClient struct {
	mu          sync.Mutex
	values      map[string]any
	cache       map[string]any
	getValueErr error // when set, GetValue returns this
	allValueErr error // when set, GetAllValues returns this
	getValueN   int32
}

func newStubClient(values map[string]any) *stubClient {
	return &stubClient{values: values, cache: map[string]any{}}
}

func (s *stubClient) GetAllValues(environment string) (map[string]any, error) {
	if s.allValueErr != nil {
		return nil, s.allValueErr
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for k, v := range s.values {
		s.cache[k] = v
	}
	out := map[string]any{}
	for k, v := range s.values {
		out[k] = v
	}
	return out, nil
}

func (s *stubClient) GetValue(key, environment string) (any, error) {
	atomic.AddInt32(&s.getValueN, 1)
	if s.getValueErr != nil {
		return nil, s.getValueErr
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.values[key]
	if !ok {
		return nil, nil
	}
	s.cache[key] = v
	return v, nil
}

func (s *stubClient) GetCachedValue(key, environment string) (any, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.cache[key]
	return v, ok
}

func (s *stubClient) SeedCache(key string, value any, environment string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cache[key] = value
}

func testSchema(t *testing.T) *config.ConfigDefinition {
	t.Helper()
	return config.DefineConfig(
		map[string]any{"type": "object", "properties": map[string]any{"apiUrl": map[string]any{"type": "string"}}},
		map[string]any{"type": "object", "properties": map[string]any{"stripeApiKey": map[string]any{"type": "string"}}},
		map[string]any{"type": "object", "properties": map[string]any{"betaEnabled": map[string]any{"type": "boolean"}}},
	)
}

// --- §7.2: bootstrap-missing-env errors + lists missing -----------------------

func TestInitContainerConfig_MissingEnv_ErrorsAndListsMissing(t *testing.T) {
	_, err := InitContainerConfig(context.Background(), InitContainerConfigOptions{
		Schema:      testSchema(t),
		EnvOverride: map[string]string{}, // nothing set
	})
	require.Error(t, err)

	var be *ConfigBootstrapError
	require.True(t, errors.As(err, &be), "expected *ConfigBootstrapError, got %T", err)
	assert.ElementsMatch(t, []string{
		"SMOOAI_CONFIG_API_URL",
		"SMOOAI_CONFIG_CLIENT_ID",
		"SMOOAI_CONFIG_CLIENT_SECRET",
		"SMOOAI_CONFIG_ORG_ID",
		"SMOOAI_CONFIG_ENV",
	}, be.Missing)
	assert.Contains(t, be.Error(), "SMOOAI_CONFIG_CLIENT_ID")
}

func TestInitContainerConfig_BlankEnvCountsAsMissing(t *testing.T) {
	_, err := InitContainerConfig(context.Background(), InitContainerConfigOptions{
		Schema: testSchema(t),
		EnvOverride: map[string]string{
			"SMOOAI_CONFIG_API_URL":       "  ", // blank
			"SMOOAI_CONFIG_CLIENT_ID":     "id",
			"SMOOAI_CONFIG_CLIENT_SECRET": "sk",
			"SMOOAI_CONFIG_ORG_ID":        "org",
			"SMOOAI_CONFIG_ENV":           "production",
		},
	})
	var be *ConfigBootstrapError
	require.ErrorAs(t, err, &be)
	assert.Equal(t, []string{"SMOOAI_CONFIG_API_URL"}, be.Missing)
}

func TestInitContainerConfig_MissingSchema(t *testing.T) {
	_, err := InitContainerConfig(context.Background(), InitContainerConfigOptions{})
	var be *ConfigBootstrapError
	require.ErrorAs(t, err, &be)
	assert.Equal(t, []string{"Schema"}, be.Missing)
}

func TestInitContainerConfig_InjectedClient_OnlyEnvRequired(t *testing.T) {
	// With a ConfigClient injected, only SMOOAI_CONFIG_ENV is required.
	stub := newStubClient(map[string]any{"stripeApiKey": "sk_live_x"})
	h, err := InitContainerConfig(context.Background(), InitContainerConfigOptions{
		Schema:       testSchema(t),
		ConfigClient: stub,
		EnvOverride:  map[string]string{"SMOOAI_CONFIG_ENV": "production"},
	})
	require.NoError(t, err)
	require.NotNil(t, h)
	assert.Equal(t, "production", h.environment)
}

func TestInitContainerConfig_InjectedClient_MissingEnvStillErrors(t *testing.T) {
	stub := newStubClient(map[string]any{})
	_, err := InitContainerConfig(context.Background(), InitContainerConfigOptions{
		Schema:       testSchema(t),
		ConfigClient: stub,
		EnvOverride:  map[string]string{},
	})
	var be *ConfigBootstrapError
	require.ErrorAs(t, err, &be)
	assert.Equal(t, []string{"SMOOAI_CONFIG_ENV"}, be.Missing)
}

// --- §7.2: happy path fetch + cache ------------------------------------------

func newHandle(t *testing.T, values map[string]any, opts ...func(*InitContainerConfigOptions)) (*ContainerConfigHandle, *stubClient) {
	t.Helper()
	stub := newStubClient(values)
	o := InitContainerConfigOptions{
		Schema:       testSchema(t),
		ConfigClient: stub,
		EnvOverride:  map[string]string{"SMOOAI_CONFIG_ENV": "production"},
	}
	for _, f := range opts {
		f(&o)
	}
	h, err := InitContainerConfig(context.Background(), o)
	require.NoError(t, err)
	return h, stub
}

func TestGet_HappyPath(t *testing.T) {
	h, _ := newHandle(t, map[string]any{"stripeApiKey": "sk_live_x", "apiUrl": "https://api.smoo.ai"})

	v, ok, err := h.SecretConfig.Get("stripeApiKey")
	require.NoError(t, err)
	assert.True(t, ok)
	assert.Equal(t, "sk_live_x", v)

	pv, ok, err := h.PublicConfig.Get("apiUrl")
	require.NoError(t, err)
	assert.True(t, ok)
	assert.Equal(t, "https://api.smoo.ai", pv)
}

func TestGet_UsesCacheAfterInitialFetch(t *testing.T) {
	h, stub := newHandle(t, map[string]any{"stripeApiKey": "sk_live_x"})
	// MustGet reads cache only — the initial GetAllValues seeded it, so no
	// GetValue network call should be needed.
	v, ok := h.SecretConfig.MustGet("stripeApiKey")
	assert.True(t, ok)
	assert.Equal(t, "sk_live_x", v)
	assert.Equal(t, int32(0), atomic.LoadInt32(&stub.getValueN), "MustGet must not call GetValue")
}

// --- §7.2: required-key-unresolved errors (not absent) -----------------------

func TestGet_RequiredKeyUnresolved_Errors(t *testing.T) {
	h, _ := newHandle(t, map[string]any{}) // server has no value for the key

	_, ok, err := h.SecretConfig.Get("stripeApiKey")
	assert.False(t, ok)
	require.Error(t, err)
	var ue *ConfigKeyUnresolvedError
	require.ErrorAs(t, err, &ue)
	assert.Equal(t, "stripeApiKey", ue.Key)
	assert.Equal(t, "production", ue.Env)
	assert.Equal(t, []Tier{TierEnv, TierHTTP}, ue.TriedTiers)
}

func TestMustGet_RequiredKeyUnresolved_Panics(t *testing.T) {
	h, _ := newHandle(t, map[string]any{})
	defer func() {
		r := recover()
		require.NotNil(t, r, "MustGet should panic on unresolved required key")
		ue, ok := r.(*ConfigKeyUnresolvedError)
		require.True(t, ok, "panic value should be *ConfigKeyUnresolvedError, got %T", r)
		assert.Equal(t, "stripeApiKey", ue.Key)
	}()
	h.SecretConfig.MustGet("stripeApiKey")
}

// --- §7.2: optional-key-absent returns absent (ok=false, no error) -----------

func TestGet_OptionalKeyAbsent_NoError(t *testing.T) {
	h, _ := newHandle(t, map[string]any{}, func(o *InitContainerConfigOptions) {
		o.OptionalKeys = []string{"stripeApiKey"}
	})
	v, ok, err := h.SecretConfig.Get("stripeApiKey")
	require.NoError(t, err)
	assert.False(t, ok)
	assert.Nil(t, v)
}

func TestMustGet_OptionalKeyAbsent_NoPanic(t *testing.T) {
	h, _ := newHandle(t, map[string]any{}, func(o *InitContainerConfigOptions) {
		o.OptionalKeys = []string{"stripeApiKey"}
	})
	v, ok := h.SecretConfig.MustGet("stripeApiKey")
	assert.False(t, ok)
	assert.Nil(t, v)
}

func TestGet_EmptyKey_Errors(t *testing.T) {
	h, _ := newHandle(t, map[string]any{})
	_, _, err := h.SecretConfig.Get("")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "empty key")
}

// --- env-tier override wins over HTTP ----------------------------------------

func TestGet_EnvOverrideWinsOverHTTP(t *testing.T) {
	h, _ := newHandle(t, map[string]any{"stripeApiKey": "from_server"}, func(o *InitContainerConfigOptions) {
		o.EnvOverride = map[string]string{
			"SMOOAI_CONFIG_ENV": "production",
			"STRIPE_API_KEY":    "from_env",
		}
	})
	v, ok, err := h.SecretConfig.Get("stripeApiKey")
	require.NoError(t, err)
	assert.True(t, ok)
	assert.Equal(t, "from_env", v)
}

// --- §5: background-refresh failure serves last-good cached value ------------

func TestGet_RefreshFailure_ServesLastGood(t *testing.T) {
	h, stub := newHandle(t, map[string]any{"stripeApiKey": "cached_value"})
	// Prime the cache with a successful read.
	v, ok, err := h.SecretConfig.Get("stripeApiKey")
	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, "cached_value", v)

	// Now force GetValue to fail; the cached value should still be served.
	stub.getValueErr = errors.New("network down")
	v, ok, err = h.SecretConfig.Get("stripeApiKey")
	require.NoError(t, err)
	assert.True(t, ok)
	assert.Equal(t, "cached_value", v)
}

// --- §7.2: 401 → refresh → retry (exercises the real ConfigClient) -----------

func Test401_Refresh_Retry(t *testing.T) {
	var tokenMints int32
	var valuesAttempts int32

	auth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&tokenMints, 1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"jwt-token","expires_in":3600}`))
	}))
	defer auth.Close()

	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&valuesAttempts, 1)
		if n == 1 {
			// First values fetch (initial getAllValues) succeeds.
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"values":{"stripeApiKey":"sk_live_x"}}`))
			return
		}
		// On the GetValue read, return 401 the first time, then 200.
		if n == 2 {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"expired"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"value":"sk_live_refreshed"}`))
	}))
	defer api.Close()

	h, err := InitContainerConfig(context.Background(), InitContainerConfigOptions{
		Schema:       testSchema(t),
		APIURL:       api.URL,
		AuthURL:      auth.URL,
		ClientID:     "cid",
		ClientSecret: "csecret",
		OrgID:        "org",
		Environment:  "production",
		CacheTTL:     1 * time.Nanosecond, // force the GetValue read to bypass cache
	})
	require.NoError(t, err)

	// Sleep so the 1ns initial-fetch cache entry expires, forcing a fresh GetValue.
	time.Sleep(2 * time.Millisecond)

	v, ok, err := h.SecretConfig.Get("stripeApiKey")
	require.NoError(t, err)
	assert.True(t, ok)
	assert.Equal(t, "sk_live_refreshed", v)
	// Token minted twice: once initially, once after the 401 invalidation.
	assert.GreaterOrEqual(t, atomic.LoadInt32(&tokenMints), int32(2))
}

// --- §4: Health healthy / unhealthy ------------------------------------------

func TestHealth_HealthyAfterInit(t *testing.T) {
	h, _ := newHandle(t, map[string]any{"stripeApiKey": "x"})
	hh := h.Health()
	assert.Equal(t, "healthy", hh.Status)
	assert.True(t, hh.IsHealthy())

	// Free-function form.
	assert.Equal(t, "healthy", ConfigHealthOf(h).Status)
}

func TestHealth_UnhealthyWhenInitialFetchFails(t *testing.T) {
	stub := newStubClient(map[string]any{})
	stub.allValueErr = errors.New("config server unreachable")
	_, err := InitContainerConfig(context.Background(), InitContainerConfigOptions{
		Schema:       testSchema(t),
		ConfigClient: stub,
		EnvOverride:  map[string]string{"SMOOAI_CONFIG_ENV": "production"},
	})
	// Initial fetch failure surfaces at init (fail-loud).
	require.Error(t, err)
	assert.Contains(t, err.Error(), "config server unreachable")
}

func TestHealth_UnhealthyAfterRefreshFailurePastTTL(t *testing.T) {
	h, stub := newHandle(t, map[string]any{"stripeApiKey": "x"}, func(o *InitContainerConfigOptions) {
		o.CacheTTL = 5 * time.Millisecond
	})
	require.Equal(t, "healthy", h.Health().Status)

	// A refresh fails — within TTL we still report healthy (serve last-good).
	stub.getValueErr = errors.New("transient")
	_, _, _ = h.SecretConfig.Get("stripeApiKey")
	assert.Equal(t, "healthy", h.Health().Status, "within TTL a failed refresh stays healthy")

	// Past hard TTL, a failed refresh flips unhealthy.
	time.Sleep(8 * time.Millisecond)
	hh := h.Health()
	assert.Equal(t, "unhealthy", hh.Status)
	assert.Contains(t, hh.Reason, "transient")
}

func TestConfigHealthOf_NilHandle(t *testing.T) {
	hh := ConfigHealthOf(nil)
	assert.Equal(t, "unhealthy", hh.Status)
	assert.NotEmpty(t, hh.Reason)
}

func TestClient_EscapeHatch(t *testing.T) {
	h, stub := newHandle(t, map[string]any{})
	assert.Same(t, ConfigClient(stub), h.Client())
}

func TestEnvVarNameFor(t *testing.T) {
	cases := map[string]string{
		"stripeApiKey": "STRIPE_API_KEY",
		"apiUrl":       "API_URL",
		"betaEnabled":  "BETA_ENABLED",
		"x":            "X",
	}
	for in, want := range cases {
		assert.Equal(t, want, envVarNameFor(in), "envVarNameFor(%q)", in)
	}
}
