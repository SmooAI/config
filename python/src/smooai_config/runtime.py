"""Bake-aware runtime hydrator for smooai-config (Python parity with TypeScript).

Reads a pre-encrypted JSON blob produced by :mod:`smooai_config.build` and
exposes typed sync accessors by seeding a :class:`ConfigClient` cache. The
library API stays uniform — consumers always call ``client.get_value(key)``
regardless of whether the data came from the baked blob or a live fetch.

- Public + secret values hydrate from the blob (sync, no network)
- Feature flags are never baked — the baker drops them so they stay
  live-fetched through :class:`ConfigClient`.

Works anywhere Python runs with a filesystem: Lambda, ECS, Fargate, EC2,
long-lived services, containers. For runtimes without a filesystem, skip
this module and use :class:`ConfigClient` directly.

Environment variables (set by the deploy pipeline):

  SMOO_CONFIG_KEY_FILE  — absolute path to the encrypted blob on disk
  SMOO_CONFIG_KEY       — base64-encoded 32-byte AES-256 key

  SMOOAI_CONFIG_API_URL  — for feature-flag / uncached lookups
  SMOOAI_CONFIG_API_KEY
  SMOOAI_CONFIG_ORG_ID
  SMOOAI_CONFIG_ENV

Blob layout (matches TypeScript):
  ``nonce (12 bytes) || ciphertext || authTag (16 bytes)``
"""

from __future__ import annotations

import base64
import json
import os
import threading
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from smooai_config.client import ConfigClient

_lock = threading.RLock()
_decrypted_cache: dict[str, dict[str, Any]] | None = None


def _decrypt_blob() -> dict[str, dict[str, Any]] | None:
    key_file = os.environ.get("SMOO_CONFIG_KEY_FILE")
    key_b64 = os.environ.get("SMOO_CONFIG_KEY")
    if not key_file or not key_b64:
        return None

    key = base64.b64decode(key_b64)
    if len(key) != 32:
        msg = f"SMOO_CONFIG_KEY must decode to 32 bytes (got {len(key)})"
        raise ValueError(msg)

    with open(key_file, "rb") as fh:
        blob = fh.read()
    if len(blob) < 28:
        msg = f"smoo-config blob too short ({len(blob)} bytes)"
        raise ValueError(msg)

    nonce = blob[:12]
    ciphertext_and_tag = blob[12:]  # AESGCM expects ciphertext||tag concatenated.

    aesgcm = AESGCM(key)
    plaintext = aesgcm.decrypt(nonce, ciphertext_and_tag, associated_data=None)

    parsed = json.loads(plaintext.decode("utf-8"))
    return {
        "public": parsed.get("public", {}),
        "secret": parsed.get("secret", {}),
    }


def read_baked_config() -> dict[str, dict[str, Any]] | None:
    """Decrypt the baked blob once and cache the result.

    Returns ``None`` when no blob is present (env vars unset). Subsequent
    calls return the same object — thread-safe.

    Prefer :func:`build_config_runtime` for typical use; reach for this when
    you just need the raw ``{public, secret}`` map.
    """
    global _decrypted_cache
    with _lock:
        if _decrypted_cache is None:
            blob = _decrypt_blob()
            _decrypted_cache = blob if blob else {"public": {}, "secret": {}}
    has_values = bool(_decrypted_cache["public"]) or bool(_decrypted_cache["secret"])
    return _decrypted_cache if has_values else None


def hydrate_config_client(client: ConfigClient, *, environment: str | None = None) -> int:
    """Seed a ConfigClient from the baked blob.

    After this call, ``client.get_value(key)`` resolves public + secret keys
    from the in-memory cache (no HTTP). Feature flags keep live-fetch
    semantics — the baker omits them from the blob.

    Returns the number of keys seeded (``0`` when no blob is present).
    """
    blob = read_baked_config()
    if blob is None:
        return 0
    merged = {**blob["public"], **blob["secret"]}
    client.seed_cache_from_map(merged, environment=environment)
    return len(merged)


def build_config_runtime(
    *,
    flag_client: ConfigClient | None = None,
    flag_cache_ttl_seconds: float = 30.0,
    base_url: str | None = None,
    api_key: str | None = None,
    client_id: str | None = None,
    client_secret: str | None = None,
    auth_url: str | None = None,
    org_id: str | None = None,
    environment: str | None = None,
) -> ConfigClient:
    """Build a hydrated ConfigClient ready for uniform ``get_value`` reads.

    Public + secret values come from the decrypted baked blob (sync-fast).
    Feature-flag reads keep live-fetch semantics with a short cache TTL.

    If a ``flag_client`` is passed, it's used as-is (hydrated). Otherwise a
    fresh :class:`ConfigClient` is constructed from the usual env vars +
    optional overrides.

    SMOODEV-974: ConfigClient now exchanges (client_id, client_secret) for
    an OAuth JWT before each call. Either pass them explicitly, or set the
    ``SMOOAI_CONFIG_CLIENT_ID`` / ``SMOOAI_CONFIG_CLIENT_SECRET`` env vars.
    ``api_key`` remains accepted as a deprecated alias for ``client_secret``.

    Example::

        from smooai_config.runtime import build_config_runtime

        config = build_config_runtime()
        tavily = config.get_value("tavilyApiKey")     # from blob, sync
        api_url = config.get_value("apiUrl")          # from blob, sync
        flag = config.get_value("newFlow")            # live API, 30s cache
    """
    if flag_client is not None:
        hydrate_config_client(flag_client, environment=environment)
        return flag_client

    client = ConfigClient(
        base_url=base_url,
        auth_url=auth_url,
        client_id=client_id,
        client_secret=client_secret,
        api_key=api_key,
        org_id=org_id,
        environment=environment,
        cache_ttl_seconds=flag_cache_ttl_seconds,
    )
    hydrate_config_client(client, environment=environment)
    return client


def _reset_runtime_caches_for_tests() -> None:
    """Internal test helper — reset module-scope cache between tests."""
    global _decrypted_cache
    with _lock:
        _decrypted_cache = None
