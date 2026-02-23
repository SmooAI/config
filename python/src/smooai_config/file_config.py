"""File-based configuration loading and merging."""

import json
import os
import threading
import time
from pathlib import Path
from typing import Any

from smooai_config.cloud_region import get_cloud_region
from smooai_config.merge import merge_replace_arrays
from smooai_config.utils import SmooaiConfigError, coerce_boolean

# Config directory cache (1h TTL)
_config_dir_cache: dict[str, tuple[str, float]] = {}
_config_dir_lock = threading.Lock()
_CONFIG_DIR_TTL = 3600  # 1 hour


def _clear_config_dir_cache() -> None:
    """Clear the config directory cache (for testing)."""
    with _config_dir_lock:
        _config_dir_cache.clear()


def find_config_directory(
    ignore_cache: bool = False,
    env: dict[str, str] | None = None,
) -> str:
    """Find the directory where JSON config files are located.

    Search order:
    1. SMOOAI_ENV_CONFIG_DIR env var
    2. CWD/.smooai-config or CWD/smooai-config
    3. Walk up directory tree (max 5 levels, configurable via SMOOAI_CONFIG_LEVELS_UP_LIMIT)

    Results cached with 1h TTL.
    """
    if env is None:
        env = dict(os.environ)

    # 1. SMOOAI_ENV_CONFIG_DIR
    config_dir = env.get("SMOOAI_ENV_CONFIG_DIR")
    if config_dir:
        if Path(config_dir).is_dir():
            return config_dir
        raise SmooaiConfigError(
            f'The directory specified in the "SMOOAI_ENV_CONFIG_DIR" environment variable does not exist: {config_dir}'
        )

    # 2. Check cache
    if not ignore_cache:
        with _config_dir_lock:
            cached = _config_dir_cache.get("smooai-config")
            if cached:
                cached_dir, cached_at = cached
                if time.time() - cached_at < _CONFIG_DIR_TTL:
                    if Path(cached_dir).is_dir():
                        return cached_dir
                    # Cache invalid
                    del _config_dir_cache["smooai-config"]

    # 3. CWD candidates
    cwd = Path.cwd()
    candidates = [".smooai-config", "smooai-config"]

    for candidate in candidates:
        candidate_path = cwd / candidate
        if candidate_path.is_dir():
            with _config_dir_lock:
                _config_dir_cache["smooai-config"] = (str(candidate_path), time.time())
            return str(candidate_path)

    # 4. Walk up directory tree
    levels_up_limit_str = env.get("SMOOAI_CONFIG_LEVELS_UP_LIMIT", "5")
    try:
        levels_up_limit = int(levels_up_limit_str)
    except ValueError:
        levels_up_limit = 5

    search_dir = cwd
    for _ in range(levels_up_limit):
        search_dir = search_dir.parent
        if search_dir == search_dir.parent:
            break  # reached root
        for candidate in candidates:
            candidate_path = search_dir / candidate
            if candidate_path.is_dir():
                with _config_dir_lock:
                    _config_dir_cache["smooai-config"] = (str(candidate_path), time.time())
                return str(candidate_path)

    raise SmooaiConfigError(
        f"Could not find the directory where the config files are located. "
        f"Tried {levels_up_limit} levels up from {cwd}."
    )


def find_and_process_file_config(
    schema_keys: set[str] | None = None,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Load and merge JSON config files in priority order.

    Merge order:
    1. default.json (REQUIRED)
    2. local.json (if IS_LOCAL env var is truthy)
    3. {env}.json (env from SMOOAI_CONFIG_ENV, default 'development')
    4. {env}.{provider}.json
    5. {env}.{provider}.{region}.json

    Sets built-in keys: ENV, IS_LOCAL, REGION, CLOUD_PROVIDER.
    """
    if env is None:
        env = dict(os.environ)

    config_dir = find_config_directory(env=env)

    is_local = coerce_boolean(env.get("IS_LOCAL", ""))
    env_name = env.get("SMOOAI_CONFIG_ENV", "development")
    cloud_region = get_cloud_region(env)

    # Build file list in merge order
    config_files: list[str] = ["default.json"]
    if is_local:
        config_files.append("local.json")
    if env_name:
        config_files.append(f"{env_name}.json")
        if cloud_region.provider and cloud_region.provider != "unknown":
            config_files.append(f"{env_name}.{cloud_region.provider}.json")
            if cloud_region.region and cloud_region.region != "unknown":
                config_files.append(f"{env_name}.{cloud_region.provider}.{cloud_region.region}.json")

    final_config: dict[str, Any] = {}

    for file_name in config_files:
        file_path = Path(config_dir) / file_name
        if not file_path.exists():
            if file_name == "default.json":
                raise SmooaiConfigError(f'Could not find required default config file in {config_dir}: "{file_name}"')
            continue  # optional files

        try:
            with open(file_path) as f:
                file_config = json.load(f)
        except (json.JSONDecodeError, OSError) as err:
            raise SmooaiConfigError(f'Error reading config file "{file_path}": {err}') from err

        final_config = merge_replace_arrays(final_config, file_config)

    # Set built-in keys
    final_config["ENV"] = env_name
    final_config["IS_LOCAL"] = is_local
    final_config["REGION"] = cloud_region.region
    final_config["CLOUD_PROVIDER"] = cloud_region.provider

    return final_config
