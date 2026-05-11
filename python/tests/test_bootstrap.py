"""Tests for smooai_config.bootstrap — plain-HTTP cold-start config reader."""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any
from unittest.mock import patch

import pytest

from smooai_config import bootstrap as bs


@pytest.fixture(autouse=True)
def _reset_cache_and_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    # Clear bootstrap cache + all SMOOAI_/SST_ env vars before each test.
    bs._reset_cache()
    import os

    for key in list(os.environ.keys()):
        if key.startswith(("SMOOAI_", "SST_")) or key == "NEXT_PUBLIC_SST_STAGE":
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("SMOOAI_CONFIG_API_URL", "https://api.example.test")
    monkeypatch.setenv("SMOOAI_CONFIG_AUTH_URL", "https://auth.example.test")
    monkeypatch.setenv("SMOOAI_CONFIG_CLIENT_ID", "client-id-123")
    monkeypatch.setenv("SMOOAI_CONFIG_CLIENT_SECRET", "client-secret-456")
    monkeypatch.setenv("SMOOAI_CONFIG_ORG_ID", "org-789")
    yield
    bs._reset_cache()


class _HttpRecorder:
    def __init__(self, queue: list[tuple[int, dict[str, Any]]]) -> None:
        self._queue = queue
        self.calls: list[tuple[str, str, dict[str, str], bytes | None]] = []

    def post(self, url: str, data: bytes, headers: dict[str, str]) -> tuple[int, bytes]:
        status, body = self._queue.pop(0)
        self.calls.append(("POST", url, headers, data))
        return status, json.dumps(body).encode("utf-8")

    def get(self, url: str, headers: dict[str, str]) -> tuple[int, bytes]:
        status, body = self._queue.pop(0)
        self.calls.append(("GET", url, headers, None))
        return status, json.dumps(body).encode("utf-8")


def _patch_http(recorder: _HttpRecorder) -> Any:
    return patch.multiple(
        bs,
        _http_post=recorder.post,
        _http_get=recorder.get,
    )


def _ok_pair(token_body: dict[str, Any], values_body: dict[str, Any]) -> list[tuple[int, dict[str, Any]]]:
    return [(200, token_body), (200, values_body)]


def test_returns_value_for_known_key() -> None:
    rec = _HttpRecorder(_ok_pair({"access_token": "TOKEN"}, {"values": {"databaseUrl": "postgres://x"}}))
    with _patch_http(rec):
        assert bs.bootstrap_fetch("databaseUrl") == "postgres://x"
    assert len(rec.calls) == 2


def test_returns_none_for_missing_key() -> None:
    rec = _HttpRecorder(_ok_pair({"access_token": "T"}, {"values": {"other": "x"}}))
    with _patch_http(rec):
        assert bs.bootstrap_fetch("databaseUrl") is None


def test_caches_values_per_env() -> None:
    rec = _HttpRecorder(_ok_pair({"access_token": "T"}, {"values": {"a": "1", "b": "2"}}))
    with _patch_http(rec):
        assert bs.bootstrap_fetch("a") == "1"
        assert bs.bootstrap_fetch("b") == "2"
    # Only 2 HTTP round trips total, even though we read 2 keys.
    assert len(rec.calls) == 2


def test_refetches_on_env_change() -> None:
    rec = _HttpRecorder(
        [
            (200, {"access_token": "T1"}),
            (200, {"values": {"a": "dev"}}),
            (200, {"access_token": "T2"}),
            (200, {"values": {"a": "prod"}}),
        ]
    )
    with _patch_http(rec):
        assert bs.bootstrap_fetch("a", environment="development") == "dev"
        assert bs.bootstrap_fetch("a", environment="production") == "prod"
    assert len(rec.calls) == 4


def test_oauth_body_shape() -> None:
    rec = _HttpRecorder(_ok_pair({"access_token": "T"}, {"values": {"k": "v"}}))
    with _patch_http(rec):
        bs.bootstrap_fetch("k")
    auth_call = rec.calls[0]
    assert auth_call[0] == "POST"
    assert auth_call[1] == "https://auth.example.test/token"
    assert auth_call[2]["Content-Type"] == "application/x-www-form-urlencoded"
    body = (auth_call[3] or b"").decode("utf-8")
    assert "grant_type=client_credentials" in body
    assert "client_id=client-id-123" in body
    assert "client_secret=client-secret-456" in body
    assert "provider=client_credentials" in body


def test_values_url_and_bearer() -> None:
    rec = _HttpRecorder(_ok_pair({"access_token": "TOKEN"}, {"values": {"k": "v"}}))
    with _patch_http(rec):
        bs.bootstrap_fetch("k", environment="staging env")
    values_call = rec.calls[1]
    assert values_call[0] == "GET"
    assert values_call[1] == ("https://api.example.test/organizations/org-789/config/values?environment=staging%20env")
    assert values_call[2]["Authorization"] == "Bearer TOKEN"


def test_throws_when_creds_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SMOOAI_CONFIG_CLIENT_ID")
    with pytest.raises(bs.BootstrapError, match=r"CLIENT_ID,CLIENT_SECRET,ORG_ID"):
        bs.bootstrap_fetch("k")


def test_accepts_legacy_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SMOOAI_CONFIG_CLIENT_SECRET")
    monkeypatch.setenv("SMOOAI_CONFIG_API_KEY", "legacy-secret")
    rec = _HttpRecorder(_ok_pair({"access_token": "T"}, {"values": {"k": "v"}}))
    with _patch_http(rec):
        assert bs.bootstrap_fetch("k") == "v"
    body = (rec.calls[0][3] or b"").decode("utf-8")
    assert "client_secret=legacy-secret" in body


def test_accepts_legacy_auth_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SMOOAI_CONFIG_AUTH_URL")
    monkeypatch.setenv("SMOOAI_AUTH_URL", "https://legacy-auth.example.test")
    rec = _HttpRecorder(_ok_pair({"access_token": "T"}, {"values": {"k": "v"}}))
    with _patch_http(rec):
        bs.bootstrap_fetch("k")
    assert rec.calls[0][1] == "https://legacy-auth.example.test/token"


def test_oauth_failure_raises() -> None:
    rec = _HttpRecorder([(401, {"error": "invalid_client"})])
    with _patch_http(rec):
        with pytest.raises(bs.BootstrapError, match=r"OAuth token exchange failed: HTTP 401"):
            bs.bootstrap_fetch("k")


def test_values_failure_raises() -> None:
    rec = _HttpRecorder([(200, {"access_token": "T"}), (500, {"error": "boom"})])
    with _patch_http(rec):
        with pytest.raises(bs.BootstrapError, match=r"GET /config/values failed: HTTP 500"):
            bs.bootstrap_fetch("k")


def test_oauth_missing_access_token_raises() -> None:
    rec = _HttpRecorder([(200, {})])
    with _patch_http(rec):
        with pytest.raises(bs.BootstrapError, match=r"no access_token"):
            bs.bootstrap_fetch("k")


def test_env_resolution_explicit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SST_STAGE", "ignored")
    rec = _HttpRecorder(_ok_pair({"access_token": "T"}, {"values": {}}))
    with _patch_http(rec):
        bs.bootstrap_fetch("k", environment="explicit")
    assert "environment=explicit" in rec.calls[1][1]


def test_env_resolution_sst_stage(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SST_STAGE", "brentrager")
    rec = _HttpRecorder(_ok_pair({"access_token": "T"}, {"values": {}}))
    with _patch_http(rec):
        bs.bootstrap_fetch("k")
    assert "environment=brentrager" in rec.calls[1][1]


def test_env_resolution_next_public(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("NEXT_PUBLIC_SST_STAGE", "dev-stage")
    rec = _HttpRecorder(_ok_pair({"access_token": "T"}, {"values": {}}))
    with _patch_http(rec):
        bs.bootstrap_fetch("k")
    assert "environment=dev-stage" in rec.calls[1][1]


def test_env_resolution_sst_resource_app(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SST_RESOURCE_App", json.dumps({"stage": "sst-resource-stage"}))
    rec = _HttpRecorder(_ok_pair({"access_token": "T"}, {"values": {}}))
    with _patch_http(rec):
        bs.bootstrap_fetch("k")
    assert "environment=sst-resource-stage" in rec.calls[1][1]


def test_env_resolution_production(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SST_STAGE", "production")
    rec = _HttpRecorder(_ok_pair({"access_token": "T"}, {"values": {}}))
    with _patch_http(rec):
        bs.bootstrap_fetch("k")
    assert "environment=production" in rec.calls[1][1]


def test_env_resolution_smooai_env_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SMOOAI_CONFIG_ENV", "qa")
    rec = _HttpRecorder(_ok_pair({"access_token": "T"}, {"values": {}}))
    with _patch_http(rec):
        bs.bootstrap_fetch("k")
    assert "environment=qa" in rec.calls[1][1]


def test_env_resolution_development_default() -> None:
    rec = _HttpRecorder(_ok_pair({"access_token": "T"}, {"values": {}}))
    with _patch_http(rec):
        bs.bootstrap_fetch("k")
    assert "environment=development" in rec.calls[1][1]


def test_malformed_sst_resource_app_falls_through(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SST_RESOURCE_App", "{not json")
    monkeypatch.setenv("SMOOAI_CONFIG_ENV", "qa")
    rec = _HttpRecorder(_ok_pair({"access_token": "T"}, {"values": {}}))
    with _patch_http(rec):
        bs.bootstrap_fetch("k")
    assert "environment=qa" in rec.calls[1][1]


def test_non_string_values_are_stringified() -> None:
    rec = _HttpRecorder(_ok_pair({"access_token": "T"}, {"values": {"count": 42, "flag": True}}))
    with _patch_http(rec):
        assert bs.bootstrap_fetch("count") == "42"
        assert bs.bootstrap_fetch("flag") == "true"
