"""Tests for ConfigManager — unified config merging file, remote, and env sources."""

import json
import threading
import time
from pathlib import Path
from unittest.mock import patch

import httpx
import pytest

from smooai_config.config_manager import ConfigManager
from smooai_config.file_config import _clear_config_dir_cache

# ---------------------------------------------------------------------------
# Test constants
# ---------------------------------------------------------------------------

TEST_BASE_URL = "https://config-test.smooai.dev"
TEST_API_KEY = "test-api-key-abc123"
TEST_ORG_ID = "550e8400-e29b-41d4-a716-446655440000"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Mock transport helpers
# ---------------------------------------------------------------------------


class RequestLog:
    """Track HTTP requests for verification."""

    def __init__(self) -> None:
        self.requests: list[dict[str, str]] = []

    def clear(self) -> None:
        self.requests.clear()

    @property
    def count(self) -> int:
        return len(self.requests)


def create_mock_transport(
    *,
    values: dict[str, object] | None = None,
    request_log: RequestLog | None = None,
    status_code: int = 200,
) -> httpx.MockTransport:
    """Create a mock transport that returns the given values for get_all_values."""
    response_values = values if values is not None else {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request_log is not None:
            request_log.requests.append(
                {
                    "method": str(request.method),
                    "url": str(request.url),
                    "auth": request.headers.get("authorization", ""),
                }
            )

        if status_code != 200:
            return httpx.Response(status_code, json={"error": "Server error"})

        url_path = request.url.path
        if "/config/values" in url_path and not url_path.endswith("/"):
            # Single value endpoint (has key after /values/)
            parts = url_path.split("/config/values/")
            if len(parts) == 2 and parts[1]:
                key = parts[1]
                val = response_values.get(key)
                if val is not None:
                    return httpx.Response(200, json={"value": val})
                return httpx.Response(404, json={"error": "Not found"})

        # All values endpoint
        if "/config/values" in url_path:
            return httpx.Response(200, json={"values": response_values})

        return httpx.Response(404)

    return httpx.MockTransport(handler)


def _patch_client_transport(manager: ConfigManager, transport: httpx.MockTransport) -> ConfigManager:
    """Monkey-patch the ConfigClient created inside _initialize to use mock transport.

    We achieve this by patching ConfigClient.__init__ to inject the mock transport
    into the httpx.Client it creates.
    """
    original_init = httpx.Client.__init__

    def patched_init(self: httpx.Client, **kwargs: object) -> None:
        kwargs["transport"] = transport  # type: ignore[assignment]
        original_init(self, **kwargs)

    manager._httpx_client_patch = patch.object(httpx.Client, "__init__", patched_init)
    manager._httpx_client_patch.start()
    return manager


# ---------------------------------------------------------------------------
# 1. Local-Only Mode — No API key, works like LocalConfigManager
# ---------------------------------------------------------------------------


class TestLocalOnlyMode:
    def test_works_without_api_credentials(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {"API_URL": "http://localhost:3000"}})
        mgr = ConfigManager(
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"},
        )
        assert mgr.get_public_config("API_URL") == "http://localhost:3000"

    def test_merges_file_and_env_without_remote(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {"API_URL": "from-file", "OTHER": "file-val"}})
        mgr = ConfigManager(
            schema_keys={"API_URL"},
            env={
                "SMOOAI_ENV_CONFIG_DIR": config_dir,
                "SMOOAI_CONFIG_ENV": "test",
                "API_URL": "from-env",
            },
        )
        # Env overrides file for API_URL
        assert mgr.get_public_config("API_URL") == "from-env"
        # File value still available for keys not in env
        assert mgr.get_public_config("OTHER") == "file-val"

    def test_sets_builtin_keys(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {}})
        mgr = ConfigManager(
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "staging"},
        )
        assert mgr.get_public_config("ENV") == "staging"
        assert mgr.get_public_config("IS_LOCAL") is False
        assert mgr.get_public_config("CLOUD_PROVIDER") == "unknown"
        assert mgr.get_public_config("REGION") == "unknown"


# ---------------------------------------------------------------------------
# 2. Remote Enrichment — Mock HTTP returns values, they appear in getters
# ---------------------------------------------------------------------------


class TestRemoteEnrichment:
    def test_remote_values_available_via_getters(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {"LOCAL_KEY": "local-val"}})
        transport = create_mock_transport(values={"REMOTE_KEY": "remote-val"})

        mgr = ConfigManager(
            api_key=TEST_API_KEY,
            base_url=TEST_BASE_URL,
            org_id=TEST_ORG_ID,
            environment="production",
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"},
        )
        _patch_client_transport(mgr, transport)

        try:
            assert mgr.get_public_config("REMOTE_KEY") == "remote-val"
            assert mgr.get_public_config("LOCAL_KEY") == "local-val"
        finally:
            mgr._httpx_client_patch.stop()

    def test_remote_values_available_across_tiers(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {}})
        transport = create_mock_transport(values={"SECRET_VAL": "s3cret", "FLAG": True})

        mgr = ConfigManager(
            api_key=TEST_API_KEY,
            base_url=TEST_BASE_URL,
            org_id=TEST_ORG_ID,
            environment="production",
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"},
        )
        _patch_client_transport(mgr, transport)

        try:
            assert mgr.get_secret_config("SECRET_VAL") == "s3cret"
            assert mgr.get_feature_flag("FLAG") is True
        finally:
            mgr._httpx_client_patch.stop()


# ---------------------------------------------------------------------------
# 3. Merge Precedence — env > remote > file
# ---------------------------------------------------------------------------


class TestMergePrecedence:
    def test_env_wins_over_remote_and_file(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {"KEY": "from-file"}})
        transport = create_mock_transport(values={"KEY": "from-remote"})

        mgr = ConfigManager(
            api_key=TEST_API_KEY,
            base_url=TEST_BASE_URL,
            org_id=TEST_ORG_ID,
            environment="production",
            schema_keys={"KEY"},
            env={
                "SMOOAI_ENV_CONFIG_DIR": config_dir,
                "SMOOAI_CONFIG_ENV": "test",
                "KEY": "from-env",
            },
        )
        _patch_client_transport(mgr, transport)

        try:
            assert mgr.get_public_config("KEY") == "from-env"
        finally:
            mgr._httpx_client_patch.stop()

    def test_remote_wins_over_file(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {"KEY": "from-file"}})
        transport = create_mock_transport(values={"KEY": "from-remote"})

        mgr = ConfigManager(
            api_key=TEST_API_KEY,
            base_url=TEST_BASE_URL,
            org_id=TEST_ORG_ID,
            environment="production",
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"},
        )
        _patch_client_transport(mgr, transport)

        try:
            assert mgr.get_public_config("KEY") == "from-remote"
        finally:
            mgr._httpx_client_patch.stop()

    def test_file_is_base_when_no_remote_or_env(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {"KEY": "from-file"}})
        mgr = ConfigManager(
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"},
        )
        assert mgr.get_public_config("KEY") == "from-file"


# ---------------------------------------------------------------------------
# 4. Nested Object Merge — Remote partial override merges correctly
# ---------------------------------------------------------------------------


class TestNestedObjectMerge:
    def test_remote_partial_override_deep_merges_with_file(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(
            tmp_path,
            {"default.json": {"DATABASE": {"host": "localhost", "port": 5432, "ssl": False}}},
        )
        transport = create_mock_transport(values={"DATABASE": {"host": "remote-db.example.com", "ssl": True}})

        mgr = ConfigManager(
            api_key=TEST_API_KEY,
            base_url=TEST_BASE_URL,
            org_id=TEST_ORG_ID,
            environment="production",
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"},
        )
        _patch_client_transport(mgr, transport)

        try:
            db = mgr.get_public_config("DATABASE")
            assert db is not None
            assert db["host"] == "remote-db.example.com"  # remote overrides
            assert db["ssl"] is True  # remote overrides
            assert db["port"] == 5432  # file provides base
        finally:
            mgr._httpx_client_patch.stop()

    def test_env_overrides_nested_remote(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(
            tmp_path,
            {"default.json": {"DATABASE": {"host": "localhost", "port": 5432}}},
        )
        transport = create_mock_transport(values={"DATABASE": {"host": "remote-db"}})

        mgr = ConfigManager(
            api_key=TEST_API_KEY,
            base_url=TEST_BASE_URL,
            org_id=TEST_ORG_ID,
            environment="production",
            schema_keys={"DATABASE"},
            schema_types={"DATABASE": "json"},
            env={
                "SMOOAI_ENV_CONFIG_DIR": config_dir,
                "SMOOAI_CONFIG_ENV": "test",
                "DATABASE": '{"host": "env-db"}',
            },
        )
        _patch_client_transport(mgr, transport)

        try:
            db = mgr.get_public_config("DATABASE")
            assert db is not None
            # Env provides {"host": "env-db"} which deep-merges over remote+file
            assert db["host"] == "env-db"
            assert db["port"] == 5432  # from file (not overridden)
        finally:
            mgr._httpx_client_patch.stop()


# ---------------------------------------------------------------------------
# 5. Graceful Degradation — Server returns 500
# ---------------------------------------------------------------------------


class TestGracefulDegradationServerError:
    def test_falls_back_to_local_on_500(self, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {"API_URL": "local-fallback"}})
        transport = create_mock_transport(status_code=500)

        mgr = ConfigManager(
            api_key=TEST_API_KEY,
            base_url=TEST_BASE_URL,
            org_id=TEST_ORG_ID,
            environment="production",
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"},
        )
        _patch_client_transport(mgr, transport)

        try:
            assert mgr.get_public_config("API_URL") == "local-fallback"
            captured = capsys.readouterr()
            assert "Warning: Failed to fetch remote config" in captured.err
        finally:
            mgr._httpx_client_patch.stop()


# ---------------------------------------------------------------------------
# 6. Graceful Degradation — Connection refused
# ---------------------------------------------------------------------------


class TestGracefulDegradationConnectionRefused:
    def test_falls_back_to_local_on_connection_error(self, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {"API_URL": "local-fallback"}})

        def error_handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("Connection refused")

        transport = httpx.MockTransport(error_handler)

        mgr = ConfigManager(
            api_key=TEST_API_KEY,
            base_url=TEST_BASE_URL,
            org_id=TEST_ORG_ID,
            environment="production",
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"},
        )
        _patch_client_transport(mgr, transport)

        try:
            assert mgr.get_public_config("API_URL") == "local-fallback"
            captured = capsys.readouterr()
            assert "Warning: Failed to fetch remote config" in captured.err
        finally:
            mgr._httpx_client_patch.stop()


# ---------------------------------------------------------------------------
# 7. Three Tiers Independent — Each tier has its own cache
# ---------------------------------------------------------------------------


class TestThreeTiersIndependent:
    def test_each_tier_has_own_cache(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {"SHARED_KEY": "value"}})
        mgr = ConfigManager(
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"},
        )

        mgr.get_public_config("SHARED_KEY")
        mgr.get_secret_config("SHARED_KEY")
        mgr.get_feature_flag("SHARED_KEY")

        assert "SHARED_KEY" in mgr._public_cache
        assert "SHARED_KEY" in mgr._secret_cache
        assert "SHARED_KEY" in mgr._feature_flag_cache

    def test_clearing_one_tier_does_not_affect_others(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {"KEY": "val"}})
        mgr = ConfigManager(
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"},
        )

        mgr.get_public_config("KEY")
        mgr.get_secret_config("KEY")
        mgr.get_feature_flag("KEY")

        # Manually clear public cache
        mgr._public_cache.clear()

        assert "KEY" not in mgr._public_cache
        assert "KEY" in mgr._secret_cache
        assert "KEY" in mgr._feature_flag_cache


# ---------------------------------------------------------------------------
# 8. Cache Behavior — Second call returns cached, invalidate clears
# ---------------------------------------------------------------------------


class TestCacheBehavior:
    def test_second_call_returns_cached(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {"API_URL": "http://localhost"}})
        mgr = ConfigManager(
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"},
        )
        v1 = mgr.get_public_config("API_URL")
        v2 = mgr.get_public_config("API_URL")
        assert v1 == v2 == "http://localhost"

    def test_cache_respects_ttl(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {"API_URL": "http://localhost"}})
        mgr = ConfigManager(
            cache_ttl=0.1,  # 100ms TTL
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"},
        )
        mgr.get_public_config("API_URL")
        assert "API_URL" in mgr._public_cache

        # Wait for cache to expire
        time.sleep(0.15)

        # Cache entry expired, but re-fetches from merged config
        result = mgr.get_public_config("API_URL")
        assert result == "http://localhost"

    def test_invalidate_clears_all_caches(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {"KEY": "val"}})
        mgr = ConfigManager(
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"},
        )
        mgr.get_public_config("KEY")
        mgr.get_secret_config("KEY")
        mgr.get_feature_flag("KEY")
        assert mgr._initialized is True

        mgr.invalidate()
        assert mgr._initialized is False
        assert len(mgr._public_cache) == 0
        assert len(mgr._secret_cache) == 0
        assert len(mgr._feature_flag_cache) == 0

    def test_invalidate_allows_reinitialization(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {"API_URL": "http://localhost"}})
        mgr = ConfigManager(
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"},
        )
        mgr.get_public_config("API_URL")
        mgr.invalidate()

        result = mgr.get_public_config("API_URL")
        assert result == "http://localhost"
        assert mgr._initialized is True

    def test_caches_none_for_missing_keys(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {"KEY": "val"}})
        mgr = ConfigManager(
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"},
        )
        result = mgr.get_public_config("NONEXISTENT")
        assert result is None
        # None is cached
        assert "NONEXISTENT" in mgr._public_cache


# ---------------------------------------------------------------------------
# 9. API Creds from Env Vars — Auto-detected
# ---------------------------------------------------------------------------


class TestApiCredsFromEnvVars:
    def test_auto_detects_api_creds_from_env(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {"LOCAL_KEY": "local"}})
        request_log = RequestLog()
        transport = create_mock_transport(values={"REMOTE_KEY": "remote"}, request_log=request_log)

        mgr = ConfigManager(
            env={
                "SMOOAI_ENV_CONFIG_DIR": config_dir,
                "SMOOAI_CONFIG_ENV": "production",
                "SMOOAI_CONFIG_API_KEY": TEST_API_KEY,
                "SMOOAI_CONFIG_API_URL": TEST_BASE_URL,
                "SMOOAI_CONFIG_ORG_ID": TEST_ORG_ID,
            },
        )
        _patch_client_transport(mgr, transport)

        try:
            assert mgr.get_public_config("REMOTE_KEY") == "remote"
            assert request_log.count > 0
        finally:
            mgr._httpx_client_patch.stop()

    def test_no_remote_fetch_without_api_key(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {"LOCAL_KEY": "local"}})
        request_log = RequestLog()
        transport = create_mock_transport(values={"REMOTE_KEY": "remote"}, request_log=request_log)

        mgr = ConfigManager(
            env={
                "SMOOAI_ENV_CONFIG_DIR": config_dir,
                "SMOOAI_CONFIG_ENV": "test",
                # No SMOOAI_CONFIG_API_KEY
                "SMOOAI_CONFIG_API_URL": TEST_BASE_URL,
                "SMOOAI_CONFIG_ORG_ID": TEST_ORG_ID,
            },
        )
        _patch_client_transport(mgr, transport)

        try:
            assert mgr.get_public_config("LOCAL_KEY") == "local"
            assert mgr.get_public_config("REMOTE_KEY") is None
            assert request_log.count == 0
        finally:
            mgr._httpx_client_patch.stop()


# ---------------------------------------------------------------------------
# 10. API Creds from Constructor — Direct params override env vars
# ---------------------------------------------------------------------------


class TestApiCredsFromConstructor:
    def test_constructor_params_override_env_vars(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {}})
        request_log = RequestLog()
        transport = create_mock_transport(values={"KEY": "value"}, request_log=request_log)

        mgr = ConfigManager(
            api_key="constructor-key",
            base_url=TEST_BASE_URL,
            org_id=TEST_ORG_ID,
            environment="production",
            env={
                "SMOOAI_ENV_CONFIG_DIR": config_dir,
                "SMOOAI_CONFIG_ENV": "test",
                "SMOOAI_CONFIG_API_KEY": "env-key",
                "SMOOAI_CONFIG_API_URL": "https://env-url.example.com",
                "SMOOAI_CONFIG_ORG_ID": "env-org-id",
            },
        )
        _patch_client_transport(mgr, transport)

        try:
            mgr.get_public_config("KEY")
            # The constructor-key was used (not env-key), so the mock transport
            # received a request. We verify the request was made to the constructor base_url.
            assert request_log.count > 0
            assert TEST_BASE_URL in request_log.requests[0]["url"]
        finally:
            mgr._httpx_client_patch.stop()


# ---------------------------------------------------------------------------
# 11. Thread Safety — Multiple threads access concurrently
# ---------------------------------------------------------------------------


class TestThreadSafety:
    def test_concurrent_access_does_not_cause_errors(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(
            tmp_path,
            {"default.json": {"API_URL": "http://localhost", "COUNT": 42}},
        )
        mgr = ConfigManager(
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"},
        )

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

    def test_concurrent_access_with_remote(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {"LOCAL": "val"}})
        transport = create_mock_transport(values={"REMOTE": "remote-val"})

        mgr = ConfigManager(
            api_key=TEST_API_KEY,
            base_url=TEST_BASE_URL,
            org_id=TEST_ORG_ID,
            environment="production",
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"},
        )
        _patch_client_transport(mgr, transport)

        results: list[str | None] = [None] * 10
        errors: list[Exception] = []

        def worker(idx: int) -> None:
            try:
                results[idx] = mgr.get_public_config("REMOTE")
            except Exception as e:
                errors.append(e)

        try:
            threads = [threading.Thread(target=worker, args=(i,)) for i in range(10)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
        finally:
            mgr._httpx_client_patch.stop()

        assert len(errors) == 0
        assert all(r == "remote-val" for r in results)


# ---------------------------------------------------------------------------
# 12. Full Integration — Temp config dir + mock HTTP + env overrides
# ---------------------------------------------------------------------------


class TestFullIntegration:
    def test_all_three_sources_merge_correctly(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(
            tmp_path,
            {
                "default.json": {
                    "FILE_ONLY": "from-file",
                    "FILE_AND_REMOTE": "file-base",
                    "ALL_THREE": "file-base",
                    "DATABASE": {"host": "localhost", "port": 5432},
                },
            },
        )
        transport = create_mock_transport(
            values={
                "REMOTE_ONLY": "from-remote",
                "FILE_AND_REMOTE": "remote-override",
                "ALL_THREE": "remote-override",
                "DATABASE": {"host": "remote-db"},
            }
        )

        mgr = ConfigManager(
            api_key=TEST_API_KEY,
            base_url=TEST_BASE_URL,
            org_id=TEST_ORG_ID,
            environment="production",
            schema_keys={"ALL_THREE"},
            env={
                "SMOOAI_ENV_CONFIG_DIR": config_dir,
                "SMOOAI_CONFIG_ENV": "test",
                "ALL_THREE": "env-override",
            },
        )
        _patch_client_transport(mgr, transport)

        try:
            # File-only key
            assert mgr.get_public_config("FILE_ONLY") == "from-file"

            # Remote-only key
            assert mgr.get_public_config("REMOTE_ONLY") == "from-remote"

            # File + remote: remote wins
            assert mgr.get_public_config("FILE_AND_REMOTE") == "remote-override"

            # All three: env wins
            assert mgr.get_public_config("ALL_THREE") == "env-override"

            # Nested merge: remote host overrides file host, file port preserved
            db = mgr.get_public_config("DATABASE")
            assert db is not None
            assert db["host"] == "remote-db"
            assert db["port"] == 5432
        finally:
            mgr._httpx_client_patch.stop()

    def test_environment_specific_file_merging_with_remote(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(
            tmp_path,
            {
                "default.json": {"API_URL": "default-url", "MAX_RETRIES": 3},
                "production.json": {"API_URL": "prod-url", "MAX_RETRIES": 5},
            },
        )
        transport = create_mock_transport(values={"REMOTE_KEY": "remote-val"})

        mgr = ConfigManager(
            api_key=TEST_API_KEY,
            base_url=TEST_BASE_URL,
            org_id=TEST_ORG_ID,
            environment="production",
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "production"},
        )
        _patch_client_transport(mgr, transport)

        try:
            # File config merges default + production
            assert mgr.get_public_config("API_URL") == "prod-url"
            assert mgr.get_public_config("MAX_RETRIES") == 5
            # Remote key also available
            assert mgr.get_public_config("REMOTE_KEY") == "remote-val"
        finally:
            mgr._httpx_client_patch.stop()


# ---------------------------------------------------------------------------
# 13. Environment Resolution — Explicit > env var > default "development"
# ---------------------------------------------------------------------------


class TestEnvironmentResolution:
    def test_explicit_environment_param(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {}})
        request_log = RequestLog()
        transport = create_mock_transport(values={}, request_log=request_log)

        mgr = ConfigManager(
            api_key=TEST_API_KEY,
            base_url=TEST_BASE_URL,
            org_id=TEST_ORG_ID,
            environment="staging",
            env={
                "SMOOAI_ENV_CONFIG_DIR": config_dir,
                "SMOOAI_CONFIG_ENV": "production",
            },
        )
        _patch_client_transport(mgr, transport)

        try:
            mgr.get_public_config("ANY_KEY")
            assert request_log.count > 0
            # The request URL should contain environment=staging
            assert "environment=staging" in request_log.requests[0]["url"]
        finally:
            mgr._httpx_client_patch.stop()

    def test_env_var_when_no_explicit_param(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {}})
        request_log = RequestLog()
        transport = create_mock_transport(values={}, request_log=request_log)

        mgr = ConfigManager(
            api_key=TEST_API_KEY,
            base_url=TEST_BASE_URL,
            org_id=TEST_ORG_ID,
            # No explicit environment param
            env={
                "SMOOAI_ENV_CONFIG_DIR": config_dir,
                "SMOOAI_CONFIG_ENV": "production",
            },
        )
        _patch_client_transport(mgr, transport)

        try:
            mgr.get_public_config("ANY_KEY")
            assert request_log.count > 0
            assert "environment=production" in request_log.requests[0]["url"]
        finally:
            mgr._httpx_client_patch.stop()

    def test_defaults_to_development(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {}})
        request_log = RequestLog()
        transport = create_mock_transport(values={}, request_log=request_log)

        mgr = ConfigManager(
            api_key=TEST_API_KEY,
            base_url=TEST_BASE_URL,
            org_id=TEST_ORG_ID,
            # No explicit environment, no SMOOAI_CONFIG_ENV
            env={
                "SMOOAI_ENV_CONFIG_DIR": config_dir,
            },
        )
        _patch_client_transport(mgr, transport)

        try:
            mgr.get_public_config("ANY_KEY")
            assert request_log.count > 0
            assert "environment=development" in request_log.requests[0]["url"]
        finally:
            mgr._httpx_client_patch.stop()


# ---------------------------------------------------------------------------
# 14. Invalidation Re-fetches — invalidate() then getter triggers new HTTP
# ---------------------------------------------------------------------------


class TestInvalidationRefetches:
    def test_invalidate_then_getter_triggers_new_http(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {"LOCAL": "val"}})
        request_log = RequestLog()
        transport = create_mock_transport(values={"REMOTE": "remote-val"}, request_log=request_log)

        mgr = ConfigManager(
            api_key=TEST_API_KEY,
            base_url=TEST_BASE_URL,
            org_id=TEST_ORG_ID,
            environment="production",
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"},
        )
        _patch_client_transport(mgr, transport)

        try:
            # First access triggers init + HTTP
            mgr.get_public_config("REMOTE")
            assert request_log.count == 1

            # Second access uses cache
            mgr.get_public_config("REMOTE")
            assert request_log.count == 1

            # Invalidate clears everything
            mgr.invalidate()

            # Next access re-initializes and re-fetches
            result = mgr.get_public_config("REMOTE")
            assert result == "remote-val"
            assert request_log.count == 2
        finally:
            mgr._httpx_client_patch.stop()

    def test_invalidate_picks_up_new_remote_values(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {}})
        call_count = [0]

        def handler(request: httpx.Request) -> httpx.Response:
            call_count[0] += 1
            if call_count[0] == 1:
                return httpx.Response(200, json={"values": {"KEY": "first"}})
            else:
                return httpx.Response(200, json={"values": {"KEY": "second"}})

        transport = httpx.MockTransport(handler)

        mgr = ConfigManager(
            api_key=TEST_API_KEY,
            base_url=TEST_BASE_URL,
            org_id=TEST_ORG_ID,
            environment="production",
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"},
        )
        _patch_client_transport(mgr, transport)

        try:
            assert mgr.get_public_config("KEY") == "first"

            mgr.invalidate()

            assert mgr.get_public_config("KEY") == "second"
        finally:
            mgr._httpx_client_patch.stop()


# ---------------------------------------------------------------------------
# Additional edge cases
# ---------------------------------------------------------------------------


class TestEdgeCases:
    def test_returns_none_for_missing_key(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {"API_URL": "test"}})
        mgr = ConfigManager(
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"},
        )
        assert mgr.get_public_config("NONEXISTENT") is None

    def test_lazy_initialization(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {"API_URL": "http://localhost"}})
        mgr = ConfigManager(
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"},
        )
        assert mgr._initialized is False
        mgr.get_public_config("API_URL")
        assert mgr._initialized is True

    def test_no_warning_when_no_api_creds(self, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
        """No API credentials should not produce any warning — it's a valid use case."""
        config_dir = _make_config_dir(tmp_path, {"default.json": {"KEY": "val"}})
        mgr = ConfigManager(
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"},
        )
        mgr.get_public_config("KEY")
        captured = capsys.readouterr()
        assert "Warning" not in captured.err

    def test_partial_api_creds_skips_remote(self, tmp_path: Path) -> None:
        """If only some API creds are provided, remote fetch is skipped."""
        config_dir = _make_config_dir(tmp_path, {"default.json": {"KEY": "local"}})
        mgr = ConfigManager(
            api_key=TEST_API_KEY,
            # No base_url or org_id
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"},
        )
        assert mgr.get_public_config("KEY") == "local"


# ---------------------------------------------------------------------------
# Deferred (Computed) Config Values
# ---------------------------------------------------------------------------


class TestDeferredConfigValues:
    def test_basic_deferred_value(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(
            tmp_path,
            {"default.json": {"HOST": "localhost", "PORT": 5432}},
        )
        mgr = ConfigManager(
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"},
            config_overrides={
                "FULL_URL": lambda config: f"{config['HOST']}:{config['PORT']}",
            },
        )
        assert mgr.get_public_config("FULL_URL") == "localhost:5432"
        # Original values still present
        assert mgr.get_public_config("HOST") == "localhost"
        assert mgr.get_public_config("PORT") == 5432

    def test_multiple_deferred_see_pre_resolution_snapshot(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(tmp_path, {"default.json": {"BASE": "hello"}})
        mgr = ConfigManager(
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"},
            config_overrides={
                "A": lambda config: f"{config['BASE']}-a",
                "B": lambda config: "A" in config,
            },
        )
        assert mgr.get_public_config("A") == "hello-a"
        # B should see that A was NOT in the snapshot (deferred values don't see each other)
        assert mgr.get_public_config("B") is False

    def test_deferred_runs_after_full_merge(self, tmp_path: Path) -> None:
        """Deferred values see the result of file + env merge."""
        config_dir = _make_config_dir(
            tmp_path,
            {"default.json": {"HOST": "file-host"}},
        )
        mgr = ConfigManager(
            schema_keys={"HOST"},
            env={
                "SMOOAI_ENV_CONFIG_DIR": config_dir,
                "SMOOAI_CONFIG_ENV": "test",
                "HOST": "env-host",
            },
            config_overrides={
                "API_URL": lambda config: f"https://{config['HOST']}/api",
            },
        )
        # Env overrides file, deferred sees env value
        assert mgr.get_public_config("API_URL") == "https://env-host/api"

    def test_deferred_with_remote(self, tmp_path: Path) -> None:
        config_dir = _make_config_dir(
            tmp_path,
            {"default.json": {"HOST": "file-host"}},
        )
        transport = create_mock_transport(values={"HOST": "remote-host", "PORT": 8080})
        mgr = ConfigManager(
            api_key=TEST_API_KEY,
            base_url=TEST_BASE_URL,
            org_id=TEST_ORG_ID,
            environment="production",
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"},
            config_overrides={
                "FULL_URL": lambda config: f"{config['HOST']}:{config['PORT']}",
            },
        )
        _patch_client_transport(mgr, transport)

        try:
            # Remote overrides file HOST, deferred sees remote value
            assert mgr.get_public_config("FULL_URL") == "remote-host:8080"
        finally:
            mgr._httpx_client_patch.stop()

    def test_no_deferred_values(self, tmp_path: Path) -> None:
        """ConfigManager works normally without any deferred values."""
        config_dir = _make_config_dir(tmp_path, {"default.json": {"KEY": "value"}})
        mgr = ConfigManager(
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"},
        )
        assert mgr.get_public_config("KEY") == "value"
