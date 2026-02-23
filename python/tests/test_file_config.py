"""Tests for file-based configuration loading."""

import json
from pathlib import Path

import pytest

from smooai_config.file_config import (
    _clear_config_dir_cache,
    find_and_process_file_config,
    find_config_directory,
)
from smooai_config.utils import SmooaiConfigError


@pytest.fixture(autouse=True)
def _clear_cache() -> None:
    """Clear config dir cache before each test."""
    _clear_config_dir_cache()


class TestFindConfigDirectory:
    def test_finds_via_env_var(self, tmp_path: Path) -> None:
        config_dir = tmp_path / "my-config"
        config_dir.mkdir()
        env = {"SMOOAI_ENV_CONFIG_DIR": str(config_dir)}
        result = find_config_directory(env=env)
        assert result == str(config_dir)

    def test_env_var_dir_not_exist_raises(self, tmp_path: Path) -> None:
        env = {"SMOOAI_ENV_CONFIG_DIR": str(tmp_path / "nonexistent")}
        with pytest.raises(SmooaiConfigError, match="does not exist"):
            find_config_directory(env=env)

    def test_finds_smooai_config_in_cwd(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        config_dir = tmp_path / ".smooai-config"
        config_dir.mkdir()
        monkeypatch.chdir(tmp_path)
        result = find_config_directory(env={})
        assert result == str(config_dir)

    def test_finds_smooai_config_no_dot(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        config_dir = tmp_path / "smooai-config"
        config_dir.mkdir()
        monkeypatch.chdir(tmp_path)
        result = find_config_directory(env={})
        assert result == str(config_dir)

    def test_dot_prefix_takes_priority(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        (tmp_path / ".smooai-config").mkdir()
        (tmp_path / "smooai-config").mkdir()
        monkeypatch.chdir(tmp_path)
        result = find_config_directory(env={})
        assert ".smooai-config" in result

    def test_walks_up_directory_tree(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        config_dir = tmp_path / ".smooai-config"
        config_dir.mkdir()
        child = tmp_path / "sub1" / "sub2"
        child.mkdir(parents=True)
        monkeypatch.chdir(child)
        result = find_config_directory(env={})
        assert result == str(config_dir)

    def test_raises_when_not_found(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.chdir(tmp_path)
        with pytest.raises(SmooaiConfigError, match="Could not find"):
            find_config_directory(env={})


class TestFindAndProcessFileConfig:
    def _write_json(self, directory: Path, filename: str, data: dict) -> None:
        with open(directory / filename, "w") as f:
            json.dump(data, f)

    def test_loads_default_json(self, tmp_path: Path) -> None:
        config_dir = tmp_path / ".smooai-config"
        config_dir.mkdir()
        self._write_json(config_dir, "default.json", {"API_URL": "http://localhost:3000", "MAX_RETRIES": 3})
        env = {"SMOOAI_ENV_CONFIG_DIR": str(config_dir), "SMOOAI_CONFIG_ENV": "test"}
        result = find_and_process_file_config(env=env)
        assert result["API_URL"] == "http://localhost:3000"
        assert result["MAX_RETRIES"] == 3

    def test_raises_without_default_json(self, tmp_path: Path) -> None:
        config_dir = tmp_path / ".smooai-config"
        config_dir.mkdir()
        env = {"SMOOAI_ENV_CONFIG_DIR": str(config_dir), "SMOOAI_CONFIG_ENV": "test"}
        with pytest.raises(SmooaiConfigError, match="default.json"):
            find_and_process_file_config(env=env)

    def test_merges_env_specific_file(self, tmp_path: Path) -> None:
        config_dir = tmp_path / ".smooai-config"
        config_dir.mkdir()
        self._write_json(config_dir, "default.json", {"API_URL": "http://localhost:3000", "MAX_RETRIES": 3})
        self._write_json(config_dir, "development.json", {"API_URL": "http://dev-api.example.com"})
        env = {"SMOOAI_ENV_CONFIG_DIR": str(config_dir), "SMOOAI_CONFIG_ENV": "development"}
        result = find_and_process_file_config(env=env)
        assert result["API_URL"] == "http://dev-api.example.com"
        assert result["MAX_RETRIES"] == 3  # inherited from default

    def test_merges_provider_and_region_files(self, tmp_path: Path) -> None:
        config_dir = tmp_path / ".smooai-config"
        config_dir.mkdir()
        self._write_json(
            config_dir,
            "default.json",
            {"DATABASE": {"host": "localhost", "port": 5432, "ssl": False}},
        )
        self._write_json(
            config_dir,
            "production.json",
            {"DATABASE": {"host": "prod-db.example.com", "port": 5432, "ssl": True}},
        )
        self._write_json(config_dir, "production.aws.json", {"DATABASE": {"host": "aws-db.example.com"}})
        self._write_json(
            config_dir, "production.aws.us-east-1.json", {"DATABASE": {"host": "us-east-1-db.example.com"}}
        )
        env = {
            "SMOOAI_ENV_CONFIG_DIR": str(config_dir),
            "SMOOAI_CONFIG_ENV": "production",
            "AWS_REGION": "us-east-1",
        }
        result = find_and_process_file_config(env=env)
        assert result["DATABASE"]["host"] == "us-east-1-db.example.com"
        assert result["DATABASE"]["port"] == 5432
        assert result["DATABASE"]["ssl"] is True

    def test_sets_builtin_keys(self, tmp_path: Path) -> None:
        config_dir = tmp_path / ".smooai-config"
        config_dir.mkdir()
        self._write_json(config_dir, "default.json", {"API_URL": "test"})
        env = {
            "SMOOAI_ENV_CONFIG_DIR": str(config_dir),
            "SMOOAI_CONFIG_ENV": "production",
            "AWS_REGION": "us-east-1",
        }
        result = find_and_process_file_config(env=env)
        assert result["ENV"] == "production"
        assert result["IS_LOCAL"] is False
        assert result["CLOUD_PROVIDER"] == "aws"
        assert result["REGION"] == "us-east-1"

    def test_is_local_flag(self, tmp_path: Path) -> None:
        config_dir = tmp_path / ".smooai-config"
        config_dir.mkdir()
        self._write_json(config_dir, "default.json", {"API_URL": "test"})
        self._write_json(config_dir, "local.json", {"API_URL": "http://local-api"})
        env = {
            "SMOOAI_ENV_CONFIG_DIR": str(config_dir),
            "SMOOAI_CONFIG_ENV": "test",
            "IS_LOCAL": "true",
        }
        result = find_and_process_file_config(env=env)
        assert result["API_URL"] == "http://local-api"
        assert result["IS_LOCAL"] is True

    def test_skips_optional_missing_files(self, tmp_path: Path) -> None:
        config_dir = tmp_path / ".smooai-config"
        config_dir.mkdir()
        self._write_json(config_dir, "default.json", {"API_URL": "test"})
        env = {
            "SMOOAI_ENV_CONFIG_DIR": str(config_dir),
            "SMOOAI_CONFIG_ENV": "nonexistent",
        }
        result = find_and_process_file_config(env=env)
        assert result["API_URL"] == "test"

    def test_defaults_env_to_development(self, tmp_path: Path) -> None:
        config_dir = tmp_path / ".smooai-config"
        config_dir.mkdir()
        self._write_json(config_dir, "default.json", {"API_URL": "base"})
        self._write_json(config_dir, "development.json", {"API_URL": "dev"})
        env = {"SMOOAI_ENV_CONFIG_DIR": str(config_dir)}
        result = find_and_process_file_config(env=env)
        assert result["API_URL"] == "dev"
        assert result["ENV"] == "development"
