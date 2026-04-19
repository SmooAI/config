"""Deploy-time baker for smooai-config (Python parity with TypeScript).

Fetches every config value for an environment via :class:`ConfigClient`,
partitions into public/secret sections (feature flags are skipped), encrypts
the JSON with AES-256-GCM, and returns the ciphertext blob + base64-encoded
key. Deploy glue writes the blob to disk, ships it in the function bundle,
and sets two environment variables on the function:

    SMOO_CONFIG_KEY_FILE = <absolute path to the blob at runtime>
    SMOO_CONFIG_KEY      = <returned key_b64>

At cold start, :func:`smooai_config.runtime.build_config_runtime` reads both
and decrypts once into an in-memory cache.

Blob layout (wire-compatible with the TypeScript baker):
    ``nonce (12 random bytes) || ciphertext || authTag (16 bytes)``
"""

from __future__ import annotations

import base64
import json
import os
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from smooai_config.client import ConfigClient

ClassifyResult = Literal["public", "secret", "skip"]
Classifier = Callable[[str, Any], ClassifyResult]


def _default_classify(_key: str, _value: Any) -> ClassifyResult:
    return "public"


@dataclass(frozen=True)
class BuildBundleResult:
    """Output of :func:`build_bundle`."""

    #: Base64-encoded 32-byte AES-256 key. Set as ``SMOO_CONFIG_KEY``.
    key_b64: str
    #: Encrypted blob (``nonce || ciphertext || authTag``).
    bundle: bytes
    #: Number of keys baked (public + secret).
    key_count: int
    #: Number of keys skipped (feature flags).
    skipped_count: int


def classify_from_schema(
    *,
    public_keys: set[str] | None = None,
    secret_keys: set[str] | None = None,
    feature_flag_keys: set[str] | None = None,
) -> Classifier:
    """Classifier factory driven by pre-extracted key sets.

    Python ``define_config`` returns a schema object without structured
    top-level schemas that are trivially iterable in all cases, so the
    simplest API takes explicit key sets. Pass the keys you extracted from
    your ``define_config`` call.

    Feature flags return ``'skip'`` — they stay live-fetched at runtime.
    """
    pub = public_keys or set()
    sec = secret_keys or set()
    flags = feature_flag_keys or set()

    def _classify(key: str, _value: Any) -> ClassifyResult:
        if key in sec:
            return "secret"
        if key in pub:
            return "public"
        if key in flags:
            return "skip"
        return "public"

    return _classify


def build_bundle(
    *,
    base_url: str | None = None,
    api_key: str | None = None,
    org_id: str | None = None,
    environment: str | None = None,
    classify: Classifier | None = None,
) -> BuildBundleResult:
    """Fetch + encrypt config values for an environment.

    Uses :class:`ConfigClient` to pull every value via ``get_all_values``,
    runs each through ``classify`` (default: everything into ``public``),
    JSON-encodes the ``{public, secret}`` partition, and encrypts with a
    fresh AES-256-GCM key and random 12-byte nonce.

    Consumers should use :func:`classify_from_schema` to partition keys
    properly — the default bucketing treats everything as ``public``, which
    is almost never what you want.
    """
    classify_fn = classify or _default_classify

    client = ConfigClient(
        base_url=base_url,
        api_key=api_key,
        org_id=org_id,
        environment=environment,
    )
    try:
        all_values = client.get_all_values(environment=environment)
    finally:
        client.close()

    partitioned: dict[str, dict[str, Any]] = {"public": {}, "secret": {}}
    skipped = 0
    for key, value in all_values.items():
        section = classify_fn(key, value)
        if section == "skip":
            skipped += 1
            continue
        partitioned[section][key] = value

    plaintext = json.dumps(partitioned, separators=(",", ":")).encode("utf-8")

    key_bytes = os.urandom(32)
    nonce = os.urandom(12)
    aesgcm = AESGCM(key_bytes)
    # AESGCM.encrypt returns ciphertext || tag (16 bytes) concatenated.
    ciphertext_and_tag = aesgcm.encrypt(nonce, plaintext, associated_data=None)
    bundle = nonce + ciphertext_and_tag

    return BuildBundleResult(
        key_b64=base64.b64encode(key_bytes).decode("ascii"),
        bundle=bundle,
        key_count=len(partitioned["public"]) + len(partitioned["secret"]),
        skipped_count=skipped,
    )
