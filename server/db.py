"""SQLite 持久层：状态、账号、会话、点击、指标、探针。"""

import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import threading
from datetime import datetime, timezone

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "rexhub.db")
_local = threading.local()

SCHEMA = """
CREATE TABLE IF NOT EXISTS state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL,
  rev INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rev INTEGER NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  username TEXT NOT NULL,
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  iterations INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session (
  token_hash TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS clicks (
  app_id TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  last_click TEXT
);
CREATE TABLE IF NOT EXISTS click_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_click_event_app_ts ON click_event(app_id, ts);
CREATE TABLE IF NOT EXISTS host_metric (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL,
  ts TEXT NOT NULL,
  cpu REAL,
  mem REAL,
  disk REAL,
  uptime INTEGER,
  load1 REAL,
  ping_ms REAL,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_metric_host_ts ON host_metric(host, ts DESC);
CREATE TABLE IF NOT EXISTS probe (
  app_id TEXT PRIMARY KEY,
  online INTEGER NOT NULL,
  http_code INTEGER,
  latency_ms REAL,
  checked_at TEXT NOT NULL,
  error TEXT
);
"""


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def configure(path):
    global DB_PATH
    DB_PATH = path
    os.makedirs(os.path.dirname(path), exist_ok=True)


def conn():
    c = getattr(_local, "conn", None)
    if c is None:
        c = sqlite3.connect(DB_PATH, timeout=15)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA synchronous=NORMAL")
        c.execute("PRAGMA busy_timeout=8000")
        _local.conn = c
    return c


def init():
    c = conn()
    c.executescript(SCHEMA)
    c.commit()
    _migrate_clicks_to_events()


def _migrate_clicks_to_events():
    """把旧版累计点击拆成事件，让 7 天热度在升级后仍有初始值。"""
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
    c.commit()


# ---------- state ----------

def get_state():
    row = conn().execute("SELECT json, rev, updated_at FROM state WHERE id = 1").fetchone()
    if not row:
        return None
    return {"state": json.loads(row["json"]), "rev": row["rev"], "updatedAt": row["updated_at"]}


def put_state(state, expected_rev):
    """返回 (payload, conflict_rev)。成功时 conflict_rev 为 None。"""
    c = conn()
    row = c.execute("SELECT rev FROM state WHERE id = 1").fetchone()
    current = row["rev"] if row else 0
    if expected_rev is not None and int(expected_rev) != current:
        return None, current
    payload = json.dumps(state, ensure_ascii=False, separators=(",", ":"))
    new_rev = current + 1
    ts = now_iso()
    c.execute(
        "INSERT INTO state(id, json, rev, updated_at) VALUES(1, ?, ?, ?) "
        "ON CONFLICT(id) DO UPDATE SET json = excluded.json, rev = excluded.rev, updated_at = excluded.updated_at",
        (payload, new_rev, ts),
    )
    c.execute("INSERT INTO snapshot(rev, json, created_at) VALUES(?, ?, ?)", (new_rev, payload, ts))
    c.execute("DELETE FROM snapshot WHERE id NOT IN (SELECT id FROM snapshot ORDER BY id DESC LIMIT 20)")
    c.commit()
    return {"rev": new_rev, "updatedAt": ts}, None


def snapshots(limit=20):
    rows = conn().execute(
        "SELECT rev, created_at FROM snapshot ORDER BY id DESC LIMIT ?", (limit,)
    ).fetchall()
    return [{"rev": r["rev"], "createdAt": r["created_at"]} for r in rows]


def snapshot_json(rev):
    row = conn().execute("SELECT json FROM snapshot WHERE rev = ? ORDER BY id DESC LIMIT 1", (rev,)).fetchone()
    return json.loads(row["json"]) if row else None


# ---------- auth ----------

def has_user():
    return conn().execute("SELECT 1 FROM user WHERE id = 1").fetchone() is not None


def set_password(username, password, iterations=200000):
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    conn().execute(
        "INSERT INTO user(id, username, salt, hash, iterations, updated_at) VALUES(1, ?, ?, ?, ?, ?) "
        "ON CONFLICT(id) DO UPDATE SET username = excluded.username, salt = excluded.salt, "
        "hash = excluded.hash, iterations = excluded.iterations, updated_at = excluded.updated_at",
        (username, salt.hex(), digest.hex(), iterations, now_iso()),
    )
    conn().commit()


def verify_password(username, password):
    row = conn().execute("SELECT salt, hash, iterations FROM user WHERE id = 1").fetchone()
    if not row:
        return False
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(row["salt"]), row["iterations"]
    )
    return hmac.compare_digest(digest.hex(), row["hash"])


def create_session(username, ttl=7 * 86400):
    token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    c = conn()
    c.execute(
        "INSERT INTO session(token_hash, username, created_at, expires_at) VALUES(?, ?, ?, ?)",
        (token_hash, username, now_iso(), _future_iso(ttl)),
    )
    c.execute("DELETE FROM session WHERE expires_at < ?", (now_iso(),))
    c.commit()
    return token


def check_session(token):
    if not token:
        return None
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    row = conn().execute(
        "SELECT username, expires_at FROM session WHERE token_hash = ?", (token_hash,)
    ).fetchone()
    if not row or row["expires_at"] < now_iso():
        return None
    return row["username"]


def delete_session(token):
    if not token:
        return
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    c = conn()
    c.execute("DELETE FROM session WHERE token_hash = ?", (token_hash,))
    c.commit()


def _future_iso(seconds):
    from datetime import timedelta
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat(timespec="seconds")


# ---------- clicks ----------

def record_click(app_id):
    c = conn()
    ts = now_iso()
    c.execute("INSERT INTO click_event(app_id, ts) VALUES(?, ?)", (app_id, ts))
    c.execute(
        "INSERT INTO clicks(app_id, count, last_click) VALUES(?, 1, ?) "
        "ON CONFLICT(app_id) DO UPDATE SET count = count + 1, last_click = excluded.last_click",
        (app_id, ts),
    )
    c.execute("DELETE FROM click_event WHERE ts < ?", (_retention_cutoff(30 * 86400),))
    c.commit()


def click_counts(days=7):
    cutoff = _retention_cutoff(days * 86400)
    rows = conn().execute(
        "SELECT app_id, COUNT(*) AS c, MAX(ts) AS last FROM click_event WHERE ts >= ? GROUP BY app_id",
        (cutoff,),
    ).fetchall()
    return {r["app_id"]: {"count": r["c"], "lastClick": r["last"]} for r in rows}


# ---------- metrics ----------

def record_metric(host, data):
    c = conn()
    c.execute(
        "INSERT INTO host_metric(host, ts, cpu, mem, disk, uptime, load1, ping_ms, error) "
        "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            host, now_iso(), data.get("cpu"), data.get("mem"), data.get("disk"),
            data.get("uptime"), data.get("load1"), data.get("pingMs"), data.get("error"),
        ),
    )
    c.execute(
        "DELETE FROM host_metric WHERE ts < ?",
        (_retention_cutoff(2 * 86400),),
    )
    c.commit()


def latest_metrics():
    rows = conn().execute(
        "SELECT m.* FROM host_metric m JOIN (SELECT host, MAX(id) AS id FROM host_metric GROUP BY host) x "
        "ON m.id = x.id"
    ).fetchall()
    return {
        r["host"]: {
            "cpu": r["cpu"], "mem": r["mem"], "disk": r["disk"], "uptime": r["uptime"],
            "load1": r["load1"], "pingMs": r["ping_ms"], "ts": r["ts"], "error": r["error"],
        }
        for r in rows
    }


def metric_history(host, limit=60):
    rows = conn().execute(
        "SELECT ts, cpu, mem, disk, load1 FROM host_metric WHERE host = ? ORDER BY id DESC LIMIT ?",
        (host, limit),
    ).fetchall()
    return [dict(r) for r in reversed(rows)]


def _retention_cutoff(seconds):
    from datetime import timedelta
    return (datetime.now(timezone.utc) - timedelta(seconds=seconds)).isoformat(timespec="seconds")


# ---------- probes ----------

def save_probe(app_id, online, http_code, latency_ms, error=None):
    c = conn()
    c.execute(
        "INSERT INTO probe(app_id, online, http_code, latency_ms, checked_at, error) VALUES(?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(app_id) DO UPDATE SET online = excluded.online, http_code = excluded.http_code, "
        "latency_ms = excluded.latency_ms, checked_at = excluded.checked_at, error = excluded.error",
        (app_id, 1 if online else 0, http_code, latency_ms, now_iso(), error),
    )
    c.commit()


def all_probes():
    rows = conn().execute("SELECT * FROM probe").fetchall()
    return {
        r["app_id"]: {
            "online": bool(r["online"]), "httpCode": r["http_code"],
            "latencyMs": r["latency_ms"], "checkedAt": r["checked_at"], "error": r["error"],
        }
        for r in rows
    }
