"""Tunnel evacuation drill API.

State machine (fixed order, first node version 1)::

    cross_passage_open -> upstream_seal -> headcount -> completed
            v1                  v2              v3          v4

Every confirmation must carry the node name *and* the version the operator
has seen. The node only advances inside a single database transaction when
both match the row held by the database; the version is then incremented.
Stale retries, duplicate confirmations and skipped nodes are rejected with
HTTP 409 and the response body reports the actual node/version so the browser
can refresh to server state. No conflict response ever mutates state.

Time planning: when starting, the commander may pass an estimated duration
(``planned_minutes``, 5..180 minutes). The server stamps the start with its
own UTC clock and computes ``planned_end_at = started_at + planned_minutes``;
all three fields are returned by every drill read. Older clients that POST no
body get the 30-minute default. A legacy database lacking the columns is
migrated in place; a legacy row lacking time data gets a consistent basis
backfilled on its first read.
"""

from __future__ import annotations

import sqlite3
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from .database import connect, init_db

# The single, fixed confirmation sequence.
STEPS: tuple[str, ...] = (
    "cross_passage_open",  # 横通道开启
    "upstream_seal",       # 上游封闭
    "headcount",           # 人员清点
)

MIN_PLANNED_MINUTES = 5
MAX_PLANNED_MINUTES = 180
# Used when an old client starts without a body and when backfilling a row
# written by an older release.
DEFAULT_PLANNED_MINUTES = 30


class DrillConflict(Exception):
    """Raised inside a transaction; rolled back and rendered as HTTP 409."""

    def __init__(self, code: str, detail: str, row: sqlite3.Row | None):
        self.code = code
        self.detail = detail
        self.row = row


class StartIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Optional: omitted (or null) means the 30-minute legacy default.
    planned_minutes: int | None = None


class ConfirmIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    node: str
    version: int


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="隧道疏散演练指挥 API", version="1.1.0", lifespan=lifespan)


@app.exception_handler(DrillConflict)
async def drill_conflict_handler(request, exc: DrillConflict) -> JSONResponse:
    body: dict[str, Any] = {"error": exc.code, "detail": exc.detail}
    if exc.row is not None:
        body.update(
            node=exc.row["current_node"],
            version=exc.row["version"],
            drill_status=exc.row["status"],
        )
    return JSONResponse(status_code=409, content=body)


def _utcnow() -> datetime:
    """Server clock; isolated as a function so tests can freeze/advance it."""
    return datetime.now(timezone.utc)


def _format_utc(value: datetime) -> str:
    """UTC ISO-8601; the browser parses it and renders local time."""
    return value.isoformat()


def _serialize(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "status": row["status"],
        "node": row["current_node"],
        "version": row["version"],
        "steps": list(STEPS),
        "planned_minutes": row["planned_minutes"],
        "started_at": row["started_at"],
        "planned_end_at": row["planned_end_at"],
    }


def _get_row(conn: sqlite3.Connection) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT id, status, current_node, version, "
        "planned_minutes, started_at, planned_end_at "
        "FROM drill WHERE id = 1"
    ).fetchone()


def _row_missing_timing(row: sqlite3.Row) -> bool:
    return (
        row["planned_minutes"] is None
        or row["started_at"] is None
        or row["planned_end_at"] is None
    )


def _ensure_timing(conn: sqlite3.Connection, row: sqlite3.Row) -> None:
    """Fill a legacy row's missing time data with a consistent basis.

    Older releases wrote no timing columns; their real start instant is
    unrecoverable, so the first read establishes *now* as the basis together
    with the 30-minute default plan — all three columns in one UPDATE, giving
    elapsed/remaining a coherent reference without recreating the database.
    """
    if not _row_missing_timing(row):
        return
    started_at = _utcnow()
    planned_end_at = started_at + timedelta(minutes=DEFAULT_PLANNED_MINUTES)
    conn.execute(
        "UPDATE drill SET planned_minutes = ?, started_at = ?, planned_end_at = ? "
        "WHERE id = 1 AND (planned_minutes IS NULL OR started_at IS NULL "
        "OR planned_end_at IS NULL)",
        (
            DEFAULT_PLANNED_MINUTES,
            _format_utc(started_at),
            _format_utc(planned_end_at),
        ),
    )


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/drills")
def get_drill() -> dict[str, Any]:
    conn = connect()
    try:
        # Plain read first: normal queries never take a write lock. A legacy
        # row lacking time data is backfilled exactly once, under a write
        # transaction so concurrent reads cannot establish two bases.
        row = _get_row(conn)
        if row is None:
            raise HTTPException(status_code=404, detail="drill_not_found")
        if _row_missing_timing(row):
            conn.execute("BEGIN IMMEDIATE")
            try:
                row = _get_row(conn)
                _ensure_timing(conn, row)
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise
            row = _get_row(conn)
            assert row is not None
        return _serialize(row)
    finally:
        conn.close()


@app.post("/api/drills/start", status_code=201)
def start_drill(payload: StartIn | None = None) -> dict[str, Any]:
    """Create the one drill with the fixed order and version 1.

    The optional body carries ``planned_minutes`` (5..180); missing body,
    empty body or null all mean the 30-minute default. Allowed only while no
    drill exists. A second call (in progress or already completed) is a 409
    carrying the actual state and changes nothing.
    """
    minutes = (
        DEFAULT_PLANNED_MINUTES
        if payload is None or payload.planned_minutes is None
        else payload.planned_minutes
    )
    if not MIN_PLANNED_MINUTES <= minutes <= MAX_PLANNED_MINUTES:
        raise HTTPException(
            status_code=422,
            detail=(
                f"预计用时需在 {MIN_PLANNED_MINUTES} 至 "
                f"{MAX_PLANNED_MINUTES} 分钟之间，收到 {minutes}。"
            ),
        )

    conn = connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        try:
            row = _get_row(conn)
            if row is not None:
                raise DrillConflict(
                    "drill_already_exists",
                    "演练已存在，不能重复启动；当前库中只保存唯一一场演练。",
                    row,
                )
            # The server's clock, stamped inside the write transaction, is
            # the single authoritative start instant.
            started_at = _utcnow()
            planned_end_at = started_at + timedelta(minutes=minutes)
            conn.execute(
                "INSERT INTO drill "
                "(id, status, current_node, version, "
                "planned_minutes, started_at, planned_end_at) "
                "VALUES (1, 'in_progress', ?, 1, ?, ?, ?)",
                (
                    STEPS[0],
                    minutes,
                    _format_utc(started_at),
                    _format_utc(planned_end_at),
                ),
            )
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
        row = _get_row(conn)
        assert row is not None
        return _serialize(row)
    finally:
        conn.close()


@app.post("/api/drills/confirm")
def confirm_drill(payload: ConfirmIn) -> dict[str, Any]:
    """Compare-and-set one confirmation in a single transaction.

    Advances only when both the submitted node and the submitted version match
    the database row; increments the version; marks the drill completed after
    the final node. Every mismatch returns 409 with the actual node/version.
    """
    conn = connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        try:
            row = _get_row(conn)
            if row is None:
                raise HTTPException(status_code=404, detail="drill_not_found")

            # Legacy rows get their time basis on the first touch as well.
            _ensure_timing(conn, row)

            if row["status"] == "completed":
                raise DrillConflict(
                    "drill_completed",
                    "演练已完成，完成结果只记录一次，不能再次确认。",
                    row,
                )

            actual_node = row["current_node"]
            actual_version = row["version"]

            if payload.node != actual_node:
                try:
                    submitted_index = STEPS.index(payload.node)
                    current_index = STEPS.index(actual_node)
                except ValueError:
                    code, detail = (
                        "unknown_node",
                        f"未知节点 {payload.node!r}，固定顺序中不存在该节点。",
                    )
                else:
                    if submitted_index < current_index:
                        code, detail = (
                            "duplicate_confirmation",
                            f"节点 {payload.node} 已确认过，不能重复确认。",
                        )
                    else:
                        code, detail = (
                            "skipped_node",
                            f"当前节点为 {actual_node}，不能跳过它确认 {payload.node}。",
                        )
                raise DrillConflict(code, detail, row)

            if payload.version != actual_version:
                if payload.version < actual_version:
                    code, detail = (
                        "old_version",
                        f"提交的是旧版本 {payload.version}，"
                        f"服务器当前版本为 {actual_version}。",
                    )
                else:
                    code, detail = (
                        "version_mismatch",
                        f"提交版本 {payload.version} 与服务器版本 "
                        f"{actual_version} 不一致。",
                    )
                raise DrillConflict(code, detail, row)

            current_index = STEPS.index(actual_node)
            if current_index == len(STEPS) - 1:
                conn.execute(
                    "UPDATE drill SET status = 'completed', version = version + 1 "
                    "WHERE id = 1"
                )
            else:
                conn.execute(
                    "UPDATE drill SET current_node = ?, version = version + 1 "
                    "WHERE id = 1",
                    (STEPS[current_index + 1],),
                )
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise

        row = _get_row(conn)
        assert row is not None
        return _serialize(row)
    finally:
        conn.close()
