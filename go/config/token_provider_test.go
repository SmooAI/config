package config

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// SMOODEV-975 — tests for the OAuth2 client_credentials token provider used
// by the runtime ConfigClient. Parity with src/platform/TokenProvider.test.ts
// and python/tests/test_token_provider.py.

func TestTokenProvider_RejectsEmptyAuthURL(t *testing.T) {
	_, err := NewTokenProvider("", "cid", "sec")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "authURL")
}

func TestTokenProvider_RejectsEmptyClientID(t *testing.T) {
	_, err := NewTokenProvider("https://auth.example.com", "", "sec")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "clientID")
}

func TestTokenProvider_RejectsEmptyClientSecret(t *testing.T) {
	_, err := NewTokenProvider("https://auth.example.com", "cid", "")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "clientSecret")
}

func TestTokenProvider_PostsClientCredentialsForm(t *testing.T) {
	var capturedReq *http.Request
	var capturedBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedReq = r
		body, _ := io.ReadAll(r.Body)
		capturedBody = string(body)
		_, _ = w.Write([]byte(`{"access_token":"minted-jwt","expires_in":3600}`))
	}))
	defer srv.Close()

	tp, err := NewTokenProvider(srv.URL, "my-client", "my-secret")
	require.NoError(t, err)

	token, err := tp.GetAccessToken(context.Background())
	require.NoError(t, err)
	assert.Equal(t, "minted-jwt", token)

	require.NotNil(t, capturedReq)
	assert.Equal(t, http.MethodPost, capturedReq.Method)
	assert.Equal(t, "/token", capturedReq.URL.Path)
	assert.Equal(t, "application/x-www-form-urlencoded", capturedReq.Header.Get("Content-Type"))

	form, err := url.ParseQuery(capturedBody)
	require.NoError(t, err)
	assert.Equal(t, "client_credentials", form.Get("grant_type"))
	assert.Equal(t, "client_credentials", form.Get("provider"))
	assert.Equal(t, "my-client", form.Get("client_id"))
	assert.Equal(t, "my-secret", form.Get("client_secret"))
}

func TestTokenProvider_TrimsTrailingSlashOnAuthURL(t *testing.T) {
	var capturedPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedPath = r.URL.Path
		_, _ = w.Write([]byte(`{"access_token":"t","expires_in":3600}`))
	}))
	defer srv.Close()

	tp, err := NewTokenProvider(srv.URL+"////", "cid", "sec")
	require.NoError(t, err)
	_, err = tp.GetAccessToken(context.Background())
	require.NoError(t, err)
	assert.Equal(t, "/token", capturedPath)
}

func TestTokenProvider_CachesWithinExpiryWindow(t *testing.T) {
	var hits atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		_, _ = w.Write([]byte(`{"access_token":"cached-jwt","expires_in":3600}`))
	}))
	defer srv.Close()

	tp, err := NewTokenProvider(srv.URL, "cid", "sec")
	require.NoError(t, err)

	for i := 0; i < 5; i++ {
		token, err := tp.GetAccessToken(context.Background())
		require.NoError(t, err)
		assert.Equal(t, "cached-jwt", token)
	}
	assert.Equal(t, int64(1), hits.Load())
}

func TestTokenProvider_RefreshesWithinRefreshWindow(t *testing.T) {
	// expires_in=10s + default refresh window=60s ⇒ every call refreshes.
	var hits atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		_, _ = w.Write([]byte(`{"access_token":"short-lived","expires_in":10}`))
	}))
	defer srv.Close()

	tp, err := NewTokenProvider(srv.URL, "cid", "sec")
	require.NoError(t, err)

	_, _ = tp.GetAccessToken(context.Background())
	_, _ = tp.GetAccessToken(context.Background())
	assert.Equal(t, int64(2), hits.Load())
}

func TestTokenProvider_InvalidateForcesRefresh(t *testing.T) {
	var hits atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		_, _ = w.Write([]byte(`{"access_token":"t","expires_in":3600}`))
	}))
	defer srv.Close()

	tp, err := NewTokenProvider(srv.URL, "cid", "sec")
	require.NoError(t, err)

	_, _ = tp.GetAccessToken(context.Background())
	assert.Equal(t, int64(1), hits.Load())

	tp.Invalidate()
	_, _ = tp.GetAccessToken(context.Background())
	assert.Equal(t, int64(2), hits.Load())
}

func TestTokenProvider_ConcurrentCallersShareCache(t *testing.T) {
	var hits atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		// Hold long enough that concurrent callers actually race.
		time.Sleep(20 * time.Millisecond)
		_, _ = w.Write([]byte(`{"access_token":"shared","expires_in":3600}`))
	}))
	defer srv.Close()

	tp, err := NewTokenProvider(srv.URL, "cid", "sec")
	require.NoError(t, err)

	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			token, err := tp.GetAccessToken(context.Background())
			assert.NoError(t, err)
			assert.Equal(t, "shared", token)
		}()
	}
	wg.Wait()
	// The mutex serializes — exactly one HTTP exchange.
	assert.Equal(t, int64(1), hits.Load())
}

func TestTokenProvider_ErrorsOnNon2xx(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"bad creds"}`))
	}))
	defer srv.Close()

	tp, err := NewTokenProvider(srv.URL, "cid", "sec")
	require.NoError(t, err)

	_, err = tp.GetAccessToken(context.Background())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "OAuth token exchange failed: HTTP 401")
}

func TestTokenProvider_ErrorsOnMissingAccessToken(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"expires_in":3600}`))
	}))
	defer srv.Close()

	tp, err := NewTokenProvider(srv.URL, "cid", "sec")
	require.NoError(t, err)

	_, err = tp.GetAccessToken(context.Background())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "no access_token")
}

func TestTokenProvider_ErrorsOnNonJSONResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`not json`))
	}))
	defer srv.Close()

	tp, err := NewTokenProvider(srv.URL, "cid", "sec")
	require.NoError(t, err)

	_, err = tp.GetAccessToken(context.Background())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "not JSON")
}

func TestTokenProvider_DefaultExpiresInWhenMissing(t *testing.T) {
	// Server omits expires_in — default to 3600s, so subsequent calls cache.
	var hits atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		_, _ = w.Write([]byte(`{"access_token":"t"}`))
	}))
	defer srv.Close()

	tp, err := NewTokenProvider(srv.URL, "cid", "sec")
	require.NoError(t, err)
	_, _ = tp.GetAccessToken(context.Background())
	_, _ = tp.GetAccessToken(context.Background())
	assert.Equal(t, int64(1), hits.Load())
}

func TestTokenProvider_CustomRefreshWindowOption(t *testing.T) {
	var hits atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		_, _ = w.Write([]byte(`{"access_token":"t","expires_in":3600}`))
	}))
	defer srv.Close()

	// 7200s refresh window vs 3600s expiry ⇒ every call refreshes.
	tp, err := NewTokenProvider(srv.URL, "cid", "sec",
		WithTokenProviderRefreshWindow(2*time.Hour),
	)
	require.NoError(t, err)
	_, _ = tp.GetAccessToken(context.Background())
	_, _ = tp.GetAccessToken(context.Background())
	assert.Equal(t, int64(2), hits.Load())
}

// silence unused import warnings when refactoring.
var _ = strings.Builder{}
