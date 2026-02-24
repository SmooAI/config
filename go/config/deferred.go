package config

// DeferredValue is a function that computes a config value from the merged config.
// It receives a snapshot of the merged config (pre-resolution) and returns the computed value.
type DeferredValue func(config map[string]any) any

// ResolveDeferred resolves all deferred values against a snapshot of the merged config.
//
// Each closure receives the pre-resolution snapshot and its return value replaces
// the corresponding key in the config map. All deferred values see the same
// snapshot (not each other's resolved values), ensuring deterministic results.
func ResolveDeferred(config map[string]any, deferred map[string]DeferredValue) {
	if len(deferred) == 0 {
		return
	}

	// Take a snapshot for resolution (pre-resolution values only)
	snapshot := make(map[string]any, len(config))
	for k, v := range config {
		snapshot[k] = v
	}

	// Resolve each deferred value
	for key, resolver := range deferred {
		config[key] = resolver(snapshot)
	}
}
