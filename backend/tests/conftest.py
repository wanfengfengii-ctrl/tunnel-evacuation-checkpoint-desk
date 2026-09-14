import os
import sys
from pathlib import Path

import pytest

# Make `import app.main` work regardless of the directory pytest is launched
# from. The actual per-test database is injected via DRILL_DB_PATH below;
# connections read that variable on every request, so a fresh file per test is
# enough to isolate state.
BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

os.environ.setdefault("DRILL_DB_PATH", "/tmp/pytest-drill-default.db")

from fastapi.testclient import TestClient  # noqa: E402

from app.main import STEPS, app  # noqa: E402


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DRILL_DB_PATH", str(tmp_path / "drill.db"))
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def started(client):
    response = client.post("/api/drills/start")
    assert response.status_code == 201
    return client


def body_of(response) -> dict:
    return response.json()
