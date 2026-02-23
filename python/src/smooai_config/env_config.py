"""Environment variable configuration loading."""

import json
import os
from typing import Any

from smooai_config.cloud_region import get_cloud_region
from smooai_config.utils import coerce_boolean


def find_and_process_env_config(
    schema_keys: set[str],
    prefix: str = "",
    schema_types: dict[str, str] | None = None,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Extract config values from environment variables.

    For each env var:
    - Strip prefix if present
    - Check if key is in schema_keys
    - Coerce types based on schema_types (boolean, number, json/object)
    - Sets built-in keys: ENV, IS_LOCAL, REGION, CLOUD_PROVIDER

    Args:
        schema_keys: Set of config keys to look for in env vars.
        prefix: Optional prefix to strip (e.g., "NEXT_PUBLIC_").
        schema_types: Optional mapping of key → type ("boolean", "number", "json", "object").
        env: Environment variable dict. If None, uses os.environ.
    """
    if env is None:
        env = dict(os.environ)

    cloud_region = get_cloud_region(env)
    env_name = env.get("SMOOAI_CONFIG_ENV", "development")
    is_local = coerce_boolean(env.get("IS_LOCAL", ""))

    result: dict[str, Any] = {}

    for key, value in env.items():
        key_to_use = key
        if prefix and key.startswith(prefix):
            key_to_use = key[len(prefix) :]

        if key_to_use not in schema_keys:
            continue

        # Type coercion
        if schema_types and key_to_use in schema_types:
            type_hint = schema_types[key_to_use]
            if type_hint == "boolean":
                result[key_to_use] = coerce_boolean(value)
                continue
            elif type_hint == "number":
                try:
                    result[key_to_use] = float(value) if "." in value else int(value)
                    continue
                except (ValueError, TypeError):
                    pass  # fall through to string
            elif type_hint in ("json", "object"):
                try:
                    result[key_to_use] = json.loads(value)
                    continue
                except (json.JSONDecodeError, TypeError):
                    pass  # fall through to string

        result[key_to_use] = value

    # Set built-in keys
    result["ENV"] = env_name
    result["IS_LOCAL"] = is_local
    result["REGION"] = cloud_region.region
    result["CLOUD_PROVIDER"] = cloud_region.provider

    return result
