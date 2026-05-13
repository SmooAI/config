"""Unit tests for smooai_config.runtime (baked-blob decrypt + hydration).

Exercise:
  - build_bundle encrypt → read_baked_config decrypt round-trip
  - hydrate_config_client seeds the underlying client cache so get_value
    resolves offline (monkey-patches the HTTP client with a stub that would
    throw on a network call)
  - graceful no-op when env vars absent
  - invalid-length key raises
"""

from __future__ import annotations

import base64
import os
from pathlib import Path

import pytest

from smooai_config.client import ConfigClient
from smooai_config.runtime import (
    _reset_runtime_caches_for_tests,
    hydrate_config_client,
    read_baked_config,
)

SAMPLE_PARTITIONED = {
    "public": {"apiUrl": "https://api.example.com", "webUrl": "https://example.com"},
    "secret": {"tavilyApiKey": "tvly-abc123", "openaiApiKey": "sk-secret"},
}


def _encrypt_sample(tmp_path: Path) -> tuple[str, Path]:
    """Encrypt SAMPLE_PARTITIONED via build_bundle's crypto path and write the blob.

    Returns ``(key_b64, blob_path)``. Bypasses the HTTP fetch — we stub a
    client-less crypto block by encrypting SAMPLE_PARTITIONED directly.
    """
    import json as _json
    import os as _os

    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    plaintext = _json.dumps(SAMPLE_PARTITIONED, separators=(",", ":")).encode("utf-8")
    key_bytes = _os.urandom(32)
    nonce = _os.urandom(12)
    aesgcm = AESGCM(key_bytes)
    ct_tag = aesgcm.encrypt(nonce, plaintext, associated_data=None)
    blob = nonce + ct_tag

    blob_path = tmp_path / "smoo-config.enc"
    blob_path.write_bytes(blob)
    return base64.b64encode(key_bytes).decode("ascii"), blob_path


@pytest.fixture(autouse=True)
def _reset_caches() -> None:
    _reset_runtime_caches_for_tests()


def test_read_baked_config_returns_none_without_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SMOO_CONFIG_KEY_FILE", raising=False)
    monkeypatch.delenv("SMOO_CONFIG_KEY", raising=False)
    assert read_baked_config() is None


def test_read_baked_config_round_trip(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    key_b64, blob_path = _encrypt_sample(tmp_path)
    monkeypatch.setenv("SMOO_CONFIG_KEY_FILE", str(blob_path))
    monkeypatch.setenv("SMOO_CONFIG_KEY", key_b64)

    blob = read_baked_config()
    assert blob is not None
    assert blob["public"]["apiUrl"] == "https://api.example.com"
    assert blob["secret"]["tavilyApiKey"] == "tvly-abc123"


def test_read_baked_config_rejects_bad_key(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _, blob_path = _encrypt_sample(tmp_path)
    monkeypatch.setenv("SMOO_CONFIG_KEY_FILE", str(blob_path))
    # 16-byte key — AES-256 requires 32.
    monkeypatch.setenv("SMOO_CONFIG_KEY", base64.b64encode(b"\x00" * 16).decode("ascii"))
    with pytest.raises(ValueError, match="32 bytes"):
        read_baked_config()


def test_hydrate_seeds_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    key_b64, blob_path = _encrypt_sample(tmp_path)
    monkeypatch.setenv("SMOO_CONFIG_KEY_FILE", str(blob_path))
    monkeypatch.setenv("SMOO_CONFIG_KEY", key_b64)
    # ConfigClient requires these — stub so construction succeeds.
    monkeypatch.setenv("SMOOAI_CONFIG_API_URL", "https://api.smoo.ai")
    monkeypatch.setenv("SMOOAI_CONFIG_API_KEY", "test-key")
    # SMOODEV-974: ConfigClient ctor requires client_id when no token_provider
    # is injected. Stub the env var so construction succeeds offline.
    monkeypatch.setenv("SMOOAI_CONFIG_CLIENT_ID", "test-client-id")
    monkeypatch.setenv("SMOOAI_CONFIG_ORG_ID", "test-org")
    monkeypatch.setenv("SMOOAI_CONFIG_ENV", "production")

    client = ConfigClient()
    count = hydrate_config_client(client)
    assert count == 4  # 2 public + 2 secret

    # Reach into the underlying cache to confirm seeding without hitting the API.
    env = client._default_environment  # type: ignore[attr-defined]
    cache = client._cache  # type: ignore[attr-defined]
    assert cache[f"{env}:tavilyApiKey"][0] == "tvly-abc123"
    assert cache[f"{env}:apiUrl"][0] == "https://api.example.com"

    client.close()


def test_hydrate_returns_zero_without_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SMOO_CONFIG_KEY_FILE", raising=False)
    monkeypatch.delenv("SMOO_CONFIG_KEY", raising=False)
    monkeypatch.setenv("SMOOAI_CONFIG_API_URL", "https://api.smoo.ai")
    monkeypatch.setenv("SMOOAI_CONFIG_API_KEY", "test-key")
    # SMOODEV-974: ConfigClient ctor requires client_id when no token_provider
    # is injected. Stub the env var so construction succeeds offline.
    monkeypatch.setenv("SMOOAI_CONFIG_CLIENT_ID", "test-client-id")
    monkeypatch.setenv("SMOOAI_CONFIG_ORG_ID", "test-org")
    monkeypatch.setenv("SMOOAI_CONFIG_ENV", "production")

    client = ConfigClient()
    try:
        assert hydrate_config_client(client) == 0
    finally:
        client.close()


def test_read_baked_config_missing_file_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SMOO_CONFIG_KEY_FILE", str(tmp_path / "does-not-exist.enc"))
    monkeypatch.setenv("SMOO_CONFIG_KEY", base64.b64encode(os.urandom(32)).decode("ascii"))
    with pytest.raises(FileNotFoundError):
        read_baked_config()
