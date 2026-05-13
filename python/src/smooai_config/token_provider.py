"""OAuth2 client_credentials token provider for the runtime ConfigClient.

Parity with the .NET SmooAI.Config.OAuth.TokenProvider and the TypeScript
src/platform/TokenProvider.ts (SMOODEV-974). Exchanges (client_id,
client_secret) for an access token against ``{auth_url}/token`` and caches
the JWT in memory until it's within ``refresh_window_seconds`` of expiry.

Server contract::

    POST {auth_url}/token
    Content-Type: application/x-www-form-urlencoded

    grant_type=client_credentials
    provider=client_credentials
    client_id=<uuid>
    client_secret=sk_...
"""

from __future__ import annotations

import threading
import time
from typing import Any

import httpx


class TokenProvider:
    """Thread-safe OAuth2 client_credentials token provider.

    Maintains a single cached access token, refreshing it from the OAuth
    issuer whenever the cache is empty or within ``refresh_window_seconds``
    of expiry. Concurrent callers during a refresh share a single in-flight
    request (single-flight via the RLock + cache check).

    Args:
        auth_url: OAuth issuer base URL (no trailing slash required).
            E.g. ``https://auth.smoo.ai``.
        client_id: OAuth client ID.
        client_secret: OAuth client secret.
        refresh_window_seconds: How many seconds before expiry to
            proactively refresh the token. Defaults to 60s — matches the
            .NET and TypeScript TokenProvider defaults.
        http_client: Optional pre-configured ``httpx.Client``. If omitted,
            the provider creates and owns its own client.
    """

    def __init__(
        self,
        *,
        auth_url: str,
        client_id: str,
        client_secret: str,
        refresh_window_seconds: float = 60.0,
        http_client: httpx.Client | None = None,
    ) -> None:
        if not auth_url:
            raise ValueError("TokenProvider requires auth_url")
        if not client_id:
            raise ValueError("TokenProvider requires client_id")
        if not client_secret:
            raise ValueError("TokenProvider requires client_secret")
        self._auth_url = auth_url.rstrip("/")
        self._client_id = client_id
        self._client_secret = client_secret
        self._refresh_window_seconds = refresh_window_seconds
        self._http_client = http_client
        self._owned_client = http_client is None
        self._cached_token: str | None = None
        self._cached_expires_at: float = 0.0
        self._lock = threading.RLock()

    def get_access_token(self) -> str:
        """Return a valid OAuth access token, refreshing if needed.

        Thread-safe — concurrent callers serialize through the lock and
        share the same refreshed token instead of issuing parallel
        exchanges.
        """
        with self._lock:
            if not self._should_refresh():
                # _cached_token is guaranteed non-None when _should_refresh is False.
                assert self._cached_token is not None
                return self._cached_token
            return self._refresh()

    def invalidate(self) -> None:
        """Invalidate the cached token.

        Callers should invoke this after observing a 401 from a downstream
        request — the next ``get_access_token()`` call re-exchanges.
        """
        with self._lock:
            self._cached_token = None
            self._cached_expires_at = 0.0

    def close(self) -> None:
        """Close the owned HTTP client (no-op if one was injected)."""
        if self._owned_client and self._http_client is not None:
            self._http_client.close()
            self._http_client = None

    def _should_refresh(self) -> bool:
        if not self._cached_token:
            return True
        return time.monotonic() >= self._cached_expires_at - self._refresh_window_seconds

    def _refresh(self) -> str:
        client = self._get_or_create_http_client()
        response = client.post(
            f"{self._auth_url}/token",
            data={
                "grant_type": "client_credentials",
                "provider": "client_credentials",
                "client_id": self._client_id,
                "client_secret": self._client_secret,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        if not response.is_success:
            body = _safe_text(response)
            raise RuntimeError(f"smooai_config: OAuth token exchange failed: HTTP {response.status_code} {body}")
        try:
            payload: dict[str, Any] = response.json()
        except ValueError as e:
            raise RuntimeError(f"smooai_config: OAuth token response was not valid JSON: {e}") from e
        access_token = payload.get("access_token")
        if not isinstance(access_token, str) or not access_token:
            raise RuntimeError("smooai_config: OAuth token endpoint returned no access_token")
        expires_in_raw = payload.get("expires_in", 3600)
        expires_in = float(expires_in_raw) if isinstance(expires_in_raw, (int, float)) else 3600.0
        self._cached_token = access_token
        self._cached_expires_at = time.monotonic() + expires_in
        return access_token

    def _get_or_create_http_client(self) -> httpx.Client:
        if self._http_client is None:
            self._http_client = httpx.Client()
        return self._http_client

    # Test seam — internal-only.
    def _set_now_for_tests(self, now: float) -> None:
        """@internal: override the monotonic clock anchor (tests only)."""
        # Shift expiry relative to a synthetic 'now' baseline.
        with self._lock:
            self._cached_expires_at = now + (self._cached_expires_at - time.monotonic())


def _safe_text(response: httpx.Response) -> str:
    try:
        return response.text
    except Exception:
        return "<unreadable>"
