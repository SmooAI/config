package config

// ESO bearer-token refresher core — Go parity port of the TypeScript
// src/eso-refresher (SMOODEV-1526, epic SMOODEV-1522).
//
// ESO's webhook provider reads a STATIC bearer from a k8s Secret, but the
// config API issues short-lived client_credentials JWTs (~1h) — so a static
// token goes stale and ESO sync silently 401s. This refresher re-mints the
// token on a short interval via the same TokenProvider the SDK uses and writes
// it into the bootstrap Secret, so ESO always reads a fresh bearer.
//
// The k8s write is abstracted behind SecretWriter so the loop is unit-testable
// with a fake (no live cluster). A native client-go-backed SecretWriter is an
// optional adapter (kept out of this core package so base SDK consumers do not
// pull a heavy k8s client) — the TypeScript sidecar remains the canonical
// deployable; this gives the refresh ALGORITHM parity in Go.

import (
	"context"
	"time"
)

// ESO refresher defaults.
const (
	ESORefresherDefaultIntervalSeconds = 900
)

// SecretWriter writes the freshly-minted bearer token into the target store.
// Abstracted so the refresh loop can be unit-tested without a live cluster.
type SecretWriter interface {
	// PatchBearerToken writes token into the configured Secret/key (the impl
	// base64-encodes for k8s).
	PatchBearerToken(token string) error
}

// tokenSource is the slice of TokenProvider the refresher needs. *TokenProvider
// satisfies it; tests inject a fake.
type tokenSource interface {
	GetAccessToken(ctx context.Context) (string, error)
	Invalidate()
}

// EsoRefresherOptions configures RunEsoRefresher.
type EsoRefresherOptions struct {
	// TokenSource mints/refreshes the bearer. Required.
	TokenSource tokenSource
	// SecretWriter writes the bearer into the target Secret. Required.
	SecretWriter SecretWriter
	// Interval between re-mints. Defaults to 900s.
	Interval time.Duration
}

// EsoRefresherHandle controls a running refresher.
type EsoRefresherHandle struct {
	// RefreshNow forces an immediate re-mint + write.
	RefreshNow func() error
	// Stop halts the refresh loop. Idempotent.
	Stop func()
}

// RunEsoRefresher performs an initial mint+write synchronously (fail-loud on
// misconfiguration), then starts a background loop re-minting on Interval.
// Returns a handle to force a refresh or stop the loop.
func RunEsoRefresher(opts EsoRefresherOptions) (*EsoRefresherHandle, error) {
	if opts.TokenSource == nil {
		return nil, NewConfigError("RunEsoRefresher: TokenSource is required")
	}
	if opts.SecretWriter == nil {
		return nil, NewConfigError("RunEsoRefresher: SecretWriter is required")
	}
	interval := opts.Interval
	if interval <= 0 {
		interval = ESORefresherDefaultIntervalSeconds * time.Second
	}

	refreshNow := func() error {
		// Force a brand-new token each cycle so the Secret always holds one with
		// (close to) a full TTL ahead — ESO must never read a token about to expire.
		opts.TokenSource.Invalidate()
		token, err := opts.TokenSource.GetAccessToken(context.Background())
		if err != nil {
			return err
		}
		return opts.SecretWriter.PatchBearerToken(token)
	}

	// Initial mint+write — fail-loud (caller exits non-zero on error).
	if err := refreshNow(); err != nil {
		return nil, err
	}

	stop := make(chan struct{})
	stopped := false
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				// Loop failures are non-fatal: the current Secret token is still
				// valid for the rest of its TTL. The caller's logger (if any) can
				// observe via a wrapping SecretWriter; here we simply retry next tick.
				_ = refreshNow()
			}
		}
	}()

	return &EsoRefresherHandle{
		RefreshNow: refreshNow,
		Stop: func() {
			if stopped {
				return
			}
			stopped = true
			close(stop)
		},
	}, nil
}
