#!/usr/bin/env bash
# 无 Docker 环境下的等价黑盒：编译 -> 全新数据目录启动 dist 产物 ->
# suite -> pre -> 杀进程重启 -> post。仅真实 HTTP 访问。
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8181}"
BASE_URL="http://127.0.0.1:${PORT}"
RUN_ID="${RUN_ID:-local$(date +%s)}"
DATA_DIR="$(mktemp -d)"
DB_PATH="$DATA_DIR/dispatch.db"
LOG="$DATA_DIR/server.log"

cleanup() {
  if [ -n "${SRV_PID:-}" ] && kill -0 "$SRV_PID" 2>/dev/null; then
    kill -TERM "$SRV_PID" 2>/dev/null || true
    wait "$SRV_PID" 2>/dev/null || true
  fi
  rm -rf "$DATA_DIR"
}
trap cleanup EXIT

echo "== build =="
npm run build

start_server() {
  SQLITE_PATH="$DB_PATH" PORT="$PORT" HOST=127.0.0.1 \
    node --experimental-sqlite dist/index.js >"$LOG" 2>&1 &
  SRV_PID=$!
  for i in $(seq 1 50); do
    if curl -fsS "$BASE_URL/healthz" >/dev/null 2>&1; then return 0; fi
    if ! kill -0 "$SRV_PID" 2>/dev/null; then
      echo "服务进程退出"; cat "$LOG"; exit 1
    fi
    sleep 0.2
  done
  echo "服务未就绪"; cat "$LOG"; exit 1
}

echo "== start (fresh DB) =="
start_server

echo "== suite =="
BASE_URL="$BASE_URL" RUN_ID="$RUN_ID" node scripts/blackbox.mjs suite

echo "== pre-restart =="
BASE_URL="$BASE_URL" RUN_ID="$RUN_ID" node scripts/blackbox.mjs pre

echo "== restart server process (DB file retained) =="
kill -TERM "$SRV_PID"
wait "$SRV_PID" 2>/dev/null || true
SRV_PID=""
start_server

echo "== post-restart =="
BASE_URL="$BASE_URL" RUN_ID="$RUN_ID" node scripts/blackbox.mjs post

echo ""
echo "✅ 本地黑盒全部通过（RUN_ID=$RUN_ID, DB=$DB_PATH）"
