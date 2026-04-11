#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agentmonitor-v2-contract-rust.XXXXXX")"
SERVER_LOG="$TMP_DIR/server.log"
SERVER_PID=""
DB_PATH="$TMP_DIR/agentmonitor-rs.db"
TEST_GLOB="${TEST_GLOB:-tests/parity/v2/**/*.test.ts}"

cleanup() {
  local exit_code=$?
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
  exit "$exit_code"
}

trap cleanup EXIT INT TERM

# Resolve cargo binary
CARGO_BIN="${HOME}/.cargo/bin/cargo"
if [[ ! -x "$CARGO_BIN" ]]; then
  CARGO_BIN="cargo"
fi

PORT="$(
  node -e "const net = require('node:net'); const server = net.createServer(); server.listen(0, '127.0.0.1', () => { console.log(server.address().port); server.close(); });"
)"

# Create fixture home with Claude JSONL files
mkdir -p "$TMP_DIR/home/.claude/projects"
mkdir -p "$TMP_DIR/home/.codex"

cd "$ROOT_DIR"

HOME="$TMP_DIR/home" \
CODEX_HOME="$TMP_DIR/home/.codex" \
  node scripts/test/seed-v2-contract-fixture.mjs

HOME="$TMP_DIR/home" \
CODEX_HOME="$TMP_DIR/home/.codex" \
  node scripts/test/seed-v2-codex-fixture.mjs

# Run Rust import CLI to populate the DB from seeded JSONL
env AGENTMONITOR_RUST_DB_PATH="$DB_PATH" \
  "$CARGO_BIN" run --manifest-path rust-backend/Cargo.toml --bin import -- \
  --source all \
  --claude-dir "$TMP_DIR/home/.claude" \
  --codex-dir "$TMP_DIR/home/.codex"

# Start Rust server against the populated DB
env \
  AGENTMONITOR_HOST="127.0.0.1" \
  AGENTMONITOR_RUST_PORT="$PORT" \
  AGENTMONITOR_RUST_DB_PATH="$DB_PATH" \
  AGENTMONITOR_AUTO_IMPORT_MINUTES="0" \
  AGENTMONITOR_STATS_INTERVAL="60000" \
  AGENTMONITOR_ENABLE_LIVE_TAB="true" \
  AGENTMONITOR_UI_DIR="$ROOT_DIR/public" \
  AGENTMONITOR_APP_UI_DIR="$ROOT_DIR/frontend/dist" \
  "$CARGO_BIN" run --manifest-path rust-backend/Cargo.toml --bin agentmonitor-rs \
  >"$SERVER_LOG" 2>&1 &
SERVER_PID="$!"

for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null; then
    AGENTMONITOR_BASE_URL="http://127.0.0.1:$PORT" \
      node --import tsx --test "$TEST_GLOB"
    exit 0
  fi
  sleep 1
done

echo "Rust server failed to start" >&2
cat "$SERVER_LOG" >&2
exit 1
