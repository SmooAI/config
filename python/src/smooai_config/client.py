"""Runtime configuration client for fetching values from the Smoo AI server."""

from typing import Any

import httpx


class ConfigClient:
    """Client for reading configuration values from the Smoo AI config server."""

    def __init__(self, *, base_url: str, api_key: str, org_id: str) -> None:
        self._base_url = base_url.rstrip("/")
        self._org_id = org_id
        self._headers = {"Authorization": f"Bearer {api_key}"}
        self._client = httpx.Client(base_url=self._base_url, headers=self._headers)
        self._cache: dict[str, Any] = {}

    def get_value(self, key: str, *, environment: str) -> Any:
        """Get a single config value."""
        cache_key = f"{environment}:{key}"
        if cache_key in self._cache:
            return self._cache[cache_key]

        response = self._client.get(
            f"/organizations/{self._org_id}/config/values/{key}",
            params={"environment": environment},
        )
        response.raise_for_status()
        value = response.json().get("value")
        self._cache[cache_key] = value
        return value

    def get_all_values(self, *, environment: str) -> dict[str, Any]:
        """Get all config values for an environment."""
        response = self._client.get(
            f"/organizations/{self._org_id}/config/values",
            params={"environment": environment},
        )
        response.raise_for_status()
        values = response.json().get("values", {})
        for key, value in values.items():
            self._cache[f"{environment}:{key}"] = value
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
