"""Local configuration manager with lazy init and multi-tier TTL caching."""

import threading
import time
from typing import Any

from smooai_config.env_config import find_and_process_env_config
from smooai_config.file_config import find_and_process_file_config


class LocalConfigManager:
    """Main entry point for local config with lazy init and multi-tier TTL caching.

    Thread-safe. Lazy initialization loads file config + env config on first access.
    Per-key caches with 24h TTL for each tier (public, secret, feature_flag).
    File config takes precedence over env config.
    """

    def __init__(
        self,
        *,
        schema_keys: set[str] | None = None,
        env_prefix: str = "",
        schema_types: dict[str, str] | None = None,
        cache_ttl: float = 86400,  # 24 hours
        env: dict[str, str] | None = None,
    ) -> None:
        self._lock = threading.RLock()
        self._initialized = False
        self._file_config: dict[str, Any] | None = None
        self._env_config: dict[str, Any] | None = None
        self._public_cache: dict[str, tuple[Any, float]] = {}
        self._secret_cache: dict[str, tuple[Any, float]] = {}
        self._feature_flag_cache: dict[str, tuple[Any, float]] = {}
        self._schema_keys = schema_keys
        self._env_prefix = env_prefix
        self._schema_types = schema_types
        self._cache_ttl = cache_ttl
        self._env = env

    def _initialize(self) -> None:
        """Lazy init: load file and env configs."""
        if self._initialized:
            return
        self._file_config = find_and_process_file_config(
            schema_keys=self._schema_keys,
            env=self._env,
        )
        self._env_config = find_and_process_env_config(
            schema_keys=self._schema_keys or set(),
            prefix=self._env_prefix,
            schema_types=self._schema_types,
            env=self._env,
        )
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
        """Get config value. File config takes precedence over env config."""
        with self._lock:
            hit, value = self._get_from_cache(cache, key)
            if hit:
                return value

            self._initialize()

            if self._file_config is not None and key in self._file_config:
                val = self._file_config[key]
                self._set_cache(cache, key, val)
                return val

            if self._env_config is not None and key in self._env_config:
                val = self._env_config[key]
                self._set_cache(cache, key, val)
                return val

            return None

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
            self._file_config = None
            self._env_config = None
            self._public_cache.clear()
            self._secret_cache.clear()
            self._feature_flag_cache.clear()
