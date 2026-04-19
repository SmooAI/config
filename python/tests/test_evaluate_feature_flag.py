"""Tests for ConfigClient.evaluate_feature_flag — cohort-aware flag SDK
surface (SMOODEV-614). Uses httpx.MockTransport so we can assert the exact
POST body + path the backend will receive."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from smooai_config.client import ConfigClient

BASE_URL = "https://config-test.smooai.dev"
ORG_ID = "550e8400-e29b-41d4-a716-446655440000"
API_KEY = "test-key"


def make_transport(handler_map: dict[str, Any]) -> httpx.MockTransport:
    """Route POST /feature-flags/{key}/evaluate through a per-key handler.

    handler_map values may be either a dict (returned verbatim) or a callable
    accepting the parsed body and returning the response dict.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.headers.get("authorization") != f"Bearer {API_KEY}":
            return httpx.Response(401, json={"error": "unauthorized"})

        path = request.url.path
        prefix = f"/organizations/{ORG_ID}/config/feature-flags/"
        if not (path.startswith(prefix) and path.endswith("/evaluate")):
            return httpx.Response(404, json={"error": "not found"})

        key = path[len(prefix) : -len("/evaluate")]
        # httpx auto-decodes the path; a literal "/" in the key would have
        # been percent-encoded upstream, so this mimics what the backend sees.
        resolver = handler_map.get(key)
        if resolver is None:
            return httpx.Response(404, json={"error": "not found", "key": key})

        body = json.loads(request.content.decode())
        payload = resolver(body) if callable(resolver) else resolver
        return httpx.Response(200, json=payload)

    return httpx.MockTransport(handler)


def make_client(transport: httpx.MockTransport) -> ConfigClient:
    client = ConfigClient(
        base_url=BASE_URL,
        api_key=API_KEY,
        org_id=ORG_ID,
        environment="production",
    )
    # Hot-swap the underlying httpx client onto the mock transport so the
    # real network stack never engages — matches the pattern used in the
    # sibling integration tests.
    client._client = httpx.Client(  # type: ignore[attr-defined]  # noqa: SLF001
        base_url=BASE_URL,
        transport=transport,
        headers={"Authorization": f"Bearer {API_KEY}"},
    )
    return client


def test_posts_environment_and_context() -> None:
    received: dict[str, Any] = {}

    def resolver(body: dict[str, Any]) -> dict[str, Any]:
        received.update(body)
        return {"value": True, "source": "rule", "matchedRuleId": "pro-users"}

    client = make_client(make_transport({"new-dashboard": resolver}))
    res = client.evaluate_feature_flag("new-dashboard", {"userId": "u1", "plan": "pro"})
    assert received == {"environment": "production", "context": {"userId": "u1", "plan": "pro"}}
    assert res == {"value": True, "source": "rule", "matchedRuleId": "pro-users"}


def test_defaults_context_to_empty() -> None:
    def resolver(body: dict[str, Any]) -> dict[str, Any]:
        assert body["context"] == {}
        return {"value": False, "source": "default"}

    client = make_client(make_transport({"flag": resolver}))
    res = client.evaluate_feature_flag("flag")
    assert res["source"] == "default"


def test_per_call_environment_override() -> None:
    def resolver(body: dict[str, Any]) -> dict[str, Any]:
        assert body["environment"] == "staging"
        return {"value": True, "source": "raw"}

    client = make_client(make_transport({"flag": resolver}))
    res = client.evaluate_feature_flag("flag", environment="staging")
    assert res["value"] is True


def test_not_cached_second_call_hits_server() -> None:
    calls = {"n": 0}

    def resolver(_: dict[str, Any]) -> dict[str, Any]:
        calls["n"] += 1
        return {"value": True, "source": "rollout", "rolloutBucket": 42}

    client = make_client(make_transport({"flag": resolver}))
    client.evaluate_feature_flag("flag", {"userId": "u1"})
    client.evaluate_feature_flag("flag", {"userId": "u1"})
    assert calls["n"] == 2


def test_surfaces_http_errors() -> None:
    client = make_client(make_transport({}))  # no handler → 404
    with pytest.raises(httpx.HTTPStatusError):
        client.evaluate_feature_flag("missing")
