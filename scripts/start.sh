#!/usr/bin/env bash
# AI Slaves Power Doc launcher.
# Double-click or run from terminal: ./scripts/start.sh

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

UI_PORT=5179
API_PORT=5176
URL="http://localhost:${UI_PORT}/"

echo "[ai-slaves] root: ${ROOT}"

# 1. install deps if missing
if [ ! -d "node_modules" ]; then
  echo "[ai-slaves] installing deps (first run)..."
  npm install
fi

# 2. free the ports if anything is already on them (best effort)
for PORT in ${UI_PORT} ${API_PORT}; do
  PIDS=$(lsof -ti:${PORT} 2>/dev/null || true)
  if [ -n "${PIDS}" ]; then
    echo "[ai-slaves] freeing port ${PORT} (killing ${PIDS})"
    echo "${PIDS}" | xargs kill 2>/dev/null || true
    sleep 1
  fi
done

# 3. spawn dev server in background (Vite UI + Express API)
LOG_DIR="${ROOT}/logs"
mkdir -p "${LOG_DIR}"
LOG="${LOG_DIR}/dev.log"
echo "[ai-slaves] starting dev server, logging to ${LOG}"
nohup npm run dev > "${LOG}" 2>&1 &
PID=$!
echo "[ai-slaves] pid: ${PID}"
echo "${PID}" > "${ROOT}/.dev.pid"

# 4. wait briefly for vite to come up, then open browser
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf --max-time 1 "${URL}" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "[ai-slaves] opening ${URL}"
if command -v open >/dev/null 2>&1; then
  open "${URL}"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "${URL}"
else
  echo "[ai-slaves] open ${URL} in your browser"
fi

echo ""
echo "[ai-slaves] dashboard is running."
echo "[ai-slaves] tail -f ${LOG}   to follow output"
echo "[ai-slaves] kill \$(cat ${ROOT}/.dev.pid)   to stop"
