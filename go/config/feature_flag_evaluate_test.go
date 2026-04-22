package config

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// helper to build a canned evaluator response
func encodeEvalResponse(t *testing.T, w http.ResponseWriter, resp EvaluateFeatureFlagResponse) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	require.NoError(t, json.NewEncoder(w).Encode(resp))
}

func TestEvaluateFeatureFlag_PostsExpectedBodyAndHeaders(t *testing.T) {
	var gotMethod, gotPath, gotAuth, gotContentType string
	var gotBody map[string]any

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod = r.Method
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotContentType = r.Header.Get("Content-Type")

		body, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		require.NoError(t, json.Unmarshal(body, &gotBody))

		encodeEvalResponse(t, w, EvaluateFeatureFlagResponse{
			Value:  true,
			Source: "rule",
		})
	}))
	defer server.Close()

	client := NewConfigClient(server.URL, "secret-key", "org-abc")
	defer client.Close()

	ctx := context.Background()
	resp, err := client.EvaluateFeatureFlag(ctx, "new_dashboard", map[string]any{
		"userId": "u-1",
		"plan":   "pro",
	}, "production")
	require.NoError(t, err)
	require.NotNil(t, resp)

	assert.Equal(t, http.MethodPost, gotMethod)
	assert.Equal(t, "/organizations/org-abc/config/feature-flags/new_dashboard/evaluate", gotPath)
	assert.Equal(t, "Bearer secret-key", gotAuth)
	assert.Equal(t, "application/json", gotContentType)

	assert.Equal(t, "production", gotBody["environment"])
	require.IsType(t, map[string]any{}, gotBody["context"])
	gotCtx := gotBody["context"].(map[string]any)
	assert.Equal(t, "u-1", gotCtx["userId"])
	assert.Equal(t, "pro", gotCtx["plan"])

	assert.Equal(t, true, resp.Value)
	assert.Equal(t, "rule", resp.Source)
}

func TestEvaluateFeatureFlag_NilContextSerializesAsEmptyObject(t *testing.T) {
	var gotBody map[string]any

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		require.NoError(t, json.Unmarshal(body, &gotBody))

		encodeEvalResponse(t, w, EvaluateFeatureFlagResponse{Value: false, Source: "default"})
	}))
	defer server.Close()

	client := NewConfigClient(server.URL, "key", "org")
	defer client.Close()

	_, err := client.EvaluateFeatureFlag(context.Background(), "flag", nil, "production")
	require.NoError(t, err)

	require.Contains(t, gotBody, "context")
	ctxField, ok := gotBody["context"].(map[string]any)
	require.True(t, ok, "context should be a JSON object, got %T", gotBody["context"])
	assert.Empty(t, ctxField)
}

func TestEvaluateFeatureFlag_UsesDefaultEnvironmentWhenEmpty(t *testing.T) {
	t.Setenv("SMOOAI_CONFIG_ENV", "staging")

	var gotEnv string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
		gotEnv, _ = body["environment"].(string)
		encodeEvalResponse(t, w, EvaluateFeatureFlagResponse{Value: "on", Source: "raw"})
	}))
	defer server.Close()

	client := NewConfigClient(server.URL, "key", "org")
	defer client.Close()

	_, err := client.EvaluateFeatureFlag(context.Background(), "flag", map[string]any{}, "")
	require.NoError(t, err)

	assert.Equal(t, "staging", gotEnv)
}

func TestEvaluateFeatureFlag_EnvironmentOverrideWins(t *testing.T) {
	t.Setenv("SMOOAI_CONFIG_ENV", "staging")

	var gotEnv string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
		gotEnv, _ = body["environment"].(string)
		encodeEvalResponse(t, w, EvaluateFeatureFlagResponse{Value: "x", Source: "raw"})
	}))
	defer server.Close()

	client := NewConfigClient(server.URL, "key", "org")
	defer client.Close()

	_, err := client.EvaluateFeatureFlag(context.Background(), "flag", nil, "production")
	require.NoError(t, err)
	assert.Equal(t, "production", gotEnv)
}

func TestEvaluateFeatureFlag_URLEncodesKey(t *testing.T) {
	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// r.URL.Path is already percent-decoded; r.URL.RawPath preserves escapes when they differ.
		if r.URL.RawPath != "" {
			gotPath = r.URL.RawPath
		} else {
			gotPath = r.URL.Path
		}
		encodeEvalResponse(t, w, EvaluateFeatureFlagResponse{Value: nil, Source: "default"})
	}))
	defer server.Close()

	client := NewConfigClient(server.URL, "key", "org-abc")
	defer client.Close()

	_, err := client.EvaluateFeatureFlag(context.Background(), "weird key/with:chars", nil, "production")
	require.NoError(t, err)

	// The key segment should be percent-encoded.
	assert.Contains(t, gotPath, "/feature-flags/")
	segments := strings.Split(gotPath, "/feature-flags/")
	require.Len(t, segments, 2)
	encodedKeyPlusSuffix := segments[1]
	assert.True(t, strings.HasSuffix(encodedKeyPlusSuffix, "/evaluate"))
	encodedKey := strings.TrimSuffix(encodedKeyPlusSuffix, "/evaluate")
	assert.NotContains(t, encodedKey, " ", "space must be encoded")
	assert.Contains(t, encodedKey, "%20", "space should be %20")
}

func TestEvaluateFeatureFlag_DecodesFullResponseShape(t *testing.T) {
	ruleID := "rule-42"
	bucket := 37

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		encodeEvalResponse(t, w, EvaluateFeatureFlagResponse{
			Value:         map[string]any{"variant": "B"},
			MatchedRuleID: &ruleID,
			RolloutBucket: &bucket,
			Source:        "rollout",
		})
	}))
	defer server.Close()

	client := NewConfigClient(server.URL, "key", "org")
	defer client.Close()

	resp, err := client.EvaluateFeatureFlag(context.Background(), "flag", map[string]any{"userId": "u"}, "production")
	require.NoError(t, err)
	require.NotNil(t, resp)
	assert.Equal(t, "rollout", resp.Source)
	require.NotNil(t, resp.MatchedRuleID)
	assert.Equal(t, "rule-42", *resp.MatchedRuleID)
	require.NotNil(t, resp.RolloutBucket)
	assert.Equal(t, 37, *resp.RolloutBucket)
	valMap, ok := resp.Value.(map[string]any)
	require.True(t, ok)
	assert.Equal(t, "B", valMap["variant"])
}

func TestEvaluateFeatureFlag_404ReturnsNotFoundError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("flag not defined"))
	}))
	defer server.Close()

	client := NewConfigClient(server.URL, "key", "org")
	defer client.Close()

	_, err := client.EvaluateFeatureFlag(context.Background(), "missing", nil, "production")
	require.Error(t, err)

	var ffErr *FeatureFlagEvaluationError
	require.True(t, errors.As(err, &ffErr), "expected *FeatureFlagEvaluationError, got %T", err)
	assert.Equal(t, FeatureFlagKindNotFound, ffErr.Kind)
	assert.Equal(t, 404, ffErr.StatusCode)
	assert.Equal(t, "missing", ffErr.Key)
	assert.True(t, errors.Is(err, ErrFeatureFlagNotFound))
	assert.False(t, errors.Is(err, ErrFeatureFlagContext))
}

func TestEvaluateFeatureFlag_400ReturnsContextError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"invalid context"}`))
	}))
	defer server.Close()

	client := NewConfigClient(server.URL, "key", "org")
	defer client.Close()

	_, err := client.EvaluateFeatureFlag(context.Background(), "flag", map[string]any{}, "production")
	require.Error(t, err)

	var ffErr *FeatureFlagEvaluationError
	require.True(t, errors.As(err, &ffErr))
	assert.Equal(t, FeatureFlagKindContext, ffErr.Kind)
	assert.Equal(t, 400, ffErr.StatusCode)
	assert.Contains(t, ffErr.ServerMessage, "invalid context")
	assert.True(t, errors.Is(err, ErrFeatureFlagContext))
	assert.False(t, errors.Is(err, ErrFeatureFlagNotFound))
}

func TestEvaluateFeatureFlag_500ReturnsServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("boom"))
	}))
	defer server.Close()

	client := NewConfigClient(server.URL, "key", "org")
	defer client.Close()

	_, err := client.EvaluateFeatureFlag(context.Background(), "flag", nil, "production")
	require.Error(t, err)

	var ffErr *FeatureFlagEvaluationError
	require.True(t, errors.As(err, &ffErr))
	assert.Equal(t, FeatureFlagKindServer, ffErr.Kind)
	assert.Equal(t, 500, ffErr.StatusCode)
	assert.True(t, errors.Is(err, ErrFeatureFlagServer))
	assert.False(t, errors.Is(err, ErrFeatureFlagNotFound))
	assert.False(t, errors.Is(err, ErrFeatureFlagContext))
}

func TestEvaluateFeatureFlag_CanceledContextReturnsError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		encodeEvalResponse(t, w, EvaluateFeatureFlagResponse{Value: true, Source: "raw"})
	}))
	defer server.Close()

	client := NewConfigClient(server.URL, "key", "org")
	defer client.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // pre-cancelled

	_, err := client.EvaluateFeatureFlag(ctx, "flag", nil, "production")
	require.Error(t, err)
	assert.True(t, errors.Is(err, context.Canceled))
}

func TestFeatureFlagErrorKind_String(t *testing.T) {
	assert.Equal(t, "not_found", FeatureFlagKindNotFound.String())
	assert.Equal(t, "context", FeatureFlagKindContext.String())
	assert.Equal(t, "server", FeatureFlagKindServer.String())
}

func TestFeatureFlagEvaluationError_ErrorMessage(t *testing.T) {
	cases := []struct {
		name    string
		err     *FeatureFlagEvaluationError
		wantSub []string
	}{
		{
			name: "with server message",
			err: &FeatureFlagEvaluationError{
				Key:           "k",
				StatusCode:    400,
				Kind:          FeatureFlagKindContext,
				ServerMessage: "bad input",
			},
			wantSub: []string{`"k"`, "400", "bad input"},
		},
		{
			name: "without server message",
			err: &FeatureFlagEvaluationError{
				Key:        "k2",
				StatusCode: 404,
				Kind:       FeatureFlagKindNotFound,
			},
			wantSub: []string{`"k2"`, "404"},
		},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			msg := tc.err.Error()
			for _, s := range tc.wantSub {
				assert.Contains(t, msg, s)
			}
		})
	}
}
