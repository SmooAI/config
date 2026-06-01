"""``smooai_config.container`` — container/runtime mode (SMOODEV-1489 / SMOODEV-1493).

The Python SDK's implementation of container mode, mirroring the TypeScript
**reference** (SMOODEV-1490) with identical env contract and error semantics.
Idioms differ (Python is sync here, like :class:`~smooai_config.client.ConfigClient`);
behavior does not.

Why
---

``smooai_config`` resolves values through four tiers: blob → env → http →
file. The blob tier (an encrypted bundle baked into a Lambda layer / image at
deploy time, decrypted with a separately-delivered key) is the blessed path
for **Lambda**. It is the *wrong* default for long-lived **containers**
(EKS/ECS): when the per-build blob key isn't delivered to the pod, resolution
silently falls through to the (absent) file tier and returns ``None`` for a
required secret (the SMOODEV-1478 CrashLoop outage).

Container mode makes the **HTTP tier the blessed, first-class path** for
containers, authenticated with an OAuth2 ``client_credentials`` (M2M) token,
**fail-loud** so a missing required value is an immediate, clear error (a
typed :class:`ConfigKeyUnresolvedError`, never a silent ``None``).

Usage
-----

.. code-block:: python

    from smooai_config import define_config
    from smooai_config.container import init_container_config

    schema = define_config(public=PublicConfig, secret=SecretConfig)

    # Validates env, mints a token, does an initial fetch — startup fails
    # loudly here, not on first read.
    config = init_container_config(schema=schema)

    # Fail-loud: a required secret that doesn't resolve raises.
    stripe_key = config.secret_config.get("stripeApiKey")

    # Readiness probe handler:
    health = config.health()
    status = 200 if health.status == "healthy" else 503

Env contract (§1 — identical across all five SDKs)
--------------------------------------------------

  SMOOAI_CONFIG_MODE          ``container`` forces this mode (see :func:`select_mode`).
  SMOOAI_CONFIG_API_URL       (required) config API base URL.
  SMOOAI_CONFIG_AUTH_URL      OAuth issuer base URL (default ``https://auth.smoo.ai``;
                              legacy ``SMOOAI_AUTH_URL`` accepted).
  SMOOAI_CONFIG_CLIENT_ID     (required) M2M OAuth client id.
  SMOOAI_CONFIG_CLIENT_SECRET (required) M2M OAuth client secret
                              (legacy alias ``SMOOAI_CONFIG_API_KEY`` accepted).
  SMOOAI_CONFIG_ORG_ID        (required) org id whose config to fetch.
  SMOOAI_CONFIG_ENV           (required) environment name (e.g. ``production``).
"""

from __future__ import annotations

import logging
import os
import time
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any, Literal

from smooai_config.client import ConfigClient
from smooai_config.schema import ConfigDefinition
from smooai_config.token_provider import TokenProvider
from smooai_config.utils import camel_to_upper_snake

logger = logging.getLogger("smooai_config.container")

# --- Constants (§5, parity: same defaults in every SDK) ----------------------

#: Default config-value cache TTL in milliseconds (§5). Same 30s default
#: everywhere.
DEFAULT_CACHE_TTL_MS = 30_000

#: Default token proactive-refresh window in seconds (§5). Matches
#: :class:`~smooai_config.token_provider.TokenProvider`.
DEFAULT_TOKEN_REFRESH_BUFFER_SECONDS = 60

#: One of the resolution tiers consulted during a value read.
ConfigTier = Literal["blob", "env", "http", "file"]

#: Mode the SDK should run in (§2).
ConfigMode = Literal["container", "default"]


# --- Typed errors (§3, parity: same names + carried fields) ------------------


class ConfigBootstrapError(Exception):
    """Raised by :func:`init_container_config` when the container-required env
    (§1 of the spec) is missing or blank.

    Carries the exact list of offending env var names (:attr:`missing`) so the
    operator can fix the deployment without guessing. No partial init: if any
    required var is absent, bootstrap fails whole.
    """

    def __init__(self, missing: Sequence[str]) -> None:
        self.missing: list[str] = list(missing)
        plural = "this variable" if len(self.missing) == 1 else "these variables"
        super().__init__(
            f"[smooai_config] container-mode bootstrap failed: missing required env "
            f"{', '.join(self.missing)}. Set {plural} before calling "
            f"init_container_config() (see docs/Container-Runtime-Mode.md for the "
            f"Kubernetes/ExternalSecret recipe)."
        )


class ConfigKeyUnresolvedError(Exception):
    """Raised by a required-key read (``secret_config.get`` / ``get_sync`` and
    the public/flag analogs) in container mode when the value resolves to
    absent across every active tier.

    This is the exact class that closes the silent-``None`` hole (SMOODEV-1478 /
    SMOODEV-1135). Optional keys (declared via
    ``init_container_config(optional_keys=[...])``) do NOT raise this — they
    return ``None``.
    """

    def __init__(self, *, key: str, env: str, tried_tiers: Sequence[ConfigTier]) -> None:
        self.key = key
        self.env = env
        self.tried_tiers: list[ConfigTier] = list(tried_tiers)
        tiers = " → ".join(self.tried_tiers) or "none"
        super().__init__(
            f'[smooai_config] required config key "{key}" did not resolve in '
            f'environment "{env}" (container mode; tiers tried: {tiers}). Set a '
            f'value for this key in the config server for "{env}", or mark it '
            f"optional via init_container_config(optional_keys=['{key}'])."
        )


# --- Health status (§4, never raises) ----------------------------------------


@dataclass(frozen=True)
class ConfigHealth:
    """Status returned by :meth:`ContainerConfigHandle.health` and
    :func:`config_health`. Never raised — purely a value.
    """

    status: Literal["healthy", "unhealthy"]
    reason: str | None = None


# --- Env helpers -------------------------------------------------------------


def _read_env(name: str) -> str | None:
    return os.environ.get(name)


def _non_blank(value: str | None) -> str | None:
    """Blank-aware presence check (a set-but-whitespace value counts as
    missing), preserving the original (untrimmed) value when non-blank.
    """
    if value is None:
        return None
    return value if value.strip() else None


def _is_set(value: Any) -> bool:
    return value is not None and value != ""


@dataclass(frozen=True)
class _ResolvedEnv:
    api_url: str
    auth_url: str
    client_id: str
    client_secret: str
    org_id: str
    environment: str


def _resolve_and_validate_env(
    *,
    api_url: str | None,
    auth_url: str | None,
    client_id: str | None,
    client_secret: str | None,
    org_id: str | None,
    environment: str | None,
    client_injected: bool,
) -> _ResolvedEnv:
    """Resolve + validate the container-mode env contract (§1).

    Explicit args override env vars. Returns the resolved values, or raises
    :class:`ConfigBootstrapError` listing exactly which required vars are
    missing/blank. No partial result.
    """
    r_api_url = _non_blank(api_url) or _non_blank(_read_env("SMOOAI_CONFIG_API_URL"))
    r_auth_url = (
        _non_blank(auth_url)
        or _non_blank(_read_env("SMOOAI_CONFIG_AUTH_URL"))
        or _non_blank(_read_env("SMOOAI_AUTH_URL"))
        or "https://auth.smoo.ai"
    )
    r_client_id = _non_blank(client_id) or _non_blank(_read_env("SMOOAI_CONFIG_CLIENT_ID"))
    r_client_secret = (
        _non_blank(client_secret)
        or _non_blank(_read_env("SMOOAI_CONFIG_CLIENT_SECRET"))
        or _non_blank(_read_env("SMOOAI_CONFIG_API_KEY"))
    )
    r_org_id = _non_blank(org_id) or _non_blank(_read_env("SMOOAI_CONFIG_ORG_ID"))
    r_environment = _non_blank(environment) or _non_blank(_read_env("SMOOAI_CONFIG_ENV"))

    missing: list[str] = []
    # When a ConfigClient is injected it already carries api_url/auth/client_id/
    # secret/org_id — only the environment is still container-required.
    if not client_injected:
        if not r_api_url:
            missing.append("SMOOAI_CONFIG_API_URL")
        if not r_client_id:
            missing.append("SMOOAI_CONFIG_CLIENT_ID")
        if not r_client_secret:
            missing.append("SMOOAI_CONFIG_CLIENT_SECRET")
        if not r_org_id:
            missing.append("SMOOAI_CONFIG_ORG_ID")
    if not r_environment:
        missing.append("SMOOAI_CONFIG_ENV")

    if missing:
        raise ConfigBootstrapError(missing)

    return _ResolvedEnv(
        api_url=r_api_url or "",
        auth_url=r_auth_url,
        client_id=r_client_id or "",
        client_secret=r_client_secret or "",
        org_id=r_org_id or "",
        environment=r_environment or "",
    )


# --- The handle --------------------------------------------------------------


class _TierAccessor:
    """Exposes ``get`` (async-semantics network read) + ``get_sync`` (cache-only)
    for one tier (public / secret / feature_flag), both fail-loud (§3).
    """

    def __init__(self, handle: ContainerConfigHandle, tier: str) -> None:
        self._handle = handle
        self._tier = tier

    def get(self, key: str) -> Any:
        """Resolve a key through the env → http tiers; raise
        :class:`ConfigKeyUnresolvedError` for a required key that resolves
        absent. Optional keys return ``None``.
        """
        return self._handle._get(key, self._tier)

    def get_sync(self, key: str) -> Any:
        """Resolve a key from the env tier + the local cache only (no network);
        raise :class:`ConfigKeyUnresolvedError` for a required key that
        resolves absent. Optional keys return ``None``.
        """
        return self._handle._get_sync(key, self._tier)


class ContainerConfigHandle:
    """The handle returned by :func:`init_container_config`.

    Exposes the same tier accessors as the baked runtime (``get`` + cache-only
    ``get_sync``) but with §3 fail-loud behavior, plus a non-throwing
    :meth:`health` for Kubernetes readiness/liveness probes.
    """

    def __init__(
        self,
        *,
        client: ConfigClient,
        environment: str,
        cache_ttl_ms: int,
        optional_keys: Iterable[str],
    ) -> None:
        self._client = client
        self._environment = environment
        self._cache_ttl_seconds = cache_ttl_ms / 1000.0
        self._optional_keys: set[str] = set(optional_keys)

        # Health state (§5): once an initial fetch succeeds we serve last-good
        # on a later background refresh failure until the cache TTL hard-expires.
        self._last_fetch_ok = False
        self._last_fetch_at = 0.0
        self._last_error: str | None = None

        self.public_config = _TierAccessor(self, "public")
        self.secret_config = _TierAccessor(self, "secret")
        self.feature_flag = _TierAccessor(self, "feature_flag")

    @property
    def client(self) -> ConfigClient:
        """The underlying :class:`ConfigClient` (escape hatch for advanced
        callers).
        """
        return self._client

    def _mark_fetch_ok(self) -> None:
        self._last_fetch_ok = True
        self._last_fetch_at = time.monotonic()
        self._last_error = None

    def _is_optional(self, key: str) -> bool:
        return key in self._optional_keys

    def _resolve(self, key: str) -> tuple[Any, list[ConfigTier]]:
        """Async-style tier read. Order matches the existing chain's env-over-http
        precedence: an explicit process env var wins, else the HTTP value. The
        blob/file tiers are disabled in container mode (§2).
        """
        tried: list[ConfigTier] = ["env"]
        from_env = _read_env(camel_to_upper_snake(key))
        if _is_set(from_env):
            # Seed the cache so a later get_sync sees the override too.
            self._client.seed_cache_from_map({key: from_env}, environment=self._environment)
            return from_env, tried

        tried.append("http")
        try:
            value = self._client.get_value(key, environment=self._environment)
            self._mark_fetch_ok()
            if _is_set(value):
                return value, tried
            return None, tried
        except Exception as err:  # noqa: BLE001 — surface as health signal, serve last-good.
            self._last_error = str(err)
            # §5: serve last-good from cache until TTL hard-expiry.
            cached = self._client.get_cached_value(key, environment=self._environment)
            if _is_set(cached):
                logger.warning(
                    "container config: HTTP refresh failed for key %r; serving last-good cached value (%s)",
                    key,
                    err,
                )
                return cached, tried
            return None, tried

    def _sync_resolve(self, key: str) -> tuple[Any, list[ConfigTier]]:
        tried: list[ConfigTier] = ["env"]
        from_env = _read_env(camel_to_upper_snake(key))
        if _is_set(from_env):
            return from_env, tried
        tried.append("http")
        cached = self._client.get_cached_value(key, environment=self._environment)
        return cached, tried

    def _get(self, key: str, tier: str) -> Any:
        _assert_key(key, tier)
        value, tried = self._resolve(key)
        if _is_set(value):
            return value
        if self._is_optional(key):
            return None
        raise ConfigKeyUnresolvedError(key=key, env=self._environment, tried_tiers=tried)

    def _get_sync(self, key: str, tier: str) -> Any:
        _assert_key(key, tier)
        value, tried = self._sync_resolve(key)
        if _is_set(value):
            return value
        if self._is_optional(key):
            return None
        raise ConfigKeyUnresolvedError(key=key, env=self._environment, tried_tiers=tried)

    def health(self) -> ConfigHealth:
        """Cheap, non-throwing status for readiness/liveness probes (§4).

        Healthy once the initial fetch succeeded. A background refresh failure
        serves healthy while within the cache TTL window of the last good
        fetch; past the hard TTL a failed refresh flips unhealthy (§5).
        """
        if not self._last_fetch_ok:
            return ConfigHealth(
                status="unhealthy",
                reason=self._last_error or "initial config fetch has not succeeded",
            )
        age = time.monotonic() - self._last_fetch_at
        if self._last_error is not None and age > self._cache_ttl_seconds:
            return ConfigHealth(
                status="unhealthy",
                reason=(
                    f"last config refresh failed and cache TTL "
                    f"({int(self._cache_ttl_seconds * 1000)}ms) expired: {self._last_error}"
                ),
            )
        return ConfigHealth(status="healthy")


def _assert_key(key: Any, tier: str) -> None:
    if isinstance(key, str) and key:
        return
    kind = "None" if key is None else f"non-string ({type(key).__name__})"
    raise ValueError(
        f"smooai_config (container): {tier}_config called with {kind} key. Most common "
        f"cause: reading a key not declared in your schema."
    )


# --- init_container_config (§4) ----------------------------------------------


def init_container_config(
    *,
    schema: ConfigDefinition,
    api_url: str | None = None,
    auth_url: str | None = None,
    client_id: str | None = None,
    client_secret: str | None = None,
    org_id: str | None = None,
    environment: str | None = None,
    cache_ttl_ms: int = DEFAULT_CACHE_TTL_MS,
    token_refresh_buffer_seconds: float = DEFAULT_TOKEN_REFRESH_BUFFER_SECONDS,
    optional_keys: Sequence[str] | None = None,
    config_client: ConfigClient | None = None,
    token_provider: TokenProvider | None = None,
) -> ContainerConfigHandle:
    """Explicit container-mode bootstrap (§4).

    Validates the §1 env, constructs the M2M
    :class:`~smooai_config.token_provider.TokenProvider` +
    :class:`~smooai_config.client.ConfigClient`, and performs an **initial
    token mint + config fetch** so auth/network failures surface at startup,
    not on first read. Returns a :class:`ContainerConfigHandle` whose accessors
    are fail-loud (§3).

    Explicit args override the corresponding env vars. When ``config_client``
    is injected, only ``SMOOAI_CONFIG_ENV`` is env-required (the client already
    carries the rest).

    The schema makes every key optional (no required/optional metadata), so
    **container mode treats all schema-declared keys as REQUIRED by default**;
    pass ``optional_keys`` to opt specific keys out. This matches the TS
    reference's design fork.

    Args:
        schema: The :func:`~smooai_config.schema.define_config` result. Required.
        cache_ttl_ms: Config value cache TTL in ms. Default
            :data:`DEFAULT_CACHE_TTL_MS` (30s).
        token_refresh_buffer_seconds: Seconds before token expiry to refresh.
            Default :data:`DEFAULT_TOKEN_REFRESH_BUFFER_SECONDS` (60s).
        optional_keys: Keys allowed to be absent (return ``None`` instead of
            raising).
        config_client: Test/embedding seam — inject a pre-built ConfigClient.
        token_provider: Test/embedding seam — inject a pre-built TokenProvider.

    Raises:
        ConfigBootstrapError: When container-required env is missing/blank.
        Exception: On auth/network failure during the initial token mint or
            fetch.
    """
    if schema is None:
        raise ConfigBootstrapError(["schema"])

    env = _resolve_and_validate_env(
        api_url=api_url,
        auth_url=auth_url,
        client_id=client_id,
        client_secret=client_secret,
        org_id=org_id,
        environment=environment,
        client_injected=config_client is not None,
    )

    cache_ttl_seconds = cache_ttl_ms / 1000.0

    # Build the ConfigClient. When the caller injects one (test/embedding seam)
    # it already carries its own TokenProvider, so we don't build a second one
    # (env creds may be empty in that path).
    if config_client is not None:
        client = config_client
    else:
        provider = token_provider or TokenProvider(
            auth_url=env.auth_url,
            client_id=env.client_id,
            client_secret=env.client_secret,
            refresh_window_seconds=token_refresh_buffer_seconds,
        )
        client = ConfigClient(
            base_url=env.api_url,
            org_id=env.org_id,
            environment=env.environment,
            cache_ttl_seconds=cache_ttl_seconds,
            token_provider=provider,
        )

    handle = ContainerConfigHandle(
        client=client,
        environment=env.environment,
        cache_ttl_ms=cache_ttl_ms,
        optional_keys=optional_keys or [],
    )

    # Initial config fetch — fail loud at startup, not first read. The OAuth
    # token mint happens inside get_all_values (the ConfigClient's
    # TokenProvider exchanges on the first authed request), so an auth failure
    # surfaces here too. A pod that can't reach the config server should
    # CrashLoop visibly, not start degraded.
    try:
        client.get_all_values(environment=env.environment)
        handle._mark_fetch_ok()
    except Exception as err:
        handle._last_error = str(err)
        raise

    return handle


def config_health(handle: ContainerConfigHandle) -> ConfigHealth:
    """Standalone health check (§4) for a handle.

    Exposed both as ``handle.health()`` and as this free function for call
    sites that prefer the functional form. Never raises.
    """
    try:
        return handle.health()
    except Exception as err:  # noqa: BLE001 — health must never raise.
        return ConfigHealth(status="unhealthy", reason=str(err))


# --- Mode selection (§2) -----------------------------------------------------


@dataclass
class SelectModeInputs:
    """Inputs for :func:`select_mode`. Each defaults to the matching env var."""

    mode: str | None = None
    client_id: str | None = None
    client_secret: str | None = None
    api_url: str | None = None
    blob_present: bool | None = None
    file_present: bool | None = None


_auto_select_logged = False


def select_mode(inputs: SelectModeInputs | None = None) -> ConfigMode:
    """Mode selection (§2). Resolution order:

    1. ``SMOOAI_CONFIG_MODE=container`` → container mode (explicit).
    2. else if a blob/file source is present → ``default`` (Lambda/local).
    3. else if CLIENT_ID + CLIENT_SECRET + API_URL all set → container (auto;
       logs once that container mode was auto-selected).
    4. else → ``default``.

    Container mode MUST NOT silently degrade to the file tier — that decision
    is enforced by :func:`init_container_config`'s bootstrap validation; this
    only decides which mode to enter.
    """
    global _auto_select_logged
    i = inputs or SelectModeInputs()

    mode = _non_blank(i.mode) or _non_blank(_read_env("SMOOAI_CONFIG_MODE"))
    if mode is not None and mode.lower() == "container":
        return "container"

    blob_present = i.blob_present
    if blob_present is None:
        blob_present = _is_set(_read_env("SMOO_CONFIG_KEY")) and _is_set(_read_env("SMOO_CONFIG_KEY_FILE"))
    file_present = i.file_present if i.file_present is not None else False
    if blob_present or file_present:
        return "default"

    r_client_id = _non_blank(i.client_id) or _non_blank(_read_env("SMOOAI_CONFIG_CLIENT_ID"))
    r_client_secret = (
        _non_blank(i.client_secret)
        or _non_blank(_read_env("SMOOAI_CONFIG_CLIENT_SECRET"))
        or _non_blank(_read_env("SMOOAI_CONFIG_API_KEY"))
    )
    r_api_url = _non_blank(i.api_url) or _non_blank(_read_env("SMOOAI_CONFIG_API_URL"))

    if r_client_id and r_client_secret and r_api_url:
        if not _auto_select_logged:
            _auto_select_logged = True
            logger.info(
                "smooai_config: container mode auto-selected (CLIENT_ID + CLIENT_SECRET + "
                "API_URL set, no blob/file source present)"
            )
        return "container"
    return "default"


def _reset_select_mode_log_for_tests() -> None:
    """Test-only: reset the once-per-process auto-select log latch."""
    global _auto_select_logged
    _auto_select_logged = False
