package container

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func boolPtr(b bool) *bool { return &b }

func TestSelectMode_ExplicitContainer(t *testing.T) {
	defer resetSelectModeLogForTests()
	got := SelectMode(&SelectModeInputs{
		EnvOverride: map[string]string{"SMOOAI_CONFIG_MODE": "container"},
	})
	assert.Equal(t, ModeContainer, got)
}

func TestSelectMode_ExplicitContainerCaseInsensitive(t *testing.T) {
	defer resetSelectModeLogForTests()
	got := SelectMode(&SelectModeInputs{Mode: "Container"})
	assert.Equal(t, ModeContainer, got)
}

func TestSelectMode_BlobPresent_Default(t *testing.T) {
	defer resetSelectModeLogForTests()
	// Even with M2M creds set, a present blob means default mode.
	got := SelectMode(&SelectModeInputs{
		ClientID:     "cid",
		ClientSecret: "csecret",
		APIURL:       "https://api.smoo.ai",
		BlobPresent:  boolPtr(true),
	})
	assert.Equal(t, ModeDefault, got)
}

func TestSelectMode_BlobPresentFromEnv_Default(t *testing.T) {
	defer resetSelectModeLogForTests()
	got := SelectMode(&SelectModeInputs{
		ClientID:     "cid",
		ClientSecret: "csecret",
		APIURL:       "https://api.smoo.ai",
		EnvOverride: map[string]string{
			"SMOO_CONFIG_KEY":      "base64key",
			"SMOO_CONFIG_KEY_FILE": "/path/blob.enc",
		},
	})
	assert.Equal(t, ModeDefault, got)
}

func TestSelectMode_FilePresent_Default(t *testing.T) {
	defer resetSelectModeLogForTests()
	got := SelectMode(&SelectModeInputs{
		ClientID:     "cid",
		ClientSecret: "csecret",
		APIURL:       "https://api.smoo.ai",
		FilePresent:  boolPtr(true),
	})
	assert.Equal(t, ModeDefault, got)
}

func TestSelectMode_AutoSelectOnCreds(t *testing.T) {
	defer resetSelectModeLogForTests()
	// EnvOverride with creds present and no blob/file env vars set — keeps the
	// test independent of the developer machine's ambient SMOO_CONFIG_KEY blob.
	got := SelectMode(&SelectModeInputs{
		EnvOverride: map[string]string{
			"SMOOAI_CONFIG_CLIENT_ID":     "cid",
			"SMOOAI_CONFIG_CLIENT_SECRET": "csecret",
			"SMOOAI_CONFIG_API_URL":       "https://api.smoo.ai",
		},
	})
	assert.Equal(t, ModeContainer, got)
}

func TestSelectMode_AutoSelectViaLegacyApiKeySecret(t *testing.T) {
	defer resetSelectModeLogForTests()
	got := SelectMode(&SelectModeInputs{
		EnvOverride: map[string]string{
			"SMOOAI_CONFIG_CLIENT_ID": "cid",
			"SMOOAI_CONFIG_API_KEY":   "legacy_secret",
			"SMOOAI_CONFIG_API_URL":   "https://api.smoo.ai",
		},
	})
	assert.Equal(t, ModeContainer, got)
}

func TestSelectMode_DefaultWhenNothingSet(t *testing.T) {
	defer resetSelectModeLogForTests()
	got := SelectMode(&SelectModeInputs{EnvOverride: map[string]string{}})
	assert.Equal(t, ModeDefault, got)
}

func TestSelectMode_DefaultWhenIncompleteCreds(t *testing.T) {
	defer resetSelectModeLogForTests()
	// Missing API URL → not enough to auto-select.
	got := SelectMode(&SelectModeInputs{
		ClientID:     "cid",
		ClientSecret: "csecret",
	})
	assert.Equal(t, ModeDefault, got)
}

func TestSelectMode_NilInputs(t *testing.T) {
	defer resetSelectModeLogForTests()
	got := SelectMode(nil)
	// With a clean (test) env the result is deterministic only if no ambient
	// SMOOAI_CONFIG_* vars are set; assert it returns a valid mode.
	assert.Contains(t, []string{ModeContainer, ModeDefault}, got)
}
