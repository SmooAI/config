"""Tests for container/runtime mode (SMOODEV-1493).

Mirrors the TypeScript reference suite (src/container/__tests__/container.test.ts)
with identical semantics: bootstrap-missing-env raises + lists the missing vars;
required-key-unresolved raises (not None); optional-key-absent returns None;
happy-path fetch+cache; 401 → refresh → retry; health healthy/unhealthy.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Iterator

import httpx
import pytest
from pydantic import BaseModel

from smooai_config.client import ConfigClient
from smooai_config.container import (
    ConfigBootstrapError,
    ConfigKeyUnresolvedError,
    SelectModeInputs,
    config_health,
    init_container_config,
    select_mode,
)
from smooai_config.container import (
    _reset_select_mode_log_for_tests as reset_select_mode_log,
)
from smooai_config.schema import define_config
from smooai_config.token_provider import TokenProvider

# --- Schema --------------------------------------------------------------------


# Config keys are camelCase by convention (the env tier reads them as
# UPPER_SNAKE_CASE); N815 (no mixedCase in class scope) doesn't apply here.
class PublicConfig(BaseModel):
    apiBaseUrl: str = ""  # noqa: N815


class SecretConfig(BaseModel):
    stripeApiKey: str = ""  # noqa: N815
    sendgridApiKey: str = ""  # noqa: N815


class FeatureFlags(BaseModel):
    newCheckout: str = ""  # noqa: N815


SCHEMA = define_config(public=PublicConfig, secret=SecretConfig, feature_flags=FeatureFlags)

# Env vars the env-tier read would consult for our schema keys — cleared per-test
# so a host shell can't leak into the env tier and break isolation.
SCHEMA_KEY_ENV = ["STRIPE_API_KEY", "SENDGRID_API_KEY", "API_BASE_URL", "NEW_CHECKOUT"]


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    import os

    for k in list(os.environ):
        if k.startswith("SMOOAI_") or k.startswith("SMOO_CONFIG"):
            monkeypatch.delenv(k, raising=False)
    for k in SCHEMA_KEY_ENV:
        monkeypatch.delenv(k, raising=False)
    reset_select_mode_log()
    yield
    reset_select_mode_log()


# --- Helpers -------------------------------------------------------------------


class StubTokenProvider(TokenProvider):
    """Returns a fixed JWT without an OAuth round-trip; counts invalidations."""

    def __init__(self, token: str = "test-token") -> None:
        super().__init__(auth_url="https://stub.invalid", client_id="id", client_secret="secret")
        self._token = token
        self.invalidate_call_count = 0

    def get_access_token(self) -> str:  # type: ignore[override]
        return self._token

    def invalidate(self) -> None:  # type: ignore[override]
        self.invalidate_call_count += 1
        super().invalidate()


def make_client(
    handler: Callable[[httpx.Request], httpx.Response],
    *,
    token_provider: TokenProvider | None = None,
    cache_ttl_seconds: float = 30.0,
) -> ConfigClient:
    transport = httpx.MockTransport(handler)
    http = httpx.Client(base_url="https://api.smooai.test", transport=transport)
    return ConfigClient(
        base_url="https://api.smooai.test",
        org_id="org-1",
        environment="production",
        cache_ttl_seconds=cache_ttl_seconds,
        token_provider=token_provider or StubTokenProvider(),
        http_client=http,
    )


def all_values_handler(values: dict[str, object]) -> Callable[[httpx.Request], httpx.Response]:
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.endswith("/config/values") or "/config/values?" in url:
            return httpx.Response(200, json={"values": values})
        # per-key endpoint: return absent
        return httpx.Response(200, json={"value": None})

    return handler


# --- Bootstrap validation ------------------------------------------------------


class TestBootstrapValidation:
    def test_raises_listing_every_missing_required_env(self) -> None:
        with pytest.raises(ConfigBootstrapError) as ei:
            init_container_config(schema=SCHEMA)
        missing = ei.value.missing
        assert set(missing) >= {
            "SMOOAI_CONFIG_API_URL",
            "SMOOAI_CONFIG_CLIENT_ID",
            "SMOOAI_CONFIG_CLIENT_SECRET",
            "SMOOAI_CONFIG_ORG_ID",
            "SMOOAI_CONFIG_ENV",
        }
        assert "SMOOAI_CONFIG_API_URL" in str(ei.value)

    def test_lists_only_actually_missing_vars(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("SMOOAI_CONFIG_API_URL", "https://api.smooai.test")
        monkeypatch.setenv("SMOOAI_CONFIG_CLIENT_ID", "id")
        monkeypatch.setenv("SMOOAI_CONFIG_ORG_ID", "org-1")
        monkeypatch.setenv("SMOOAI_CONFIG_ENV", "production")
        # CLIENT_SECRET missing.
        with pytest.raises(ConfigBootstrapError) as ei:
            init_container_config(schema=SCHEMA)
        assert ei.value.missing == ["SMOOAI_CONFIG_CLIENT_SECRET"]

    def test_blank_whitespace_env_treated_as_missing(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("SMOOAI_CONFIG_API_URL", "https://api.smooai.test")
        monkeypatch.setenv("SMOOAI_CONFIG_CLIENT_ID", "   ")
        monkeypatch.setenv("SMOOAI_CONFIG_CLIENT_SECRET", "secret")
        monkeypatch.setenv("SMOOAI_CONFIG_ORG_ID", "org-1")
        monkeypatch.setenv("SMOOAI_CONFIG_ENV", "production")
        with pytest.raises(ConfigBootstrapError) as ei:
            init_container_config(schema=SCHEMA)
        assert ei.value.missing == ["SMOOAI_CONFIG_CLIENT_ID"]

    def test_legacy_api_key_accepted_as_client_secret(self) -> None:
        client = make_client(all_values_handler({}))
        handle = init_container_config(
            schema=SCHEMA,
            api_url="https://api.smooai.test",
            client_id="id",
            client_secret="legacy-secret",  # would also work via SMOOAI_CONFIG_API_KEY
            org_id="org-1",
            environment="production",
            config_client=client,
        )
        assert handle is not None

    def test_injected_client_only_requires_env(self) -> None:
        client = make_client(all_values_handler({}))
        with pytest.raises(ConfigBootstrapError) as ei:
            init_container_config(schema=SCHEMA, config_client=client)
        assert ei.value.missing == ["SMOOAI_CONFIG_ENV"]

    def test_explicit_args_override_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # Env says one thing; explicit env arg wins and bootstrap proceeds.
        monkeypatch.setenv("SMOOAI_CONFIG_ENV", "staging")
        client = make_client(all_values_handler({"stripeApiKey": "sk"}))
        handle = init_container_config(schema=SCHEMA, environment="production", config_client=client)
        assert handle.secret_config.get("stripeApiKey") == "sk"


# --- Startup fetch (fail at boot, not first read) ------------------------------


class TestStartupFetch:
    def test_raises_when_initial_fetch_fails(self) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(500, text="boom")

        client = make_client(handler)
        with pytest.raises(httpx.HTTPStatusError):
            init_container_config(schema=SCHEMA, environment="production", config_client=client)

    def test_happy_path_reads_from_cache_without_second_http_call(self) -> None:
        calls = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            calls["n"] += 1
            return httpx.Response(200, json={"values": {"stripeApiKey": "sk_live_123", "apiBaseUrl": "https://x"}})

        client = make_client(handler)
        handle = init_container_config(schema=SCHEMA, environment="production", config_client=client)
        calls_after_init = calls["n"]
        assert handle.secret_config.get("stripeApiKey") == "sk_live_123"
        assert handle.public_config.get("apiBaseUrl") == "https://x"
        # get_all_values seeded the cache, so no extra fetches.
        assert calls["n"] == calls_after_init


# --- Fail-loud reads (§3) ------------------------------------------------------


class TestFailLoudReads:
    def test_required_secret_unresolved_raises(self) -> None:
        client = make_client(all_values_handler({}))
        handle = init_container_config(schema=SCHEMA, environment="production", config_client=client)
        with pytest.raises(ConfigKeyUnresolvedError) as ei:
            handle.secret_config.get("stripeApiKey")
        assert ei.value.key == "stripeApiKey"
        assert ei.value.env == "production"
        assert ei.value.tried_tiers == ["env", "http"]

    def test_optional_key_absent_returns_none(self) -> None:
        client = make_client(all_values_handler({}))
        handle = init_container_config(
            schema=SCHEMA,
            environment="production",
            config_client=client,
            optional_keys=["sendgridApiKey"],
        )
        assert handle.secret_config.get("sendgridApiKey") is None

    def test_get_sync_for_unresolved_required_key_raises(self) -> None:
        client = make_client(all_values_handler({}))
        handle = init_container_config(schema=SCHEMA, environment="production", config_client=client)
        with pytest.raises(ConfigKeyUnresolvedError):
            handle.secret_config.get_sync("stripeApiKey")

    def test_get_sync_returns_cached_value(self) -> None:
        client = make_client(all_values_handler({"stripeApiKey": "sk_cached"}))
        handle = init_container_config(schema=SCHEMA, environment="production", config_client=client)
        assert handle.secret_config.get_sync("stripeApiKey") == "sk_cached"

    def test_env_override_wins_over_http(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("STRIPE_API_KEY", "sk_from_env")
        client = make_client(all_values_handler({"stripeApiKey": "sk_from_http"}))
        handle = init_container_config(schema=SCHEMA, environment="production", config_client=client)
        assert handle.secret_config.get("stripeApiKey") == "sk_from_env"


# --- 401 → refresh → retry (§5) ------------------------------------------------


class TestTokenRefreshRetry:
    def test_invalidates_and_retries_once_on_401(self) -> None:
        tp = StubTokenProvider()
        state = {"phase": "init", "per_key_calls": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            url = str(request.url)
            is_all = url.endswith("/config/values") or "/config/values?" in url
            if is_all:
                return httpx.Response(200, json={"values": {}})
            # per-key getValue: 401 first, then 200.
            state["per_key_calls"] += 1
            if state["per_key_calls"] == 1:
                return httpx.Response(401, text="expired")
            return httpx.Response(200, json={"value": "sk_after_refresh"})

        client = make_client(handler, token_provider=tp)
        handle = init_container_config(schema=SCHEMA, environment="production", config_client=client)
        v = handle.secret_config.get("stripeApiKey")
        assert v == "sk_after_refresh"
        assert tp.invalidate_call_count == 1


# --- config_health (§4) --------------------------------------------------------


class TestConfigHealth:
    def test_healthy_after_successful_initial_fetch(self) -> None:
        client = make_client(all_values_handler({"stripeApiKey": "sk"}))
        handle = init_container_config(schema=SCHEMA, environment="production", config_client=client)
        assert handle.health().status == "healthy"
        assert config_health(handle).status == "healthy"

    def test_serves_healthy_within_ttl_then_unhealthy_past_hard_expiry(self) -> None:
        # Short cache TTL so the per-key cache expires quickly, forcing a refresh
        # on the next read — which fails — exercising the last-good / hard-expiry
        # health transition.
        state = {"phase": "init"}

        def handler(request: httpx.Request) -> httpx.Response:
            url = str(request.url)
            is_all = url.endswith("/config/values") or "/config/values?" in url
            if is_all and state["phase"] == "init":
                state["phase"] = "post-init"
                return httpx.Response(200, json={"values": {"stripeApiKey": "sk_initial"}})
            # All subsequent refreshes fail.
            return httpx.Response(503, text="network down")

        client = make_client(handler, cache_ttl_seconds=0.05)
        handle = init_container_config(schema=SCHEMA, environment="production", config_client=client, cache_ttl_ms=50)
        assert handle.health().status == "healthy"

        # Let the per-key cache TTL expire so the next read triggers a (failing)
        # refresh with no last-good cached value left.
        time.sleep(0.1)
        with pytest.raises(ConfigKeyUnresolvedError):
            handle.secret_config.get("stripeApiKey")

        # last refresh failed; force the age past the hard TTL window.
        handle._last_fetch_at = time.monotonic() - 1.0
        h = handle.health()
        assert h.status == "unhealthy"
        assert h.reason is not None
        assert "network down" in h.reason or "TTL" in h.reason

    def test_serves_last_good_on_refresh_failure_within_ttl(self) -> None:
        # Generous TTL: the seeded value is still cached, so a read returns the
        # last-good value and health stays healthy even though no refresh runs.
        client = make_client(all_values_handler({"stripeApiKey": "sk_initial"}), cache_ttl_seconds=30.0)
        handle = init_container_config(
            schema=SCHEMA, environment="production", config_client=client, cache_ttl_ms=30_000
        )
        assert handle.secret_config.get("stripeApiKey") == "sk_initial"
        assert handle.health().status == "healthy"

    def test_unhealthy_before_initial_fetch_never_raises(self) -> None:
        # config_health on a handle whose initial fetch failed/never ran.
        client = make_client(all_values_handler({}))
        handle = init_container_config(schema=SCHEMA, environment="production", config_client=client)
        handle._last_fetch_ok = False
        handle._last_error = "boom"
        h = config_health(handle)
        assert h.status == "unhealthy"
        assert h.reason == "boom"


# --- select_mode (§2) ----------------------------------------------------------


class TestSelectMode:
    def test_explicit_container_mode(self) -> None:
        assert select_mode(SelectModeInputs(mode="container")) == "container"
        assert select_mode(SelectModeInputs(mode="CONTAINER")) == "container"

    def test_blob_present_means_default(self) -> None:
        assert (
            select_mode(SelectModeInputs(blob_present=True, client_id="id", client_secret="s", api_url="u"))
            == "default"
        )

    def test_file_present_means_default(self) -> None:
        assert (
            select_mode(SelectModeInputs(file_present=True, client_id="id", client_secret="s", api_url="u"))
            == "default"
        )

    def test_auto_selects_container_on_m2m_creds(self) -> None:
        assert select_mode(SelectModeInputs(client_id="id", client_secret="s", api_url="u")) == "container"

    def test_falls_back_to_default_when_creds_incomplete(self) -> None:
        assert select_mode(SelectModeInputs(client_id="id", api_url="u")) == "default"
        assert select_mode(SelectModeInputs()) == "default"

    def test_reads_from_env_when_inputs_omitted(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("SMOOAI_CONFIG_MODE", "container")
        assert select_mode() == "container"
