"""SQLite persistence for state, snapshots, authentication and telemetry."""

import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import threading
from datetime import datetime, timedelta, timezone

import validation

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "rexhub.db")
SCHEMA_VERSION = 1
_local = threading.local()
_init_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS state (
  id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL,
  rev INTEGER NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT, rev INTEGER NOT NULL,
  json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshot_rev ON snapshot(rev);
CREATE TABLE IF NOT EXISTS user (
  id INTEGER PRIMARY KEY CHECK (id = 1), username TEXT NOT NULL,
  salt TEXT NOT NULL, hash TEXT NOT NULL, iterations INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session (
  token_hash TEXT PRIMARY KEY, username TEXT NOT NULL,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_expires ON session(expires_at);
CREATE TABLE IF NOT EXISTS clicks (
  app_id TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, last_click TEXT
);
CREATE TABLE IF NOT EXISTS click_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT, app_id TEXT NOT NULL, ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_click_event_app_ts ON click_event(app_id, ts);
CREATE TABLE IF NOT EXISTS host_metric (
  id INTEGER PRIMARY KEY AUTOINCREMENT, host TEXT NOT NULL, ts TEXT NOT NULL,
  cpu REAL, mem REAL, disk REAL, uptime INTEGER, load1 REAL, ping_ms REAL, error TEXT
);
CREATE INDEX IF NOT EXISTS idx_metric_host_ts ON host_metric(host, ts DESC);
CREATE TABLE IF NOT EXISTS probe (
  app_id TEXT PRIMARY KEY, online INTEGER NOT NULL, http_code INTEGER,
  latency_ms REAL, checked_at TEXT NOT NULL, error TEXT
);
"""


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def configure(path):
    global DB_PATH
    if not isinstance(path, (str, os.PathLike)) or not os.fspath(path):
        raise ValueError("数据库路径不能为空")
    normalized = os.path.realpath(os.path.abspath(os.path.expanduser(os.fspath(path))))
    old = getattr(_local, "conn", None)
    if old is not None:
        old.close()
        _local.conn = None
    DB_PATH = normalized
    parent = os.path.dirname(DB_PATH)
    if parent:
        os.makedirs(parent, exist_ok=True)
    return DB_PATH


def conn():
    c = getattr(_local, "conn", None)
    if c is None:
        c = sqlite3.connect(DB_PATH, timeout=15)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA synchronous=NORMAL")
        c.execute("PRAGMA busy_timeout=15000")
        c.execute("PRAGMA foreign_keys=ON")
        _local.conn = c
    return c


def _backup_before_migration(version):
    if not os.path.exists(DB_PATH) or os.path.getsize(DB_PATH) == 0:
        return None
    source = sqlite3.connect(DB_PATH)
    try:
        has_table = source.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='state'").fetchone()
        if not has_table:
            return None
        target_path = f"{DB_PATH}.pre-v{SCHEMA_VERSION}.bak"
        if os.path.exists(target_path):
            return target_path
        tmp = target_path + ".tmp"
        target = sqlite3.connect(tmp)
        try:
            source.backup(target)
        finally:
            target.close()
        os.replace(tmp, target_path)
        return target_path
    finally:
        source.close()


def init():
    with _init_lock:
        c = conn()
        version = int(c.execute("PRAGMA user_version").fetchone()[0])
        if version > SCHEMA_VERSION:
            raise RuntimeError(f"数据库版本 {version} 高于支持的版本 {SCHEMA_VERSION}")
        if version < SCHEMA_VERSION:
            _backup_before_migration(version)
        c.executescript(SCHEMA)
        _migrate_clicks_to_events(commit=False)
        c.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
        c.commit()
        c.execute("DELETE FROM session WHERE expires_at < ?", (now_iso(),))
        c.commit()


def _migrate_clicks_to_events(commit=True):
    c = conn()
    if c.execute("SELECT 1 FROM click_event LIMIT 1").fetchone():
        return
    rows = c.execute("SELECT app_id, count, last_click FROM clicks").fetchall()
    for row in rows:
        count = int(row["count"] or 0)
        ts = row["last_click"] or now_iso()
        if count > 0:
            c.executemany(
                "INSERT INTO click_event(app_id, ts) VALUES(?, ?)",
                [(row["app_id"], ts)] * min(count, 5000),
            )
    if commit:
        c.commit()


def get_state():
    row = conn().execute("SELECT json, rev, updated_at FROM state WHERE id = 1").fetchone()
    if not row:
        return None
    return {"state": json.loads(row["json"]), "rev": row["rev"], "updatedAt": row["updated_at"]}


def _replace_clicks(c, state, ts):
    c.execute("DELETE FROM click_event")
    c.execute("DELETE FROM clicks")
    for app in state.get("apps", []):
        count = int(app.get("clicks") or 0)
        if count <= 0:
            continue
        app_id = app["id"]
        c.execute("INSERT INTO clicks(app_id, count, last_click) VALUES(?, ?, ?)", (app_id, count, ts))
        c.executemany(
            "INSERT INTO click_event(app_id, ts) VALUES(?, ?)",
            [(app_id, ts)] * min(count, 5000),
        )


def _clicks_match(c, state):
    expected = {app["id"]: int(app.get("clicks") or 0) for app in state.get("apps", [])
                if int(app.get("clicks") or 0) > 0}
    actual = {row["app_id"]: row["count"] for row in c.execute("SELECT app_id, count FROM clicks")}
    return expected == actual


def _write_state(c, state, expected_rev, force=False, replace_clicks=False):
    current = c.execute("SELECT rev, json FROM state WHERE id = 1").fetchone()
    current_rev = current["rev"] if current else 0
    if not force and expected_rev is not None:
        if (isinstance(expected_rev, bool) or not isinstance(expected_rev, (int, str))
                or (isinstance(expected_rev, str) and not expected_rev.isdigit())):
            raise validation.ValidationError("rev 必须是非负整数")
        expected = int(expected_rev)
        if expected < 0:
            raise validation.ValidationError("rev 必须是非负整数")
        if expected != current_rev:
            return None, current_rev
    payload = json.dumps(state, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    if (current and current["json"] == payload and (force or replace_clicks)
            and (not replace_clicks or _clicks_match(c, state))):
        return {"rev": current_rev, "updatedAt": c.execute(
            "SELECT updated_at FROM state WHERE id=1"
        ).fetchone()[0], "unchanged": True}, None
    new_rev = current_rev + 1
    ts = now_iso()
    c.execute(
        "INSERT INTO state(id, json, rev, updated_at) VALUES(1, ?, ?, ?) "
        "ON CONFLICT(id) DO UPDATE SET json=excluded.json, rev=excluded.rev, updated_at=excluded.updated_at",
        (payload, new_rev, ts),
    )
    c.execute("INSERT INTO snapshot(rev, json, created_at) VALUES(?, ?, ?)", (new_rev, payload, ts))
    c.execute("DELETE FROM snapshot WHERE id NOT IN (SELECT id FROM snapshot ORDER BY id DESC LIMIT 20)")
    if replace_clicks:
        _replace_clicks(c, state, ts)
    return {"rev": new_rev, "updatedAt": ts, "unchanged": False}, None


def put_state(state, expected_rev):
    validation.validate_state(state)
    c = conn()
    try:
        c.execute("BEGIN IMMEDIATE")
        return _write_state(c, state, expected_rev)
    except Exception:
        c.rollback()
        raise
    finally:
        if c.in_transaction:
            c.commit()


def restore_state(rev, expected_rev=None, force=False):
    if (isinstance(rev, bool) or not isinstance(rev, (int, str))
            or (isinstance(rev, str) and not rev.isdigit()) or int(rev) < 0):
        raise validation.ValidationError("快照 rev 必须是非负整数")
    rev = int(rev)
    c = conn()
    try:
        c.execute("BEGIN IMMEDIATE")
        row = c.execute("SELECT json FROM snapshot WHERE rev=? ORDER BY id DESC LIMIT 1", (rev,)).fetchone()
        if not row:
            c.rollback()
            return None, "not_found"
        state = json.loads(row["json"])
        validation.validate_state(state)
        result, conflict = _write_state(c, state, expected_rev, force=force, replace_clicks=True)
        if conflict is not None:
            c.rollback()
            return None, conflict
        c.commit()
        return result, None
    except Exception:
        if c.in_transaction:
            c.rollback()
        raise


def import_state(state, expected_rev=None, force=False):
    validation.validate_state(state)
    c = conn()
    try:
        c.execute("BEGIN IMMEDIATE")
        result, conflict = _write_state(c, state, expected_rev, force=force, replace_clicks=True)
        if conflict is not None:
            c.rollback()
            return None, conflict
        c.commit()
        return result, None
    except Exception:
        if c.in_transaction:
            c.rollback()
        raise


def snapshots(limit=20):
    if (isinstance(limit, bool) or not isinstance(limit, (int, str))
            or (isinstance(limit, str) and not limit.isdigit())):
        raise validation.ValidationError("limit 必须是整数")
    limit = max(1, min(100, int(limit)))
    rows = conn().execute("SELECT rev, created_at FROM snapshot ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [{"rev": r["rev"], "createdAt": r["created_at"]} for r in rows]


def snapshot_json(rev):
    if (isinstance(rev, bool) or not isinstance(rev, (int, str))
            or (isinstance(rev, str) and not rev.isdigit()) or int(rev) < 0):
        raise validation.ValidationError("快照 rev 必须是非负整数")
    rev = int(rev)
    row = conn().execute("SELECT json, created_at FROM snapshot WHERE rev=? ORDER BY id DESC LIMIT 1", (rev,)).fetchone()
    if not row:
        return None
    return {"state": json.loads(row["json"]), "rev": rev, "createdAt": row["created_at"]}


def has_user():
    return conn().execute("SELECT 1 FROM user WHERE id=1").fetchone() is not None


def set_password(username, password, iterations=200000):
    validation.validate_id(username, "username")
    if not isinstance(password, str) or not 1 <= len(password) <= 1024:
        raise validation.ValidationError("密码必须是 1-1024 字符的字符串")
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    c = conn()
    try:
        c.execute("BEGIN IMMEDIATE")
        c.execute(
            "INSERT INTO user(id, username, salt, hash, iterations, updated_at) VALUES(1, ?, ?, ?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET username=excluded.username, salt=excluded.salt, "
            "hash=excluded.hash, iterations=excluded.iterations, updated_at=excluded.updated_at",
            (username, salt.hex(), digest.hex(), iterations, now_iso()),
        )
        c.execute("DELETE FROM session")
        c.commit()
    except Exception:
        c.rollback()
        raise


def verify_password(username, password):
    if not isinstance(username, str) or not isinstance(password, str):
        return False
    row = conn().execute("SELECT salt, hash, iterations FROM user WHERE id=1").fetchone()
    if not row:
        return False
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(row["salt"]), row["iterations"])
    return hmac.compare_digest(digest.hex(), row["hash"])


def create_session(username, ttl=7 * 86400):
    token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    c = conn()
    c.execute("INSERT INTO session(token_hash, username, created_at, expires_at) VALUES(?, ?, ?, ?)",
              (token_hash, username, now_iso(), _future_iso(ttl)))
    c.execute("DELETE FROM session WHERE expires_at < ?", (now_iso(),))
    c.commit()
    return token


def check_session(token):
    if not isinstance(token, str) or not token or len(token) > 512:
        return None
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    row = conn().execute("SELECT username, expires_at FROM session WHERE token_hash=?", (token_hash,)).fetchone()
    if not row or row["expires_at"] < now_iso():
        return None
    return row["username"]


def delete_session(token):
    if not isinstance(token, str) or not token:
        return
    c = conn()
    c.execute("DELETE FROM session WHERE token_hash=?", (hashlib.sha256(token.encode()).hexdigest(),))
    c.commit()


def _future_iso(seconds):
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat(timespec="seconds")


def record_click(app_id):
    validation.validate_id(app_id, "appId")
    c = conn()
    ts = now_iso()
    c.execute("INSERT INTO click_event(app_id, ts) VALUES(?, ?)", (app_id, ts))
    c.execute("INSERT INTO clicks(app_id, count, last_click) VALUES(?, 1, ?) "
              "ON CONFLICT(app_id) DO UPDATE SET count=count+1, last_click=excluded.last_click", (app_id, ts))
    c.execute("DELETE FROM click_event WHERE ts < ?", (_retention_cutoff(30 * 86400),))
    c.commit()


def seed_clicks(app_id, count):
    if count <= 0:
        return
    ts = now_iso()
    c = conn()
    c.executemany("INSERT INTO click_event(app_id, ts) VALUES(?, ?)", [(app_id, ts)] * min(int(count), 5000))
    c.execute("INSERT INTO clicks(app_id, count, last_click) VALUES(?, ?, ?) "
              "ON CONFLICT(app_id) DO UPDATE SET count=count+excluded.count, last_click=excluded.last_click",
              (app_id, int(count), ts))
    c.commit()


def click_counts(days=7):
    cutoff = _retention_cutoff(days * 86400)
    rows = conn().execute("SELECT app_id, COUNT(*) AS c, MAX(ts) AS last FROM click_event WHERE ts>=? GROUP BY app_id",
                          (cutoff,)).fetchall()
    return {r["app_id"]: {"count": r["c"], "lastClick": r["last"]} for r in rows}


def record_metric(host, data):
    c = conn()
    c.execute("INSERT INTO host_metric(host, ts, cpu, mem, disk, uptime, load1, ping_ms, error) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
              (host, now_iso(), data.get("cpu"), data.get("mem"), data.get("disk"), data.get("uptime"),
               data.get("load1"), data.get("pingMs"), data.get("error")))
    c.execute("DELETE FROM host_metric WHERE ts < ?", (_retention_cutoff(2 * 86400),))
    c.commit()


def latest_metrics():
    rows = conn().execute("SELECT m.* FROM host_metric m JOIN (SELECT host, MAX(id) AS id FROM host_metric GROUP BY host) x ON m.id=x.id").fetchall()
    return {r["host"]: {"cpu": r["cpu"], "mem": r["mem"], "disk": r["disk"], "uptime": r["uptime"],
                        "load1": r["load1"], "pingMs": r["ping_ms"], "ts": r["ts"], "error": r["error"]} for r in rows}


def metric_history(host, limit=60):
    rows = conn().execute("SELECT ts, cpu, mem, disk, load1 FROM host_metric WHERE host=? ORDER BY id DESC LIMIT ?",
                          (host, max(1, min(1000, int(limit))))).fetchall()
    return [dict(r) for r in reversed(rows)]


def _retention_cutoff(seconds):
    return (datetime.now(timezone.utc) - timedelta(seconds=seconds)).isoformat(timespec="seconds")


def save_probe(app_id, online, http_code, latency_ms, error=None):
    c = conn()
    c.execute("INSERT INTO probe(app_id, online, http_code, latency_ms, checked_at, error) VALUES(?, ?, ?, ?, ?, ?) "
              "ON CONFLICT(app_id) DO UPDATE SET online=excluded.online, http_code=excluded.http_code, "
              "latency_ms=excluded.latency_ms, checked_at=excluded.checked_at, error=excluded.error",
              (app_id, 1 if online else 0, http_code, latency_ms, now_iso(), error))
    c.commit()


def all_probes():
    rows = conn().execute("SELECT * FROM probe").fetchall()
    return {r["app_id"]: {"online": bool(r["online"]), "httpCode": r["http_code"], "latencyMs": r["latency_ms"],
                          "checkedAt": r["checked_at"], "error": r["error"]} for r in rows}
