package container

import (
	"log"
	"os"
	"strings"
	"sync"
)

// Mode is the mode the SDK should run in, per §2. "container" means
// HTTP-primary fail-loud; "default" means the existing blob → env → http → file
// chain.
const (
	ModeContainer = "container"
	ModeDefault   = "default"
)

// SelectModeInputs are the inputs for SelectMode. Empty fields fall back to the
// corresponding env var.
type SelectModeInputs struct {
	// Mode is SMOOAI_CONFIG_MODE.
	Mode string
	// ClientID is SMOOAI_CONFIG_CLIENT_ID.
	ClientID string
	// ClientSecret is SMOOAI_CONFIG_CLIENT_SECRET (or legacy SMOOAI_CONFIG_API_KEY).
	ClientSecret string
	// APIURL is SMOOAI_CONFIG_API_URL.
	APIURL string
	// BlobPresent reports whether a baked blob source is present
	// (SMOO_CONFIG_KEY + SMOO_CONFIG_KEY_FILE). When the pointer is nil the env
	// vars are consulted.
	BlobPresent *bool
	// FilePresent reports whether a local .smooai-config/ file source is present.
	// When the pointer is nil it defaults to false.
	FilePresent *bool

	// EnvOverride replaces os.Getenv lookups (primarily for tests).
	EnvOverride map[string]string
}

var autoSelectLogOnce sync.Once

// SelectMode decides which mode to enter, per §2. Resolution order:
//
//  1. SMOOAI_CONFIG_MODE=container → container mode (explicit).
//  2. else if a blob/file source is present → default (Lambda/local), unchanged.
//  3. else if CLIENT_ID + CLIENT_SECRET + API_URL all set → container (auto;
//     logs once that container mode was auto-selected).
//  4. else → default.
//
// Container mode MUST NOT silently degrade to the file tier — that decision is
// enforced by InitContainerConfig's bootstrap validation; this only decides
// which mode to enter.
func SelectMode(inputs *SelectModeInputs) string {
	if inputs == nil {
		inputs = &SelectModeInputs{}
	}
	getEnv := os.Getenv
	if inputs.EnvOverride != nil {
		ov := inputs.EnvOverride
		getEnv = func(k string) string { return ov[k] }
	}
	pick := func(optVal string, envNames ...string) string {
		if v := strings.TrimSpace(optVal); v != "" {
			return optVal
		}
		for _, name := range envNames {
			if v := getEnv(name); strings.TrimSpace(v) != "" {
				return v
			}
		}
		return ""
	}

	mode := pick(inputs.Mode, "SMOOAI_CONFIG_MODE")
	if strings.EqualFold(mode, ModeContainer) {
		return ModeContainer
	}

	blobPresent := false
	if inputs.BlobPresent != nil {
		blobPresent = *inputs.BlobPresent
	} else {
		blobPresent = strings.TrimSpace(getEnv("SMOO_CONFIG_KEY")) != "" &&
			strings.TrimSpace(getEnv("SMOO_CONFIG_KEY_FILE")) != ""
	}
	filePresent := false
	if inputs.FilePresent != nil {
		filePresent = *inputs.FilePresent
	}
	if blobPresent || filePresent {
		return ModeDefault
	}

	clientID := pick(inputs.ClientID, "SMOOAI_CONFIG_CLIENT_ID")
	clientSecret := pick(inputs.ClientSecret, "SMOOAI_CONFIG_CLIENT_SECRET", "SMOOAI_CONFIG_API_KEY")
	apiURL := pick(inputs.APIURL, "SMOOAI_CONFIG_API_URL")

	if clientID != "" && clientSecret != "" && apiURL != "" {
		autoSelectLogOnce.Do(func() {
			log.Printf("@smooai/config: container mode auto-selected " +
				"(CLIENT_ID + CLIENT_SECRET + API_URL set, no blob/file source present)")
		})
		return ModeContainer
	}
	return ModeDefault
}

// resetSelectModeLogForTests resets the once-per-process auto-select log latch.
// Test-only.
func resetSelectModeLogForTests() {
	autoSelectLogOnce = sync.Once{}
}
