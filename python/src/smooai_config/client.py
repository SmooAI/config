"""Runtime configuration client for fetching values from the Smoo AI server.

Authentication uses OAuth2 ``client_credentials`` against
``{auth_url}/token``, mirroring the .NET ``SmooConfigClient``, the
TypeScript ``ConfigClient`` (post-SMOODEV-974), and the in-package
``bootstrap`` module. The exchanged JWT is cached + auto-refreshed by
:class:`TokenProvider`.

Environment variables (used as defaults when constructor args are omitted):

    SMOOAI_CONFIG_API_URL        — Base URL of the config API
    SMOOAI_CONFIG_AUTH_URL       — OAuth issuer base URL (default
                                   ``https://auth.smoo.ai``; legacy
                                   ``SMOOAI_AUTH_URL`` also accepted)
    SMOOAI_CONFIG_CLIENT_ID      — OAuth client ID
    SMOOAI_CONFIG_CLIENT_SECRET  — OAuth client secret (also accepts
                                   the legacy ``SMOOAI_CONFIG_API_KEY``)
    SMOOAI_CONFIG_ORG_ID         — Organization ID
    SMOOAI_CONFIG_ENV            — Default environment name (e.g. ``"production"``)

SMOODEV-975: Previously sent the raw ``SMOOAI_CONFIG_API_KEY`` as the
Bearer token, which the backend rejected with 401. The SDK now mints a
JWT via the OAuth ``client_credentials`` grant before each call.
"""

import os
import threading
import time
from typing import Any, Literal
from urllib.parse import quote

import httpx
from pydantic import BaseModel, Field

from smooai_config.token_provider import TokenProvider
from smooai_config.utils import SmooaiConfigError


class ConfigClient:
    """Client for reading configuration values from the Smoo AI config server.

    All constructor arguments are optional if the corresponding environment
    variables are set. Thread-safe: cache operations are protected by an RLock.

    SMOODEV-975: now requires ``client_id`` in addition to ``client_secret``
    (legacy ``api_key`` accepted as deprecated alias). Constructing without
    ``client_id`` raises :class:`ValueError`.
    """

    def __init__(
        self,
        *,
        base_url: str | None = None,
        auth_url: str | None = None,
        client_id: str | None = None,
        client_secret: str | None = None,
        api_key: str | None = None,  # Deprecated alias for client_secret
        org_id: str | None = None,
        environment: str | None = None,
        cache_ttl_seconds: float = 0,
        token_provider: TokenProvider | None = None,
        http_client: httpx.Client | None = None,
    ) -> None:
        resolved_base_url = base_url or os.environ.get("SMOOAI_CONFIG_API_URL")
        resolved_auth_url = (
            auth_url
            or os.environ.get("SMOOAI_CONFIG_AUTH_URL")
            or os.environ.get("SMOOAI_AUTH_URL")
            or "https://auth.smoo.ai"
        )
        resolved_client_id = client_id or os.environ.get("SMOOAI_CONFIG_CLIENT_ID")
        resolved_client_secret = (
            client_secret
            or api_key
            or os.environ.get("SMOOAI_CONFIG_CLIENT_SECRET")
            or os.environ.get("SMOOAI_CONFIG_API_KEY")
        )
        resolved_org_id = org_id or os.environ.get("SMOOAI_CONFIG_ORG_ID")

        if not resolved_base_url:
            raise ValueError("base_url is required (or set SMOOAI_CONFIG_API_URL)")
        if not resolved_org_id:
            raise ValueError("org_id is required (or set SMOOAI_CONFIG_ORG_ID)")
        if token_provider is None:
            if not resolved_client_id:
                raise ValueError("client_id is required (or set SMOOAI_CONFIG_CLIENT_ID)")
            if not resolved_client_secret:
                raise ValueError(
                    "client_secret is required (or set SMOOAI_CONFIG_CLIENT_SECRET / SMOOAI_CONFIG_API_KEY)"
                )

        self._base_url = resolved_base_url.rstrip("/")
        self._org_id = resolved_org_id
        self._default_environment = environment or os.environ.get("SMOOAI_CONFIG_ENV", "development")
        self._client = http_client or httpx.Client(base_url=self._base_url)
        self._owns_http_client = http_client is None
        self._cache: dict[str, tuple[Any, float]] = {}  # key → (value, expires_at)
        self._cache_ttl_seconds = cache_ttl_seconds
        self._lock = threading.RLock()
        self._token_provider = token_provider or TokenProvider(
            auth_url=resolved_auth_url,
            client_id=resolved_client_id,  # type: ignore[arg-type]  # guarded above
            client_secret=resolved_client_secret,  # type: ignore[arg-type]  # guarded above
            http_client=self._client,
        )

    def _compute_expires_at(self) -> float:
        """Compute expiration timestamp. 0.0 means no expiry."""
        if self._cache_ttl_seconds > 0:
            return time.monotonic() + self._cache_ttl_seconds
        return 0.0

    def _get_cached(self, cache_key: str) -> tuple[bool, Any]:
        """Thread-safe cache lookup. Returns (found, value)."""
        with self._lock:
            entry = self._cache.get(cache_key)
            if entry is None:
                return False, None
            value, expires_at = entry
            if expires_at > 0 and time.monotonic() > expires_at:
                del self._cache[cache_key]
                return False, None
            return True, value

    def _set_cached(self, cache_key: str, value: Any) -> None:
        """Thread-safe cache write."""
        with self._lock:
            self._cache[cache_key] = (value, self._compute_expires_at())

    def _auth_headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._token_provider.get_access_token()}"}

    def _request_with_retry(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        """Issue an HTTP request, retrying once after invalidating the cached
        token on a 401 (handles server-side rotation / revocation).
        """
        headers = dict(kwargs.pop("headers", {}) or {})
        headers.update(self._auth_headers())
        response = self._client.request(method, url, headers=headers, **kwargs)
        if response.status_code == 401:
            self._token_provider.invalidate()
            headers.update(self._auth_headers())
            response = self._client.request(method, url, headers=headers, **kwargs)
        return response

    def get_value(self, key: str, *, environment: str | None = None) -> Any:
        """Get a single config value."""
        env = environment or self._default_environment
        cache_key = f"{env}:{key}"

        found, value = self._get_cached(cache_key)
        if found:
            return value

        response = self._request_with_retry(
            "GET",
            f"/organizations/{self._org_id}/config/values/{key}",
            params={"environment": env},
        )
        response.raise_for_status()
        value = response.json().get("value")
        self._set_cached(cache_key, value)
        return value

    def get_all_values(self, *, environment: str | None = None) -> dict[str, Any]:
        """Get all config values for an environment."""
        env = environment or self._default_environment
        response = self._request_with_retry(
            "GET",
            f"/organizations/{self._org_id}/config/values",
            params={"environment": env},
        )
        response.raise_for_status()
        values = response.json().get("values", {})
        with self._lock:
            expires_at = self._compute_expires_at()
            for key, value in values.items():
                self._cache[f"{env}:{key}"] = (value, expires_at)
        return values

    def seed_cache_from_map(
        self,
        values: dict[str, Any],
        *,
        environment: str | None = None,
    ) -> None:
        """Pre-populate the local cache from an already-fetched map.

        Useful for cold-start hydration from a baked config blob — the caller
        decrypts the blob and feeds the map in, so subsequent ``get_value``
        calls resolve synchronously without hitting the HTTP API. Thread-safe.
        """
        env = environment or self._default_environment
        with self._lock:
            expires_at = self._compute_expires_at()
            for key, value in values.items():
                self._cache[f"{env}:{key}"] = (value, expires_at)

    def invalidate_cache(self) -> None:
        """Clear the entire local cache."""
        with self._lock:
            self._cache.clear()

    def invalidate_cache_for_environment(self, environment: str) -> None:
        """Clear cached values for a specific environment."""
        prefix = f"{environment}:"
        with self._lock:
            keys_to_remove = [k for k in self._cache if k.startswith(prefix)]
            for k in keys_to_remove:
                del self._cache[k]

    def evaluate_feature_flag(
        self,
        key: str,
        context: dict[str, Any] | None = None,
        environment: str | None = None,
    ) -> "EvaluateFeatureFlagResponse":
        """Evaluate a segment-aware feature flag against the server.

        Unlike :meth:`get_value` / the local cache, this is always a network
        call: segment rules (percentage rollout, attribute matching, bucketing)
        live server-side and the response depends on the ``context`` passed.
        Callers that don't need segment evaluation should keep using
        :meth:`get_value` for the static flag value.

        Args:
            key: Feature-flag key.
            context: Attributes the server's segment rules may reference
                (e.g. ``{"userId": ..., "tenantId": ..., "plan": ..., "country": ...}``).
                Unreferenced keys are ignored by the server. Keep values
                JSON-serializable — the server hashes ``bucketBy`` values by
                their string representation, so numbers and booleans bucket
                stably across client rebuilds. Defaults to an empty dict.
            environment: Environment name (defaults to the client's default).

        Raises:
            FeatureFlagNotFoundError: Server returned 404 — flag not defined
                in the org's schema.
            FeatureFlagContextError: Server returned 400 — invalid context or
                missing environment.
            FeatureFlagEvaluationError: Server returned any other non-2xx
                status code.
        """
        env = environment or self._default_environment
        ctx = context if context is not None else {}

        # Match the TS client's `encodeURIComponent` behavior so flag keys
        # containing slashes, spaces, or reserved characters are escaped.
        encoded_key = quote(key, safe="")
        response = self._request_with_retry(
            "POST",
            f"/organizations/{self._org_id}/config/feature-flags/{encoded_key}/evaluate",
            json={"environment": env, "context": ctx},
        )

        if response.status_code == 404:
            raise FeatureFlagNotFoundError(key)
        if response.status_code == 400:
            raise FeatureFlagContextError(key, _safe_text(response))
        if not response.is_success:
            raise FeatureFlagEvaluationError(key, response.status_code, _safe_text(response))

        return EvaluateFeatureFlagResponse.model_validate(response.json())

    def close(self) -> None:
        """Close the HTTP client (if owned by this client)."""
        if self._owns_http_client:
            self._client.close()

    def __enter__(self) -> "ConfigClient":
        return self

    def __exit__(self, *args: object) -> None:
        self.close()


def _safe_text(response: httpx.Response) -> str:
    """Read response body as text, swallowing decode errors."""
    try:
        return response.text
    except Exception:
        return ""


class EvaluateFeatureFlagResponse(BaseModel):
    """Response from the server-side feature-flag evaluator.

    Matches the wire contract defined in ``@smooai/schemas/config/feature-flag``.
    """

    value: Any = None
    """The resolved flag value (post rules + rollout)."""

    matched_rule_id: str | None = Field(default=None, alias="matchedRuleId")
    """Id of the rule that fired, if any."""

    rollout_bucket: int | None = Field(default=None, alias="rolloutBucket")
    """0–99 bucket the context was assigned to, if a rollout ran."""

    source: Literal["raw", "rule", "rollout", "default"]
    """Which branch the evaluator returned from."""

    model_config = {"populate_by_name": True}


class FeatureFlagEvaluationError(SmooaiConfigError):
    """Base class for errors raised by :meth:`ConfigClient.evaluate_feature_flag`.

    Subclasses let callers branch on 404 / 400 / 5xx without parsing messages.
    """

    def __init__(self, key: str, status_code: int, server_message: str | None = None) -> None:
        self.key = key
        self.status_code = status_code
        self.server_message = server_message
        suffix = f" — {server_message}" if server_message else ""
        super().__init__(f'Feature flag "{key}" evaluation failed: HTTP {status_code}{suffix}')


class FeatureFlagNotFoundError(FeatureFlagEvaluationError):
    """Server returned 404 — the flag key is not defined in the org's schema."""

    def __init__(self, key: str) -> None:
        super().__init__(key, 404, "flag not defined in schema")


class FeatureFlagContextError(FeatureFlagEvaluationError):
    """Server returned 400 — invalid context or missing environment."""

    def __init__(self, key: str, server_message: str | None = None) -> None:
        super().__init__(key, 400, server_message or "invalid context or environment")
