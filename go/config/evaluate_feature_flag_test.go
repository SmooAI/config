package config

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// evalHandler simulates POST /organizations/{org}/config/feature-flags/{key}/evaluate.
// Records the last parsed body and returns whatever `reply` produces.
type evalHandler struct {
	key     string
	reply   func(environment string, context map[string]any) (int, map[string]any)
	lastEnv string
	lastCtx map[string]any
	calls   atomic.Int32
}

func newEvalServer(t *testing.T, handlers ...*evalHandler) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+testAPIKey {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		prefix := "/organizations/" + testOrgID + "/config/feature-flags/"
		if !strings.HasPrefix(r.URL.Path, prefix) || !strings.HasSuffix(r.URL.Path, "/evaluate") {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		key := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, prefix), "/evaluate")

		raw, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		var body struct {
			Environment string         `json:"environment"`
			Context     map[string]any `json:"context"`
		}
		require.NoError(t, json.Unmarshal(raw, &body))

		for _, h := range handlers {
			if h.key == key {
				h.calls.Add(1)
				h.lastEnv = body.Environment
				h.lastCtx = body.Context
				status, payload := h.reply(body.Environment, body.Context)
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(status)
				_ = json.NewEncoder(w).Encode(payload)
				return
			}
		}
		http.Error(w, "not found", http.StatusNotFound)
	}))
}

func TestEvaluateFeatureFlag_PostsEnvAndContext(t *testing.T) {
	h := &evalHandler{
		key: "new-dashboard",
		reply: func(_ string, _ map[string]any) (int, map[string]any) {
			return http.StatusOK, map[string]any{"value": true, "source": "rule", "matchedRuleId": "pro-users"}
		},
	}
	srv := newEvalServer(t, h)
	defer srv.Close()

	client := NewConfigClient(srv.URL, testAPIKey, testOrgID)
	defer client.Close()
	res, err := client.EvaluateFeatureFlag("new-dashboard", map[string]any{"userId": "u1", "plan": "pro"}, "production")
	require.NoError(t, err)
	assert.Equal(t, true, res.Value)
	assert.Equal(t, "rule", res.Source)
	assert.Equal(t, "pro-users", res.MatchedRuleID)
	assert.Equal(t, "production", h.lastEnv)
	assert.Equal(t, "u1", h.lastCtx["userId"])
	assert.Equal(t, "pro", h.lastCtx["plan"])
}

func TestEvaluateFeatureFlag_DefaultsContextToEmpty(t *testing.T) {
	h := &evalHandler{
		key: "flag",
		reply: func(_ string, ctx map[string]any) (int, map[string]any) {
			if ctx == nil || len(ctx) != 0 {
				return http.StatusBadRequest, map[string]any{"error": "expected empty context"}
			}
			return http.StatusOK, map[string]any{"value": false, "source": "default"}
		},
	}
	srv := newEvalServer(t, h)
	defer srv.Close()

	client := NewConfigClient(srv.URL, testAPIKey, testOrgID)
	defer client.Close()
	res, err := client.EvaluateFeatureFlag("flag", nil, "")
	require.NoError(t, err)
	assert.Equal(t, "default", res.Source)
}

func TestEvaluateFeatureFlag_NotCachedHitsServerTwice(t *testing.T) {
	h := &evalHandler{
		key: "flag",
		reply: func(_ string, _ map[string]any) (int, map[string]any) {
			bucket := 42
			return http.StatusOK, map[string]any{"value": true, "source": "rollout", "rolloutBucket": bucket}
		},
	}
	srv := newEvalServer(t, h)
	defer srv.Close()

	client := NewConfigClient(srv.URL, testAPIKey, testOrgID)
	defer client.Close()
	_, err := client.EvaluateFeatureFlag("flag", map[string]any{"userId": "u1"}, "")
	require.NoError(t, err)
	_, err = client.EvaluateFeatureFlag("flag", map[string]any{"userId": "u1"}, "")
	require.NoError(t, err)
	assert.Equal(t, int32(2), h.calls.Load())
}

func TestEvaluateFeatureFlag_SurfacesHTTPError(t *testing.T) {
	srv := newEvalServer(t) // no handlers
	defer srv.Close()

	client := NewConfigClient(srv.URL, testAPIKey, testOrgID)
	defer client.Close()
	_, err := client.EvaluateFeatureFlag("missing", nil, "")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "404")
}
