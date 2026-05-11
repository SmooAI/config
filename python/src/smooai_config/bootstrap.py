"""smooai_config.bootstrap — lightweight cold-start config fetcher.

This module is designed to be importable in environments where the full
``smooai_config`` SDK is too heavy or pulls in a problematic transitive
dependency. It uses only the Python standard library (``urllib``,
``json``, ``os``) and has **zero** imports from anywhere else in this
package.

Use ``bootstrap_fetch(key, environment=...)`` from a deploy script,
container entry-point, or any cold-start context to read a single config
value via plain HTTP.

It performs a single OAuth ``client_credentials`` exchange, then a
single GET against
``/organizations/{orgId}/config/values?environment={env}`` and caches
the resulting values map per-process per-env so repeated reads in the
same process avoid the round-trip.

Inputs (read from ``os.environ``):
    SMOOAI_CONFIG_API_URL       base URL (default https://api.smoo.ai)
    SMOOAI_CONFIG_AUTH_URL      OAuth base URL
                                (default https://auth.smoo.ai;
                                legacy SMOOAI_AUTH_URL also accepted)
    SMOOAI_CONFIG_CLIENT_ID     OAuth M2M client id
    SMOOAI_CONFIG_CLIENT_SECRET OAuth M2M client secret
                                (legacy SMOOAI_CONFIG_API_KEY accepted)
    SMOOAI_CONFIG_ORG_ID        target org id
    SMOOAI_CONFIG_ENV           default env name (used when ``environment``
                                arg is omitted and no SST stage is detected)
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any


class BootstrapError(RuntimeError):
    """Raised when bootstrap_fetch cannot complete (env, auth, or network)."""


@dataclass(frozen=True)
class _Creds:
    api_url: str
    auth_url: str
    client_id: str
    client_secret: str
    org_id: str


def _read_creds() -> _Creds:
    api_url = os.environ.get("SMOOAI_CONFIG_API_URL", "https://api.smoo.ai")
    auth_url = os.environ.get("SMOOAI_CONFIG_AUTH_URL") or os.environ.get("SMOOAI_AUTH_URL") or "https://auth.smoo.ai"
    client_id = os.environ.get("SMOOAI_CONFIG_CLIENT_ID")
    client_secret = os.environ.get("SMOOAI_CONFIG_CLIENT_SECRET") or os.environ.get("SMOOAI_CONFIG_API_KEY")
    org_id = os.environ.get("SMOOAI_CONFIG_ORG_ID")
    if not client_id or not client_secret or not org_id:
        raise BootstrapError(
            "[smooai_config.bootstrap] missing "
            "SMOOAI_CONFIG_{CLIENT_ID,CLIENT_SECRET,ORG_ID} in env. "
            "Set these (e.g. via `pnpm sst shell --stage <stage>`) before "
            "calling bootstrap_fetch."
        )
    return _Creds(
        api_url=api_url,
        auth_url=auth_url,
        client_id=client_id,
        client_secret=client_secret,
        org_id=org_id,
    )


def _resolve_env(environment: str | None) -> str:
    if environment:
        return environment
    stage = os.environ.get("SST_STAGE") or os.environ.get("NEXT_PUBLIC_SST_STAGE")
    if not stage:
        raw = os.environ.get("SST_RESOURCE_App")
        if raw:
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, dict) and isinstance(parsed.get("stage"), str):
                    stage = parsed["stage"]
            except (json.JSONDecodeError, ValueError):
                pass
    if not stage:
        return os.environ.get("SMOOAI_CONFIG_ENV", "development")
    if stage == "production":
        return "production"
    return stage


def _http_post(url: str, data: bytes, headers: dict[str, str]) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req) as resp:  # noqa: S310 - plain HTTPS to known hosts
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def _http_get(url: str, headers: dict[str, str]) -> tuple[int, bytes]:
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req) as resp:  # noqa: S310 - plain HTTPS to known hosts
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def _mint_access_token(creds: _Creds) -> str:
    auth_url = creds.auth_url.rstrip("/")
    body = urllib.parse.urlencode(
        {
            "grant_type": "client_credentials",
            "provider": "client_credentials",
            "client_id": creds.client_id,
            "client_secret": creds.client_secret,
        }
    ).encode("utf-8")
    status, raw = _http_post(
        f"{auth_url}/token",
        body,
        {"Content-Type": "application/x-www-form-urlencoded"},
    )
    if status < 200 or status >= 300:
        raise BootstrapError(
            f"[smooai_config.bootstrap] OAuth token exchange failed: HTTP {status} "
            f"{raw.decode('utf-8', errors='replace')}"
        )
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        raise BootstrapError(f"[smooai_config.bootstrap] OAuth token response was not valid JSON: {e}") from e
    token = payload.get("access_token") if isinstance(payload, dict) else None
    if not isinstance(token, str) or not token:
        raise BootstrapError("[smooai_config.bootstrap] OAuth token endpoint returned no access_token")
    return token


_cached_values: dict[str, Any] | None = None
_cached_env: str | None = None


def _reset_cache() -> None:
    """Test-only: clear the in-process cache. Not part of the public API."""
    global _cached_values, _cached_env
    _cached_values = None
    _cached_env = None


def bootstrap_fetch(key: str, environment: str | None = None) -> str | None:
    """Fetch a single config value by camelCase key.

    Returns ``None`` if the key is not present in the values map. Does
    NOT raise on missing keys — only on env/auth/network errors.

    The full values map is cached per-process per-env after the first
    call so repeated reads inside the same process don't re-do the
    OAuth + GET round-trip.
    """
    global _cached_values, _cached_env

    env = _resolve_env(environment)
    if _cached_values is None or _cached_env != env:
        creds = _read_creds()
        token = _mint_access_token(creds)
        api_url = creds.api_url.rstrip("/")
        url = (
            f"{api_url}/organizations/{urllib.parse.quote(creds.org_id, safe='')}"
            f"/config/values?environment={urllib.parse.quote(env, safe='')}"
        )
        status, raw = _http_get(
            url,
            {"Authorization": f"Bearer {token}", "Accept": "application/json"},
        )
        if status < 200 or status >= 300:
            raise BootstrapError(
                f"[smooai_config.bootstrap] GET /config/values failed: HTTP {status} "
                f"{raw.decode('utf-8', errors='replace')}"
            )
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            raise BootstrapError(f"[smooai_config.bootstrap] values response was not valid JSON: {e}") from e
        values = payload.get("values") if isinstance(payload, dict) else None
        _cached_values = values if isinstance(values, dict) else {}
        _cached_env = env

    raw_value = _cached_values.get(key)
    if raw_value is None:
        return None
    if isinstance(raw_value, str):
        return raw_value
    if isinstance(raw_value, bool):
        return "true" if raw_value else "false"
    return str(raw_value)
