"""Tests for deep merge with array replacement."""

from smooai_config.merge import merge_replace_arrays


class TestMergeReplaceArrays:
    # --- Primitive overwrites ---

    def test_string_overwrites_string(self) -> None:
        assert merge_replace_arrays("old", "new") == "new"

    def test_number_overwrites_number(self) -> None:
        assert merge_replace_arrays(1, 2) == 2

    def test_bool_overwrites_bool(self) -> None:
        assert merge_replace_arrays(True, False) is False

    def test_none_overwrites_value(self) -> None:
        assert merge_replace_arrays("hello", None) is None

    def test_value_overwrites_none(self) -> None:
        assert merge_replace_arrays(None, "hello") == "hello"

    # --- Array replacement (not concatenation) ---

    def test_array_replaces_array(self) -> None:
        result = merge_replace_arrays([1, 2, 3], [4, 5])
        assert result == [4, 5]

    def test_array_replaces_completely(self) -> None:
        result = merge_replace_arrays([1, 2, 3], [])
        assert result == []

    def test_array_replaces_non_array(self) -> None:
        result = merge_replace_arrays("not-array", [1, 2])
        assert result == [1, 2]

    def test_array_is_new_copy(self) -> None:
        source = [1, 2, 3]
        result = merge_replace_arrays([], source)
        assert result == [1, 2, 3]
        assert result is not source  # must be a copy

    # --- Recursive object merge ---

    def test_flat_object_merge(self) -> None:
        target = {"a": 1, "b": 2}
        source = {"b": 3, "c": 4}
        result = merge_replace_arrays(target, source)
        assert result == {"a": 1, "b": 3, "c": 4}

    def test_nested_object_merge(self) -> None:
        target = {"a": {"x": 1, "y": 2}, "b": 3}
        source = {"a": {"y": 10, "z": 20}}
        result = merge_replace_arrays(target, source)
        assert result == {"a": {"x": 1, "y": 10, "z": 20}, "b": 3}

    def test_deeply_nested_merge(self) -> None:
        target = {"a": {"b": {"c": 1, "d": 2}}}
        source = {"a": {"b": {"d": 3, "e": 4}}}
        result = merge_replace_arrays(target, source)
        assert result == {"a": {"b": {"c": 1, "d": 3, "e": 4}}}

    def test_source_object_creates_missing_keys(self) -> None:
        target = {"a": 1}
        source = {"b": {"x": 10}}
        result = merge_replace_arrays(target, source)
        assert result == {"a": 1, "b": {"x": 10}}

    def test_object_overwrites_non_object_target(self) -> None:
        result = merge_replace_arrays("not-object", {"a": 1})
        assert result == {"a": 1}

    # --- Mixed types ---

    def test_array_in_object_gets_replaced(self) -> None:
        target = {"a": [1, 2, 3], "b": "keep"}
        source = {"a": [4, 5]}
        result = merge_replace_arrays(target, source)
        assert result == {"a": [4, 5], "b": "keep"}

    def test_nested_array_in_deep_object(self) -> None:
        target = {"a": {"items": [1, 2, 3], "count": 3}}
        source = {"a": {"items": [10, 20]}}
        result = merge_replace_arrays(target, source)
        assert result == {"a": {"items": [10, 20], "count": 3}}

    def test_primitive_replaces_object(self) -> None:
        target = {"a": {"x": 1}}
        source = {"a": 42}
        result = merge_replace_arrays(target, source)
        assert result == {"a": 42}

    def test_object_replaces_primitive(self) -> None:
        target = {"a": 42}
        source = {"a": {"x": 1}}
        result = merge_replace_arrays(target, source)
        assert result == {"a": {"x": 1}}

    # --- Empty values ---

    def test_empty_source_preserves_target(self) -> None:
        target = {"a": 1, "b": 2}
        result = merge_replace_arrays(target, {})
        assert result == {"a": 1, "b": 2}

    def test_empty_target_uses_source(self) -> None:
        source = {"a": 1, "b": 2}
        result = merge_replace_arrays({}, source)
        assert result == {"a": 1, "b": 2}

    def test_both_empty(self) -> None:
        result = merge_replace_arrays({}, {})
        assert result == {}

    # --- Does not mutate originals ---

    def test_does_not_mutate_target(self) -> None:
        target = {"a": {"x": 1}, "b": 2}
        source = {"a": {"y": 3}}
        original_target = {"a": {"x": 1}, "b": 2}
        merge_replace_arrays(target, source)
        assert target == original_target

    def test_does_not_mutate_source(self) -> None:
        target = {"a": 1}
        source = {"b": {"x": 10}}
        original_source = {"b": {"x": 10}}
        merge_replace_arrays(target, source)
        assert source == original_source

    # --- Database config scenario (matches integration tests) ---

    def test_partial_database_override(self) -> None:
        """Mimic production.aws.json overriding only DATABASE.host."""
        base = {
            "DATABASE": {"host": "prod-db.example.com", "port": 5432, "ssl": True},
            "API_URL": "https://api.example.com",
        }
        override = {
            "DATABASE": {"host": "aws-prod-db.example.com"},
        }
        result = merge_replace_arrays(base, override)
        assert result == {
            "DATABASE": {"host": "aws-prod-db.example.com", "port": 5432, "ssl": True},
            "API_URL": "https://api.example.com",
        }
