"""Tests for LocalConfigManager."""

import json
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from smooai_config.file_config import _clear_config_dir_cache
from smooai_config.local import LocalConfigManager


@pytest.fixture(autouse=True)
def _clear_cache() -> None:
    _clear_config_dir_cache()


def _make_config_dir(tmp_path: Path, configs: dict[str, dict]) -> str:
    """Create a config dir with JSON files."""
    config_dir = tmp_path / ".smooai-config"
    config_dir.mkdir()
    for filename, data in configs.items():
        with open(config_dir / filename, "w") as f:
            json.dump(data, f)
    return str(config_dir)


class TestLocalConfigManager:
    def test_lazy_initialization(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {"API_URL": "http://localhost"}})
        mgr = LocalConfigManager(env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"})
        # Not initialized until first access
        assert mgr._initialized is False
        mgr.get_public_config("API_URL")
        assert mgr._initialized is True

    def test_get_public_config(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {"API_URL": "http://localhost", "MAX_RETRIES": 3}})
        mgr = LocalConfigManager(env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"})
        assert mgr.get_public_config("API_URL") == "http://localhost"
        assert mgr.get_public_config("MAX_RETRIES") == 3

    def test_get_secret_config(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {"API_KEY": "secret-key"}})
        mgr = LocalConfigManager(env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"})
        assert mgr.get_secret_config("API_KEY") == "secret-key"

    def test_get_feature_flag(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {"ENABLE_NEW_UI": True}})
        mgr = LocalConfigManager(env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"})
        assert mgr.get_feature_flag("ENABLE_NEW_UI") is True

    def test_returns_none_for_missing_key(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {"API_URL": "test"}})
        mgr = LocalConfigManager(env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"})
        assert mgr.get_public_config("NONEXISTENT") is None

    def test_caching_returns_same_value(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {"API_URL": "http://localhost"}})
        mgr = LocalConfigManager(env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"})
        v1 = mgr.get_public_config("API_URL")
        v2 = mgr.get_public_config("API_URL")
        assert v1 == v2

    def test_cache_ttl_expiration(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {"API_URL": "http://localhost"}})
        mgr = LocalConfigManager(
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"},
            cache_ttl=0.1,  # 100ms TTL
        )
        mgr.get_public_config("API_URL")
        assert "API_URL" in mgr._public_cache

        # Wait for cache to expire
        time.sleep(0.15)

        # Cache entry expired, but re-fetches from file config
        result = mgr.get_public_config("API_URL")
        assert result == "http://localhost"

    def test_invalidate_clears_everything(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {"API_URL": "http://localhost"}})
        mgr = LocalConfigManager(env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"})
        mgr.get_public_config("API_URL")
        assert mgr._initialized is True

        mgr.invalidate()
        assert mgr._initialized is False
        assert len(mgr._public_cache) == 0
        assert len(mgr._secret_cache) == 0
        assert len(mgr._feature_flag_cache) == 0

    def test_invalidate_allows_reinitialization(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {"API_URL": "http://localhost"}})
        mgr = LocalConfigManager(env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"})
        mgr.get_public_config("API_URL")
        mgr.invalidate()

        # Should re-initialize on next access
        result = mgr.get_public_config("API_URL")
        assert result == "http://localhost"
        assert mgr._initialized is True

    def test_file_config_takes_precedence_over_env(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {"API_URL": "from-file"}})
        mgr = LocalConfigManager(
            schema_keys={"API_URL"},
            env={
                "SMOOAI_ENV_CONFIG_DIR": config_dir,
                "SMOOAI_CONFIG_ENV": "test",
                "API_URL": "from-env",
            },
        )
        assert mgr.get_public_config("API_URL") == "from-file"

    def test_falls_back_to_env_config(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {"OTHER": "value"}})
        mgr = LocalConfigManager(
            schema_keys={"API_URL"},
            env={
                "SMOOAI_ENV_CONFIG_DIR": config_dir,
                "SMOOAI_CONFIG_ENV": "test",
                "API_URL": "from-env",
            },
        )
        assert mgr.get_public_config("API_URL") == "from-env"

    def test_separate_tier_caches(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(
            tmp_path,
            {"default.json": {"SHARED_KEY": "value"}},
        )
        mgr = LocalConfigManager(env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"})

        # Access through different tiers
        mgr.get_public_config("SHARED_KEY")
        mgr.get_secret_config("SHARED_KEY")
        mgr.get_feature_flag("SHARED_KEY")

        # Each tier has its own cache
        assert "SHARED_KEY" in mgr._public_cache
        assert "SHARED_KEY" in mgr._secret_cache
        assert "SHARED_KEY" in mgr._feature_flag_cache

    def test_thread_safety(self, tmp_path: Path) -> None:
        """Test that concurrent access doesn't cause errors."""
        import threading

        config_dir = _make_config_dir(tmp_path, {"default.json": {"API_URL": "http://localhost", "COUNT": 42}})
        mgr = LocalConfigManager(env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"})

        results: list[str | None] = [None] * 10
        errors: list[Exception] = []

        def worker(idx: int) -> None:
            try:
                results[idx] = mgr.get_public_config("API_URL")
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert len(errors) == 0
        assert all(r == "http://localhost" for r in results)
