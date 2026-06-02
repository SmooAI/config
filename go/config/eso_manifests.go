package config

// ESO (ExternalSecrets Operator) manifest generator — Go parity port of the
// TypeScript `src/eso-manifests` (SMOODEV-1526, epic SMOODEV-1522).
//
// Emits the two ESO resources that let a Kubernetes workload pull its secrets
// from the @smooai/config HTTP API (api.smoo.ai) instead of having them baked
// at deploy time:
//
//  1. BuildClusterSecretStore — a ClusterSecretStore whose webhook provider
//     points at the real config-values endpoint (org + env baked into the URL,
//     bearer from the bootstrap Secret the eso-refresher keeps fresh).
//  2. BuildExternalSecret — a per-workload ExternalSecret mapping secret-tier
//     config keys to env-var names (UPPER_SNAKE_CASE by default, overridable).
//
// Returns plain map structures (cdk8s / kubectl / YAML marshaling all accept
// them). No cluster or network access.

import "strings"

// Default values shared across the ESO manifests.
const (
	ESODefaultClusterSecretStoreName   = "smooai-config"
	ESODefaultBootstrapSecretName      = "smooai-config-bootstrap"
	ESODefaultBootstrapSecretNamespace = "external-secrets"
	ESODefaultBootstrapSecretKey       = "bearer-token"
	ESODefaultRefreshInterval          = "1h"
	ESOAPIVersion                      = "external-secrets.io/v1beta1"
)

// BootstrapSecretRef references the Kubernetes Secret + key holding the ESO
// bearer token.
type BootstrapSecretRef struct {
	Name      string // default "smooai-config-bootstrap"
	Namespace string // default "external-secrets"
	Key       string // default "bearer-token"
}

// ClusterSecretStoreOptions configures BuildClusterSecretStore.
type ClusterSecretStoreOptions struct {
	Name            string // ClusterSecretStore name; default "smooai-config"
	APIURL          string // config API base URL, e.g. "https://api.smoo.ai" (required)
	OrgID           string // org id whose config this store reads (required)
	Environment     string // environment baked into the query string (required)
	BootstrapSecret *BootstrapSecretRef
}

// BuildClusterSecretStore builds a ClusterSecretStore backed by the
// @smooai/config webhook provider. org + environment are baked into the URL
// because ESO's webhook only templates {{ .remoteRef.key }} per-secret — so a
// store is scoped to one (org, env) pair. Returns an error if required fields
// are missing.
func BuildClusterSecretStore(opts ClusterSecretStoreOptions) (map[string]any, error) {
	if opts.APIURL == "" {
		return nil, NewConfigError("BuildClusterSecretStore: APIURL is required")
	}
	if opts.OrgID == "" {
		return nil, NewConfigError("BuildClusterSecretStore: OrgID is required")
	}
	if opts.Environment == "" {
		return nil, NewConfigError("BuildClusterSecretStore: Environment is required")
	}

	name := opts.Name
	if name == "" {
		name = ESODefaultClusterSecretStoreName
	}
	apiURL := strings.TrimRight(opts.APIURL, "/")
	secretName := ESODefaultBootstrapSecretName
	secretNamespace := ESODefaultBootstrapSecretNamespace
	secretKey := ESODefaultBootstrapSecretKey
	if opts.BootstrapSecret != nil {
		if opts.BootstrapSecret.Name != "" {
			secretName = opts.BootstrapSecret.Name
		}
		if opts.BootstrapSecret.Namespace != "" {
			secretNamespace = opts.BootstrapSecret.Namespace
		}
		if opts.BootstrapSecret.Key != "" {
			secretKey = opts.BootstrapSecret.Key
		}
	}

	url := apiURL + "/organizations/" + opts.OrgID + "/config/values/{{ .remoteRef.key }}?environment=" + urlQueryEscape(opts.Environment)

	return map[string]any{
		"apiVersion": ESOAPIVersion,
		"kind":       "ClusterSecretStore",
		"metadata":   map[string]any{"name": name},
		"spec": map[string]any{
			"provider": map[string]any{
				"webhook": map[string]any{
					"url": url,
					"headers": map[string]any{
						"Content-Type":  "application/json",
						"Authorization": "Bearer {{ .auth.token }}",
					},
					"result": map[string]any{"jsonPath": "$.value"},
					"secrets": []any{
						map[string]any{
							"name": "auth",
							"secretRef": map[string]any{
								"name":      secretName,
								"namespace": secretNamespace,
								"key":       secretKey,
							},
						},
					},
				},
			},
		},
	}, nil
}

// SecretMapping is one mapped secret: a config key → the env-var name the
// workload reads. EnvVar defaults to UPPER_SNAKE_CASE(ConfigKey).
type SecretMapping struct {
	ConfigKey string
	EnvVar    string // optional; defaults to CamelToUpperSnake(ConfigKey)
}

// ExternalSecretOptions configures BuildExternalSecret.
type ExternalSecretOptions struct {
	Name                   string          // ExternalSecret resource name (required)
	Namespace              string          // namespace (required)
	Secrets                []SecretMapping // at least one (required)
	TargetSecretName       string          // default = Name
	ClusterSecretStoreName string          // default "smooai-config"
	RefreshInterval        string          // default "1h"
	Labels                 map[string]string
}

// ResolveSecretMapping normalizes a mapping, defaulting EnvVar to the
// UPPER_SNAKE_CASE form of ConfigKey.
func ResolveSecretMapping(m SecretMapping) (SecretMapping, error) {
	if m.ConfigKey == "" {
		return SecretMapping{}, NewConfigError("ResolveSecretMapping: ConfigKey is required")
	}
	envVar := m.EnvVar
	if envVar == "" {
		envVar = CamelToUpperSnake(m.ConfigKey)
	}
	return SecretMapping{ConfigKey: m.ConfigKey, EnvVar: envVar}, nil
}

// BuildExternalSecret builds a per-workload ExternalSecret. Each entry becomes
// a data mapping of secretKey (the env-var name in the synced Secret) ←
// remoteRef.key (the @smooai/config key). Returns an error on missing required
// fields or duplicate env-var names.
func BuildExternalSecret(opts ExternalSecretOptions) (map[string]any, error) {
	if opts.Name == "" {
		return nil, NewConfigError("BuildExternalSecret: Name is required")
	}
	if opts.Namespace == "" {
		return nil, NewConfigError("BuildExternalSecret: Namespace is required")
	}
	if len(opts.Secrets) == 0 {
		return nil, NewConfigError("BuildExternalSecret: at least one secret mapping is required")
	}

	data := make([]any, 0, len(opts.Secrets))
	seen := map[string]bool{}
	for _, entry := range opts.Secrets {
		resolved, err := ResolveSecretMapping(entry)
		if err != nil {
			return nil, err
		}
		if seen[resolved.EnvVar] {
			return nil, NewConfigError("BuildExternalSecret: duplicate env-var name: " + resolved.EnvVar)
		}
		seen[resolved.EnvVar] = true
		data = append(data, map[string]any{
			"secretKey": resolved.EnvVar,
			"remoteRef": map[string]any{"key": resolved.ConfigKey},
		})
	}

	targetName := opts.TargetSecretName
	if targetName == "" {
		targetName = opts.Name
	}
	storeName := opts.ClusterSecretStoreName
	if storeName == "" {
		storeName = ESODefaultClusterSecretStoreName
	}
	refresh := opts.RefreshInterval
	if refresh == "" {
		refresh = ESODefaultRefreshInterval
	}

	metadata := map[string]any{
		"name":      opts.Name,
		"namespace": opts.Namespace,
	}
	if len(opts.Labels) > 0 {
		metadata["labels"] = opts.Labels
	}

	return map[string]any{
		"apiVersion": ESOAPIVersion,
		"kind":       "ExternalSecret",
		"metadata":   metadata,
		"spec": map[string]any{
			"refreshInterval": refresh,
			"secretStoreRef": map[string]any{
				"name": storeName,
				"kind": "ClusterSecretStore",
			},
			"target": map[string]any{
				"name":           targetName,
				"creationPolicy": "Owner",
			},
			"data": data,
		},
	}, nil
}

// urlQueryEscape percent-encodes a query-string value. Local helper to avoid a
// net/url import for a single value (mirrors the TS encodeURIComponent usage).
func urlQueryEscape(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'A' && r <= 'Z', r >= 'a' && r <= 'z', r >= '0' && r <= '9',
			r == '-', r == '_', r == '.', r == '~':
			b.WriteRune(r)
		case r == ' ':
			b.WriteString("%20")
		default:
			for _, by := range []byte(string(r)) {
				b.WriteString("%")
				const hex = "0123456789ABCDEF"
				b.WriteByte(hex[by>>4])
				b.WriteByte(hex[by&0x0F])
			}
		}
	}
	return b.String()
}
