"""Integration tests for the Python config priority chain.

Parity with TypeScript ``src/server/server.priority-chain.integration.test.ts``,
adapted to the Python architecture, which splits the blob tier out of
``ConfigManager`` into a separate hydrator (``runtime.py``):

  ConfigManager merge:   file < remote (HTTP) < env
  Runtime hydrator:      decrypt baked AES-256-GCM blob → seed ConfigClient cache

These integration tests exercise:

  - precedence (each tier wins when higher tiers absent)
  - tier-missing → ``None`` (no crash)
  - HTTP errors (5xx) fall through to lower tiers without losing them
  - caching: repeated reads memoize, ``invalidate()`` drops them
  - blob-tier hydration: real AES-256-GCM blob seeded into ``ConfigClient``
    resolves keys offline (no network)
  - blob does not silently leak into ``ConfigManager``'s 3-tier path
    (architecture intent — the blob hydrator is a separate code path)
"""

from __future__ import annotations

import base64
import json
import os
from pathlib import Path
from unittest.mock import patch

import httpx
import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from smooai_config.client import ConfigClient
from smooai_config.config_manager import ConfigManager
from smooai_config.file_config import _clear_config_dir_cache
from smooai_config.runtime import (
    _reset_runtime_caches_for_tests,
    hydrate_config_client,
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

TEST_BASE_URL = "https://config.smooai.test"
TEST_API_KEY = "test-api-key-priority-chain"
TEST_ORG_ID = "550e8400-e29b-41d4-a716-446655440000"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_caches() -> None:
    _clear_config_dir_cache()
    _reset_runtime_caches_for_tests()


def _make_config_dir(tmp_path: Path, default: dict[str, object]) -> str:
    """Create a ``.smooai-config/`` dir with a single ``default.json``."""
    config_dir = tmp_path / ".smooai-config"
    config_dir.mkdir()
    (config_dir / "default.json").write_text(json.dumps(default))
    return str(config_dir)


# ---------------------------------------------------------------------------
# HTTP tier — mock transport modeled after Smoo AI config API
# ---------------------------------------------------------------------------


def _make_http_transport(
    *,
    values: dict[str, dict[str, object]],
    status_code: int = 200,
    require_auth: bool = True,
) -> httpx.MockTransport:
    """Mock the config API. ``values`` is keyed by environment name."""

    def handler(request: httpx.Request) -> httpx.Response:
        if status_code != 200:
            return httpx.Response(status_code, json={"error": "boom"})

        if require_auth and request.headers.get("authorization") != f"Bearer {TEST_API_KEY}":
            return httpx.Response(401, json={"error": "Unauthorized"})

        env_name = dict(request.url.params).get("environment", "development")
        env_values = values.get(env_name, {})

        url_path = request.url.path
        prefix = f"/organizations/{TEST_ORG_ID}/config/values/"
        base = f"/organizations/{TEST_ORG_ID}/config/values"

        if url_path.startswith(prefix) and url_path != base:
            key = url_path[len(prefix) :]
            if key not in env_values:
                return httpx.Response(404, json={"error": "Not found"})
            return httpx.Response(200, json={"value": env_values[key]})

        if url_path == base:
            return httpx.Response(200, json={"values": env_values})

        return httpx.Response(404, json={"error": "Not found"})

    return httpx.MockTransport(handler)


def _patch_client_transport(transport: httpx.MockTransport):
    """Force every ``httpx.Client`` instantiated under us to use ``transport``."""
    original_init = httpx.Client.__init__

    def patched_init(self: httpx.Client, **kwargs: object) -> None:
        kwargs["transport"] = transport  # type: ignore[assignment]
        original_init(self, **kwargs)

    return patch.object(httpx.Client, "__init__", patched_init)


# ---------------------------------------------------------------------------
# Blob tier — encrypt fixture exactly like the SST baker
# ---------------------------------------------------------------------------


def _encrypt_blob(tmp_path: Path, payload: dict[str, dict[str, object]]) -> tuple[str, str]:
    """Write a real AES-256-GCM blob; return ``(key_b64, blob_path)``."""
    plaintext = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    key_bytes = os.urandom(32)
    nonce = os.urandom(12)
    ct_tag = AESGCM(key_bytes).encrypt(nonce, plaintext, associated_data=None)
    blob_path = tmp_path / "smoo-config.enc"
    blob_path.write_bytes(nonce + ct_tag)
    return base64.b64encode(key_bytes).decode("ascii"), str(blob_path)


# ---------------------------------------------------------------------------
# ConfigManager — 3-tier (env > HTTP > file) precedence
# ---------------------------------------------------------------------------


class TestConfigManagerPriority:
    """env > HTTP > file precedence in ``ConfigManager._initialize``."""

    def test_env_wins_over_http_and_file(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"API_URL": "https://api.from-file.example"})
        transport = _make_http_transport(
            values={"production": {"API_URL": "https://api.from-http.example"}},
        )

        with _patch_client_transport(transport):
            mgr = ConfigManager(
                api_key=TEST_API_KEY,
                base_url=TEST_BASE_URL,
                org_id=TEST_ORG_ID,
                environment="production",
                schema_keys={"API_URL"},
                env={
                    "SMOOAI_ENV_CONFIG_DIR": config_dir,
                    "SMOOAI_CONFIG_ENV": "production",
                    "API_URL": "https://api.from-env.example",
                },
            )
            assert mgr.get_public_config("API_URL") == "https://api.from-env.example"

    def test_http_wins_over_file_when_env_absent(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"API_URL": "https://api.from-file.example"})
        transport = _make_http_transport(
            values={"production": {"API_URL": "https://api.from-http.example"}},
        )

        with _patch_client_transport(transport):
            mgr = ConfigManager(
                api_key=TEST_API_KEY,
                base_url=TEST_BASE_URL,
                org_id=TEST_ORG_ID,
                environment="production",
                env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "production"},
            )
            assert mgr.get_public_config("API_URL") == "https://api.from-http.example"

    def test_file_wins_when_http_and_env_absent(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"API_URL": "https://api.from-file.example"})

        mgr = ConfigManager(
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "production"},
        )
        assert mgr.get_public_config("API_URL") == "https://api.from-file.example"

    def test_returns_none_when_no_tier_has_key(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {})

        mgr = ConfigManager(
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "production"},
        )
        assert mgr.get_public_config("MISSING_KEY") is None
        assert mgr.get_secret_config("MISSING_SECRET") is None
        assert mgr.get_feature_flag("MISSING_FLAG") is None


class TestConfigManagerHttpFault:
    """``ConfigManager`` swallows HTTP errors so file/env tiers still resolve."""

    def test_http_5xx_falls_through_to_env(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {})
        transport = _make_http_transport(values={}, status_code=500)

        with _patch_client_transport(transport):
            mgr = ConfigManager(
                api_key=TEST_API_KEY,
                base_url=TEST_BASE_URL,
                org_id=TEST_ORG_ID,
                environment="production",
                schema_keys={"API_URL"},
                env={
                    "SMOOAI_ENV_CONFIG_DIR": config_dir,
                    "SMOOAI_CONFIG_ENV": "production",
                    "API_URL": "https://api.from-env.example",
                },
            )
            # HTTP 500 must not erase the env tier.
            assert mgr.get_public_config("API_URL") == "https://api.from-env.example"

    def test_http_5xx_falls_through_to_file(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"API_URL": "https://api.from-file.example"})
        transport = _make_http_transport(values={}, status_code=503)

        with _patch_client_transport(transport):
            mgr = ConfigManager(
                api_key=TEST_API_KEY,
                base_url=TEST_BASE_URL,
                org_id=TEST_ORG_ID,
                environment="production",
                env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "production"},
            )
            assert mgr.get_public_config("API_URL") == "https://api.from-file.example"


class TestConfigManagerCaching:
    """Repeated reads memoize; ``invalidate()`` drops the cache."""

    def test_repeated_reads_memoize_then_invalidate_drops(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"API_URL": "from-file"})
        # Tally HTTP requests so we can prove memoization.
        request_count = {"n": 0}

        def handler(request: httpx.Request) -> httpx.Response:
            request_count["n"] += 1
            env = dict(request.url.params).get("environment", "development")
            data = {"production": {"API_URL": "from-http-1"}}.get(env, {})
            url_path = request.url.path
            base = f"/organizations/{TEST_ORG_ID}/config/values"
            if url_path == base:
                return httpx.Response(200, json={"values": data})
            return httpx.Response(404)

        transport = httpx.MockTransport(handler)

        with _patch_client_transport(transport):
            mgr = ConfigManager(
                api_key=TEST_API_KEY,
                base_url=TEST_BASE_URL,
                org_id=TEST_ORG_ID,
                environment="production",
                env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "production"},
            )

            assert mgr.get_public_config("API_URL") == "from-http-1"
            initial = request_count["n"]
            assert initial >= 1

            # Subsequent read serves from per-tier cache — no new HTTP.
            assert mgr.get_public_config("API_URL") == "from-http-1"
            assert request_count["n"] == initial

            mgr.invalidate()
            assert mgr.get_public_config("API_URL") == "from-http-1"
            # invalidate() forces re-init → at least one new fetch.
            assert request_count["n"] > initial


# ---------------------------------------------------------------------------
# Runtime blob hydrator — separate path that pre-seeds ``ConfigClient`` cache
# ---------------------------------------------------------------------------


class TestBlobHydration:
    """The blob path bypasses HTTP entirely by seeding the client cache."""

    def test_hydrated_client_resolves_offline(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        key_b64, blob_path = _encrypt_blob(
            tmp_path,
            {
                "public": {"apiUrl": "https://api.from-blob.example"},
                "secret": {"sendgridApiKey": "SG.from-blob"},
            },
        )
        monkeypatch.setenv("SMOO_CONFIG_KEY_FILE", blob_path)
        monkeypatch.setenv("SMOO_CONFIG_KEY", key_b64)

        # No transport → any HTTP call would explode. We rely on the cache.
        client = ConfigClient(
            base_url=TEST_BASE_URL,
            api_key=TEST_API_KEY,
            org_id=TEST_ORG_ID,
            environment="production",
        )
        try:
            count = hydrate_config_client(client)
            assert count == 2

            # These resolve from cache — no HTTP.
            assert client.get_value("apiUrl") == "https://api.from-blob.example"
            assert client.get_value("sendgridApiKey") == "SG.from-blob"
        finally:
            client.close()

    def test_blob_hydration_is_noop_without_env_vars(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("SMOO_CONFIG_KEY_FILE", raising=False)
        monkeypatch.delenv("SMOO_CONFIG_KEY", raising=False)

        client = ConfigClient(
            base_url=TEST_BASE_URL,
            api_key=TEST_API_KEY,
            org_id=TEST_ORG_ID,
            environment="production",
        )
        try:
            assert hydrate_config_client(client) == 0
        finally:
            client.close()

    def test_blob_path_is_independent_of_config_manager(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """``ConfigManager`` does not consume the blob — confirms the split.

        TypeScript merges blob → env → HTTP → file in a single pipeline.
        Python's ``ConfigManager`` does **not** read the blob; it must be
        consumed via ``hydrate_config_client``. This test pins that boundary
        so a future refactor can't quietly cross-wire them.
        """
        # Set up a blob the ConfigManager would otherwise prefer.
        key_b64, blob_path = _encrypt_blob(
            tmp_path,
            {"public": {"API_URL": "from-blob"}, "secret": {}},
        )
        monkeypatch.setenv("SMOO_CONFIG_KEY_FILE", blob_path)
        monkeypatch.setenv("SMOO_CONFIG_KEY", key_b64)

        config_dir = _make_config_dir(tmp_path, {"API_URL": "from-file"})

        mgr = ConfigManager(
            env={
                "SMOOAI_ENV_CONFIG_DIR": config_dir,
                "SMOOAI_CONFIG_ENV": "production",
                # Blob env vars are also set above via monkeypatch but
                # ConfigManager's env dict drives its own resolution; the
                # important point is the merge result.
            },
        )
        # File wins because the blob path is not consulted by ConfigManager.
        assert mgr.get_public_config("API_URL") == "from-file"
