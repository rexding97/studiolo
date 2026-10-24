#!/bin/sh
set -eu

DATA_DIR="${REXHUB_DATA_DIR:-/app/server/data}"
PORT="${REXHUB_PORT:-3002}"
DB="${REXHUB_DB:-$DATA_DIR/rexhub.db}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R studiolo:studiolo "$DATA_DIR"
  exec gosu studiolo "$0" "$@"
fi

if [ -n "${REXHUB_INIT_PASSWORD:-}" ]; then
  REXHUB_DB="$DB" python /app/server/docker_init.py
fi

if [ -n "${REXHUB_IMPORT_YAML:-}" ]; then
  if [ ! -f "$REXHUB_IMPORT_YAML" ]; then
    echo "[init] REXHUB_IMPORT_YAML not found: $REXHUB_IMPORT_YAML" >&2
  elif [ "${REXHUB_IMPORT_FORCE:-0}" = "1" ]; then
    python /app/server/rexhub.py --data "$DB" --import-yaml "$REXHUB_IMPORT_YAML" --force-import || true
  else
    python /app/server/rexhub.py --data "$DB" --import-yaml "$REXHUB_IMPORT_YAML" || true
  fi
fi

exec python /app/server/rexhub.py \
  --host 0.0.0.0 \
  --port "$PORT" \
  --web /app/web \
  --data "$DB"
