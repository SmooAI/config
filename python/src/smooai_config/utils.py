"""Utility functions for configuration management."""

import re
from typing import Any


class SmooaiConfigError(Exception):
    """Configuration error with standard prefix."""

    def __init__(self, message: str) -> None:
        super().__init__(f"[Smooai Config] {message}")


_UPPER_SNAKE_RE = re.compile(r"^[A-Z0-9]+(?:_[A-Z0-9]+)*$")


def camel_to_upper_snake(input_str: str) -> str:
    """Convert camelCase to UPPER_SNAKE_CASE.

    One-pass conversion:
    - Early exit if already UPPER_SNAKE_CASE
    - Drops underscores/spaces
    - Splits on lower→Upper and Acronym→Word boundaries
    """
    if not input_str:
        return input_str

    # Early return if already UPPER_SNAKE_CASE
    if _UPPER_SNAKE_RE.match(input_str):
        return input_str

    out: list[str] = []
    length = len(input_str)

    for i in range(length):
        ch = input_str[i]

        # Skip underscores and spaces
        if ch in ("_", " "):
            continue

        if ch.isupper():
            # Split on lower→upper or acronym→word
            if i > 0:
                prev = input_str[i - 1]
                prev_is_lower = prev.islower()
                next_is_lower = (i + 1 < length) and input_str[i + 1].islower()
                if prev_is_lower or next_is_lower:
                    out.append("_")
            out.append(ch)
        elif ch.islower():
            out.append(ch.upper())
        else:
            # digits and other chars
            out.append(ch)

    return "".join(out)


def coerce_boolean(value: Any) -> bool:
    """Coerce a value to boolean.

    "true", "1", 1, True → True; everything else → False.
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value == 1
    if isinstance(value, str):
        return value.lower().strip() in ("true", "1")
    return False
