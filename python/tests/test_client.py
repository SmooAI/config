"""Tests for ConfigClient."""

import httpx
import pytest

from smooai_config.client import ConfigClient


@pytest.fixture
def mock_transport() -> httpx.MockTransport:
    """Create a mock transport for httpx."""

    def handler(request: httpx.Request) -> httpx.Response:
        if "/config/values/" in str(request.url) and "all_values" not in str(request.url):
            # Single value endpoint
            key = str(request.url).split("/config/values/")[-1].split("?")[0]
            return httpx.Response(200, json={"value": f"value-for-{key}"})
        elif "/config/values" in str(request.url):
            # All values endpoint
            return httpx.Response(
                200,
                json={
                    "values": {
                        "API_URL": "https://api.example.com",
                        "MAX_RETRIES": 3,
                        "DEBUG": False,
                    }
                },
            )
        return httpx.Response(404)

    return httpx.MockTransport(handler)


@pytest.fixture
def client(mock_transport: httpx.MockTransport) -> ConfigClient:
    """Create a ConfigClient with mocked transport."""
    c = ConfigClient(
        base_url="https://config.smooai.dev",
        api_key="test-api-key",
        org_id="550e8400-e29b-41d4-a716-446655440000",
    )
    # Replace the internal client with one using mock transport
    c._client = httpx.Client(
        base_url="https://config.smooai.dev",
        headers={"Authorization": "Bearer test-api-key"},
        transport=mock_transport,
    )
    return c


class TestConfigClientInit:
    """Tests for ConfigClient initialization."""

    def test_strips_trailing_slash(self) -> None:
        with ConfigClient(
            base_url="https://config.smooai.dev/",
            api_key="key",
            org_id="org-id",
        ) as c:
            assert c._base_url == "https://config.smooai.dev"

    def test_sets_authorization_header(self) -> None:
        with ConfigClient(
            base_url="https://config.smooai.dev",
            api_key="my-secret-key",
            org_id="org-id",
        ) as c:
            assert c._headers == {"Authorization": "Bearer my-secret-key"}

    def test_initializes_empty_cache(self) -> None:
        with ConfigClient(
            base_url="https://config.smooai.dev",
            api_key="key",
            org_id="org-id",
        ) as c:
            assert c._cache == {}

    def test_reads_from_env_vars(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("SMOOAI_CONFIG_API_URL", "https://env.example.com")
        monkeypatch.setenv("SMOOAI_CONFIG_API_KEY", "env-key")
        monkeypatch.setenv("SMOOAI_CONFIG_ORG_ID", "env-org")
        monkeypatch.setenv("SMOOAI_CONFIG_ENV", "staging")

        with ConfigClient() as c:
            assert c._base_url == "https://env.example.com"
            assert c._org_id == "env-org"
            assert c._default_environment == "staging"

    def test_explicit_args_override_env_vars(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("SMOOAI_CONFIG_API_URL", "https://env.example.com")
        monkeypatch.setenv("SMOOAI_CONFIG_API_KEY", "env-key")
        monkeypatch.setenv("SMOOAI_CONFIG_ORG_ID", "env-org")

        with ConfigClient(
            base_url="https://explicit.example.com",
            api_key="explicit-key",
            org_id="explicit-org",
        ) as c:
            assert c._base_url == "https://explicit.example.com"
            assert c._org_id == "explicit-org"

    def test_raises_without_base_url(self) -> None:
        with pytest.raises(ValueError, match="base_url is required"):
            ConfigClient(api_key="key", org_id="org")

    def test_raises_without_api_key(self) -> None:
        with pytest.raises(ValueError, match="api_key is required"):
            ConfigClient(base_url="https://example.com", org_id="org")

    def test_raises_without_org_id(self) -> None:
        with pytest.raises(ValueError, match="org_id is required"):
            ConfigClient(base_url="https://example.com", api_key="key")

    def test_default_environment_fallback(self) -> None:
        with ConfigClient(
            base_url="https://config.smooai.dev",
            api_key="key",
            org_id="org-id",
        ) as c:
            assert c._default_environment == "development"

    def test_explicit_environment(self) -> None:
        with ConfigClient(
            base_url="https://config.smooai.dev",
            api_key="key",
            org_id="org-id",
            environment="production",
        ) as c:
            assert c._default_environment == "production"


class TestGetValue:
    """Tests for get_value()."""

    def test_fetches_single_value(self, client: ConfigClient) -> None:
        result = client.get_value("API_URL", environment="production")
        assert result == "value-for-API_URL"

    def test_caches_value_after_first_fetch(self, client: ConfigClient) -> None:
        # First fetch — hits the server
        result1 = client.get_value("API_URL", environment="production")
        assert result1 == "value-for-API_URL"

        # Verify it's in the cache
        assert "production:API_URL" in client._cache

        # Second fetch — should come from cache
        result2 = client.get_value("API_URL", environment="production")
        assert result2 == result1

    def test_different_environments_have_separate_cache_keys(self, client: ConfigClient) -> None:
        client.get_value("API_URL", environment="production")
        client.get_value("API_URL", environment="staging")

        assert "production:API_URL" in client._cache
        assert "staging:API_URL" in client._cache


class TestGetAllValues:
    """Tests for get_all_values()."""

    def test_fetches_all_values(self, client: ConfigClient) -> None:
        result = client.get_all_values(environment="production")
        assert result == {
            "API_URL": "https://api.example.com",
            "MAX_RETRIES": 3,
            "DEBUG": False,
        }

    def test_populates_cache_for_all_keys(self, client: ConfigClient) -> None:
        client.get_all_values(environment="production")
        # Cache stores (value, expires_at) tuples
        assert client._cache["production:API_URL"][0] == "https://api.example.com"
        assert client._cache["production:MAX_RETRIES"][0] == 3
        assert client._cache["production:DEBUG"][0] is False


class TestInvalidateCache:
    """Tests for invalidate_cache()."""

    def test_clears_all_cached_values(self, client: ConfigClient) -> None:
        # Populate cache
        client.get_value("API_URL", environment="production")
        assert len(client._cache) > 0

        # Invalidate
        client.invalidate_cache()
        assert client._cache == {}

    def test_invalidate_empty_cache_is_noop(self, client: ConfigClient) -> None:
        client.invalidate_cache()
        assert client._cache == {}


class TestContextManager:
    """Tests for context manager protocol."""

    def test_enter_returns_self(self, client: ConfigClient) -> None:
        result = client.__enter__()
        assert result is client

    def test_exit_closes_client(self, mock_transport: httpx.MockTransport) -> None:
        client = ConfigClient(
            base_url="https://config.smooai.dev",
            api_key="key",
            org_id="org-id",
        )
        client._client = httpx.Client(
            base_url="https://config.smooai.dev",
            headers={"Authorization": "Bearer key"},
            transport=mock_transport,
        )

        client.__exit__(None, None, None)

        # After close, using the client should fail
        with pytest.raises(RuntimeError):
            client.get_value("key", environment="prod")

    def test_with_statement(self, mock_transport: httpx.MockTransport) -> None:
        with ConfigClient(
            base_url="https://config.smooai.dev",
            api_key="key",
            org_id="org-id",
        ) as client:
            client._client = httpx.Client(
                base_url="https://config.smooai.dev",
                headers={"Authorization": "Bearer key"},
                transport=mock_transport,
            )
            result = client.get_value("API_URL", environment="prod")
            assert result == "value-for-API_URL"


class TestErrorHandling:
    """Tests for HTTP error handling."""

    def test_raises_on_server_error(self) -> None:
        def error_handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500, json={"error": "Internal server error"})

        transport = httpx.MockTransport(error_handler)
        with ConfigClient(
            base_url="https://config.smooai.dev",
            api_key="key",
            org_id="org-id",
        ) as client:
            client._client = httpx.Client(
                base_url="https://config.smooai.dev",
                headers={"Authorization": "Bearer key"},
                transport=transport,
            )
            with pytest.raises(httpx.HTTPStatusError):
                client.get_value("key", environment="prod")

    def test_raises_on_unauthorized(self) -> None:
        def auth_handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(401, json={"error": "Unauthorized"})

        transport = httpx.MockTransport(auth_handler)
        with ConfigClient(
            base_url="https://config.smooai.dev",
            api_key="bad-key",
            org_id="org-id",
        ) as client:
            client._client = httpx.Client(
                base_url="https://config.smooai.dev",
                headers={"Authorization": "Bearer bad-key"},
                transport=transport,
            )
            with pytest.raises(httpx.HTTPStatusError):
                client.get_value("key", environment="prod")

    def test_raises_on_not_found(self) -> None:
        def not_found_handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(404, json={"error": "Not found"})

        transport = httpx.MockTransport(not_found_handler)
        with ConfigClient(
            base_url="https://config.smooai.dev",
            api_key="key",
            org_id="org-id",
        ) as client:
            client._client = httpx.Client(
                base_url="https://config.smooai.dev",
                headers={"Authorization": "Bearer key"},
                transport=transport,
            )
            with pytest.raises(httpx.HTTPStatusError):
                client.get_value("nonexistent", environment="prod")
