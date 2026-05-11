package bootstrap

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type capturedReq struct {
	method string
	url    string
	header http.Header
	body   string
}

type recorder struct {
	t         *testing.T
	responses []func(w http.ResponseWriter, r *http.Request)
	calls     []capturedReq
}

func (r *recorder) handle(w http.ResponseWriter, req *http.Request) {
	body, _ := io.ReadAll(req.Body)
	r.calls = append(r.calls, capturedReq{
		method: req.Method,
		url:    req.URL.String(),
		header: req.Header.Clone(),
		body:   string(body),
	})
	if len(r.responses) == 0 {
		r.t.Fatalf("recorder ran out of queued responses")
	}
	fn := r.responses[0]
	r.responses = r.responses[1:]
	fn(w, req)
}

func ok(body string) func(w http.ResponseWriter, r *http.Request) {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, body)
	}
}

func fail(status int, body string) func(w http.ResponseWriter, r *http.Request) {
	return func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}
}

func newEnvMap(pairs ...string) map[string]string {
	m := map[string]string{}
	for i := 0; i+1 < len(pairs); i += 2 {
		m[pairs[i]] = pairs[i+1]
	}
	return m
}

func envFn(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func newRecorderServer(t *testing.T, responses ...func(w http.ResponseWriter, r *http.Request)) (*httptest.Server, *recorder) {
	rec := &recorder{t: t, responses: responses}
	srv := httptest.NewServer(http.HandlerFunc(rec.handle))
	return srv, rec
}

func baseEnv(serverURL string) map[string]string {
	return newEnvMap(
		"SMOOAI_CONFIG_API_URL", serverURL,
		"SMOOAI_CONFIG_AUTH_URL", serverURL,
		"SMOOAI_CONFIG_CLIENT_ID", "client-id-123",
		"SMOOAI_CONFIG_CLIENT_SECRET", "client-secret-456",
		"SMOOAI_CONFIG_ORG_ID", "org-789",
	)
}

func TestFetch_ReturnsValueForKnownKey(t *testing.T) {
	resetCache()
	srv, rec := newRecorderServer(t,
		ok(`{"access_token":"TOKEN"}`),
		ok(`{"values":{"databaseUrl":"postgres://x"}}`),
	)
	defer srv.Close()

	v, err := Fetch(context.Background(), "databaseUrl",
		withGetEnv(envFn(baseEnv(srv.URL))),
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if v != "postgres://x" {
		t.Fatalf("got %q, want postgres://x", v)
	}
	if len(rec.calls) != 2 {
		t.Fatalf("got %d HTTP calls, want 2", len(rec.calls))
	}
}

func TestFetch_ReturnsEmptyForMissingKey(t *testing.T) {
	resetCache()
	srv, _ := newRecorderServer(t,
		ok(`{"access_token":"T"}`),
		ok(`{"values":{"other":"x"}}`),
	)
	defer srv.Close()

	v, err := Fetch(context.Background(), "databaseUrl",
		withGetEnv(envFn(baseEnv(srv.URL))),
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if v != "" {
		t.Fatalf("got %q, want empty string", v)
	}
}

func TestFetch_CachesValuesPerEnv(t *testing.T) {
	resetCache()
	srv, rec := newRecorderServer(t,
		ok(`{"access_token":"T"}`),
		ok(`{"values":{"a":"1","b":"2"}}`),
	)
	defer srv.Close()

	ctx := context.Background()
	env := envFn(baseEnv(srv.URL))

	v1, err := Fetch(ctx, "a", withGetEnv(env))
	if err != nil || v1 != "1" {
		t.Fatalf("a: %q err=%v", v1, err)
	}
	v2, err := Fetch(ctx, "b", withGetEnv(env))
	if err != nil || v2 != "2" {
		t.Fatalf("b: %q err=%v", v2, err)
	}
	if len(rec.calls) != 2 {
		t.Fatalf("expected 2 HTTP calls (cached), got %d", len(rec.calls))
	}
}

func TestFetch_RefetchesOnEnvChange(t *testing.T) {
	resetCache()
	srv, rec := newRecorderServer(t,
		ok(`{"access_token":"T1"}`),
		ok(`{"values":{"a":"dev"}}`),
		ok(`{"access_token":"T2"}`),
		ok(`{"values":{"a":"prod"}}`),
	)
	defer srv.Close()
	env := envFn(baseEnv(srv.URL))

	v1, err := Fetch(context.Background(), "a", withGetEnv(env), WithEnvironment("development"))
	if err != nil || v1 != "dev" {
		t.Fatalf("v1: %q err=%v", v1, err)
	}
	v2, err := Fetch(context.Background(), "a", withGetEnv(env), WithEnvironment("production"))
	if err != nil || v2 != "prod" {
		t.Fatalf("v2: %q err=%v", v2, err)
	}
	if len(rec.calls) != 4 {
		t.Fatalf("expected 4 HTTP calls, got %d", len(rec.calls))
	}
}

func TestFetch_OAuthRequestShape(t *testing.T) {
	resetCache()
	srv, rec := newRecorderServer(t,
		ok(`{"access_token":"TOKEN"}`),
		ok(`{"values":{"k":"v"}}`),
	)
	defer srv.Close()

	_, err := Fetch(context.Background(), "k", withGetEnv(envFn(baseEnv(srv.URL))))
	if err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	auth := rec.calls[0]
	if auth.method != "POST" {
		t.Fatalf("auth method = %s, want POST", auth.method)
	}
	if auth.url != "/token" {
		t.Fatalf("auth url = %s, want /token", auth.url)
	}
	if !strings.Contains(auth.body, "grant_type=client_credentials") ||
		!strings.Contains(auth.body, "client_id=client-id-123") ||
		!strings.Contains(auth.body, "client_secret=client-secret-456") ||
		!strings.Contains(auth.body, "provider=client_credentials") {
		t.Fatalf("auth body missing required fields: %s", auth.body)
	}
}

func TestFetch_ValuesRequestShape(t *testing.T) {
	resetCache()
	srv, rec := newRecorderServer(t,
		ok(`{"access_token":"TOKEN"}`),
		ok(`{"values":{"k":"v"}}`),
	)
	defer srv.Close()

	_, err := Fetch(context.Background(), "k",
		withGetEnv(envFn(baseEnv(srv.URL))),
		WithEnvironment("staging env"),
	)
	if err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	values := rec.calls[1]
	if values.method != "GET" {
		t.Fatalf("values method = %s, want GET", values.method)
	}
	wantPath := "/organizations/org-789/config/values?environment=staging+env"
	// QueryEscape encodes spaces as +; both + and %20 are valid. Accept either.
	if values.url != wantPath && values.url != "/organizations/org-789/config/values?environment=staging%20env" {
		t.Fatalf("values url = %s, want %s", values.url, wantPath)
	}
	if got := values.header.Get("Authorization"); got != "Bearer TOKEN" {
		t.Fatalf("Authorization = %q, want Bearer TOKEN", got)
	}
}

func TestFetch_MissingCredsErrors(t *testing.T) {
	resetCache()
	env := baseEnv("http://example.test")
	delete(env, "SMOOAI_CONFIG_CLIENT_ID")

	_, err := Fetch(context.Background(), "k", withGetEnv(envFn(env)))
	if err == nil || !strings.Contains(err.Error(), "CLIENT_ID,CLIENT_SECRET,ORG_ID") {
		t.Fatalf("got err=%v, want missing-creds error", err)
	}
}

func TestFetch_AcceptsLegacyApiKey(t *testing.T) {
	resetCache()
	srv, rec := newRecorderServer(t,
		ok(`{"access_token":"T"}`),
		ok(`{"values":{"k":"v"}}`),
	)
	defer srv.Close()

	env := baseEnv(srv.URL)
	delete(env, "SMOOAI_CONFIG_CLIENT_SECRET")
	env["SMOOAI_CONFIG_API_KEY"] = "legacy-secret"

	v, err := Fetch(context.Background(), "k", withGetEnv(envFn(env)))
	if err != nil || v != "v" {
		t.Fatalf("v=%q err=%v", v, err)
	}
	if !strings.Contains(rec.calls[0].body, "client_secret=legacy-secret") {
		t.Fatalf("body did not include legacy client_secret: %s", rec.calls[0].body)
	}
}

func TestFetch_AcceptsLegacyAuthUrl(t *testing.T) {
	resetCache()
	srv, rec := newRecorderServer(t,
		ok(`{"access_token":"T"}`),
		ok(`{"values":{"k":"v"}}`),
	)
	defer srv.Close()

	env := baseEnv(srv.URL)
	delete(env, "SMOOAI_CONFIG_AUTH_URL")
	env["SMOOAI_AUTH_URL"] = srv.URL

	if _, err := Fetch(context.Background(), "k", withGetEnv(envFn(env))); err != nil {
		t.Fatalf("unexpected: %v", err)
	}
	if rec.calls[0].url != "/token" {
		t.Fatalf("legacy SMOOAI_AUTH_URL not used; first call URL = %s", rec.calls[0].url)
	}
}

func TestFetch_OAuthFailureErrors(t *testing.T) {
	resetCache()
	srv, _ := newRecorderServer(t, fail(401, "invalid_client"))
	defer srv.Close()

	_, err := Fetch(context.Background(), "k", withGetEnv(envFn(baseEnv(srv.URL))))
	if err == nil || !strings.Contains(err.Error(), "OAuth token exchange failed: HTTP 401") {
		t.Fatalf("got err=%v, want OAuth 401 error", err)
	}
}

func TestFetch_ValuesFailureErrors(t *testing.T) {
	resetCache()
	srv, _ := newRecorderServer(t,
		ok(`{"access_token":"T"}`),
		fail(500, "boom"),
	)
	defer srv.Close()

	_, err := Fetch(context.Background(), "k", withGetEnv(envFn(baseEnv(srv.URL))))
	if err == nil || !strings.Contains(err.Error(), "GET /config/values failed: HTTP 500") {
		t.Fatalf("got err=%v, want values 500 error", err)
	}
}

func TestFetch_OAuthMissingAccessToken(t *testing.T) {
	resetCache()
	srv, _ := newRecorderServer(t, ok(`{}`))
	defer srv.Close()

	_, err := Fetch(context.Background(), "k", withGetEnv(envFn(baseEnv(srv.URL))))
	if err == nil || !strings.Contains(err.Error(), "no access_token") {
		t.Fatalf("got err=%v, want no-access-token error", err)
	}
}

func TestResolveEnv_Variants(t *testing.T) {
	cases := []struct {
		name     string
		explicit string
		env      map[string]string
		want     string
	}{
		{"explicit wins", "explicit", newEnvMap("SST_STAGE", "ignored"), "explicit"},
		{"SST_STAGE", "", newEnvMap("SST_STAGE", "brentrager"), "brentrager"},
		{"NEXT_PUBLIC_SST_STAGE", "", newEnvMap("NEXT_PUBLIC_SST_STAGE", "dev-stage"), "dev-stage"},
		{"SST_RESOURCE_App", "", newEnvMap("SST_RESOURCE_App", `{"stage":"sst-resource-stage"}`), "sst-resource-stage"},
		{"production stays production", "", newEnvMap("SST_STAGE", "production"), "production"},
		{"SMOOAI_CONFIG_ENV fallback", "", newEnvMap("SMOOAI_CONFIG_ENV", "qa"), "qa"},
		{"development default", "", newEnvMap(), "development"},
		{"malformed SST_RESOURCE_App falls through", "", newEnvMap("SST_RESOURCE_App", "{not json", "SMOOAI_CONFIG_ENV", "qa"), "qa"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := resolveEnv(envFn(tc.env), tc.explicit)
			if got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestFetch_StringifiesNonStringValues(t *testing.T) {
	resetCache()
	srv, _ := newRecorderServer(t,
		ok(`{"access_token":"T"}`),
		ok(`{"values":{"count":42,"flag":true,"pi":3.5}}`),
	)
	defer srv.Close()
	env := envFn(baseEnv(srv.URL))

	c, _ := Fetch(context.Background(), "count", withGetEnv(env))
	if c != "42" {
		t.Fatalf("count = %q, want 42", c)
	}
	f, _ := Fetch(context.Background(), "flag", withGetEnv(env))
	if f != "true" {
		t.Fatalf("flag = %q, want true", f)
	}
	p, _ := Fetch(context.Background(), "pi", withGetEnv(env))
	if p != "3.5" {
		t.Fatalf("pi = %q, want 3.5", p)
	}
}
