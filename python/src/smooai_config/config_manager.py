"""Unified configuration manager merging file, remote, and env sources."""

import os
import sys
import threading
import time
from typing import Any

from smooai_config.client import ConfigClient
from smooai_config.env_config import find_and_process_env_config
from smooai_config.file_config import find_and_process_file_config
from smooai_config.merge import merge_replace_arrays


class ConfigManager:
    """Unified config manager that merges three sources in precedence order.

    Merge precedence (highest to lowest):
    1. Env vars -- always win
    2. Remote API -- authoritative env-specific values from server
    3. File config -- base defaults from JSON files

    Thread-safe. Lazy initialization loads and merges all sources on first access.
    Per-key caches with configurable TTL for each tier (public, secret, feature_flag).
    """

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        org_id: str | None = None,
        environment: str | None = None,
        schema_keys: set[str] | None = None,
        env_prefix: str = "",
        schema_types: dict[str, str] | None = None,
        cache_ttl: float = 86400,  # 24 hours
        env: dict[str, str] | None = None,
    ) -> None:
        self._lock = threading.RLock()
        self._initialized = False
        self._config: dict[str, Any] = {}
        self._public_cache: dict[str, tuple[Any, float]] = {}
        self._secret_cache: dict[str, tuple[Any, float]] = {}
        self._feature_flag_cache: dict[str, tuple[Any, float]] = {}
        self._api_key = api_key
        self._base_url = base_url
        self._org_id = org_id
        self._environment = environment
        self._schema_keys = schema_keys
        self._env_prefix = env_prefix
        self._schema_types = schema_types
        self._cache_ttl = cache_ttl
        self._env = env

    def _resolve_env_var(self, key: str) -> str | None:
        """Resolve an environment variable from the configured env dict or os.environ."""
        if self._env is not None:
            return self._env.get(key)
        return os.environ.get(key)

    def _initialize(self) -> None:
        """Lazy init: load file config, remote config, and env config, then merge."""
        if self._initialized:
            return

        # 1. Load file config
        file_config = find_and_process_file_config(
            schema_keys=self._schema_keys,
            env=self._env,
        )

        # 2. Load env config
        env_config = find_and_process_env_config(
            schema_keys=self._schema_keys or set(),
            prefix=self._env_prefix,
            schema_types=self._schema_types,
            env=self._env,
        )

        # 3. Try remote fetch if API creds available
        remote_config: dict[str, Any] = {}
        api_key = self._api_key or self._resolve_env_var("SMOOAI_CONFIG_API_KEY")
        base_url = self._base_url or self._resolve_env_var("SMOOAI_CONFIG_API_URL")
        org_id = self._org_id or self._resolve_env_var("SMOOAI_CONFIG_ORG_ID")

        if api_key and base_url and org_id:
            # Resolve environment: explicit param > env var > default "development"
            resolved_environment = self._environment or self._resolve_env_var("SMOOAI_CONFIG_ENV") or "development"

            try:
                client = ConfigClient(
                    base_url=base_url,
                    api_key=api_key,
                    org_id=org_id,
                    environment=resolved_environment,
                )
                try:
                    remote_config = client.get_all_values()
                finally:
                    client.close()
            except Exception as exc:
                print(
                    f"[Smooai Config] Warning: Failed to fetch remote config: {exc}",
                    file=sys.stderr,
                )

        # 4. Merge: file < remote < env
        merged: dict[str, Any] = merge_replace_arrays({}, file_config)
        merged = merge_replace_arrays(merged, remote_config)
        merged = merge_replace_arrays(merged, env_config)
        self._config = merged
        self._initialized = True

    def _get_from_cache(self, cache: dict[str, tuple[Any, float]], key: str) -> tuple[bool, Any]:
        """Get value from TTL cache. Returns (hit, value)."""
        if key in cache:
            value, expires_at = cache[key]
            if time.time() < expires_at:
                return True, value
            del cache[key]
        return False, None

    def _set_cache(self, cache: dict[str, tuple[Any, float]], key: str, value: Any) -> None:
        """Set value in TTL cache."""
        cache[key] = (value, time.time() + self._cache_ttl)

    def _get_value(self, key: str, cache: dict[str, tuple[Any, float]]) -> Any | None:
        """Get config value from merged config with per-tier caching."""
        with self._lock:
            hit, value = self._get_from_cache(cache, key)
            if hit:
                return value

            self._initialize()

            value = self._config.get(key)
            self._set_cache(cache, key, value)
            return value

    def get_public_config(self, key: str) -> Any | None:
        """Retrieve a public config value."""
        return self._get_value(key, self._public_cache)

    def get_secret_config(self, key: str) -> Any | None:
        """Retrieve a secret config value."""
        return self._get_value(key, self._secret_cache)

    def get_feature_flag(self, key: str) -> Any | None:
        """Retrieve a feature flag value."""
        return self._get_value(key, self._feature_flag_cache)

    def invalidate(self) -> None:
        """Clear all caches and force re-initialization on next access."""
        with self._lock:
            self._initialized = False
            self._config = {}
            self._public_cache.clear()
            self._secret_cache.clear()
            self._feature_flag_cache.clear()
