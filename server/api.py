"""HTTP API business logic, authentication and bounded external caches."""

import hashlib
import ipaddress
import json
import os
import ssl
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor

import db
import validation

FAVICON_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "favicon")
FAVICON_TTL = 86400
FAVICON_MAX = 256
FAVICON_BYTES = 512 * 1024
WEATHER_TTL = 600
WEATHER_STALE_TTL = 86400
GEO_TTL = 86400
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) rexhub/1.0"
ADMIN_USER = "admin"

_weather_cache = {}
_weather_negative = {}
_geo_cache = {}
_weather_locks = [threading.Lock() for _ in range(64)]
_weather_pending = set()
_weather_guard = threading.Lock()
_weather_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="rexhub-weather")
_login_fails = {}
_login_lock = threading.Lock()
_icon_memory = OrderedDict()
_icon_locks = [threading.Lock() for _ in range(64)]
_icon_guard = threading.Lock()
_icon_last_cleanup = 0.0


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def _validated(fn, *args):
    try:
        return fn(*args)
    except validation.ValidationError as exc:
        raise ApiError(400, str(exc)) from None


def _session_cookies(handler):
    cookies = {}
    for part in handler.headers.get("Cookie", "").split(";"):
        name, _, value = part.strip().partition("=")
        if name in ("__Host-rex_sid", "rex_sid"):
            cookies[name] = value
    return cookies


def request_user(handler):
    cookies = _session_cookies(handler)
    for name in ("__Host-rex_sid", "rex_sid"):
        user = db.check_session(cookies.get(name))
        if user:
            return user
    return None


def require_user(handler):
    user = request_user(handler)
    if not user:
        raise ApiError(401, "未登录")
    return user


def _secure_cookie():
    return os.environ.get("REXHUB_SECURE_COOKIE", "").lower() in ("1", "true", "yes", "on")


def _cookie(token, max_age, name=None):
    secure = _secure_cookie()
    name = name or ("__Host-rex_sid" if secure else "rex_sid")
    secure_attribute = "; Secure" if secure or name == "__Host-rex_sid" else ""
    return f"{name}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure_attribute}"


def _trusted_proxies():
    result = set()
    for raw in os.environ.get("REXHUB_TRUSTED_PROXIES", "").split(","):
        try:
            result.add(str(ipaddress.ip_address(raw.strip())))
        except ValueError:
            continue
    return result


def _client_ip(handler):
    direct = handler.client_address[0]
    trusted = _trusted_proxies()
    try:
        direct = str(ipaddress.ip_address(direct))
    except ValueError:
        return direct
    if direct not in trusted:
        return direct
    chain = [p.strip() for p in handler.headers.get("X-Forwarded-For", "").split(",") if p.strip()]
    if not chain:
        return direct
    try:
        addresses = [str(ipaddress.ip_address(p)) for p in chain]
    except ValueError:
        return direct
    for address in reversed(addresses):
        if address not in trusted:
            return address
    return addresses[0]


def login(handler, body, query):
    payload = dict(body) if isinstance(body, dict) else body
    if isinstance(payload, dict):
        payload.setdefault("username", ADMIN_USER)
    username, password = _validated(validation.validate_login, payload)
    ip = _client_ip(handler)
    now = time.time()
    with _login_lock:
        for key in list(_login_fails):
            fresh = [t for t in _login_fails[key] if now - t < 300]
            if fresh:
                _login_fails[key] = fresh
            else:
                del _login_fails[key]
        fails = _login_fails.get(ip, [])
        if len(fails) >= 8:
            raise ApiError(429, "尝试过于频繁，请 5 分钟后再试")
    if not db.verify_password(username, password):
        with _login_lock:
            _login_fails.setdefault(ip, []).append(now)
        raise ApiError(401, "用户名或密码错误")
    token = db.create_session(username)
    with _login_lock:
        _login_fails.pop(ip, None)
    handler.extra_header("Set-Cookie", _cookie(token, 604800))
    return 200, {"username": username}


def logout(handler, body, query):
    for token in _session_cookies(handler).values():
        db.delete_session(token)
    handler.extra_header("Set-Cookie", _cookie("", 0, "__Host-rex_sid"))
    handler.extra_header("Set-Cookie", _cookie("", 0, "rex_sid"))
    return 200, {"ok": True}


def change_password(handler, body, query):
    username = require_user(handler)
    validation.require_dict(body, "请求体")
    current = body.get("currentPassword")
    new = body.get("newPassword")
    if (not isinstance(current, str) or not 1 <= len(current) <= 1024
            or not isinstance(new, str) or not 1 <= len(new) <= 1024):
        raise ApiError(400, "currentPassword/newPassword 必须是有效字符串")
    if not db.verify_password(username, current):
        raise ApiError(403, "当前密码错误")
    db.set_password(username, new)
    handler.extra_header("Set-Cookie", _cookie("", 0))
    return 200, {"ok": True}


def me(handler, body, query):
    user = request_user(handler)
    return 200, {"username": user, "authenticated": bool(user)}


def get_state(handler, body, query):
    require_user(handler)
    return 200, db.get_state() or {"rev": 0, "updatedAt": None, "state": None}


def put_state(handler, body, query):
    require_user(handler)
    validation.require_dict(body, "请求体")
    state = body.get("state")
    validation.validate_state(state)
    if len(json.dumps(state, ensure_ascii=False, allow_nan=False).encode("utf-8")) > 2 * 1024 * 1024:
        raise ApiError(413, "state 超过 2MB")
    payload, conflict = db.put_state(state, body.get("rev"))
    if conflict is None:
        return 200, payload
    current = db.get_state()
    return 409, {"error": "conflict", "rev": conflict, "state": current["state"] if current else None}


def list_snapshots(handler, body, query):
    require_user(handler)
    return 200, {"snapshots": db.snapshots(query.get("limit", [20])[0])}


def get_snapshot(handler, body, query, rev):
    require_user(handler)
    snapshot = db.snapshot_json(rev)
    if snapshot is None:
        raise ApiError(404, "快照不存在")
    return 200, snapshot


def restore_snapshot(handler, body, query, rev):
    require_user(handler)
    body = {} if body is None else validation.require_dict(body, "请求体")
    expected = body.get("expectedRev", body.get("rev"))
    force = body.get("force", False)
    if not isinstance(force, bool):
        raise ApiError(400, "force 必须是布尔值")
    payload, conflict = db.restore_state(rev, expected, force=force)
    if conflict == "not_found":
        raise ApiError(404, "快照不存在")
    if conflict is not None:
        current = db.get_state()
        return 409, {"error": "conflict", "rev": conflict, "state": current["state"] if current else None}
    return 200, payload


def weather_cities_from_state():
    current = db.get_state()
    if not current:
        return []
    cities = []
    for item in current["state"].get("layout", []):
        if not isinstance(item, dict) or item.get("widgetType") != "weather":
            continue
        config = item.get("config") if isinstance(item.get("config"), dict) else {}
        city = (config.get("city") or "").strip()
        if city and city not in cities:
            cities.append(city)
    return cities[:8]


def normalize_city(city):
    if not isinstance(city, str) or len(city) > 128:
        raise ApiError(400, "city 必须是不超过 128 字符的字符串")
    for sep in ("·", "|", ",", "，", "/"):
        if sep in city:
            city = city.split(sep)[0]
    return city.strip() or "南京"


def _schedule_weather(city):
    key = city.lower()
    with _weather_guard:
        if key in _weather_pending:
            return
        _weather_pending.add(key)
    def work():
        try:
            get_weather(city)
        except ApiError:
            pass
        finally:
            with _weather_guard:
                _weather_pending.discard(key)
    try:
        _weather_pool.submit(work)
    except RuntimeError:
        with _weather_guard:
            _weather_pending.discard(key)


def _runtime_weather(city):
    key = normalize_city(city).lower()
    now = time.time()
    with _weather_guard:
        hit = _weather_cache.get(key)
    if hit and now - hit[0] <= WEATHER_STALE_TTL:
        payload = dict(hit[1])
        payload["stale"] = now - hit[0] >= WEATHER_TTL
        if payload["stale"]:
            _schedule_weather(city)
        return payload
    _schedule_weather(city)
    return {"stale": True, "status": "loading"}


def runtime(handler, body, query):
    require_user(handler)
    weather = {}
    for city in weather_cities_from_state():
        payload = _runtime_weather(city)
        payload["query"] = city
        weather[city] = payload
    return 200, {"hosts": db.latest_metrics(), "probes": db.all_probes(), "clicks": db.click_counts(),
                 "weather": weather, "serverTime": db.now_iso()}


def state_meta(handler, body, query):
    require_user(handler)
    current = db.get_state()
    return 200, {"rev": current["rev"], "updatedAt": current["updatedAt"]} if current else {"rev": 0, "updatedAt": None}


def metric_history(handler, body, query):
    require_user(handler)
    host = query.get("host", [""])[0]
    validation.validate_id(host, "host")
    return 200, {"host": host, "points": db.metric_history(host, 60)}


def record_click(handler, body, query):
    require_user(handler)
    validation.require_dict(body, "请求体")
    app_id = validation.validate_id(body.get("appId"), "appId")
    db.record_click(app_id)
    return 200, {"ok": True}


def allowed_favicon_hosts():
    current = db.get_state()
    hosts = set()
    if not current:
        return hosts
    for app in current["state"].get("apps", []):
        for key in ("href", "logoUrl"):
            value = app.get(key)
            if isinstance(value, str) and value:
                try:
                    parsed = urllib.parse.urlparse(value)
                    if parsed.hostname:
                        hosts.add(parsed.hostname.lower().rstrip("."))
                except ValueError:
                    continue
    return hosts


def _icon_key(parsed):
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    return f"{parsed.scheme}://{parsed.hostname.lower().rstrip('.')}:{port}/favicon.ico"


def _icon_memory_get(key):
    now = time.time()
    with _icon_guard:
        hit = _icon_memory.get(key)
        if not hit:
            return None
        if now - hit[0] > FAVICON_TTL:
            del _icon_memory[key]
            return None
        _icon_memory.move_to_end(key)
        return hit[1], hit[2]


def _icon_memory_put(key, data, ctype):
    with _icon_guard:
        _icon_memory[key] = (time.time(), data, ctype)
        _icon_memory.move_to_end(key)
        while len(_icon_memory) > FAVICON_MAX:
            _icon_memory.popitem(last=False)


def _icon_disk_get(key):
    now = time.time()
    for ext, ctype in (("png", "image/png"), ("ico", "image/x-icon"), ("jpg", "image/jpeg"),
                       ("gif", "image/gif"), ("webp", "image/webp")):
        path = os.path.join(FAVICON_DIR, hashlib.sha256(key.encode()).hexdigest() + "." + ext)
        try:
            if now - os.path.getmtime(path) > FAVICON_TTL:
                continue
            with open(path, "rb") as fh:
                data = fh.read(FAVICON_BYTES + 1)
            if 0 < len(data) <= FAVICON_BYTES and _sniff_ctype(data):
                return data, ctype
        except OSError:
            continue
    return None


def _cleanup_icons():
    global _icon_last_cleanup
    now = time.time()
    if now - _icon_last_cleanup < 300:
        return
    _icon_last_cleanup = now
    try:
        entries = []
        for name in os.listdir(FAVICON_DIR):
            path = os.path.join(FAVICON_DIR, name)
            if not os.path.isfile(path):
                continue
            stat = os.stat(path)
            if now - stat.st_mtime > FAVICON_TTL:
                os.unlink(path)
            else:
                entries.append((stat.st_mtime, path))
        for _, path in sorted(entries, reverse=True)[FAVICON_MAX:]:
            os.unlink(path)
    except OSError:
        pass


def favicon(handler, body, query):
    require_user(handler)
    raw = query.get("u", [""])[0]
    _validated(validation.validate_url, raw, "u")
    parsed = urllib.parse.urlparse(raw)
    if parsed.hostname.lower().rstrip(".") not in allowed_favicon_hosts():
        raise ApiError(403, "该域名不在桌面应用列表中")
    key = _icon_key(parsed)
    cached = _icon_memory_get(key) or _icon_disk_get(key)
    if cached:
        return _binary(cached[0], cached[1], cache="public, max-age=86400")
    lock = _icon_locks[hash(key) % len(_icon_locks)]
    with lock:
        cached = _icon_memory_get(key) or _icon_disk_get(key)
        if cached:
            return _binary(cached[0], cached[1], cache="public, max-age=86400")
        data, ctype = _fetch_icon(parsed, allowed_favicon_hosts())
        if not data:
            raise ApiError(404, "未找到位图图标")
        os.makedirs(FAVICON_DIR, exist_ok=True)
        ext = {"image/png": "png", "image/x-icon": "ico", "image/jpeg": "jpg",
               "image/gif": "gif", "image/webp": "webp"}[ctype]
        path = os.path.join(FAVICON_DIR, hashlib.sha256(key.encode()).hexdigest() + "." + ext)
        fd, tmp = tempfile.mkstemp(prefix=".icon-", dir=FAVICON_DIR)
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(data)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
        _icon_memory_put(key, data, ctype)
        _cleanup_icons()
        return _binary(data, ctype, cache="public, max-age=86400")


class _IconRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, allowed):
        self.allowed = allowed

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        try:
            parsed = urllib.parse.urlparse(newurl)
            host = parsed.hostname
            port = parsed.port
        except ValueError:
            raise urllib.error.HTTPError(newurl, code, "invalid redirect", headers, fp) from None
        if parsed.scheme not in ("http", "https") or not host or host.lower().rstrip(".") not in self.allowed:
            raise urllib.error.HTTPError(newurl, code, "redirect host is not allowed", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _fetch_icon(parsed, allowed_hosts=None):
    allowed_hosts = allowed_hosts or {parsed.hostname.lower()}
    origin = f"{parsed.scheme}://{parsed.netloc}"
    opener = urllib.request.build_opener(_IconRedirect(allowed_hosts), urllib.request.HTTPSHandler(context=_ctx()))
    try:
        req = urllib.request.Request(origin + "/favicon.ico", headers={"User-Agent": UA, "Accept": "image/*"})
        with opener.open(req, timeout=6) as resp:
            data = resp.read(FAVICON_BYTES + 1)
            declared = resp.headers.get("Content-Type", "").split(";")[0].strip().lower()
        if not data or len(data) > FAVICON_BYTES:
            return None, None
        ctype = _sniff_ctype(data)
        if not ctype or declared in ("image/svg+xml", "image/xml", "text/xml", "application/xml", "text/html"):
            return None, None
        if declared and declared != "application/octet-stream" and not declared.startswith("image/"):
            return None, None
        return data, ctype
    except Exception:
        return None, None


def _sniff_ctype(data):
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"\x00\x00\x01\x00":
        return "image/x-icon"
    if data[:2] == b"\xff\xd8":
        return "image/jpeg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def _looks_like_image(data):
    return _sniff_ctype(data) is not None


def _ctx():
    return ssl.create_default_context()


def _binary(data, ctype, cache="no-store"):
    return 200, {"__binary__": data, "contentType": ctype, "cacheControl": cache}


def get_weather(city):
    city = normalize_city(city or "南京")
    key = city.lower()
    lock = _weather_locks[hash(key) % len(_weather_locks)]
    with lock:
        now = time.time()
        hit = _weather_cache.get(key)
        if hit and now - hit[0] < WEATHER_TTL:
            return hit[1]
        negative = _weather_negative.get(key)
        if negative and now - negative[0] < 60:
            if hit:
                return dict(hit[1], stale=True)
            raise ApiError(negative[1], "天气服务暂时不可用")
        try:
            payload = _fetch_weather(city, key, now)
        except ApiError as exc:
            _weather_negative[key] = (now, exc.status)
            if len(_weather_negative) > 128:
                oldest = min(_weather_negative, key=lambda k: _weather_negative[k][0])
                _weather_negative.pop(oldest, None)
            if hit and now - hit[0] < WEATHER_STALE_TTL:
                return dict(hit[1], stale=True)
            raise
        _weather_cache[key] = (now, payload)
        _weather_negative.pop(key, None)
        if len(_weather_cache) > 128:
            oldest = min(_weather_cache, key=lambda k: _weather_cache[k][0])
            _weather_cache.pop(oldest, None)
        return payload


def _fetch_weather(city, key, now):
    geo = _geo_cache.get(key)
    if not geo or now - geo[0] > GEO_TTL:
        geo_data = _get_json("https://geocoding-api.open-meteo.com/v1/search?" + urllib.parse.urlencode(
            {"name": city, "count": 1, "language": "zh", "format": "json"}))
        results = (geo_data or {}).get("results") or []
        if not results:
            raise ApiError(404, "未找到城市")
        try:
            geo = (now, {"lat": results[0]["latitude"], "lon": results[0]["longitude"],
                         "name": results[0].get("name", city)})
        except (KeyError, TypeError):
            raise ApiError(502, "地理编码响应无效") from None
        _geo_cache[key] = geo
        if len(_geo_cache) > 128:
            oldest = min(_geo_cache, key=lambda k: _geo_cache[k][0])
            _geo_cache.pop(oldest, None)
    params = {"latitude": geo[1]["lat"], "longitude": geo[1]["lon"],
              "current": "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m",
              "daily": "weather_code,temperature_2m_max,temperature_2m_min", "timezone": "auto", "forecast_days": 4}
    data = _get_json("https://api.open-meteo.com/v1/forecast?" + urllib.parse.urlencode(params))
    if not data:
        raise ApiError(502, "天气服务不可用")
    try:
        cur = data.get("current") or {}
        daily = data.get("daily") or {}
        days = []
        for i in range(min(4, len(daily.get("time") or []))):
            days.append({"date": daily["time"][i], "code": daily["weather_code"][i],
                         "max": daily["temperature_2m_max"][i], "min": daily["temperature_2m_min"][i]})
    except (KeyError, IndexError, TypeError):
        raise ApiError(502, "天气响应无效") from None
    return {"city": geo[1]["name"], "temp": cur.get("temperature_2m"), "feels": cur.get("apparent_temperature"),
            "humidity": cur.get("relative_humidity_2m"), "wind": cur.get("wind_speed_10m"),
            "code": cur.get("weather_code"), "days": days, "updatedAt": db.now_iso(), "stale": False}


def weather(handler, body, query):
    require_user(handler)
    return 200, get_weather(normalize_city(query.get("city", ["南京"])[0]))


def _get_json(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=8, context=_ctx()) as resp:
            raw = resp.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            return None
        return json.loads(raw.decode("utf-8"))
    except Exception as exc:
        print(f"[weather] {exc}", flush=True)
        return None
