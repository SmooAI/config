"""ESO bearer-token refresher core — Python parity port of the TypeScript
``src/eso-refresher`` (SMOODEV-1526, epic SMOODEV-1522).

ESO's webhook provider reads a STATIC bearer from a k8s Secret, but the config
API issues short-lived ``client_credentials`` JWTs (~1h) — so a static token goes
stale and ESO sync silently 401s. This refresher re-mints the token on a short
interval via the same TokenProvider the SDK uses and writes it into the bootstrap
Secret, so ESO always reads a fresh bearer.

The k8s write is abstracted behind :class:`SecretWriter` so the loop is
unit-testable with a fake (no live cluster). A native ``kubernetes``-backed
writer is an optional adapter (kept out of this core so base SDK consumers do not
pull a heavy k8s client) — the TypeScript sidecar remains the canonical
deployable; this gives the refresh ALGORITHM parity in Python.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Callable, Protocol

from smooai_config.utils import SmooaiConfigError

ESO_REFRESHER_DEFAULT_INTERVAL_SECONDS = 900.0


class SecretWriter(Protocol):
    """Writes the freshly-minted bearer token into the target Secret."""

    def patch_bearer_token(self, token: str) -> None: ...


class TokenSource(Protocol):
    """The slice of TokenProvider the refresher needs. The real ``TokenProvider``
    satisfies it; tests inject a fake."""

    def get_access_token(self) -> str: ...

    def invalidate(self) -> None: ...


# A scheduler starts a repeating callback every ``interval`` seconds and returns
# a cancel callable. Injectable so tests drive ticks deterministically.
Scheduler = Callable[[Callable[[], None], float], Callable[[], None]]


def _default_scheduler(fn: Callable[[], None], interval: float) -> Callable[[], None]:
    stop = threading.Event()

    def loop() -> None:
        while not stop.wait(interval):
            fn()

    thread = threading.Thread(target=loop, daemon=True)
    thread.start()
    return stop.set


@dataclass
class EsoRefresherHandle:
    """Controls a running refresher."""

    refresh_now: Callable[[], None]
    stop: Callable[[], None]


def run_eso_refresher(
    *,
    token_source: TokenSource,
    secret_writer: SecretWriter,
    interval_seconds: float = ESO_REFRESHER_DEFAULT_INTERVAL_SECONDS,
    scheduler: Scheduler | None = None,
) -> EsoRefresherHandle:
    """Start the refresher.

    Performs an initial mint+write synchronously (fail-loud on misconfiguration),
    then schedules periodic refreshes. Returns a handle to force a refresh or
    stop the loop. Loop failures are swallowed (the current Secret token is still
    valid for the rest of its TTL) and retried on the next tick.
    """
    if token_source is None:
        raise SmooaiConfigError("run_eso_refresher: token_source is required")
    if secret_writer is None:
        raise SmooaiConfigError("run_eso_refresher: secret_writer is required")
    if interval_seconds <= 0:
        interval_seconds = ESO_REFRESHER_DEFAULT_INTERVAL_SECONDS

    def refresh_now() -> None:
        # Force a brand-new token each cycle so the Secret always holds one with
        # (close to) a full TTL ahead — ESO must never read a token about to expire.
        token_source.invalidate()
        token = token_source.get_access_token()
        secret_writer.patch_bearer_token(token)

    # Initial mint+write — fail-loud.
    refresh_now()

    def tick() -> None:
        try:
            refresh_now()
        except Exception:  # noqa: BLE001 — loop failures are non-fatal, retried next tick
            pass

    sched = scheduler or _default_scheduler
    cancel = sched(tick, interval_seconds)

    stopped = {"v": False}

    def stop() -> None:
        if stopped["v"]:
            return
        stopped["v"] = True
        cancel()

    return EsoRefresherHandle(refresh_now=refresh_now, stop=stop)
