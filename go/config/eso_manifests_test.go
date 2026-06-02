package config

import (
	"strings"
	"testing"
)

func TestBuildClusterSecretStore(t *testing.T) {
	store, err := BuildClusterSecretStore(ClusterSecretStoreOptions{APIURL: "https://api.smoo.ai", OrgID: "org-123", Environment: "production"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	spec := store["spec"].(map[string]any)
	webhook := spec["provider"].(map[string]any)["webhook"].(map[string]any)
	url := webhook["url"].(string)
	want := "https://api.smoo.ai/organizations/org-123/config/values/{{ .remoteRef.key }}?environment=production"
	if url != want {
		t.Errorf("url = %q, want %q", url, want)
	}
	if strings.Contains(url, "config.smoo.ai") {
		t.Error("url must never reference the hallucinated config.smoo.ai")
	}
	if webhook["result"].(map[string]any)["jsonPath"].(string) != "$.value" {
		t.Error("jsonPath should be $.value")
	}
}

func TestBuildClusterSecretStoreDefaultsAndOverrides(t *testing.T) {
	store, _ := BuildClusterSecretStore(ClusterSecretStoreOptions{APIURL: "https://api.smoo.ai///", OrgID: "o", Environment: "pre prod"})
	webhook := store["spec"].(map[string]any)["provider"].(map[string]any)["webhook"].(map[string]any)
	url := webhook["url"].(string)
	if !strings.HasPrefix(url, "https://api.smoo.ai/organizations") {
		t.Errorf("trailing slashes not stripped: %q", url)
	}
	if !strings.Contains(url, "environment=pre%20prod") {
		t.Errorf("environment not url-encoded: %q", url)
	}
	ref := webhook["secrets"].([]any)[0].(map[string]any)["secretRef"].(map[string]any)
	if ref["name"] != "smooai-config-bootstrap" || ref["namespace"] != "external-secrets" || ref["key"] != "bearer-token" {
		t.Errorf("bootstrap secret ref defaults wrong: %v", ref)
	}
}

func TestBuildClusterSecretStoreRequiredFields(t *testing.T) {
	if _, err := BuildClusterSecretStore(ClusterSecretStoreOptions{OrgID: "o", Environment: "e"}); err == nil {
		t.Error("expected error for missing APIURL")
	}
	if _, err := BuildClusterSecretStore(ClusterSecretStoreOptions{APIURL: "u", Environment: "e"}); err == nil {
		t.Error("expected error for missing OrgID")
	}
	if _, err := BuildClusterSecretStore(ClusterSecretStoreOptions{APIURL: "u", OrgID: "o"}); err == nil {
		t.Error("expected error for missing Environment")
	}
}

func TestResolveSecretMapping(t *testing.T) {
	m, _ := ResolveSecretMapping(SecretMapping{ConfigKey: "mimoApiKey"})
	if m.EnvVar != "MIMO_API_KEY" {
		t.Errorf("default envVar = %q, want MIMO_API_KEY", m.EnvVar)
	}
	m2, _ := ResolveSecretMapping(SecretMapping{ConfigKey: "alibabaModelStudioApiKey", EnvVar: "DASHSCOPE_API_KEY"})
	if m2.EnvVar != "DASHSCOPE_API_KEY" {
		t.Errorf("override envVar = %q, want DASHSCOPE_API_KEY", m2.EnvVar)
	}
}

func TestBuildExternalSecret(t *testing.T) {
	es, err := BuildExternalSecret(ExternalSecretOptions{
		Name:      "litellm-config",
		Namespace: "smooai-litellm",
		Secrets: []SecretMapping{
			{ConfigKey: "mimoApiKey"},
			{ConfigKey: "alibabaModelStudioApiKey", EnvVar: "DASHSCOPE_API_KEY"},
		},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	spec := es["spec"].(map[string]any)
	data := spec["data"].([]any)
	if len(data) != 2 {
		t.Fatalf("data len = %d, want 2", len(data))
	}
	first := data[0].(map[string]any)
	if first["secretKey"] != "MIMO_API_KEY" || first["remoteRef"].(map[string]any)["key"] != "mimoApiKey" {
		t.Errorf("first mapping wrong: %v", first)
	}
	if spec["target"].(map[string]any)["name"] != "litellm-config" {
		t.Error("target name should default to resource name")
	}
	if spec["secretStoreRef"].(map[string]any)["name"] != "smooai-config" {
		t.Error("store should default to smooai-config")
	}
}

func TestBuildExternalSecretDuplicateEnvVar(t *testing.T) {
	_, err := BuildExternalSecret(ExternalSecretOptions{
		Name:      "x",
		Namespace: "ns",
		Secrets: []SecretMapping{
			{ConfigKey: "mimoApiKey"},
			{ConfigKey: "somethingElse", EnvVar: "MIMO_API_KEY"},
		},
	})
	if err == nil || !strings.Contains(err.Error(), "duplicate env-var") {
		t.Errorf("expected duplicate env-var error, got %v", err)
	}
}

func TestBuildExternalSecretRequiredFields(t *testing.T) {
	if _, err := BuildExternalSecret(ExternalSecretOptions{Namespace: "ns", Secrets: []SecretMapping{{ConfigKey: "k"}}}); err == nil {
		t.Error("expected error for missing Name")
	}
	if _, err := BuildExternalSecret(ExternalSecretOptions{Name: "n", Secrets: []SecretMapping{{ConfigKey: "k"}}}); err == nil {
		t.Error("expected error for missing Namespace")
	}
	if _, err := BuildExternalSecret(ExternalSecretOptions{Name: "n", Namespace: "ns"}); err == nil {
		t.Error("expected error for empty Secrets")
	}
}
