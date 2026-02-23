"""Tests for utility functions."""

import pytest

from smooai_config.utils import SmooaiConfigError, camel_to_upper_snake, coerce_boolean


class TestCamelToUpperSnake:
    def test_api_url(self) -> None:
        assert camel_to_upper_snake("apiUrl") == "API_URL"

    def test_max_retries(self) -> None:
        assert camel_to_upper_snake("maxRetries") == "MAX_RETRIES"

    def test_enable_debug(self) -> None:
        assert camel_to_upper_snake("enableDebug") == "ENABLE_DEBUG"

    def test_app_name(self) -> None:
        assert camel_to_upper_snake("appName") == "APP_NAME"

    def test_database(self) -> None:
        assert camel_to_upper_snake("database") == "DATABASE"

    def test_api_key(self) -> None:
        assert camel_to_upper_snake("apiKey") == "API_KEY"

    def test_db_password(self) -> None:
        assert camel_to_upper_snake("dbPassword") == "DB_PASSWORD"

    def test_jwt_secret(self) -> None:
        assert camel_to_upper_snake("jwtSecret") == "JWT_SECRET"

    def test_enable_new_ui(self) -> None:
        assert camel_to_upper_snake("enableNewUI") == "ENABLE_NEW_UI"

    def test_enable_beta(self) -> None:
        assert camel_to_upper_snake("enableBeta") == "ENABLE_BETA"

    def test_maintenance_mode(self) -> None:
        assert camel_to_upper_snake("maintenanceMode") == "MAINTENANCE_MODE"

    def test_already_upper_snake_case(self) -> None:
        assert camel_to_upper_snake("API_URL") == "API_URL"
        assert camel_to_upper_snake("MAX_RETRIES") == "MAX_RETRIES"
        assert camel_to_upper_snake("DATABASE") == "DATABASE"

    def test_acronym_handling(self) -> None:
        assert camel_to_upper_snake("apiURL") == "API_URL"

    def test_empty_string(self) -> None:
        assert camel_to_upper_snake("") == ""

    def test_single_char(self) -> None:
        assert camel_to_upper_snake("a") == "A"
        assert camel_to_upper_snake("A") == "A"

    def test_all_lowercase(self) -> None:
        assert camel_to_upper_snake("hello") == "HELLO"

    def test_with_numbers(self) -> None:
        assert camel_to_upper_snake("api2Key") == "API2_KEY"


class TestCoerceBoolean:
    def test_true_string(self) -> None:
        assert coerce_boolean("true") is True

    def test_false_string(self) -> None:
        assert coerce_boolean("false") is False

    def test_one_string(self) -> None:
        assert coerce_boolean("1") is True

    def test_zero_string(self) -> None:
        assert coerce_boolean("0") is False

    def test_true_bool(self) -> None:
        assert coerce_boolean(True) is True

    def test_false_bool(self) -> None:
        assert coerce_boolean(False) is False

    def test_one_int(self) -> None:
        assert coerce_boolean(1) is True

    def test_zero_int(self) -> None:
        assert coerce_boolean(0) is False

    def test_true_uppercase(self) -> None:
        assert coerce_boolean("TRUE") is True

    def test_true_mixed_case(self) -> None:
        assert coerce_boolean("True") is True

    def test_empty_string(self) -> None:
        assert coerce_boolean("") is False

    def test_random_string(self) -> None:
        assert coerce_boolean("yes") is False

    def test_none(self) -> None:
        assert coerce_boolean(None) is False


class TestSmooaiConfigError:
    def test_message_format(self) -> None:
        err = SmooaiConfigError("test error")
        assert str(err) == "[Smooai Config] test error"

    def test_is_exception(self) -> None:
        err = SmooaiConfigError("test")
        assert isinstance(err, Exception)

    def test_can_be_raised_and_caught(self) -> None:
        with pytest.raises(SmooaiConfigError, match=r"\[Smooai Config\] something went wrong"):
            raise SmooaiConfigError("something went wrong")
