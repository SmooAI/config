package container

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestConfigBootstrapError_Message(t *testing.T) {
	e := &ConfigBootstrapError{Missing: []string{"SMOOAI_CONFIG_CLIENT_ID", "SMOOAI_CONFIG_ENV"}}
	msg := e.Error()
	assert.Contains(t, msg, "SMOOAI_CONFIG_CLIENT_ID")
	assert.Contains(t, msg, "SMOOAI_CONFIG_ENV")
	assert.Contains(t, msg, "these variables")
	assert.Contains(t, msg, "docs/Container-Runtime-Mode.md")
}

func TestConfigBootstrapError_SingularNoun(t *testing.T) {
	e := &ConfigBootstrapError{Missing: []string{"SMOOAI_CONFIG_ENV"}}
	assert.Contains(t, e.Error(), "this variable")
}

func TestConfigKeyUnresolvedError_Message(t *testing.T) {
	e := &ConfigKeyUnresolvedError{
		Key:        "stripeApiKey",
		Env:        "production",
		TriedTiers: []Tier{TierEnv, TierHTTP},
	}
	msg := e.Error()
	assert.Contains(t, msg, "stripeApiKey")
	assert.Contains(t, msg, "production")
	assert.Contains(t, msg, "env → http")
	assert.Contains(t, msg, "OptionalKeys")
}

func TestConfigKeyUnresolvedError_NoTiers(t *testing.T) {
	e := &ConfigKeyUnresolvedError{Key: "k", Env: "dev"}
	assert.Contains(t, e.Error(), "tiers tried: none")
}
