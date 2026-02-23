"""Runtime configuration client for fetching values from the Smoo AI server.

Environment variables (used as defaults when constructor args are omitted):
    SMOOAI_CONFIG_API_URL  — Base URL of the config API
    SMOOAI_CONFIG_API_KEY  — Bearer token for authentication
    SMOOAI_CONFIG_ORG_ID   — Organization ID
    SMOOAI_CONFIG_ENV      — Default environment name (e.g. "production")
"""

import os
from typing import Any

import httpx


class ConfigClient:
    """Client for reading configuration values from the Smoo AI config server.

    All constructor arguments are optional if the corresponding environment
    variables are set (SMOOAI_CONFIG_API_URL, SMOOAI_CONFIG_API_KEY,
    SMOOAI_CONFIG_ORG_ID, SMOOAI_CONFIG_ENV).
    """

    def __init__(
        self,
        *,
        base_url: str | None = None,
        api_key: str | None = None,
        org_id: str | None = None,
        environment: str | None = None,
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
        self._cache: dict[str, Any] = {}

    def get_value(self, key: str, *, environment: str | None = None) -> Any:
        """Get a single config value."""
        env = environment or self._default_environment
        cache_key = f"{env}:{key}"
        if cache_key in self._cache:
            return self._cache[cache_key]

        response = self._client.get(
            f"/organizations/{self._org_id}/config/values/{key}",
            params={"environment": env},
        )
        response.raise_for_status()
        value = response.json().get("value")
        self._cache[cache_key] = value
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
        for key, value in values.items():
            self._cache[f"{env}:{key}"] = value
        return values

    def invalidate_cache(self) -> None:
        """Clear the local cache."""
        self._cache.clear()

    def close(self) -> None:
        """Close the HTTP client."""
        self._client.close()

    def __enter__(self) -> "ConfigClient":
        return self

    def __exit__(self, *args: object) -> None:
        self.close()
