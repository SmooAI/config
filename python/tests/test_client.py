"""Tests for ConfigClient."""

import json

import httpx
import pytest

from smooai_config.client import (
    ConfigClient,
    EvaluateFeatureFlagResponse,
    FeatureFlagContextError,
    FeatureFlagEvaluationError,
    FeatureFlagNotFoundError,
)
from smooai_config.token_provider import TokenProvider


# SMOODEV-975: stub TokenProvider so these tests focus on ConfigClient
# behavior (cache, fetch, error mapping) without exercising the OAuth
# handshake — that lives in test_token_provider.py.
class StubTokenProvider(TokenProvider):
    def __init__(self, token: str = "stub-jwt") -> None:
        super().__init__(auth_url="https://stub.invalid", client_id="stub", client_secret="stub")
        self._token = token

    def get_access_token(self) -> str:  # type: ignore[override]
        return self._token


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
    """Create a ConfigClient with mocked transport + stub OAuth token."""
    http = httpx.Client(base_url="https://config.smooai.dev", transport=mock_transport)
    return ConfigClient(
        base_url="https://config.smooai.dev",
        org_id="550e8400-e29b-41d4-a716-446655440000",
        token_provider=StubTokenProvider(),
        http_client=http,
    )


class TestConfigClientInit:
    """Tests for ConfigClient initialization."""

    def test_strips_trailing_slash(self) -> None:
        with ConfigClient(
            base_url="https://config.smooai.dev/",
            client_id="cid",
            client_secret="sec",
            org_id="org-id",
        ) as c:
            assert c._base_url == "https://config.smooai.dev"

    def test_initializes_empty_cache(self) -> None:
        with ConfigClient(
            base_url="https://config.smooai.dev",
            client_id="cid",
            client_secret="sec",
            org_id="org-id",
        ) as c:
            assert c._cache == {}

    def test_reads_from_env_vars(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("SMOOAI_CONFIG_API_URL", "https://env.example.com")
        monkeypatch.setenv("SMOOAI_CONFIG_CLIENT_ID", "env-client-id")
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
            client_id="cid",
            client_secret="sec",
            org_id="explicit-org",
        ) as c:
            assert c._base_url == "https://explicit.example.com"
            assert c._org_id == "explicit-org"

    def test_accepts_api_key_as_alias_for_client_secret(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """SMOODEV-975: api_key kwarg is preserved as a deprecated alias for client_secret."""
        self._scrub_env(monkeypatch)
        with ConfigClient(
            base_url="https://example.com",
            client_id="cid",
            api_key="legacy-key",
            org_id="org-id",
        ) as c:
            assert c._base_url == "https://example.com"

    @staticmethod
    def _scrub_env(monkeypatch: pytest.MonkeyPatch) -> None:
        """Remove any SMOOAI_CONFIG_* env vars that might otherwise satisfy
        the required-arg checks when a developer has them set locally."""
        for var in (
            "SMOOAI_CONFIG_API_URL",
            "SMOOAI_CONFIG_AUTH_URL",
            "SMOOAI_AUTH_URL",
            "SMOOAI_CONFIG_CLIENT_ID",
            "SMOOAI_CONFIG_CLIENT_SECRET",
            "SMOOAI_CONFIG_API_KEY",
            "SMOOAI_CONFIG_ORG_ID",
            "SMOOAI_CONFIG_ENV",
        ):
            monkeypatch.delenv(var, raising=False)

    def test_raises_without_base_url(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self._scrub_env(monkeypatch)
        with pytest.raises(ValueError, match="base_url is required"):
            ConfigClient(client_id="cid", client_secret="sec", org_id="org")

    def test_raises_without_client_id(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self._scrub_env(monkeypatch)
        with pytest.raises(ValueError, match="client_id is required"):
            ConfigClient(base_url="https://example.com", client_secret="sec", org_id="org")

    def test_raises_without_client_secret(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self._scrub_env(monkeypatch)
        with pytest.raises(ValueError, match="client_secret is required"):
            ConfigClient(base_url="https://example.com", client_id="cid", org_id="org")

    def test_raises_without_org_id(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self._scrub_env(monkeypatch)
        with pytest.raises(ValueError, match="org_id is required"):
            ConfigClient(base_url="https://example.com", client_id="cid", client_secret="sec")

    def test_default_environment_fallback(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self._scrub_env(monkeypatch)
        with ConfigClient(
            base_url="https://config.smooai.dev",
            client_id="cid",
            client_secret="sec",
            org_id="org-id",
        ) as c:
            assert c._default_environment == "development"

    def test_explicit_environment(self) -> None:
        with ConfigClient(
            base_url="https://config.smooai.dev",
            client_id="cid",
            client_secret="sec",
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


def _make_client_with_transport(transport: httpx.MockTransport, *, environment: str = "production") -> ConfigClient:
    """Build a ConfigClient whose internal httpx.Client uses the given mock transport."""
    http = httpx.Client(base_url="https://config.smooai.dev", transport=transport)
    return ConfigClient(
        base_url="https://config.smooai.dev",
        org_id="org-123",
        environment=environment,
        token_provider=StubTokenProvider(),
        http_client=http,
    )


class TestEvaluateFeatureFlag:
    """Tests for ConfigClient.evaluate_feature_flag()."""

    def test_posts_body_with_environment_and_context(self) -> None:
        captured: dict[str, httpx.Request] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["request"] = request
            return httpx.Response(
                200,
                json={"value": True, "source": "rule", "matchedRuleId": "rule-123"},
            )

        with _make_client_with_transport(httpx.MockTransport(handler)) as client:
            result = client.evaluate_feature_flag("aboutPage", {"userId": "u-1", "plan": "pro"})

        assert isinstance(result, EvaluateFeatureFlagResponse)
        assert result.value is True
        assert result.source == "rule"
        assert result.matched_rule_id == "rule-123"
        assert result.rollout_bucket is None

        req = captured["request"]
        assert req.method == "POST"
        assert str(req.url) == (
            "https://config.smooai.dev/organizations/org-123/config/feature-flags/aboutPage/evaluate"
        )
        # SMOODEV-975: Bearer is the OAuth JWT (stub-jwt here), not the API key.
        assert req.headers["authorization"] == "Bearer stub-jwt"
        assert json.loads(req.content) == {
            "environment": "production",
            "context": {"userId": "u-1", "plan": "pro"},
        }

    def test_defaults_context_to_empty_dict(self) -> None:
        captured: dict[str, httpx.Request] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["request"] = request
            return httpx.Response(200, json={"value": False, "source": "default"})

        with _make_client_with_transport(httpx.MockTransport(handler)) as client:
            result = client.evaluate_feature_flag("aboutPage")

        assert result.value is False
        assert result.source == "default"
        assert json.loads(captured["request"].content) == {
            "environment": "production",
            "context": {},
        }

    def test_honors_explicit_environment_override(self) -> None:
        captured: dict[str, httpx.Request] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["request"] = request
            return httpx.Response(200, json={"value": True, "source": "raw"})

        with _make_client_with_transport(httpx.MockTransport(handler)) as client:
            client.evaluate_feature_flag("aboutPage", {}, environment="staging")

        assert json.loads(captured["request"].content) == {
            "environment": "staging",
            "context": {},
        }

    def test_url_encodes_flag_key_with_special_characters(self) -> None:
        captured: dict[str, httpx.Request] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["request"] = request
            return httpx.Response(200, json={"value": None, "source": "default"})

        with _make_client_with_transport(httpx.MockTransport(handler)) as client:
            client.evaluate_feature_flag("with spaces/and+slashes")

        assert "with%20spaces%2Fand%2Bslashes" in str(captured["request"].url)

    def test_parses_rollout_bucket(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={"value": True, "source": "rollout", "rolloutBucket": 42},
            )

        with _make_client_with_transport(httpx.MockTransport(handler)) as client:
            result = client.evaluate_feature_flag("aboutPage", {"userId": "u-1"})

        assert result.source == "rollout"
        assert result.rollout_bucket == 42

    def test_raises_feature_flag_not_found_on_404(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(404, text="flag not defined")

        with _make_client_with_transport(httpx.MockTransport(handler)) as client:
            with pytest.raises(FeatureFlagNotFoundError) as exc_info:
                client.evaluate_feature_flag("unknown")

        err = exc_info.value
        assert isinstance(err, FeatureFlagEvaluationError)
        assert err.key == "unknown"
        assert err.status_code == 404

    def test_raises_feature_flag_context_error_on_400(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(400, text="context missing required key")

        with _make_client_with_transport(httpx.MockTransport(handler)) as client:
            with pytest.raises(FeatureFlagContextError) as exc_info:
                client.evaluate_feature_flag("aboutPage")

        err = exc_info.value
        assert isinstance(err, FeatureFlagEvaluationError)
        assert err.status_code == 400
        assert err.server_message == "context missing required key"

    def test_raises_feature_flag_evaluation_error_on_5xx(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(503, text="evaluator overloaded")

        with _make_client_with_transport(httpx.MockTransport(handler)) as client:
            with pytest.raises(FeatureFlagEvaluationError) as exc_info:
                client.evaluate_feature_flag("aboutPage")

        err = exc_info.value
        assert not isinstance(err, FeatureFlagNotFoundError)
        assert not isinstance(err, FeatureFlagContextError)
        assert err.status_code == 503
        assert err.server_message == "evaluator overloaded"

    def test_uses_default_environment_from_constructor(self) -> None:
        captured: dict[str, httpx.Request] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["request"] = request
            return httpx.Response(200, json={"value": True, "source": "raw"})

        with _make_client_with_transport(
            httpx.MockTransport(handler),
            environment="development",
        ) as client:
            client.evaluate_feature_flag("aboutPage")

        assert json.loads(captured["request"].content)["environment"] == "development"
