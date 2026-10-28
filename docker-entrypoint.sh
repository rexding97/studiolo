#!/bin/sh
set -eu
umask 077

DATA_DIR="${REXHUB_DATA_DIR:-/app/server/data}"
PORT="${REXHUB_PORT:-3002}"
HOST="${REXHUB_HOST:-0.0.0.0}"
DB="${REXHUB_DB:-$DATA_DIR/rexhub.db}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  if ! gosu studiolo test -w "$DATA_DIR"; then
    chown studiolo:studiolo "$DATA_DIR"
  fi
  exec gosu studiolo "$0" "$@"
fi

if [ -n "${REXHUB_INIT_PASSWORD:-}" ]; then
  REXHUB_DB="$DB" python /app/server/docker_init.py
fi

if [ -n "${REXHUB_IMPORT_YAML:-}" ]; then
  if [ ! -f "$REXHUB_IMPORT_YAML" ]; then
    echo "[init] REXHUB_IMPORT_YAML not found: $REXHUB_IMPORT_YAML" >&2
    exit 1
  fi

  case "${REXHUB_IMPORT_FORCE:-0}" in
    0)
      if python - "$DB" <<'PY'
import sys

sys.path.insert(0, "/app/server")
import db

db.configure(sys.argv[1])
db.init()
sys.exit(0 if db.get_state() else 1)
PY
      then
        echo "[init] desktop state exists; import skipped (use a one-shot force restore to replace it)"
      else
        python /app/server/rexhub.py --data "$DB" --import-yaml "$REXHUB_IMPORT_YAML"
      fi
      ;;
    1)
      MARKER="$DATA_DIR/.rexhub-import-force.sha256"
      DIGEST="$(python - "$REXHUB_IMPORT_YAML" <<'PY'
import hashlib
import sys

with open(sys.argv[1], "rb") as source:
    print(hashlib.file_digest(source, "sha256").hexdigest())
PY
)"
      if [ -f "$MARKER" ] && [ "$(cat "$MARKER")" = "$DIGEST" ]; then
        echo "[init] this forced import already succeeded; skipping"
      else
        python /app/server/rexhub.py --data "$DB" --import-yaml "$REXHUB_IMPORT_YAML" --force-import
        TEMP_MARKER="$MARKER.tmp.$$"
        printf '%s\n' "$DIGEST" > "$TEMP_MARKER"
        mv "$TEMP_MARKER" "$MARKER"
        echo "[init] forced import completed and recorded"
      fi
      ;;
    *)
      echo "[init] REXHUB_IMPORT_FORCE must be 0 or 1" >&2
      exit 1
      ;;
  esac
fi

if [ "${REXHUB_IMPORT_ONLY:-0}" = "1" ]; then
  exit 0
fi

exec python /app/server/rexhub.py \
  --host "$HOST" \
  --port "$PORT" \
  --web /app/web \
  --data "$DB"
