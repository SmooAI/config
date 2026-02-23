"""Integration tests for the Python SDK ConfigClient.

Uses httpx.MockTransport with a realistic mock server that simulates
the Smoo AI config API matching the backend in packages/backend.
"""

import time
from unittest.mock import patch

import httpx
import pytest

from smooai_config.client import ConfigClient

# ---------------------------------------------------------------------------
# Test data — mirrors the API contract from packages/backend/src/routes/config
# ---------------------------------------------------------------------------

TEST_BASE_URL = "https://config-test.smooai.dev"
TEST_API_KEY = "test-api-key-abc123"
TEST_ORG_ID = "550e8400-e29b-41d4-a716-446655440000"

CONFIG_STORE: dict[str, dict[str, object]] = {
    "production": {
        "API_URL": "https://api.smooai.com",
        "MAX_RETRIES": 3,
        "ENABLE_NEW_UI": True,
        "DATABASE_URL": "postgres://prod:secret@db.smooai.com/prod",
        "COMPLEX_VALUE": {"nested": {"deep": True}, "list": [1, 2, 3]},
    },
    "staging": {
        "API_URL": "https://staging-api.smooai.com",
        "MAX_RETRIES": 5,
        "ENABLE_NEW_UI": False,
        "DATABASE_URL": "postgres://staging:secret@db.smooai.com/staging",
    },
    "development": {
        "API_URL": "http://localhost:3000",
        "MAX_RETRIES": 10,
        "ENABLE_NEW_UI": True,
    },
}


# ---------------------------------------------------------------------------
# Realistic mock transport matching the backend API behavior
# ---------------------------------------------------------------------------


class RequestLog:
    """Track HTTP requests for cache verification."""

    def __init__(self) -> None:
        self.requests: list[dict[str, str]] = []

    def clear(self) -> None:
        self.requests.clear()

    @property
    def count(self) -> int:
        return len(self.requests)


request_log = RequestLog()


def create_mock_transport(
    *,
    api_key: str = TEST_API_KEY,
    org_id: str = TEST_ORG_ID,
) -> httpx.MockTransport:
    """Create a mock transport simulating the Smoo AI config API."""

    def handler(request: httpx.Request) -> httpx.Response:
        request_log.requests.append(
            {
                "method": str(request.method),
                "url": str(request.url),
                "auth": request.headers.get("authorization", ""),
            }
        )

        # Auth check
        auth_header = request.headers.get("authorization", "")
        if auth_header != f"Bearer {api_key}":
            return httpx.Response(401, json={"error": "Unauthorized", "message": "Invalid or missing API key"})

        url_path = request.url.path

        # GET /organizations/{org_id}/config/values/{key}?environment=...
        values_prefix = f"/organizations/{org_id}/config/values/"
        values_base = f"/organizations/{org_id}/config/values"

        if url_path.startswith(values_prefix) and url_path != values_base:
            key = url_path[len(values_prefix) :]
            environment = dict(request.url.params).get("environment", "development")
            env_store = CONFIG_STORE.get(environment, {})

            if key not in env_store:
                return httpx.Response(
                    404,
                    json={
                        "error": "Not found",
                        "message": f'Config key "{key}" not found in environment "{environment}"',
                    },
                )

            return httpx.Response(200, json={"value": env_store[key]})

        # GET /organizations/{org_id}/config/values?environment=...
        if url_path == values_base:
            environment = dict(request.url.params).get("environment", "development")
            env_store = CONFIG_STORE.get(environment, {})
            return httpx.Response(200, json={"values": env_store})

        return httpx.Response(404, json={"error": "Not found"})

    return httpx.MockTransport(handler)


def create_client(
    *,
    transport: httpx.MockTransport | None = None,
    environment: str = "production",
    api_key: str = TEST_API_KEY,
    org_id: str = TEST_ORG_ID,
    cache_ttl_seconds: float = 0,
) -> ConfigClient:
    """Create a ConfigClient with mocked transport."""
    t = transport or create_mock_transport(api_key=api_key, org_id=org_id)
    client = ConfigClient(
        base_url=TEST_BASE_URL,
        api_key=api_key,
        org_id=org_id,
        environment=environment,
        cache_ttl_seconds=cache_ttl_seconds,
    )
    client._client = httpx.Client(
        base_url=TEST_BASE_URL,
        headers={"Authorization": f"Bearer {api_key}"},
        transport=t,
    )
    return client


@pytest.fixture(autouse=True)
def _clear_request_log() -> None:
    request_log.clear()


# ---------------------------------------------------------------------------
# getValue
# ---------------------------------------------------------------------------


class TestGetValue:
    """Integration tests for get_value()."""

    def test_fetches_string_value(self) -> None:
        with create_client(environment="production") as client:
            result = client.get_value("API_URL")
            assert result == "https://api.smooai.com"

    def test_fetches_numeric_value(self) -> None:
        with create_client(environment="production") as client:
            result = client.get_value("MAX_RETRIES")
            assert result == 3

    def test_fetches_boolean_value(self) -> None:
        with create_client(environment="production") as client:
            result = client.get_value("ENABLE_NEW_UI")
            assert result is True

    def test_fetches_complex_nested_json(self) -> None:
        with create_client(environment="production") as client:
            result = client.get_value("COMPLEX_VALUE")
            assert result == {"nested": {"deep": True}, "list": [1, 2, 3]}

    def test_explicit_environment_overrides_default(self) -> None:
        with create_client(environment="production") as client:
            result = client.get_value("API_URL", environment="staging")
            assert result == "https://staging-api.smooai.com"

    def test_uses_default_environment(self) -> None:
        with create_client(environment="development") as client:
            result = client.get_value("API_URL")
            assert result == "http://localhost:3000"

    def test_sends_correct_auth_header(self) -> None:
        with create_client(environment="production") as client:
            client.get_value("API_URL")
            assert request_log.count == 1
            assert request_log.requests[0]["auth"] == f"Bearer {TEST_API_KEY}"

    def test_raises_on_401_unauthorized(self) -> None:
        # Use default transport (expects TEST_API_KEY) but send bad-key
        transport = create_mock_transport()
        client = ConfigClient(
            base_url=TEST_BASE_URL,
            api_key="bad-key",
            org_id=TEST_ORG_ID,
            environment="production",
        )
        client._client = httpx.Client(
            base_url=TEST_BASE_URL,
            headers={"Authorization": "Bearer bad-key"},
            transport=transport,
        )
        with client:
            with pytest.raises(httpx.HTTPStatusError) as exc_info:
                client.get_value("API_URL")
            assert exc_info.value.response.status_code == 401

    def test_raises_on_404_missing_key(self) -> None:
        with create_client(environment="production") as client:
            with pytest.raises(httpx.HTTPStatusError) as exc_info:
                client.get_value("NONEXISTENT_KEY")
            assert exc_info.value.response.status_code == 404

    def test_raises_on_500_server_error(self) -> None:
        def error_handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500, json={"error": "Internal server error"})

        transport = httpx.MockTransport(error_handler)
        with create_client(transport=transport, environment="production") as client:
            with pytest.raises(httpx.HTTPStatusError) as exc_info:
                client.get_value("API_URL")
            assert exc_info.value.response.status_code == 500


# ---------------------------------------------------------------------------
# getAllValues
# ---------------------------------------------------------------------------


class TestGetAllValues:
    """Integration tests for get_all_values()."""

    def test_fetches_all_production_values(self) -> None:
        with create_client(environment="production") as client:
            result = client.get_all_values()
            assert result == CONFIG_STORE["production"]

    def test_fetches_all_staging_values(self) -> None:
        with create_client(environment="staging") as client:
            result = client.get_all_values()
            assert result == CONFIG_STORE["staging"]

    def test_explicit_environment_overrides_default(self) -> None:
        with create_client(environment="production") as client:
            result = client.get_all_values(environment="staging")
            assert result == CONFIG_STORE["staging"]

    def test_returns_empty_dict_for_unknown_environment(self) -> None:
        with create_client(environment="nonexistent") as client:
            result = client.get_all_values()
            assert result == {}

    def test_sends_correct_auth_header(self) -> None:
        with create_client(environment="production") as client:
            client.get_all_values()
            assert request_log.count == 1
            assert request_log.requests[0]["auth"] == f"Bearer {TEST_API_KEY}"

    def test_raises_on_401_unauthorized(self) -> None:
        transport = create_mock_transport()
        client = ConfigClient(
            base_url=TEST_BASE_URL,
            api_key="bad-key",
            org_id=TEST_ORG_ID,
            environment="production",
        )
        client._client = httpx.Client(
            base_url=TEST_BASE_URL,
            headers={"Authorization": "Bearer bad-key"},
            transport=transport,
        )
        with client:
            with pytest.raises(httpx.HTTPStatusError) as exc_info:
                client.get_all_values()
            assert exc_info.value.response.status_code == 401

    def test_raises_on_500_server_error(self) -> None:
        def error_handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500, json={"error": "Internal server error"})

        transport = httpx.MockTransport(error_handler)
        with create_client(transport=transport, environment="production") as client:
            with pytest.raises(httpx.HTTPStatusError) as exc_info:
                client.get_all_values()
            assert exc_info.value.response.status_code == 500


# ---------------------------------------------------------------------------
# Caching behavior
# ---------------------------------------------------------------------------


class TestCaching:
    """Integration tests for local cache behavior."""

    def test_get_value_caches_result(self) -> None:
        with create_client(environment="production") as client:
            result1 = client.get_value("API_URL")
            assert result1 == "https://api.smooai.com"
            assert request_log.count == 1

            result2 = client.get_value("API_URL")
            assert result2 == "https://api.smooai.com"
            assert request_log.count == 1  # No additional request

    def test_cache_is_per_environment(self) -> None:
        with create_client(environment="production") as client:
            client.get_value("API_URL")
            assert request_log.count == 1

            client.get_value("API_URL", environment="staging")
            assert request_log.count == 2  # Different env = new request

    def test_get_all_values_populates_cache_for_get_value(self) -> None:
        with create_client(environment="production") as client:
            client.get_all_values()
            assert request_log.count == 1

            # Individual reads should come from cache
            assert client.get_value("API_URL") == "https://api.smooai.com"
            assert client.get_value("MAX_RETRIES") == 3
            assert client.get_value("ENABLE_NEW_UI") is True
            assert request_log.count == 1  # Still just 1 request

    def test_invalidate_cache_forces_refetch(self) -> None:
        with create_client(environment="production") as client:
            client.get_value("API_URL")
            assert request_log.count == 1

            client.invalidate_cache()

            client.get_value("API_URL")
            assert request_log.count == 2  # Re-fetched

    def test_invalidate_cache_clears_all_environments(self) -> None:
        with create_client(environment="production") as client:
            client.get_value("API_URL")
            client.get_value("API_URL", environment="staging")
            assert request_log.count == 2

            client.invalidate_cache()

            client.get_value("API_URL")
            client.get_value("API_URL", environment="staging")
            assert request_log.count == 4  # Both re-fetched

    def test_get_all_values_for_one_env_does_not_cache_another(self) -> None:
        with create_client(environment="production") as client:
            client.get_all_values()
            assert request_log.count == 1

            # Different environment needs new fetch
            client.get_value("API_URL", environment="staging")
            assert request_log.count == 2

    def test_cache_key_format_is_env_colon_key(self) -> None:
        with create_client(environment="production") as client:
            client.get_value("API_URL")
            assert "production:API_URL" in client._cache


# ---------------------------------------------------------------------------
# Full workflow integration scenarios
# ---------------------------------------------------------------------------


class TestFullWorkflow:
    """End-to-end workflow tests."""

    def test_fetch_all_then_read_individual_then_invalidate(self) -> None:
        with create_client(environment="production") as client:
            # 1. Fetch all
            all_values = client.get_all_values()
            assert len(all_values) == 5
            assert request_log.count == 1

            # 2. Read individuals from cache
            assert client.get_value("API_URL") == "https://api.smooai.com"
            assert client.get_value("DATABASE_URL") == "postgres://prod:secret@db.smooai.com/prod"
            assert request_log.count == 1  # No new requests

            # 3. Invalidate and re-fetch
            client.invalidate_cache()
            assert client.get_value("API_URL") == "https://api.smooai.com"
            assert request_log.count == 2

    def test_multi_environment_workflow(self) -> None:
        with create_client(environment="production") as client:
            # Fetch across environments
            prod_url = client.get_value("API_URL")
            staging_url = client.get_value("API_URL", environment="staging")
            dev_url = client.get_value("API_URL", environment="development")

            assert prod_url == "https://api.smooai.com"
            assert staging_url == "https://staging-api.smooai.com"
            assert dev_url == "http://localhost:3000"
            assert request_log.count == 3

            # All cached — no new requests
            assert client.get_value("API_URL") == "https://api.smooai.com"
            assert client.get_value("API_URL", environment="staging") == "https://staging-api.smooai.com"
            assert client.get_value("API_URL", environment="development") == "http://localhost:3000"
            assert request_log.count == 3

    def test_mixed_get_value_and_get_all_values(self) -> None:
        with create_client(environment="production") as client:
            # Single fetch first
            client.get_value("API_URL")
            assert request_log.count == 1

            # Fetch all — API_URL already cached, but getAllValues still hits server
            client.get_all_values()
            assert request_log.count == 2

            # Now all values cached
            assert client.get_value("MAX_RETRIES") == 3
            assert client.get_value("ENABLE_NEW_UI") is True
            assert request_log.count == 2


class TestTTLCaching:
    """Integration tests for cache TTL behavior."""

    def test_serves_from_cache_within_ttl(self) -> None:
        with create_client(cache_ttl_seconds=60.0) as client:
            client.get_value("API_URL", environment="production")
            assert request_log.count == 1

            # Still cached
            client.get_value("API_URL", environment="production")
            assert request_log.count == 1

    def test_refetches_after_ttl_expires(self) -> None:
        fake_time = [time.monotonic()]

        with patch("smooai_config.client.time.monotonic", side_effect=lambda: fake_time[0]):
            with create_client(cache_ttl_seconds=0.1) as client:
                client.get_value("API_URL", environment="production")
                assert request_log.count == 1

                # Still within TTL
                client.get_value("API_URL", environment="production")
                assert request_log.count == 1

                # Advance past TTL
                fake_time[0] += 0.2

                client.get_value("API_URL", environment="production")
                assert request_log.count == 2

    def test_no_ttl_means_cache_never_expires(self) -> None:
        fake_time = [time.monotonic()]

        with patch("smooai_config.client.time.monotonic", side_effect=lambda: fake_time[0]):
            with create_client() as client:  # No TTL
                client.get_value("API_URL", environment="production")
                assert request_log.count == 1

                # Advance time significantly
                fake_time[0] += 86400  # 24 hours

                client.get_value("API_URL", environment="production")
                assert request_log.count == 1  # Still cached

    def test_get_all_values_respects_ttl(self) -> None:
        fake_time = [time.monotonic()]

        with patch("smooai_config.client.time.monotonic", side_effect=lambda: fake_time[0]):
            with create_client(cache_ttl_seconds=0.1) as client:
                client.get_all_values(environment="production")
                assert request_log.count == 1

                # Cached
                client.get_value("API_URL", environment="production")
                assert request_log.count == 1

                # Expire
                fake_time[0] += 0.2

                client.get_value("API_URL", environment="production")
                assert request_log.count == 2


class TestInvalidateCacheForEnvironment:
    """Integration tests for environment-specific cache invalidation."""

    def test_clears_only_target_environment(self) -> None:
        with create_client() as client:
            client.get_value("API_URL", environment="production")
            client.get_value("API_URL", environment="staging")
            assert request_log.count == 2

            client.invalidate_cache_for_environment("production")

            # Production re-fetched
            client.get_value("API_URL", environment="production")
            assert request_log.count == 3

            # Staging still cached
            client.get_value("API_URL", environment="staging")
            assert request_log.count == 3

    def test_clears_all_keys_for_environment(self) -> None:
        with create_client() as client:
            client.get_all_values(environment="production")
            assert request_log.count == 1

            client.invalidate_cache_for_environment("production")

            # All production keys need re-fetch
            client.get_value("API_URL", environment="production")
            client.get_value("MAX_RETRIES", environment="production")
            assert request_log.count == 3

    def test_noop_for_nonexistent_environment(self) -> None:
        with create_client() as client:
            client.get_value("API_URL", environment="production")
            assert request_log.count == 1

            client.invalidate_cache_for_environment("nonexistent")

            client.get_value("API_URL", environment="production")
            assert request_log.count == 1  # Still cached
