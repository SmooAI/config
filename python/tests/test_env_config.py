"""Tests for environment variable configuration loading."""

from smooai_config.env_config import find_and_process_env_config


class TestFindAndProcessEnvConfig:
    def test_extracts_matching_keys(self) -> None:
        schema_keys = {"API_URL", "MAX_RETRIES"}
        env = {"API_URL": "http://localhost:3000", "MAX_RETRIES": "3", "UNRELATED": "ignored"}
        result = find_and_process_env_config(schema_keys, env=env)
        assert result["API_URL"] == "http://localhost:3000"
        assert result["MAX_RETRIES"] == "3"
        assert "UNRELATED" not in result

    def test_strips_prefix(self) -> None:
        schema_keys = {"API_URL"}
        env = {"NEXT_PUBLIC_API_URL": "http://example.com"}
        result = find_and_process_env_config(schema_keys, prefix="NEXT_PUBLIC_", env=env)
        assert result["API_URL"] == "http://example.com"

    def test_coerces_boolean_type(self) -> None:
        schema_keys = {"ENABLE_DEBUG", "IS_LOCAL"}
        schema_types = {"ENABLE_DEBUG": "boolean", "IS_LOCAL": "boolean"}
        env = {"ENABLE_DEBUG": "true", "IS_LOCAL": "false"}
        result = find_and_process_env_config(schema_keys, schema_types=schema_types, env=env)
        assert result["ENABLE_DEBUG"] is True

    def test_coerces_number_type_int(self) -> None:
        schema_keys = {"MAX_RETRIES"}
        schema_types = {"MAX_RETRIES": "number"}
        env = {"MAX_RETRIES": "5"}
        result = find_and_process_env_config(schema_keys, schema_types=schema_types, env=env)
        assert result["MAX_RETRIES"] == 5
        assert isinstance(result["MAX_RETRIES"], int)

    def test_coerces_number_type_float(self) -> None:
        schema_keys = {"TIMEOUT"}
        schema_types = {"TIMEOUT": "number"}
        env = {"TIMEOUT": "3.14"}
        result = find_and_process_env_config(schema_keys, schema_types=schema_types, env=env)
        assert result["TIMEOUT"] == 3.14

    def test_coerces_json_type(self) -> None:
        schema_keys = {"DATABASE"}
        schema_types = {"DATABASE": "json"}
        env = {"DATABASE": '{"host": "localhost", "port": 5432}'}
        result = find_and_process_env_config(schema_keys, schema_types=schema_types, env=env)
        assert result["DATABASE"] == {"host": "localhost", "port": 5432}

    def test_invalid_json_falls_through_to_string(self) -> None:
        schema_keys = {"DATABASE"}
        schema_types = {"DATABASE": "json"}
        env = {"DATABASE": "not-json"}
        result = find_and_process_env_config(schema_keys, schema_types=schema_types, env=env)
        assert result["DATABASE"] == "not-json"

    def test_invalid_number_falls_through_to_string(self) -> None:
        schema_keys = {"PORT"}
        schema_types = {"PORT": "number"}
        env = {"PORT": "not-a-number"}
        result = find_and_process_env_config(schema_keys, schema_types=schema_types, env=env)
        assert result["PORT"] == "not-a-number"

    def test_sets_builtin_keys(self) -> None:
        env = {"SMOOAI_CONFIG_ENV": "production", "AWS_REGION": "us-east-1"}
        result = find_and_process_env_config(set(), env=env)
        assert result["ENV"] == "production"
        assert result["IS_LOCAL"] is False
        assert result["CLOUD_PROVIDER"] == "aws"
        assert result["REGION"] == "us-east-1"

    def test_defaults_env_to_development(self) -> None:
        result = find_and_process_env_config(set(), env={})
        assert result["ENV"] == "development"

    def test_empty_schema_keys_only_returns_builtins(self) -> None:
        env = {"API_URL": "http://localhost", "RANDOM": "value"}
        result = find_and_process_env_config(set(), env=env)
        assert "API_URL" not in result
        assert "RANDOM" not in result
        assert "ENV" in result

    def test_prefix_only_strips_when_present(self) -> None:
        schema_keys = {"API_URL"}
        env = {"API_URL": "direct", "NEXT_PUBLIC_API_URL": "prefixed"}
        result = find_and_process_env_config(schema_keys, prefix="NEXT_PUBLIC_", env=env)
        # Both "API_URL" (direct match) and "NEXT_PUBLIC_API_URL" (stripped) match
        assert result["API_URL"] in ("direct", "prefixed")
