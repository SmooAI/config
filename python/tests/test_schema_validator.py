"""Tests for cross-language schema validation."""

import json
from pathlib import Path

import pytest

from smooai_config.schema_validator import validate_smooai_schema

FIXTURES_PATH = Path(__file__).resolve().parent.parent.parent / "test-fixtures" / "schema-validation-cases.json"
FIXTURES = json.loads(FIXTURES_PATH.read_text())


class TestValidSchemas:
    """All schemas in the 'valid' list must pass validation."""

    @pytest.mark.parametrize("case", FIXTURES["valid"], ids=lambda c: c["name"])
    def test_valid_schema(self, case: dict) -> None:
        result = validate_smooai_schema(case["schema"])
        assert result.valid, f"Expected valid but got errors: {[e.keyword for e in result.errors]}"
        assert len(result.errors) == 0


class TestInvalidSchemas:
    """All schemas in the 'invalid' list must fail with the expected keywords."""

    @pytest.mark.parametrize("case", FIXTURES["invalid"], ids=lambda c: c["name"])
    def test_invalid_schema(self, case: dict) -> None:
        result = validate_smooai_schema(case["schema"])
        assert not result.valid
        assert len(result.errors) > 0

        reported_keywords = {e.keyword for e in result.errors}
        for expected in case["expected_keywords"]:
            assert expected in reported_keywords, f'Expected keyword "{expected}" in errors, got {reported_keywords}'


class TestErrorStructure:
    """Errors must include path, keyword, message, and suggestion."""

    def test_error_fields(self) -> None:
        schema = {
            "type": "object",
            "properties": {
                "value": {"not": {"type": "string"}},
            },
        }
        result = validate_smooai_schema(schema)
        assert not result.valid
        assert len(result.errors) == 1
        error = result.errors[0]
        assert error.path == "/properties/value"
        assert error.keyword == "not"
        assert "not" in error.message
        assert error.suggestion

    def test_unsupported_format(self) -> None:
        schema = {
            "type": "object",
            "properties": {
                "field": {"type": "string", "format": "hostname"},
            },
        }
        result = validate_smooai_schema(schema)
        assert not result.valid
        assert result.errors[0].keyword == "format"
        assert "hostname" in result.errors[0].message

    def test_supported_format(self) -> None:
        schema = {
            "type": "object",
            "properties": {
                "email": {"type": "string", "format": "email"},
            },
        }
        result = validate_smooai_schema(schema)
        assert result.valid


class TestNestedDetection:
    """Unsupported keywords in nested schemas must be detected."""

    def test_deeply_nested(self) -> None:
        schema = {
            "type": "object",
            "properties": {
                "level1": {
                    "type": "object",
                    "properties": {
                        "level2": {
                            "type": "object",
                            "patternProperties": {"^x-": {"type": "string"}},
                        },
                    },
                },
            },
        }
        result = validate_smooai_schema(schema)
        assert not result.valid
        assert result.errors[0].path == "/properties/level1/properties/level2"

    def test_inside_anyof(self) -> None:
        schema = {
            "type": "object",
            "properties": {
                "value": {
                    "anyOf": [
                        {"type": "string"},
                        {"type": "object", "patternProperties": {"^x-": {"type": "string"}}},
                    ],
                },
            },
        }
        result = validate_smooai_schema(schema)
        assert not result.valid
        assert "anyOf/1" in result.errors[0].path

    def test_inside_defs(self) -> None:
        schema = {
            "type": "object",
            "$defs": {
                "BadDef": {
                    "type": "object",
                    "dependencies": {"a": ["b"]},
                },
            },
            "properties": {},
        }
        result = validate_smooai_schema(schema)
        assert not result.valid
        assert "$defs/BadDef" in result.errors[0].path


class TestEdgeCases:
    """Edge cases and empty schemas."""

    def test_empty_schema(self) -> None:
        result = validate_smooai_schema({})
        assert result.valid

    def test_metadata_only(self) -> None:
        result = validate_smooai_schema(
            {
                "$schema": "http://json-schema.org/draft-07/schema#",
                "title": "Test",
                "description": "A test schema",
            }
        )
        assert result.valid
