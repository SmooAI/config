"""Deep merge utility with array replacement."""

from typing import Any


def _is_plain_object(obj: Any) -> bool:
    """Check if obj is a plain dict (not list, not None, not primitive)."""
    return isinstance(obj, dict)


def merge_replace_arrays(target: Any, source: Any) -> Any:
    """Deep merge where arrays replace entirely, dicts recurse, primitives overwrite.

    Args:
        target: The base value to merge into.
        source: The value to merge from (takes precedence).

    Returns:
        The merged result.
    """
    # If source is a list, replace entirely
    if isinstance(source, list):
        return list(source)  # new copy

    # If source is a dict, merge recursively
    if _is_plain_object(source):
        if not _is_plain_object(target):
            target = {}
        else:
            target = dict(target)  # shallow copy to avoid mutating original
        for key in source:
            target[key] = merge_replace_arrays(target.get(key), source[key])
        return target

    # For primitives (string, number, etc.) or other data, overwrite
    return source
