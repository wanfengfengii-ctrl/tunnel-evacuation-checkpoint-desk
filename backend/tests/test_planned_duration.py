"""Acceptance tests for the planned-duration feature.

Covers:
- old-style start without a body yields a 30-minute plan;
- a chosen duration is persisted and returned by GET, with the end instant
  computed from the server's start instant;
- illegal durations are rejected and never create the drill row;
- a legacy single-row database migrates in place and a row lacking time data
  gets one consistent time basis backfilled on first read;
- the server clock is the authority (controllable here by freezing _utcnow).
"""

from __future__ import annotations

import sqlite3
import threading
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app import database
from app.main import app


def _parse_utc(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(
        timezone.utc
    )


def _assert_plan(state: dict, minutes: int, *, expected_start: datetime) -> None:
    assert state["planned_minutes"] == minutes
    started_at = _parse_utc(state["started_at"])
    planned_end_at = _parse_utc(state["planned_end_at"])
    assert started_at == expected_start
    assert planned_end_at == expected_start + timedelta(minutes=minutes)
    # Timestamps carry explicit UTC offsets; the browser converts locally.
    assert started_at.utcoffset() == timedelta(0)


@pytest.fixture
def client(monkeypatch, tmp_path):
    """Override conftest.client with the frozen clock in scope here."""
    monkeypatch.setenv("DRILL_DB_PATH", str(tmp_path / "drill.db"))
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def frozen_now(monkeypatch) -> datetime:
    fixed = datetime(2026, 9, 15, 10, 0, 0, tzinfo=timezone.utc)

    def fake_now() -> datetime:
        return fixed

    monkeypatch.setattr("app.main._utcnow", fake_now)
    return fixed


# ---------------------------------------------------------------------------
# Default plan for old clients
# ---------------------------------------------------------------------------


def test_start_without_body_gets_30_minute_default_plan(client, frozen_now):
    response = client.post("/api/drills/start")  # no request body at all
    assert response.status_code == 201
    _assert_plan(response.json(), 30, expected_start=frozen_now)


@pytest.mark.parametrize("body", [{}, {"planned_minutes": None}])
def test_empty_body_and_null_get_30_minute_default(
    monkeypatch, tmp_path, frozen_now, body
):
    monkeypatch.setenv("DRILL_DB_PATH", str(tmp_path / "drill.db"))
    with TestClient(app) as test_client:
        response = test_client.post("/api/drills/start", json=body)
        assert response.status_code == 201
        _assert_plan(response.json(), 30, expected_start=frozen_now)


# ---------------------------------------------------------------------------
# Explicit duration flows through write and query
# ---------------------------------------------------------------------------


def test_planned_minutes_flows_through_start_and_query(client, frozen_now):
    response = client.post("/api/drills/start", json={"planned_minutes": 45})
    assert response.status_code == 201
    _assert_plan(response.json(), 45, expected_start=frozen_now)

    fetched = client.get("/api/drills").json()
    _assert_plan(fetched, 45, expected_start=frozen_now)
    assert fetched["started_at"] == response.json()["started_at"]
    assert fetched["planned_end_at"] == response.json()["planned_end_at"]

    # Confirmed responses keep reporting the same immutable time basis.
    confirmed = client.post(
        "/api/drills/confirm",
        json={"node": "cross_passage_open", "version": 1},
    ).json()
    assert confirmed["planned_minutes"] == 45
    assert confirmed["started_at"] == fetched["started_at"]
    assert confirmed["planned_end_at"] == fetched["planned_end_at"]


@pytest.mark.parametrize("minutes", [5, 180])
def test_boundary_durations_5_and_180_are_accepted(
    monkeypatch, tmp_path, frozen_now, minutes
):
    monkeypatch.setenv("DRILL_DB_PATH", str(tmp_path / f"drill-{minutes}.db"))
    with TestClient(app) as test_client:
        created = test_client.post(
            "/api/drills/start", json={"planned_minutes": minutes}
        )
        assert created.status_code == 201, created.text
        _assert_plan(created.json(), minutes, expected_start=frozen_now)


# ---------------------------------------------------------------------------
# Illegal durations never create a drill
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("minutes", [4, 181, 0, -10, 9999])
def test_out_of_range_duration_is_rejected_and_creates_nothing(
    client, frozen_now, minutes
):
    response = client.post("/api/drills/start", json={"planned_minutes": minutes})
    assert response.status_code == 422
    assert "5" in response.json()["detail"] and "180" in response.json()["detail"]

    # No drill row was created: GET is still 404, and a later valid start works.
    assert client.get("/api/drills").status_code == 404
    retry = client.post("/api/drills/start", json={"planned_minutes": 30})
    assert retry.status_code == 201
    _assert_plan(retry.json(), 30, expected_start=frozen_now)


def test_non_integer_duration_is_rejected_and_creates_nothing(
    client, frozen_now
):
    response = client.post(
        "/api/drills/start", json={"planned_minutes": "30分钟"}
    )
    assert response.status_code == 422
    assert client.get("/api/drills").status_code == 404


# ---------------------------------------------------------------------------
# Legacy database: repeatable column migration + first-read backfill
# ---------------------------------------------------------------------------


def test_legacy_row_is_migrated_and_backfilled_on_first_read(
    tmp_path, monkeypatch, frozen_now
):
    db_file = tmp_path / "legacy.db"
    # Simulate a database written by the first release: old schema, no timing
    # columns at all, one in-progress row.
    with sqlite3.connect(db_file) as raw:
        raw.execute(
            """
            CREATE TABLE drill (
                id           INTEGER PRIMARY KEY CHECK (id = 1),
                status       TEXT NOT NULL CHECK (status IN ('in_progress', 'completed')),
                current_node TEXT NOT NULL,
                version      INTEGER NOT NULL CHECK (version >= 1)
            )
            """
        )
        raw.execute(
            "INSERT INTO drill (id, status, current_node, version) "
            "VALUES (1, 'in_progress', 'upstream_seal', 2)"
        )

    monkeypatch.setenv("DRILL_DB_PATH", str(db_file))
    with TestClient(app) as test_client:
        # init_db must be repeatable: run it a second time without error and
        # without duplicating columns.
        database.init_db()

        with sqlite3.connect(db_file) as check:
            columns = {row[1] for row in check.execute("PRAGMA table_info(drill)")}
            assert {"planned_minutes", "started_at", "planned_end_at"} <= columns
            legacy = check.execute(
                "SELECT planned_minutes, started_at, planned_end_at FROM drill"
            ).fetchone()
            assert legacy == (None, None, None)

        # First read fills the missing basis using the (frozen) server clock.
        state = test_client.get("/api/drills")
        assert state.status_code == 200
        body = state.json()
        _assert_plan(body, 30, expected_start=frozen_now)
        assert body["node"] == "upstream_seal" and body["version"] == 2

        # The backfill is durable and stable: a restart keeps the same instants.
    with TestClient(app) as test_client:
        again = test_client.get("/api/drills").json()
        assert again["started_at"] == body["started_at"]
        assert again["planned_end_at"] == body["planned_end_at"]
        assert again["planned_minutes"] == 30


def test_legacy_row_backfills_on_first_confirm_without_touching_machine(
    tmp_path, monkeypatch, frozen_now
):
    db_file = tmp_path / "legacy-confirm.db"
    with sqlite3.connect(db_file) as raw:
        raw.execute(
            """
            CREATE TABLE drill (
                id           INTEGER PRIMARY KEY CHECK (id = 1),
                status       TEXT NOT NULL CHECK (status IN ('in_progress', 'completed')),
                current_node TEXT NOT NULL,
                version      INTEGER NOT NULL CHECK (version >= 1)
            )
            """
        )
        raw.execute(
            "INSERT INTO drill (id, status, current_node, version) "
            "VALUES (1, 'in_progress', 'cross_passage_open', 1)"
        )

    monkeypatch.setenv("DRILL_DB_PATH", str(db_file))
    with TestClient(app) as test_client:
        confirmed = test_client.post(
            "/api/drills/confirm",
            json={"node": "cross_passage_open", "version": 1},
        )
        assert confirmed.status_code == 200
        body = confirmed.json()
        _assert_plan(body, 30, expected_start=frozen_now)
        # The three-step machine semantics are unchanged.
        assert body["node"] == "upstream_seal" and body["version"] == 2


def test_start_with_duration_uses_server_clock_not_client_time(
    client, monkeypatch
):
    # Whatever the browser's wall clock says, end = server start + duration.
    fixed = datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc)
    monkeypatch.setattr("app.main._utcnow", lambda: fixed)
    body = client.post(
        "/api/drills/start", json={"planned_minutes": 7}
    ).json()
    _assert_plan(body, 7, expected_start=fixed)


def test_concurrent_first_reads_backfill_one_consistent_basis(
    tmp_path, monkeypatch, frozen_now
):
    db_file = tmp_path / "legacy-race.db"
    with sqlite3.connect(db_file) as raw:
        raw.execute(
            """
            CREATE TABLE drill (
                id           INTEGER PRIMARY KEY CHECK (id = 1),
                status       TEXT NOT NULL CHECK (status IN ('in_progress', 'completed')),
                current_node TEXT NOT NULL,
                version      INTEGER NOT NULL CHECK (version >= 1)
            )
            """
        )
        raw.execute(
            "INSERT INTO drill (id, status, current_node, version) "
            "VALUES (1, 'in_progress', 'cross_passage_open', 1)"
        )

    monkeypatch.setenv("DRILL_DB_PATH", str(db_file))
    with TestClient(app) as test_client:
        barrier = threading.Barrier(2)
        bases: list[tuple[str, str, int]] = []

        def read() -> None:
            barrier.wait()
            body = test_client.get("/api/drills").json()
            bases.append(
                (body["started_at"], body["planned_end_at"], body["planned_minutes"])
            )

        threads = [threading.Thread(target=read) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

    # Both callers observe the identical basis, written exactly once.
    assert bases[0] == bases[1]
    assert bases[0] == (
        frozen_now.isoformat(),
        (frozen_now + timedelta(minutes=30)).isoformat(),
        30,
    )
