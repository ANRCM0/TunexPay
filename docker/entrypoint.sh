#!/usr/bin/env bash
set -euo pipefail

DB_MIGRATION_RETRY_SECONDS="${DB_MIGRATION_RETRY_SECONDS:-5}"
DB_MIGRATION_MAX_ATTEMPTS="${DB_MIGRATION_MAX_ATTEMPTS:-0}"
API_INTERNAL_PORT="${API_INTERNAL_PORT:-3001}"
WEB_INTERNAL_PORT="${WEB_INTERNAL_PORT:-3000}"
GATEWAY_PORT="${GATEWAY_PORT:-8080}"

log() {
  printf '[TunexPay] %s\n' "$*"
}

run_migrations() {
  local attempt=1
  while true; do
    log "Running database migrations (attempt ${attempt})..."
    if npm run db:deploy; then
      log "Database migrations completed."
      return 0
    fi

    if [[ "${DB_MIGRATION_MAX_ATTEMPTS}" != "0" && "${attempt}" -ge "${DB_MIGRATION_MAX_ATTEMPTS}" ]]; then
      log "Database migration retry limit reached; exiting."
      return 1
    fi

    log "Database unavailable or migration failed; retrying in ${DB_MIGRATION_RETRY_SECONDS}s."
    attempt=$((attempt + 1))
    sleep "${DB_MIGRATION_RETRY_SECONDS}"
  done
}

PIDS=()
NAMES=()

start_child() {
  local name="$1"
  shift
  log "Starting ${name}..."
  "$@" &
  PIDS+=("$!")
  NAMES+=("${name}")
}

stop_children() {
  trap - SIGTERM SIGINT
  if (("${#PIDS[@]}" > 0)); then
    log "Stopping child processes..."
    kill -TERM "${PIDS[@]}" 2>/dev/null || true
    wait "${PIDS[@]}" 2>/dev/null || true
  fi
}

wait_http() {
  local name="$1"
  local url="$2"
  local attempts="${3:-60}"
  local i

  for ((i=1; i<=attempts; i++)); do
    if node -e "fetch(process.argv[1], { signal: AbortSignal.timeout(1500) }).then(r => process.exit(r.status < 500 ? 0 : 1)).catch(() => process.exit(1))" "$url"; then
      log "${name} is ready."
      return 0
    fi
    sleep 1
  done

  log "${name} did not become ready."
  return 1
}

on_signal() {
  stop_children
  exit 143
}

trap on_signal SIGTERM SIGINT
trap stop_children EXIT

run_migrations

start_child "API" env PORT="${API_INTERNAL_PORT}" node apps/api/dist/server.js
start_child "Worker" node apps/api/dist/worker.js
start_child "Web" env PORT="${WEB_INTERNAL_PORT}" HOSTNAME=127.0.0.1 INTERNAL_API_URL="${INTERNAL_API_URL:-http://127.0.0.1:${API_INTERNAL_PORT}}" npm run start --workspace @tuoxin-pay/web

wait_http "API" "http://127.0.0.1:${API_INTERNAL_PORT}/health"
wait_http "Web" "http://127.0.0.1:${WEB_INTERNAL_PORT}/login"

start_child "Gateway" env GATEWAY_PORT="${GATEWAY_PORT}" API_INTERNAL_PORT="${API_INTERNAL_PORT}" WEB_INTERNAL_PORT="${WEB_INTERNAL_PORT}" node docker/gateway.mjs

log "TunexPay appliance is ready on :${GATEWAY_PORT}."

set +e
wait -n "${PIDS[@]}"
STATUS=$?
set -e

log "A TunexPay child process exited with status ${STATUS}; restarting the appliance."
exit "${STATUS}"
