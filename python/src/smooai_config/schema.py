"""Configuration schema definition using Pydantic."""

from enum import StrEnum
from typing import Any

from pydantic import BaseModel


class ConfigTier(StrEnum):
    """Configuration value tiers."""

    PUBLIC = "public"
    SECRET = "secret"
    FEATURE_FLAG = "feature_flag"


class ConfigFieldMeta(BaseModel):
    """Metadata for a config field."""

    tier: ConfigTier = ConfigTier.PUBLIC
    description: str = ""


class ConfigDefinition(BaseModel):
    """Result of define_config() containing schema metadata."""

    public_schema: dict[str, Any]
    secret_schema: dict[str, Any]
    feature_flag_schema: dict[str, Any]
    json_schema: dict[str, Any]


def define_config(
    *,
    public: type[BaseModel] | None = None,
    secret: type[BaseModel] | None = None,
    feature_flags: type[BaseModel] | None = None,
) -> ConfigDefinition:
    """Define a configuration schema with three tiers.

    Args:
        public: Pydantic model for public configuration values.
        secret: Pydantic model for secret configuration values.
        feature_flags: Pydantic model for feature flag values.

    Returns:
        ConfigDefinition with JSON schemas for each tier.
    """
    public_schema = public.model_json_schema() if public else {}
    secret_schema = secret.model_json_schema() if secret else {}
    feature_flag_schema = feature_flags.model_json_schema() if feature_flags else {}

    # Combined JSON schema for server push
    json_schema: dict[str, Any] = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
            "public": public_schema if public else {"type": "object", "properties": {}},
            "secret": secret_schema if secret else {"type": "object", "properties": {}},
            "feature_flags": feature_flag_schema if feature_flags else {"type": "object", "properties": {}},
        },
    }

    return ConfigDefinition(
        public_schema=public_schema,
        secret_schema=secret_schema,
        feature_flag_schema=feature_flag_schema,
        json_schema=json_schema,
    )
