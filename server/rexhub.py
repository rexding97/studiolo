#!/usr/bin/env python3
"""Studiolo Hub — 零依赖 HTTP 服务：静态托管 + JSON API + 后台采集。"""

import argparse
import json
import os
import sys
import urllib.parse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import api
import collectors
import db

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_WEB = os.path.normpath(os.path.join(BASE_DIR, "..", "web"))
DEFAULT_DB = os.path.join(BASE_DIR, "data", "rexhub.db")
MAX_BODY = 2 * 1024 * 1024

ROUTES = {
    ("POST", "/api/v1/auth/login"): api.login,
    ("POST", "/api/v1/auth/logout"): api.logout,
    ("GET", "/api/v1/auth/me"): api.me,
    ("GET", "/api/v1/state"): api.get_state,
    ("PUT", "/api/v1/state"): api.put_state,
    ("GET", "/api/v1/state/meta"): api.state_meta,
    ("GET", "/api/v1/state/snapshots"): api.list_snapshots,
    ("GET", "/api/v1/runtime"): api.runtime,
    ("GET", "/api/v1/metrics"): api.metric_history,
    ("POST", "/api/v1/click"): api.record_click,
    ("GET", "/api/v1/favicon"): api.favicon,
    ("GET", "/api/v1/weather"): api.weather,
    ("GET", "/api/v1/health"): lambda handler, body, query: (
        200, {"ok": True, "ts": db.now_iso(), "user": bool(api.request_user(handler))}
    ),
}


# ---------- 从 state 推导采集目标 ----------

LOCAL_IPS = {"127.0.0.1", "localhost", "::1"}


def hosts_from_state():
    current = db.get_state()
    if not current:
        return [{"id": "mac", "local": True, "ip": "127.0.0.1"}]
    out = []
    for item in current["state"].get("layout", []):
        if item.get("kind") != "widget" or item.get("widgetType") != "server-node":
            continue
        cfg = item.get("config") or {}
        host_id = str(item.get("id", "host-x")).replace("host-", "")
        ip = (cfg.get("ip") or "").strip()
        out.append({
            "id": host_id,
            "ip": ip,
            "local": host_id == "mac" or ip in LOCAL_IPS,
            "sshPort": int(cfg.get("sshPort") or 22),
            "sshUser": cfg.get("sshUser") or "root",
        })
    if not any(h["local"] for h in out):
        out.insert(0, {"id": "mac", "ip": "127.0.0.1", "local": True})
    return out


def apps_from_state():
    current = db.get_state()
    if not current:
        return []
    return [a for a in current["state"].get("apps", []) if isinstance(a, dict)]


# ---------- HTTP ----------

class Handler(SimpleHTTPRequestHandler):
    server_version = "rexhub/1.0"

    def __init__(self, *args, **kwargs):
        self._extra_headers = []
        self._is_static = False
        super().__init__(*args, **kwargs)

    def extra_header(self, name, value):
        self._extra_headers.append((name, value))

    def do_GET(self):
        self._dispatch("GET")

    def do_HEAD(self):
        self._dispatch("HEAD")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def _dispatch(self, method):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        if not path.startswith("/api/"):
            if method not in ("GET", "HEAD"):
                return self._send(405, {"error": "method not allowed"})
            self._is_static = True
            return super().do_GET()

        lookup = "GET" if method == "HEAD" else method
        fn = ROUTES.get((lookup, path))
        if not fn:
            return self._send(404, {"error": "not found"})

        body = None
        if method in ("POST", "PUT"):
            body = self._read_json()
            if body is BAD_BODY:
                return

        try:
            status, payload = fn(self, body, urllib.parse.parse_qs(parsed.query))
        except api.ApiError as exc:
            return self._send(exc.status, {"error": exc.message})
        except Exception as exc:  # noqa: BLE001
            print(f"[api] {method} {path} failed: {exc}", flush=True)
            return self._send(500, {"error": "internal error"})
        self._send(status, payload)

    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length > MAX_BODY:
            self._send(413, {"error": "请求体过大"})
            return BAD_BODY
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send(400, {"error": "JSON 格式错误"})
            return BAD_BODY

    def _send(self, status, payload):
        if isinstance(payload, dict) and "__binary__" in payload:
            body = payload["__binary__"]
            ctype = payload["contentType"]
            cache = payload.get("cacheControl", "no-store")
        else:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            ctype = "application/json; charset=utf-8"
            cache = "no-store"

        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        for name, value in self._extra_headers:
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except BrokenPipeError:
                pass

    def end_headers(self):
        if self._is_static and not self._extra_headers:
            self.send_header("Cache-Control", "no-cache, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        if fmt.startswith('"') or "code" in fmt:
            print(f"[http] {self.address_string()} {fmt % args}", flush=True)


BAD_BODY = object()


def build_parser():
    p = argparse.ArgumentParser(description="Studiolo Hub")
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--port", type=int, default=3002)
    p.add_argument("--web", default=DEFAULT_WEB)
    p.add_argument("--data", default=DEFAULT_DB)
    p.add_argument("--user", default=api.ADMIN_USER)
    p.add_argument("--set-password", action="store_true", help="从 REXHUB_INIT_PASSWORD 或 stdin 读取并写入密码哈希")
    return p


def main():
    args = build_parser().parse_args()
    db.configure(args.data)
    db.init()

    if args.set_password:
        api.ADMIN_USER = args.user
        password = os.environ.get("REXHUB_INIT_PASSWORD") or sys.stdin.readline().rstrip("\r\n")
        if not password:
            print("密码为空，未写入", file=sys.stderr)
            return 1
        db.set_password(args.user, password)
        print(f"已为 {args.user} 设置密码（仅保存 PBKDF2 哈希）")
        return 0

    if not db.has_user():
        print("警告：尚未设置登录密码，请先运行 --set-password", file=sys.stderr)

    web_dir = os.path.abspath(args.web)
    if not os.path.isdir(web_dir):
        print(f"静态目录不存在：{web_dir}", file=sys.stderr)
        return 1

    handler_cls = partial(Handler, directory=web_dir)
    httpd = ThreadingHTTPServer((args.host, args.port), handler_cls)
    httpd.daemon_threads = True

    collector = collectors.Collector(hosts_from_state, apps_from_state)
    collector.start()

    print(f"rexhub listening on http://{args.host}:{args.port} (web={web_dir}, db={args.data})", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("shutting down", flush=True)
    finally:
        collector.stop()
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
