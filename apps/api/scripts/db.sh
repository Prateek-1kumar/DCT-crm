#!/usr/bin/env bash
# Postgres 16 for DCT Finance in Apple `container` (not Docker). Port 5434.
# Only ever touches the container named dct-postgres.
set -euo pipefail
NAME=dct-postgres
PORT=5434

exists() { container ls -a | awk 'NR>1 {print $1}' | grep -qx "$NAME"; }

wait_ready() {
  for _ in $(seq 1 60); do
    if container exec "$NAME" pg_isready -U dct -q 2>/dev/null; then
      # separate databases for vitest and the Playwright e2e run
      for db in dct_finance_test dct_finance_e2e; do
        container exec "$NAME" psql -U dct -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1 \
          || container exec "$NAME" psql -U dct -d postgres -c "CREATE DATABASE $db" >/dev/null
      done
      echo "postgres ready on localhost:$PORT (dct_finance, dct_finance_test, dct_finance_e2e)"
      return 0
    fi
    sleep 1
  done
  echo "postgres did not become ready" >&2
  exit 1
}

start() {
  if exists; then
    container start "$NAME" >/dev/null 2>&1 || true
  else
    container run -d --name "$NAME" \
      -e POSTGRES_USER=dct -e POSTGRES_PASSWORD=dct -e POSTGRES_DB=dct_finance \
      -p "$PORT:5432" postgres:16 >/dev/null
  fi
  wait_ready
}

stop() {
  if exists; then container stop "$NAME" >/dev/null && echo "stopped $NAME"; fi
}

reset() {
  if exists; then
    container stop "$NAME" >/dev/null 2>&1 || true
    container delete "$NAME" >/dev/null
  fi
  start
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  reset) reset ;;
  *) echo "usage: $0 start|stop|reset" >&2; exit 2 ;;
esac
