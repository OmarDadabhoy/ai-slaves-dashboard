#!/usr/bin/env bash
# Stop the AI Slaves Power Doc dev server started by start.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

if [ -f ".dev.pid" ]; then
  PID="$(cat .dev.pid)"
  if kill -0 "${PID}" 2>/dev/null; then
    echo "[ai-slaves] killing ${PID}"
    kill "${PID}" 2>/dev/null || true
  fi
  rm -f .dev.pid
fi

for PORT in 5179 5176; do
  PIDS=$(lsof -ti:${PORT} 2>/dev/null || true)
  if [ -n "${PIDS}" ]; then
    echo "[ai-slaves] freeing port ${PORT}"
    echo "${PIDS}" | xargs kill 2>/dev/null || true
  fi
done

echo "[ai-slaves] stopped."
