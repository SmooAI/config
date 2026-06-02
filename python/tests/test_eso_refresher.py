"""SMOODEV-1526 — ESO refresher core parity tests (Python)."""

from __future__ import annotations

from collections.abc import Callable

import pytest

from smooai_config.eso_refresher import run_eso_refresher
from smooai_config.utils import SmooaiConfigError


class FakeTokenSource:
    def __init__(self, tokens: list[str]) -> None:
        self._tokens = tokens
        self._idx = 0
        self.calls = 0
        self.invalidations = 0

    def get_access_token(self) -> str:
        self.calls += 1
        t = self._tokens[min(self._idx, len(self._tokens) - 1)]
        self._idx += 1
        return t

    def invalidate(self) -> None:
        self.invalidations += 1


class RecordingWriter:
    def __init__(self, fail_on_call: int = -1) -> None:
        self.written: list[str] = []
        self._fail_on_call = fail_on_call
        self._call = 0

    def patch_bearer_token(self, token: str) -> None:
        self._call += 1
        if self._call == self._fail_on_call:
            raise RuntimeError("simulated k8s patch failure")
        self.written.append(token)


class ManualScheduler:
    """Captures the tick fn so tests drive it deterministically."""

    def __init__(self) -> None:
        self.fn: Callable[[], None] | None = None
        self.interval: float = 0
        self.cancelled = False

    def __call__(self, fn: Callable[[], None], interval: float) -> Callable[[], None]:
        self.fn = fn
        self.interval = interval

        def cancel() -> None:
            self.cancelled = True

        return cancel

    def tick(self) -> None:
        assert self.fn is not None
        self.fn()


def test_initial_write():
    ts = FakeTokenSource(["tok-1"])
    w = RecordingWriter()
    run_eso_refresher(token_source=ts, secret_writer=w, scheduler=ManualScheduler())
    assert w.written == ["tok-1"]


def test_forces_fresh_each_cycle():
    ts = FakeTokenSource(["tok-1", "tok-2", "tok-3"])
    w = RecordingWriter()
    sched = ManualScheduler()
    run_eso_refresher(token_source=ts, secret_writer=w, scheduler=sched)
    sched.tick()
    assert ts.calls == 2
    assert ts.invalidations == 2
    assert w.written == ["tok-1", "tok-2"]


def test_survives_tick_failure():
    ts = FakeTokenSource(["tok-1", "tok-2", "tok-3"])
    w = RecordingWriter(fail_on_call=2)  # first scheduled tick fails
    sched = ManualScheduler()
    run_eso_refresher(token_source=ts, secret_writer=w, scheduler=sched)
    sched.tick()  # fails internally, must not raise
    sched.tick()  # recovers
    assert w.written == ["tok-1", "tok-3"]


def test_fail_loud_initial():
    ts = FakeTokenSource(["tok-1"])
    w = RecordingWriter(fail_on_call=1)  # initial write fails
    with pytest.raises(RuntimeError):
        run_eso_refresher(token_source=ts, secret_writer=w, scheduler=ManualScheduler())


def test_stop_cancels_loop():
    ts = FakeTokenSource(["tok-1"])
    w = RecordingWriter()
    sched = ManualScheduler()
    handle = run_eso_refresher(token_source=ts, secret_writer=w, scheduler=sched)
    assert sched.cancelled is False
    handle.stop()
    assert sched.cancelled is True


def test_required_fields():
    with pytest.raises(SmooaiConfigError):
        run_eso_refresher(token_source=None, secret_writer=RecordingWriter(), scheduler=ManualScheduler())  # type: ignore[arg-type]
    with pytest.raises(SmooaiConfigError):
        run_eso_refresher(token_source=FakeTokenSource(["t"]), secret_writer=None, scheduler=ManualScheduler())  # type: ignore[arg-type]


def test_honors_interval_override():
    sched = ManualScheduler()
    run_eso_refresher(
        token_source=FakeTokenSource(["t"]),
        secret_writer=RecordingWriter(),
        interval_seconds=123.0,
        scheduler=sched,
    )
    assert sched.interval == 123.0
