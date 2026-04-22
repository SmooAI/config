"""Runtime configuration client for fetching values from the Smoo AI server.

Environment variables (used as defaults when constructor args are omitted):
    SMOOAI_CONFIG_API_URL  — Base URL of the config API
    SMOOAI_CONFIG_API_KEY  — Bearer token for authentication
    SMOOAI_CONFIG_ORG_ID   — Organization ID
    SMOOAI_CONFIG_ENV      — Default environment name (e.g. "production")
"""

import os
import threading
import time
from typing import Any, Literal
from urllib.parse import quote

import httpx
from pydantic import BaseModel, Field

from smooai_config.utils import SmooaiConfigError


class ConfigClient:
    """Client for reading configuration values from the Smoo AI config server.

    All constructor arguments are optional if the corresponding environment
    variables are set (SMOOAI_CONFIG_API_URL, SMOOAI_CONFIG_API_KEY,
    SMOOAI_CONFIG_ORG_ID, SMOOAI_CONFIG_ENV).

    Thread-safe: all cache operations are protected by an RLock.
    """

    def __init__(
        self,
        *,
        base_url: str | None = None,
        api_key: str | None = None,
        org_id: str | None = None,
        environment: str | None = None,
        cache_ttl_seconds: float = 0,
    ) -> None:
        resolved_base_url = base_url or os.environ.get("SMOOAI_CONFIG_API_URL")
        resolved_api_key = api_key or os.environ.get("SMOOAI_CONFIG_API_KEY")
        resolved_org_id = org_id or os.environ.get("SMOOAI_CONFIG_ORG_ID")

        if not resolved_base_url:
            raise ValueError("base_url is required (or set SMOOAI_CONFIG_API_URL)")
        if not resolved_api_key:
            raise ValueError("api_key is required (or set SMOOAI_CONFIG_API_KEY)")
        if not resolved_org_id:
            raise ValueError("org_id is required (or set SMOOAI_CONFIG_ORG_ID)")

        self._base_url = resolved_base_url.rstrip("/")
        self._org_id = resolved_org_id
        self._default_environment = environment or os.environ.get("SMOOAI_CONFIG_ENV", "development")
        self._headers = {"Authorization": f"Bearer {resolved_api_key}"}
        self._client = httpx.Client(base_url=self._base_url, headers=self._headers)
        self._cache: dict[str, tuple[Any, float]] = {}  # key → (value, expires_at)
        self._cache_ttl_seconds = cache_ttl_seconds
        self._lock = threading.RLock()

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

    def get_value(self, key: str, *, environment: str | None = None) -> Any:
        """Get a single config value."""
        env = environment or self._default_environment
        cache_key = f"{env}:{key}"

        found, value = self._get_cached(cache_key)
        if found:
            return value

        response = self._client.get(
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
        response = self._client.get(
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
        """Evaluate a cohort-aware feature flag against the server.

        Unlike :meth:`get_value` / the local cache, this is always a network
        call: cohort rules (percentage rollout, attribute matching, bucketing)
        live server-side and the response depends on the ``context`` passed.
        Callers that don't need cohort evaluation should keep using
        :meth:`get_value` for the static flag value.

        Args:
            key: Feature-flag key.
            context: Attributes the server's cohort rules may reference
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
        response = self._client.post(
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
        """Close the HTTP client."""
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
