// Package container implements @smooai/config container/runtime mode for Go
// (SMOODEV-1489 / SMOODEV-1492). It mirrors the TypeScript reference
// (src/container) exactly: identical env contract and error semantics. Idioms
// differ (Go returns errors instead of throwing, takes a context.Context), the
// behavior does not.
//
// # Why
//
// @smooai/config resolves values through four tiers: blob → env → http → file.
// The blob tier (an encrypted bundle baked into a Lambda layer / image at
// deploy time, decrypted with a separately-delivered key) is the blessed path
// for Lambda. It is the wrong default for long-lived containers (EKS/ECS): when
// the per-build blob key isn't delivered to the pod, resolution silently falls
// through to the (absent) file tier and returns the zero value for a required
// secret (the SMOODEV-1478 CrashLoop outage).
//
// Container mode makes the HTTP tier the blessed, first-class path for
// containers, authenticated with an OAuth2 client_credentials (M2M) token, and
// fail-loud: a missing required value is an immediate, typed
// ConfigKeyUnresolvedError, never a silent zero value.
package container

import (
	"fmt"
	"strings"
)

// Tier is one of the resolution tiers consulted during a value read.
// Container mode disables the blob and file tiers (§2) and consults env then
// http. The full set is retained for parity with the TS ConfigTier union and
// for the TriedTiers context carried by ConfigKeyUnresolvedError.
type Tier string

const (
	// TierBlob is the encrypted Lambda-layer bundle tier (disabled in container mode).
	TierBlob Tier = "blob"
	// TierEnv is the explicit process-environment-variable override tier.
	TierEnv Tier = "env"
	// TierHTTP is the config-server tier — the blessed container path.
	TierHTTP Tier = "http"
	// TierFile is the local .smooai-config/ file tier (disabled in container mode).
	TierFile Tier = "file"
)

// ConfigBootstrapError is returned by InitContainerConfig when the
// container-required environment (§1 of the spec) is missing or blank. It
// carries the exact list of offending env var names so the operator can fix the
// deployment without guessing. No partial init: if any required var is absent,
// bootstrap fails whole.
//
// Parity: mirrors the TS ConfigBootstrapError { missing: string[] }.
type ConfigBootstrapError struct {
	// Missing holds the env var names (e.g. "SMOOAI_CONFIG_CLIENT_ID") that are
	// missing or blank.
	Missing []string
}

// Error implements the error interface.
func (e *ConfigBootstrapError) Error() string {
	noun := "this variable"
	if len(e.Missing) != 1 {
		noun = "these variables"
	}
	return fmt.Sprintf(
		"[@smooai/config] container-mode bootstrap failed: missing required env %s. "+
			"Set %s before calling InitContainerConfig "+
			"(see docs/Container-Runtime-Mode.md for the Kubernetes/ExternalSecret recipe).",
		strings.Join(e.Missing, ", "), noun,
	)
}

// ConfigKeyUnresolvedError is returned by a required-key read (SecretConfig.Get
// / MustGet and the public/flag analogs) in container mode when the value
// resolves to absent across every active tier. This is the exact type that
// closes the silent-zero-value hole (SMOODEV-1478 / SMOODEV-1135).
//
// Optional keys (declared via InitContainerConfigOptions.OptionalKeys) do NOT
// produce this error — they return the zero value with ok=false.
//
// Parity: mirrors the TS ConfigKeyUnresolvedError { key, env, triedTiers }.
type ConfigKeyUnresolvedError struct {
	// Key is the camelCase config key that could not be resolved.
	Key string
	// Env is the environment the read targeted (e.g. "production").
	Env string
	// TriedTiers are the tiers that were consulted, in order, before giving up.
	TriedTiers []Tier
}

// Error implements the error interface.
func (e *ConfigKeyUnresolvedError) Error() string {
	tried := make([]string, len(e.TriedTiers))
	for i, t := range e.TriedTiers {
		tried[i] = string(t)
	}
	triedStr := strings.Join(tried, " → ")
	if triedStr == "" {
		triedStr = "none"
	}
	return fmt.Sprintf(
		"[@smooai/config] required config key %q did not resolve in environment %q "+
			"(container mode; tiers tried: %s). "+
			"Set a value for this key in the config server for %q, or mark it optional via "+
			"InitContainerConfigOptions.OptionalKeys.",
		e.Key, e.Env, triedStr, e.Env,
	)
}
