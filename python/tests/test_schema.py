"""Tests for config schema definition."""

from pydantic import BaseModel

from smooai_config.schema import ConfigDefinition, ConfigTier, define_config


class TestDefineConfig:
    """Tests for define_config()."""

    def test_empty_config(self) -> None:
        """define_config with no models returns empty schemas."""
        result = define_config()
        assert isinstance(result, ConfigDefinition)
        assert result.public_schema == {}
        assert result.secret_schema == {}
        assert result.feature_flag_schema == {}
        assert result.json_schema["type"] == "object"

    def test_public_only(self) -> None:
        """define_config with only public model."""

        class PublicConfig(BaseModel):
            api_url: str = "https://api.example.com"
            max_retries: int = 3
            debug: bool = False

        result = define_config(public=PublicConfig)
        assert "properties" in result.public_schema
        assert "api_url" in result.public_schema["properties"]
        assert "max_retries" in result.public_schema["properties"]
        assert result.secret_schema == {}
        assert result.feature_flag_schema == {}

    def test_all_tiers(self) -> None:
        """define_config with all three tiers."""

        class PublicConfig(BaseModel):
            api_url: str

        class SecretConfig(BaseModel):
            api_key: str
            jwt_secret: str

        class FeatureFlags(BaseModel):
            enable_new_ui: bool = False
            beta_features: bool = False

        result = define_config(
            public=PublicConfig,
            secret=SecretConfig,
            feature_flags=FeatureFlags,
        )
        assert "properties" in result.public_schema
        assert "api_url" in result.public_schema["properties"]
        assert "api_key" in result.secret_schema["properties"]
        assert "enable_new_ui" in result.feature_flag_schema["properties"]

    def test_json_schema_structure(self) -> None:
        """Combined JSON schema has correct structure."""

        class PublicConfig(BaseModel):
            name: str

        result = define_config(public=PublicConfig)
        schema = result.json_schema
        assert schema["$schema"] == "https://json-schema.org/draft/2020-12/schema"
        assert "public" in schema["properties"]
        assert "secret" in schema["properties"]
        assert "feature_flags" in schema["properties"]

    def test_nested_models(self) -> None:
        """Nested Pydantic models produce valid JSON schema."""

        class DatabaseConfig(BaseModel):
            host: str = "localhost"
            port: int = 5432
            name: str = "mydb"

        class PublicConfig(BaseModel):
            database: DatabaseConfig = DatabaseConfig()

        result = define_config(public=PublicConfig)
        assert "properties" in result.public_schema
        assert "database" in result.public_schema["properties"]


class TestConfigTier:
    """Tests for ConfigTier enum."""

    def test_values(self) -> None:
        assert ConfigTier.PUBLIC.value == "public"
        assert ConfigTier.SECRET.value == "secret"
        assert ConfigTier.FEATURE_FLAG.value == "feature_flag"

    def test_string_enum(self) -> None:
        assert str(ConfigTier.PUBLIC) == "public"
        assert ConfigTier("public") == ConfigTier.PUBLIC
