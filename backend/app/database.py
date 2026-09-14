"""SQLite access layer.

The whole application keeps exactly one drill in one table whose single row
has the fixed primary key ``1``. The database file location is read from the
environment on every connection so that test suites can point it at a
temporary database and so that an API restart simply re-opens the same file.
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


def init_db() -> None:
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = connect()
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS drill (
                id           INTEGER PRIMARY KEY CHECK (id = 1),
                status       TEXT NOT NULL CHECK (status IN ('in_progress', 'completed')),
                current_node TEXT NOT NULL,
                version      INTEGER NOT NULL CHECK (version >= 1)
            )
            """
        )
    finally:
        conn.close()
