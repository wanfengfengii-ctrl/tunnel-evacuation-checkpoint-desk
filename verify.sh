#!/usr/bin/env bash
# One-shot acceptance run used by the `verify` compose service.
# Starts REAL processes (uvicorn + built Vite preview) against a fresh SQLite
# file and runs pytest, Vitest and Playwright against them — including hard
# API restarts from inside the test suites.
set -euo pipefail

cd /work

PY="${PYTHON_BIN:-python3}"
export DRILL_DB_PATH=/tmp/verify-drill/drill.db
rm -rf /tmp/verify-drill
mkdir -p /tmp/verify-drill

# Fixed internal ports inside the one-shot container (host ports irrelevant).
export API_PORT=18000
export WEB_PORT=14173
export E2E_API_PORT="$API_PORT"
export E2E_WEB_PORT="$WEB_PORT"
export E2E_RUN_DIR=/tmp/e2e-run

echo "==> [1/3] pytest (FastAPI + SQLite, includes real uvicorn restart test)"
( cd backend && "$PY" -m pytest )

echo "==> [2/3] Vitest (React/TypeScript unit tests)"
( cd frontend && npm run test )

echo "==> [3/3] Playwright (real browser vs real API + Vite preview)"
( cd frontend && npm run test:e2e )

echo "==> verify OK: pytest, Vitest and Playwright all passed"
