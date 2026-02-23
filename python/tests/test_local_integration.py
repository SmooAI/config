"""Full pipeline integration tests mirroring TypeScript integration test suite 2."""

import json
from pathlib import Path

import pytest

from smooai_config.file_config import _clear_config_dir_cache
from smooai_config.local import LocalConfigManager


@pytest.fixture(autouse=True)
def _clear_cache() -> None:
    _clear_config_dir_cache()


@pytest.fixture()
def config_dir(tmp_path: Path) -> str:
    """Create a temp config directory with test JSON files."""
    d = tmp_path / ".smooai-config"
    d.mkdir()

    (d / "default.json").write_text(
        json.dumps(
            {
                "API_URL": "http://localhost:3000",
                "MAX_RETRIES": 3,
                "ENABLE_DEBUG": True,
                "APP_NAME": "default-app",
                "DATABASE": {"host": "localhost", "port": 5432, "ssl": False},
                "API_KEY": "default-api-key",
                "DB_PASSWORD": "default-db-pass",
                "JWT_SECRET": "default-jwt-secret",
                "ENABLE_NEW_UI": False,
                "ENABLE_BETA": False,
                "MAINTENANCE_MODE": False,
            }
        )
    )

    (d / "development.json").write_text(
        json.dumps(
            {
                "API_URL": "http://dev-api.example.com",
                "ENABLE_DEBUG": True,
                "APP_NAME": "dev-app",
                "ENABLE_NEW_UI": True,
                "ENABLE_BETA": True,
            }
        )
    )

    (d / "production.json").write_text(
        json.dumps(
            {
                "API_URL": "https://api.example.com",
                "MAX_RETRIES": 5,
                "ENABLE_DEBUG": False,
                "APP_NAME": "prod-app",
                "DATABASE": {"host": "prod-db.example.com", "port": 5432, "ssl": True},
                "API_KEY": "prod-api-key-secret",
                "DB_PASSWORD": "prod-db-pass-secret",
                "JWT_SECRET": "prod-jwt-secret",
                "ENABLE_NEW_UI": False,
                "ENABLE_BETA": False,
                "MAINTENANCE_MODE": False,
            }
        )
    )

    (d / "production.aws.json").write_text(
        json.dumps(
            {
                "API_URL": "https://aws-api.example.com",
                "DATABASE": {"host": "aws-prod-db.example.com"},
            }
        )
    )

    (d / "production.aws.us-east-1.json").write_text(
        json.dumps(
            {
                "DATABASE": {"host": "us-east-1-db.example.com"},
            }
        )
    )

    return str(d)


class TestDefaultConfigLoading:
    """Default config loading (no env overlay) — SMOOAI_CONFIG_ENV=test means no matching file."""

    def test_loads_all_config_tiers_from_default(self, config_dir: str) -> None:
        mgr = LocalConfigManager(
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"},
        )

        # Public config
        assert mgr.get_public_config("API_URL") == "http://localhost:3000"
        assert mgr.get_public_config("MAX_RETRIES") == 3
        assert mgr.get_public_config("ENABLE_DEBUG") is True
        assert mgr.get_public_config("APP_NAME") == "default-app"
        assert mgr.get_public_config("DATABASE") == {"host": "localhost", "port": 5432, "ssl": False}

        # Secret config
        assert mgr.get_secret_config("API_KEY") == "default-api-key"
        assert mgr.get_secret_config("DB_PASSWORD") == "default-db-pass"

        # Feature flags
        assert mgr.get_feature_flag("ENABLE_NEW_UI") is False
        assert mgr.get_feature_flag("ENABLE_BETA") is False
        assert mgr.get_feature_flag("MAINTENANCE_MODE") is False

    def test_sets_standard_builtin_config(self, config_dir: str) -> None:
        mgr = LocalConfigManager(
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"},
        )
        assert mgr.get_public_config("ENV") == "test"
        assert mgr.get_public_config("IS_LOCAL") is False
        assert mgr.get_public_config("CLOUD_PROVIDER") == "unknown"
        assert mgr.get_public_config("REGION") == "unknown"

    def test_returns_none_for_nonexistent_keys(self, config_dir: str) -> None:
        mgr = LocalConfigManager(
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"},
        )
        assert mgr.get_public_config("nonexistent") is None


class TestEnvironmentSpecificMerging:
    """Environment-specific file merging (development)."""

    def test_overrides_from_development_inherits_from_default(self, config_dir: str) -> None:
        mgr = LocalConfigManager(
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "development"},
        )

        # Overridden in development.json
        assert mgr.get_public_config("API_URL") == "http://dev-api.example.com"
        assert mgr.get_public_config("APP_NAME") == "dev-app"
        assert mgr.get_public_config("ENABLE_DEBUG") is True

        # Inherited from default.json
        assert mgr.get_public_config("MAX_RETRIES") == 3
        assert mgr.get_public_config("DATABASE") == {"host": "localhost", "port": 5432, "ssl": False}

    def test_overrides_feature_flags(self, config_dir: str) -> None:
        mgr = LocalConfigManager(
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "development"},
        )
        assert mgr.get_feature_flag("ENABLE_NEW_UI") is True
        assert mgr.get_feature_flag("ENABLE_BETA") is True
        assert mgr.get_feature_flag("MAINTENANCE_MODE") is False  # not overridden

    def test_inherits_secrets_from_default(self, config_dir: str) -> None:
        mgr = LocalConfigManager(
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "development"},
        )
        assert mgr.get_secret_config("API_KEY") == "default-api-key"
        assert mgr.get_secret_config("DB_PASSWORD") == "default-db-pass"


class TestProductionMergeChain:
    """Production + provider + region merge chain."""

    def test_merges_default_production_aws_us_east_1(self, config_dir: str) -> None:
        mgr = LocalConfigManager(
            env={
                "SMOOAI_ENV_CONFIG_DIR": config_dir,
                "SMOOAI_CONFIG_ENV": "production",
                "AWS_REGION": "us-east-1",
            },
        )

        # production.aws.json overrides API_URL from production.json
        assert mgr.get_public_config("API_URL") == "https://aws-api.example.com"

        # production.json sets MAX_RETRIES=5
        assert mgr.get_public_config("MAX_RETRIES") == 5

        # production.aws.us-east-1.json overrides DATABASE.host via deep merge
        db = mgr.get_public_config("DATABASE")
        assert db is not None
        assert db["host"] == "us-east-1-db.example.com"
        assert db["ssl"] is True  # from production.json
        assert db["port"] == 5432  # from default.json

    def test_applies_production_secrets(self, config_dir: str) -> None:
        mgr = LocalConfigManager(
            env={
                "SMOOAI_ENV_CONFIG_DIR": config_dir,
                "SMOOAI_CONFIG_ENV": "production",
                "AWS_REGION": "us-east-1",
            },
        )
        assert mgr.get_secret_config("API_KEY") == "prod-api-key-secret"
        assert mgr.get_secret_config("DB_PASSWORD") == "prod-db-pass-secret"
        assert mgr.get_secret_config("JWT_SECRET") == "prod-jwt-secret"

    def test_detects_aws_cloud_provider_and_region(self, config_dir: str) -> None:
        mgr = LocalConfigManager(
            env={
                "SMOOAI_ENV_CONFIG_DIR": config_dir,
                "SMOOAI_CONFIG_ENV": "production",
                "AWS_REGION": "us-east-1",
            },
        )
        assert mgr.get_public_config("CLOUD_PROVIDER") == "aws"
        assert mgr.get_public_config("REGION") == "us-east-1"

    def test_sets_enable_debug_false_from_production(self, config_dir: str) -> None:
        mgr = LocalConfigManager(
            env={
                "SMOOAI_ENV_CONFIG_DIR": config_dir,
                "SMOOAI_CONFIG_ENV": "production",
                "AWS_REGION": "us-east-1",
            },
        )
        assert mgr.get_public_config("ENABLE_DEBUG") is False


class TestCloudRegionDetection:
    def test_detects_aws_from_env(self, config_dir: str) -> None:
        mgr = LocalConfigManager(
            env={
                "SMOOAI_ENV_CONFIG_DIR": config_dir,
                "SMOOAI_CONFIG_ENV": "test",
                "AWS_REGION": "eu-west-1",
            },
        )
        assert mgr.get_public_config("CLOUD_PROVIDER") == "aws"
        assert mgr.get_public_config("REGION") == "eu-west-1"

    def test_detects_custom_provider(self, config_dir: str) -> None:
        mgr = LocalConfigManager(
            env={
                "SMOOAI_ENV_CONFIG_DIR": config_dir,
                "SMOOAI_CONFIG_ENV": "test",
                "SMOOAI_CONFIG_CLOUD_PROVIDER": "custom-cloud",
                "SMOOAI_CONFIG_CLOUD_REGION": "custom-region-1",
            },
        )
        assert mgr.get_public_config("CLOUD_PROVIDER") == "custom-cloud"
        assert mgr.get_public_config("REGION") == "custom-region-1"

    def test_falls_back_to_unknown(self, config_dir: str) -> None:
        mgr = LocalConfigManager(
            env={
                "SMOOAI_ENV_CONFIG_DIR": config_dir,
                "SMOOAI_CONFIG_ENV": "test",
            },
        )
        assert mgr.get_public_config("CLOUD_PROVIDER") == "unknown"
        assert mgr.get_public_config("REGION") == "unknown"


class TestConsistentResults:
    def test_returns_same_value_on_repeated_calls(self, config_dir: str) -> None:
        mgr = LocalConfigManager(
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"},
        )
        r1 = mgr.get_public_config("API_URL")
        r2 = mgr.get_public_config("API_URL")
        r3 = mgr.get_public_config("API_URL")
        assert r1 == r2 == r3 == "http://localhost:3000"

    def test_returns_same_structured_value(self, config_dir: str) -> None:
        mgr = LocalConfigManager(
            env={"SMOOAI_ENV_CONFIG_DIR": config_dir, "SMOOAI_CONFIG_ENV": "test"},
        )
        r1 = mgr.get_public_config("DATABASE")
        r2 = mgr.get_public_config("DATABASE")
        assert r1 == r2
