#!/usr/bin/env python3
"""Studiolo Hub standard-library HTTP server and CLI."""

import argparse
import json
import os
import re
import socket
import sys
import urllib.parse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import api
import collectors
import db
import schedule
import validation

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_WEB = os.path.normpath(os.path.join(BASE_DIR, "..", "web"))
DEFAULT_DB = os.path.join(BASE_DIR, "data", "rexhub.db")
MAX_BODY = 2 * 1024 * 1024
RUNTIME = {"initialized": False, "collector": None}

ROUTES = {
    ("POST", "/api/v1/auth/login"): api.login,
    ("POST", "/api/v1/auth/logout"): api.logout,
    ("POST", "/api/v1/auth/password"): api.change_password,
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
    ("GET", "/api/v1/calendar/events"): lambda h, b, q: (
        api.require_user(h) and 200, schedule.events(q.get("id", [None])[0])),
}


def _health():
    status = {"ok": False, "initialized": RUNTIME["initialized"], "database": False,
              "collector": {"running": False, "healthy": False}, "ts": db.now_iso()}
    try:
        db.conn().execute("SELECT 1").fetchone()
        status["database"] = True
    except Exception as exc:
        status["databaseError"] = str(exc)[:160]
    collector = RUNTIME["collector"]
    if collector:
        status["collector"] = collector.health()
    status["ok"] = status["database"]
    status["ready"] = status["initialized"] and status["database"] and status["collector"]["healthy"]
    return status


def health(handler, body, query):
    status = _health()
    status["user"] = bool(api.request_user(handler))
    return 200 if status["ok"] else 503, status


def readiness(handler, body, query):
    status = _health()
    return 200 if status["ready"] else 503, status


ROUTES[("GET", "/api/v1/health")] = health
ROUTES[("GET", "/api/v1/ready")] = readiness
ROUTES[("GET", "/api/v1/readiness")] = readiness

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
        out.append({"id": host_id, "ip": ip, "local": host_id == "mac" or ip in LOCAL_IPS,
                    "sshPort": int(cfg.get("sshPort") or 22), "sshUser": cfg.get("sshUser") or "root"})
    if not any(h["local"] for h in out):
        out.insert(0, {"id": "mac", "ip": "127.0.0.1", "local": True})
    return out


def apps_from_state():
    current = db.get_state()
    return [a for a in current["state"].get("apps", []) if isinstance(a, dict)] if current else []


class BoundedThreadingHTTPServer(ThreadingHTTPServer):
    daemon_threads = False
    block_on_close = True

    def __init__(self, server_address, request_handler, max_workers=64):
        self._worker_slots = __import__("threading").BoundedSemaphore(max_workers)
        super().__init__(server_address, request_handler)

    def process_request(self, request, client_address):
        self._worker_slots.acquire()
        try:
            super().process_request(request, client_address)
        except Exception:
            self._worker_slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._worker_slots.release()


class Handler(SimpleHTTPRequestHandler):
    server_version = "rexhub/1.0"
    socket_timeout = 20

    def __init__(self, *args, **kwargs):
        self._extra_headers = []
        self._is_static = False
        super().__init__(*args, **kwargs)

    def setup(self):
        super().setup()
        self.connection.settimeout(self.socket_timeout)

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

    def _origin_allowed(self):
        origin = self.headers.get("Origin")
        if origin is None:
            return True
        host = self.headers.get("Host", "")
        try:
            parsed = urllib.parse.urlparse(origin)
            return (parsed.scheme in ("http", "https") and parsed.netloc == host
                    and parsed.path in ("", "/") and not parsed.query and not parsed.fragment)
        except ValueError:
            return False

    def _dispatch(self, method):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        if not path.startswith("/api/"):
            if method not in ("GET", "HEAD"):
                return self._send(405, {"error": "method not allowed"})
            self._is_static = True
            return super().do_HEAD() if method == "HEAD" else super().do_GET()
        if method in ("POST", "PUT", "DELETE") and not self._origin_allowed():
            return self._send(403, {"error": "Origin 校验失败"})
        lookup = "GET" if method == "HEAD" else method
        query = urllib.parse.parse_qs(parsed.query, max_num_fields=100)
        fn = ROUTES.get((lookup, path))
        route_rev = None
        if not fn:
            match = re.fullmatch(r"/api/v1/state/snapshots/(\d+)(/restore)?", path)
            if match:
                route_rev = int(match.group(1))
                if match.group(2) and lookup == "POST":
                    fn = api.restore_snapshot
                elif not match.group(2) and lookup == "GET":
                    fn = api.get_snapshot
        if not fn:
            return self._send(404, {"error": "not found"})
        body = None
        if method in ("POST", "PUT"):
            body = self._read_json()
            if body is BAD_BODY:
                return
        try:
            if route_rev is None:
                status, payload = fn(self, body, query)
            else:
                status, payload = fn(self, body, query, route_rev)
        except api.ApiError as exc:
            return self._send(exc.status, {"error": exc.message})
        except validation.ValidationError as exc:
            return self._send(400, {"error": str(exc)})
        except (ValueError, TypeError) as exc:
            return self._send(400, {"error": str(exc) or "请求参数类型错误"})
        except Exception as exc:
            print(f"[api] {method} {path} failed: {exc}", flush=True)
            return self._send(500, {"error": "internal error"})
        self._send(status, payload)

    def _read_json(self):
        if self.headers.get("Transfer-Encoding"):
            self._send(400, {"error": "不支持 Transfer-Encoding"})
            return BAD_BODY
        values = self.headers.get_all("Content-Length") or []
        if len(values) != 1 and values:
            self._send(400, {"error": "Content-Length 重复"})
            return BAD_BODY
        raw_length = values[0] if values else "0"
        if not raw_length.isascii() or not raw_length.isdigit():
            self._send(400, {"error": "Content-Length 无效"})
            return BAD_BODY
        length = int(raw_length)
        if length > MAX_BODY:
            self._send(413, {"error": "请求体过大"})
            return BAD_BODY
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"), parse_constant=lambda value: (_ for _ in ()).throw(ValueError("非法数值")))
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            self._send(400, {"error": "JSON 格式错误"})
            return BAD_BODY

    def _send(self, status, payload):
        if isinstance(payload, dict) and "__binary__" in payload:
            body = payload["__binary__"]
            ctype = payload["contentType"]
            cache = payload.get("cacheControl", "no-store")
        else:
            body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
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
            except (BrokenPipeError, ConnectionResetError, socket.timeout):
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
    parser = argparse.ArgumentParser(description="Studiolo Hub")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=3002)
    parser.add_argument("--web", default=DEFAULT_WEB)
    parser.add_argument("--data", default=DEFAULT_DB)
    parser.add_argument("--user", default=api.ADMIN_USER)
    parser.add_argument("--set-password", action="store_true", help="从 REXHUB_INIT_PASSWORD 或 stdin 读取并写入密码哈希")
    parser.add_argument("--import-yaml", metavar="PATH", help="导入 YAML 桌面状态后退出")
    parser.add_argument("--force-import", action="store_true", help="导入时覆盖已有桌面状态")
    return parser


def main():
    args = build_parser().parse_args()
    if not 1 <= args.port <= 65535:
        print("端口必须在 1-65535 之间", file=sys.stderr)
        return 2
    db.configure(args.data)
    db.init()
    RUNTIME["initialized"] = True
    if args.set_password:
        api.ADMIN_USER = args.user
        password = os.environ.get("REXHUB_INIT_PASSWORD") or sys.stdin.readline().rstrip("\r\n")
        if not password:
            print("密码为空，未写入", file=sys.stderr)
            return 1
        try:
            db.set_password(args.user, password)
        except validation.ValidationError as exc:
            print(f"密码设置失败：{exc}", file=sys.stderr)
            return 1
        print(f"已为 {args.user} 设置密码（仅保存 PBKDF2 哈希）")
        return 0
    if args.import_yaml:
        import yaml_import
        try:
            state = yaml_import.load(args.import_yaml)
            result, conflict = db.import_state(state, expected_rev=None if args.force_import else 0,
                                               force=args.force_import)
            if conflict is not None:
                print("已有桌面状态，跳过导入；如需覆盖请加 --force-import", file=sys.stderr)
                return 1
        except (OSError, ValueError, validation.ValidationError, yaml_import.ImportError) as exc:
            print(f"导入失败：{exc}", file=sys.stderr)
            return 1
        print(f"已导入 {len(state['apps'])} 个应用、{len(state['layout'])} 个布局项（rev {result['rev']}）")
        return 0
    if not db.has_user():
        print("警告：尚未设置登录密码，请先运行 --set-password", file=sys.stderr)
    web_dir = os.path.realpath(os.path.abspath(args.web))
    if not os.path.isdir(web_dir):
        print(f"静态目录不存在：{web_dir}", file=sys.stderr)
        return 1
    handler_cls = partial(Handler, directory=web_dir)
    httpd = BoundedThreadingHTTPServer((args.host, args.port), handler_cls)
    collector = collectors.Collector(hosts_from_state, apps_from_state)
    RUNTIME["collector"] = collector
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
