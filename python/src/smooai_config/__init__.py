"""Smoo AI Configuration Management Library - Python SDK."""

from smooai_config.build import BuildBundleResult, build_bundle, classify_from_schema
from smooai_config.client import (
    ConfigClient,
    EvaluateFeatureFlagResponse,
    FeatureFlagContextError,
    FeatureFlagEvaluationError,
    FeatureFlagNotFoundError,
)
from smooai_config.cloud_region import CloudRegionResult, get_cloud_region
from smooai_config.config_manager import ConfigManager
from smooai_config.env_config import find_and_process_env_config
from smooai_config.file_config import find_and_process_file_config, find_config_directory
from smooai_config.local import LocalConfigManager
from smooai_config.merge import merge_replace_arrays
from smooai_config.runtime import build_config_runtime, hydrate_config_client, read_baked_config
from smooai_config.schema import ConfigTier, define_config
from smooai_config.utils import SmooaiConfigError, camel_to_upper_snake, coerce_boolean

__all__ = [
    "BuildBundleResult",
    "CloudRegionResult",
    "ConfigClient",
    "ConfigManager",
    "ConfigTier",
    "EvaluateFeatureFlagResponse",
    "FeatureFlagContextError",
    "FeatureFlagEvaluationError",
    "FeatureFlagNotFoundError",
    "LocalConfigManager",
    "SmooaiConfigError",
    "build_bundle",
    "build_config_runtime",
    "camel_to_upper_snake",
    "classify_from_schema",
    "coerce_boolean",
    "define_config",
    "find_and_process_env_config",
    "find_and_process_file_config",
    "find_config_directory",
    "get_cloud_region",
    "hydrate_config_client",
    "merge_replace_arrays",
    "read_baked_config",
]
