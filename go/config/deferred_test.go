package config

import (
	"fmt"
	"testing"
)

func TestResolveDeferredBasic(t *testing.T) {
	config := map[string]any{
		"HOST": "localhost",
		"PORT": float64(5432),
	}

	deferred := map[string]DeferredValue{
		"FULL_URL": func(c map[string]any) any {
			return fmt.Sprintf("%s:%v", c["HOST"], c["PORT"])
		},
	}

	ResolveDeferred(config, deferred)

	if config["FULL_URL"] != "localhost:5432" {
		t.Errorf("expected 'localhost:5432', got %v", config["FULL_URL"])
	}
	// Original values preserved
	if config["HOST"] != "localhost" {
		t.Errorf("expected HOST='localhost', got %v", config["HOST"])
	}
	if config["PORT"] != float64(5432) {
		t.Errorf("expected PORT=5432, got %v", config["PORT"])
	}
}

func TestResolveDeferredMultipleSeeSnapshot(t *testing.T) {
	config := map[string]any{
		"BASE": "hello",
	}

	deferred := map[string]DeferredValue{
		"A": func(c map[string]any) any {
			return fmt.Sprintf("%s-a", c["BASE"])
		},
		"B": func(c map[string]any) any {
			// B should NOT see A's resolved value — it sees the snapshot
			_, hasA := c["A"]
			return hasA
		},
	}

	ResolveDeferred(config, deferred)

	if config["A"] != "hello-a" {
		t.Errorf("expected A='hello-a', got %v", config["A"])
	}
	// B should see that A was NOT in the snapshot
	if config["B"] != false {
		t.Errorf("expected B=false, got %v", config["B"])
	}
}

func TestResolveDeferredAfterMerge(t *testing.T) {
	config := map[string]any{
		"ENV":  "production",
		"HOST": "prod.example.com",
	}

	deferred := map[string]DeferredValue{
		"API_URL": func(c map[string]any) any {
			return fmt.Sprintf("https://%s/api/%s", c["HOST"], c["ENV"])
		},
	}

	ResolveDeferred(config, deferred)

	expected := "https://prod.example.com/api/production"
	if config["API_URL"] != expected {
		t.Errorf("expected %q, got %v", expected, config["API_URL"])
	}
}

func TestResolveDeferredEmpty(t *testing.T) {
	config := map[string]any{
		"KEY": "value",
	}

	deferred := map[string]DeferredValue{}
	ResolveDeferred(config, deferred)

	if config["KEY"] != "value" {
		t.Errorf("expected KEY='value', got %v", config["KEY"])
	}
}
