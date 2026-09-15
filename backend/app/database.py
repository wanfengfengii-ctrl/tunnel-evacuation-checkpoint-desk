"""SQLite access layer.

The whole application keeps exactly one drill in one table whose single row
has the fixed primary key ``1``. The database file location is read from the
environment on every connection so that test suites can point it at a
temporary database and so that an API restart simply re-opens the same file.

Time planning columns (all times are stored as UTC ISO-8601 strings)::

    planned_minutes  INTEGER  operator-estimated duration (5..180)
    started_at       TEXT     server-side UTC instant the drill started
    planned_end_at   TEXT     started_at + planned_minutes, computed server-side

They are added as nullable columns so an existing single-row database can be
migrated in place with repeatable ``ALTER TABLE`` statements; rows written by
an older version hold NULLs there and get a consistent time basis backfilled
on their first read (see ``app.main``).
"""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path

DEFAULT_DB_PATH = "/data/drill.db"


def db_path() -> Path:
    return Path(os.environ.get("DRILL_DB_PATH", DEFAULT_DB_PATH))


def connect() -> sqlite3.Connection:
    """Open a connection in autocommit mode.

    Transactions are started explicitly with ``BEGIN IMMEDIATE`` by the
    service layer so that the compare-and-set on (node, version) is serialised
    against concurrent retries.
    """
    conn = sqlite3.connect(db_path(), timeout=30, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 30000")
    return conn


# Columns added after the first release, mapped to their ALTER TABLE fragment.
# Kept nullable so the statement succeeds on a table that already has the
# legacy row; application code guarantees non-NULL values after backfill.
_MIGRATION_COLUMNS: tuple[tuple[str, str], ...] = (
    ("planned_minutes", "ALTER TABLE drill ADD COLUMN planned_minutes INTEGER"),
    ("started_at", "ALTER TABLE drill ADD COLUMN started_at TEXT"),
    ("planned_end_at", "ALTER TABLE drill ADD COLUMN planned_end_at TEXT"),
)


def init_db() -> None:
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = connect()
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS drill (
                id              INTEGER PRIMARY KEY CHECK (id = 1),
                status          TEXT NOT NULL CHECK (status IN ('in_progress', 'completed')),
                current_node    TEXT NOT NULL,
                version         INTEGER NOT NULL CHECK (version >= 1),
                planned_minutes INTEGER,
                started_at      TEXT,
                planned_end_at  TEXT
            )
            """
        )
        # Repeatable migration of a legacy single-row table: only add columns
        # that are missing, so init_db() is safe to run any number of times.
        existing = {row[1] for row in conn.execute("PRAGMA table_info(drill)")}
        for name, statement in _MIGRATION_COLUMNS:
            if name not in existing:
                conn.execute(statement)
    finally:
        conn.close()
