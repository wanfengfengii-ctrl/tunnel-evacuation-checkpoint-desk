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
"""

from __future__ import annotations

import sqlite3
from contextlib import asynccontextmanager
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


class DrillConflict(Exception):
    """Raised inside a transaction; rolled back and rendered as HTTP 409."""

    def __init__(self, code: str, detail: str, row: sqlite3.Row | None):
        self.code = code
        self.detail = detail
        self.row = row


class ConfirmIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    node: str
    version: int


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(title="隧道疏散演练指挥 API", version="1.0.0", lifespan=lifespan)


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


def _serialize(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "status": row["status"],
        "node": row["current_node"],
        "version": row["version"],
        "steps": list(STEPS),
    }


def _get_row(conn: sqlite3.Connection) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT id, status, current_node, version FROM drill WHERE id = 1"
    ).fetchone()


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/drills")
def get_drill() -> dict[str, Any]:
    conn = connect()
    try:
        row = _get_row(conn)
    finally:
        conn.close()
    if row is None:
        raise HTTPException(status_code=404, detail="drill_not_found")
    return _serialize(row)


@app.post("/api/drills/start", status_code=201)
def start_drill() -> dict[str, Any]:
    """Create the one drill with the fixed order and version 1.

    Allowed only while no drill exists. A second call (in progress or already
    completed) is a 409 carrying the actual state and changes nothing.
    """
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
            conn.execute(
                "INSERT INTO drill (id, status, current_node, version) "
                "VALUES (1, 'in_progress', ?, 1)",
                (STEPS[0],),
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
