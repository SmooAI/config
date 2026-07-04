package config

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// SMOODEV-2306: limits are the numeric sibling of feature flags. These tests
// mirror feature_flag_evaluate_test.go.

func TestEvaluateLimit_PostsExpectedBodyAndReturnsNumericValue(t *testing.T) {
	var gotMethod, gotPath string
	var gotBody map[string]any

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		body, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		require.NoError(t, json.Unmarshal(body, &gotBody))

		w.Header().Set("Content-Type", "application/json")
		ruleID := "rule-9"
		require.NoError(t, json.NewEncoder(w).Encode(EvaluateLimitResponse{
			Value:         20,
			Source:        "rule",
			MatchedRuleID: &ruleID,
		}))
	}))
	defer server.Close()

	client := newFeatureFlagTestClient(t, server.URL, "org-abc", "secret-key")
	defer client.Close()

	resp, err := client.EvaluateLimit(context.Background(), "agentMaxIterations", map[string]any{
		"orgId":   "o-1",
		"agentId": "a-1",
	}, "production")
	require.NoError(t, err)
	require.NotNil(t, resp)

	assert.Equal(t, http.MethodPost, gotMethod)
	assert.Equal(t, "/organizations/org-abc/config/limits/agentMaxIterations/evaluate", gotPath)
	assert.Equal(t, "production", gotBody["environment"])
	assert.Equal(t, float64(20), resp.Value)
	assert.Equal(t, "rule", resp.Source)
	require.NotNil(t, resp.MatchedRuleID)
	assert.Equal(t, "rule-9", *resp.MatchedRuleID)
}

func TestEvaluateLimit_NilContextSerializesAsEmptyObject(t *testing.T) {
	var gotBody map[string]any

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		require.NoError(t, json.Unmarshal(body, &gotBody))
		w.Header().Set("Content-Type", "application/json")
		require.NoError(t, json.NewEncoder(w).Encode(EvaluateLimitResponse{Value: 12, Source: "default"}))
	}))
	defer server.Close()

	client := newFeatureFlagTestClient(t, server.URL, "org", "")
	defer client.Close()

	_, err := client.EvaluateLimit(context.Background(), "agentMaxIterations", nil, "production")
	require.NoError(t, err)

	ctxField, ok := gotBody["context"].(map[string]any)
	require.True(t, ok, "context should be a JSON object, got %T", gotBody["context"])
	assert.Empty(t, ctxField)
}

func TestEvaluateLimit_Maps404ToNotFound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("limit not defined"))
	}))
	defer server.Close()

	client := newFeatureFlagTestClient(t, server.URL, "org", "")
	defer client.Close()

	_, err := client.EvaluateLimit(context.Background(), "unknown", nil, "production")
	require.Error(t, err)
	assert.True(t, errors.Is(err, ErrLimitNotFound))

	var limitErr *LimitEvaluationError
	require.True(t, errors.As(err, &limitErr))
	assert.Equal(t, "unknown", limitErr.Key)
	assert.Equal(t, http.StatusNotFound, limitErr.StatusCode)
}

func TestEvaluateLimit_Maps400And5xx(t *testing.T) {
	for _, tc := range []struct {
		status int
		is     error
	}{
		{http.StatusBadRequest, ErrLimitContext},
		{http.StatusServiceUnavailable, ErrLimitServer},
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(tc.status)
		}))
		client := newFeatureFlagTestClient(t, server.URL, "org", "")

		_, err := client.EvaluateLimit(context.Background(), "agentMaxIterations", nil, "production")
		require.Error(t, err)
		assert.True(t, errors.Is(err, tc.is), "status %d should match sentinel", tc.status)

		client.Close()
		server.Close()
	}
}

func f64ptr(v float64) *float64 { return &v }

func TestClampLimit(t *testing.T) {
	spec := LimitSpec{Default: 12, Min: f64ptr(1), Max: f64ptr(50)}

	assert.Equal(t, float64(20), ClampLimit(20, spec))
	assert.Equal(t, float64(1), ClampLimit(-5, spec))
	assert.Equal(t, float64(50), ClampLimit(1000, spec))
	// Non-finite falls back to default.
	assert.Equal(t, float64(12), ClampLimit(math.NaN(), spec))
	assert.Equal(t, float64(12), ClampLimit(math.Inf(1), spec))

	stepped := LimitSpec{Default: 10, Min: f64ptr(0), Max: f64ptr(100), Step: f64ptr(5)}
	assert.Equal(t, float64(10), ClampLimit(12, stepped))
	assert.Equal(t, float64(15), ClampLimit(13, stepped))
}
