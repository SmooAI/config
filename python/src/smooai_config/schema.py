"""Configuration schema definition using Pydantic."""

from __future__ import annotations

import warnings
from collections.abc import Callable
from enum import StrEnum
from typing import Any, get_type_hints

from pydantic import BaseModel

from smooai_config.schema_validator import validate_smooai_schema


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


def _check_pydantic_model(model: type[BaseModel], tier: str) -> None:
    """Check a Pydantic model for unsupported features before conversion.

    Raises SmooaiConfigError for unsupported features,
    issues warnings for runtime-only features.
    """
    # Check for computed_field
    if hasattr(model, "model_computed_fields") and model.model_computed_fields:
        msg = (
            f"[{tier}] computed_field is runtime-only and won't appear in JSON Schema. "
            f"Fields: {list(model.model_computed_fields.keys())}"
        )
        raise ValueError(msg)

    # Check field types for callables/functions
    try:
        hints = get_type_hints(model)
    except Exception:
        hints = {}

    for field_name, field_type in hints.items():
        origin = getattr(field_type, "__origin__", None)
        if field_type is Callable or origin is Callable:
            msg = (
                f"[{tier}] Field '{field_name}' has type Callable which cannot be a config value. "
                "Use a plain type instead."
            )
            raise ValueError(msg)

    # Warn about validators (runtime-only, they still work fine but won't serialize)
    validators = getattr(model, "__validators__", None) or {}
    field_validators = getattr(model, "model_validators", None)
    if validators or field_validators:
        warnings.warn(
            f"[{tier}] model_validator/field_validator are runtime-only and won't appear in JSON Schema.",
            UserWarning,
            stacklevel=3,
        )


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

    Raises:
        ValueError: If a model uses unsupported features (computed_field, Callable types).
    """
    # Pre-validate Pydantic models before conversion
    if public:
        _check_pydantic_model(public, "public")
    if secret:
        _check_pydantic_model(secret, "secret")
    if feature_flags:
        _check_pydantic_model(feature_flags, "feature_flags")

    public_schema = public.model_json_schema() if public else {}
    secret_schema = secret.model_json_schema() if secret else {}
    feature_flag_schema = feature_flags.model_json_schema() if feature_flags else {}

    # Validate cross-language compatibility of generated schemas
    for tier_name, tier_schema in [
        ("public", public_schema),
        ("secret", secret_schema),
        ("feature_flags", feature_flag_schema),
    ]:
        if tier_schema:
            result = validate_smooai_schema(tier_schema)
            if not result.valid:
                error_msgs = [f"  {e.path}: {e.message} Suggestion: {e.suggestion}" for e in result.errors]
                raise ValueError(
                    f"[{tier_name}] Schema uses unsupported JSON Schema features:\n" + "\n".join(error_msgs)
                )

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
