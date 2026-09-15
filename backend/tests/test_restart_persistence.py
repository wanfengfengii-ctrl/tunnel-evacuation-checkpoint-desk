"""End-to-end durability test with a *real* separate uvicorn process.

After every successful confirmation the API process is killed and restarted
against the same SQLite file; the commander must always resume at exactly the
correct next node/version. This cannot be faked with an in-process TestClient
and is the core guarantee behind "stale retries must not push the state".
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]


def _free_port() -> int:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


class ApiProcess:
    def __init__(self, db_path: Path, port: int):
        self.db_path = db_path
        self.port = port
        self.proc: subprocess.Popen | None = None

    def start(self) -> None:
        env = dict(os.environ)
        env["DRILL_DB_PATH"] = str(self.db_path)
        env["PYTHONPATH"] = str(BACKEND_DIR)
        self.proc = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "app.main:app",
                "--host",
                "127.0.0.1",
                "--port",
                str(self.port),
            ],
            cwd=BACKEND_DIR,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        self._wait_ready()

    def _wait_ready(self, attempts: int = 60) -> None:
        last_error: Exception | None = None
        for _ in range(attempts):
            if self.proc is not None and self.proc.poll() is not None:
                output = self.proc.stdout.read().decode() if self.proc.stdout else ""
                raise AssertionError(f"uvicorn exited early:\n{output}")
            try:
                response = httpx.get(
                    f"http://127.0.0.1:{self.port}/api/health", timeout=1.0
                )
                if response.status_code == 200:
                    return
            except httpx.HTTPError as exc:
                last_error = exc
            time.sleep(0.5)
        raise AssertionError(f"API never became ready: {last_error}")

    def stop(self) -> None:
        assert self.proc is not None
        self.proc.terminate()
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=10)
        self.proc = None


@pytest.fixture
def api(tmp_path):
    db_path = tmp_path / "restart-drill.db"
    server = ApiProcess(db_path, _free_port())
    server.start()
    yield server
    if server.proc is not None:
        server.stop()


def test_state_survives_restart_after_every_confirmation(api):
    base = f"http://127.0.0.1:{api.port}"

    response = httpx.post(f"{base}/api/drills/start", timeout=5)
    assert response.status_code == 201
    assert response.json()["version"] == 1

    # (submitted node/version) -> (expected next node, expected version, status)
    transitions = [
        ("cross_passage_open", 1, "upstream_seal", 2, "in_progress"),
        ("upstream_seal", 2, "headcount", 3, "in_progress"),
        ("headcount", 3, "headcount", 4, "completed"),
    ]

    for submitted_node, submitted_version, exp_node, exp_version, exp_status in transitions:
        # Hard restart *after* the previous successful confirmation.
        api.stop()
        api.start()

        # The commander reconnects and sees exactly where they left off.
        current = httpx.get(f"{base}/api/drills", timeout=5).json()
        if exp_status == "completed":
            # Last loop: before this confirm state is headcount@3 in progress.
            assert current["node"] == "headcount" and current["version"] == 3
        else:
            assert current["node"] == submitted_node and current["version"] == submitted_version

        confirmed = httpx.post(
            f"{base}/api/drills/confirm",
            json={"node": submitted_node, "version": submitted_version},
            timeout=5,
        )
        assert confirmed.status_code == 200, confirmed.text
        state = confirmed.json()
        assert state["node"] == exp_node
        assert state["version"] == exp_version
        assert state["status"] == exp_status

    # Restart after completion: still exactly one completion.
    api.stop()
    api.start()
    final = httpx.get(f"{base}/api/drills", timeout=5).json()
    assert {k: final[k] for k in ("status", "node", "version", "steps")} == {
        "status": "completed",
        "node": "headcount",
        "version": 4,
        "steps": ["cross_passage_open", "upstream_seal", "headcount"],
    }
    # Timing basis survives the restart unchanged as well.
    assert final["planned_minutes"] == 30
    assert final["started_at"] == response.json()["started_at"]
    assert final["planned_end_at"] == response.json()["planned_end_at"]

    # A restart cannot be used to complete a second time; the stale final
    # click is rejected with the actual state.
    stale = httpx.post(
        f"{base}/api/drills/confirm",
        json={"node": "headcount", "version": 3},
        timeout=5,
    )
    assert stale.status_code == 409
    assert stale.json()["error"] == "drill_completed"
    assert stale.json()["version"] == 4
    assert httpx.get(f"{base}/api/drills", timeout=5).json()["version"] == 4
