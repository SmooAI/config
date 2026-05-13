"""Tests for the OAuth2 TokenProvider used by the runtime ConfigClient.

Parity with src/platform/TokenProvider.test.ts (SMOODEV-974) and the .NET
TokenProvider tests. Covers the wire shape, caching, refresh window,
single-flight dedup, invalidation, and error paths.
"""

from __future__ import annotations

import threading
import time
from typing import Any
from urllib.parse import parse_qs

import httpx
import pytest

from smooai_config.token_provider import TokenProvider


class _Recorder:
    """Captures requests made through the mock transport."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.bodies: list[dict[str, list[str]]] = []


def _make_transport(
    *,
    recorder: _Recorder | None = None,
    access_token: str = "minted-jwt",
    expires_in: int = 3600,
    status_code: int = 200,
    error_body: str = "",
) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        if recorder is not None:
            recorder.requests.append(request)
            recorder.bodies.append(parse_qs(request.content.decode("utf-8")))
        if status_code != 200:
            return httpx.Response(status_code, text=error_body)
        return httpx.Response(
            200,
            json={"access_token": access_token, "expires_in": expires_in, "token_type": "Bearer"},
        )

    return httpx.MockTransport(handler)


def _make_provider(
    *,
    transport: httpx.MockTransport,
    auth_url: str = "https://auth.example.com",
    client_id: str = "test-client-id",
    client_secret: str = "test-client-secret",
    refresh_window_seconds: float = 60.0,
) -> TokenProvider:
    client = httpx.Client(transport=transport)
    return TokenProvider(
        auth_url=auth_url,
        client_id=client_id,
        client_secret=client_secret,
        refresh_window_seconds=refresh_window_seconds,
        http_client=client,
    )


class TestConstructor:
    def test_requires_auth_url(self) -> None:
        with pytest.raises(ValueError, match="auth_url"):
            TokenProvider(auth_url="", client_id="cid", client_secret="sec")

    def test_requires_client_id(self) -> None:
        with pytest.raises(ValueError, match="client_id"):
            TokenProvider(auth_url="https://auth.example.com", client_id="", client_secret="sec")

    def test_requires_client_secret(self) -> None:
        with pytest.raises(ValueError, match="client_secret"):
            TokenProvider(auth_url="https://auth.example.com", client_id="cid", client_secret="")

    def test_strips_trailing_slash_from_auth_url(self) -> None:
        recorder = _Recorder()
        provider = _make_provider(
            transport=_make_transport(recorder=recorder),
            auth_url="https://auth.example.com////",
        )
        provider.get_access_token()
        assert str(recorder.requests[0].url) == "https://auth.example.com/token"


class TestPostShape:
    def test_posts_client_credentials_form_to_token_endpoint(self) -> None:
        recorder = _Recorder()
        provider = _make_provider(transport=_make_transport(recorder=recorder))
        token = provider.get_access_token()

        assert token == "minted-jwt"
        assert len(recorder.requests) == 1
        req = recorder.requests[0]
        assert req.method == "POST"
        assert str(req.url) == "https://auth.example.com/token"
        assert req.headers["content-type"] == "application/x-www-form-urlencoded"
        body = recorder.bodies[0]
        assert body == {
            "grant_type": ["client_credentials"],
            "provider": ["client_credentials"],
            "client_id": ["test-client-id"],
            "client_secret": ["test-client-secret"],
        }


class TestCaching:
    def test_returns_cached_token_within_window(self) -> None:
        recorder = _Recorder()
        provider = _make_provider(transport=_make_transport(recorder=recorder, expires_in=3600))

        t1 = provider.get_access_token()
        t2 = provider.get_access_token()
        t3 = provider.get_access_token()

        assert t1 == t2 == t3 == "minted-jwt"
        assert len(recorder.requests) == 1  # only one exchange

    def test_refreshes_when_within_refresh_window(self) -> None:
        # 60s refresh window, 10s expiry — first call mints, second call
        # is within the window so should mint again.
        recorder = _Recorder()
        provider = _make_provider(
            transport=_make_transport(recorder=recorder, expires_in=10),
            refresh_window_seconds=60.0,
        )

        provider.get_access_token()
        provider.get_access_token()
        # Second call should have refreshed because cached.expires_at - 60s <= now
        assert len(recorder.requests) == 2

    def test_invalidate_forces_refresh(self) -> None:
        recorder = _Recorder()
        provider = _make_provider(transport=_make_transport(recorder=recorder, expires_in=3600))

        provider.get_access_token()
        assert len(recorder.requests) == 1
        provider.invalidate()
        provider.get_access_token()
        assert len(recorder.requests) == 2


class TestErrors:
    def test_raises_on_non_2xx(self) -> None:
        provider = _make_provider(transport=_make_transport(status_code=401, error_body="bad creds"))
        with pytest.raises(RuntimeError, match="OAuth token exchange failed: HTTP 401"):
            provider.get_access_token()

    def test_raises_when_response_missing_access_token(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"expires_in": 3600})

        provider = TokenProvider(
            auth_url="https://auth.example.com",
            client_id="cid",
            client_secret="sec",
            http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        )
        with pytest.raises(RuntimeError, match="no access_token"):
            provider.get_access_token()

    def test_raises_when_response_not_json(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text="not json")

        provider = TokenProvider(
            auth_url="https://auth.example.com",
            client_id="cid",
            client_secret="sec",
            http_client=httpx.Client(transport=httpx.MockTransport(handler)),
        )
        with pytest.raises(RuntimeError, match="not valid JSON"):
            provider.get_access_token()


class TestThreading:
    def test_concurrent_callers_share_cache(self) -> None:
        """Single exchange survives parallel callers (lock serializes)."""
        recorder = _Recorder()
        provider = _make_provider(transport=_make_transport(recorder=recorder, expires_in=3600))

        tokens: list[str] = []
        errors: list[Exception] = []
        barrier = threading.Barrier(8)

        def worker() -> None:
            try:
                barrier.wait()
                tokens.append(provider.get_access_token())
            except Exception as exc:  # pragma: no cover - safety net
                errors.append(exc)

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert errors == []
        assert all(t == "minted-jwt" for t in tokens)
        # The lock dedups: only one HTTP exchange even with 8 racing callers.
        assert len(recorder.requests) == 1


class TestClose:
    def test_close_is_noop_when_client_was_injected(self) -> None:
        # Injected client: caller owns it, close() must not touch it.
        client = httpx.Client(transport=_make_transport())
        provider = TokenProvider(
            auth_url="https://auth.example.com",
            client_id="cid",
            client_secret="sec",
            http_client=client,
        )
        provider.close()
        # Verify the injected client is still usable.
        assert not client.is_closed

    def test_close_disposes_owned_client(self) -> None:
        # Without http_client kwarg, provider owns and creates lazily.
        provider = TokenProvider(
            auth_url="https://auth.example.com",
            client_id="cid",
            client_secret="sec",
        )
        # Force the owned client to be created by calling internal helper.
        provider._get_or_create_http_client()
        provider.close()
        # After close the slot is None, signaling it was disposed.
        assert provider._http_client is None  # type: ignore[attr-defined]


# Silence type errors about unused imports in linters that don't see indirect refs.
_ = (Any, time, parse_qs)
