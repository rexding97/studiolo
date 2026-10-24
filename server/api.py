"""HTTP API 业务实现。"""

import hashlib
import json
import os
import ssl
import threading
import time
import urllib.parse
import urllib.request

import db

FAVICON_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "favicon")
WEATHER_TTL = 600
GEO_TTL = 86400
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) rexhub/1.0"

_weather_cache = {}
_geo_cache = {}
_login_fails = {}
_login_lock = threading.Lock()

ADMIN_USER = "admin"


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def request_user(handler):
    """从 Cookie 解析登录用户，未登录返回 None。"""
    raw = handler.headers.get("Cookie", "")
    for part in raw.split(";"):
        name, _, value = part.strip().partition("=")
        if name == "rex_sid":
            return db.check_session(value)
    return None


def require_user(handler):
    user = request_user(handler)
    if not user:
        raise ApiError(401, "未登录")
    return user


# ---------- auth ----------

def login(handler, body, query):
    username = (body or {}).get("username") or ADMIN_USER
    password = (body or {}).get("password") or ""
    ip = handler.client_address[0]
    now = time.time()
    with _login_lock:
        fails = [t for t in _login_fails.get(ip, []) if now - t < 300]
        if len(fails) >= 8:
            raise ApiError(429, "尝试过于频繁，请 5 分钟后再试")
        _login_fails[ip] = fails

    if not db.verify_password(username, password):
        with _login_lock:
            _login_fails.setdefault(ip, []).append(now)
        raise ApiError(401, "用户名或密码错误")

    token = db.create_session(username)
    with _login_lock:
        _login_fails.pop(ip, None)
    handler.extra_header(
        "Set-Cookie",
        f"rex_sid={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800",
    )
    return 200, {"username": username}


def logout(handler, body, query):
    raw = handler.headers.get("Cookie", "")
    for part in raw.split(";"):
        name, _, value = part.strip().partition("=")
        if name == "rex_sid":
            db.delete_session(value)
    handler.extra_header("Set-Cookie", "rex_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0")
    return 200, {"ok": True}


def me(handler, body, query):
    user = request_user(handler)
    return 200, {"username": user, "authenticated": bool(user)}


# ---------- state ----------

def get_state(handler, body, query):
    require_user(handler)
    current = db.get_state()
    if not current:
        return 200, {"rev": 0, "updatedAt": None, "state": None}
    return 200, current


def put_state(handler, body, query):
    require_user(handler)
    if not isinstance(body, dict):
        raise ApiError(400, "请求体必须是 JSON 对象")
    state = body.get("state")
    if not isinstance(state, dict) or not isinstance(state.get("layout"), list) or not isinstance(state.get("apps"), list):
        raise ApiError(400, "state 必须包含 layout 与 apps 数组")
    if len(json.dumps(state, ensure_ascii=False)) > 2 * 1024 * 1024:
        raise ApiError(413, "state 超过 2MB")
    payload, conflict = db.put_state(state, body.get("rev"))
    if conflict is None:
        return 200, payload
    current = db.get_state()
    return 409, {"error": "conflict", "rev": conflict, "state": current["state"] if current else None}


def list_snapshots(handler, body, query):
    require_user(handler)
    return 200, {"snapshots": db.snapshots(20)}


# ---------- runtime ----------

def weather_cities_from_state():
    current = db.get_state()
    if not current:
        return []
    cities = []
    for item in current["state"].get("layout", []):
        if item.get("widgetType") != "weather":
            continue
        city = ((item.get("config") or {}).get("city") or "").strip()
        if city and city not in cities:
            cities.append(city)
    return cities[:8]


def normalize_city(city):
    for sep in ("·", "|", ",", "，", "/"):
        if sep in city:
            city = city.split(sep)[0]
    return city.strip() or "南京"


def runtime(handler, body, query):
    require_user(handler)
    weather = {}
    for city in weather_cities_from_state():
        try:
            payload = get_weather(normalize_city(city))
            payload["query"] = city
            weather[city] = payload
        except ApiError:
            continue
    return 200, {
        "hosts": db.latest_metrics(),
        "probes": db.all_probes(),
        "clicks": db.click_counts(),
        "weather": weather,
        "serverTime": db.now_iso(),
    }


def state_meta(handler, body, query):
    require_user(handler)
    current = db.get_state()
    if not current:
        return 200, {"rev": 0, "updatedAt": None}
    return 200, {"rev": current["rev"], "updatedAt": current["updatedAt"]}


def metric_history(handler, body, query):
    require_user(handler)
    host = query.get("host", [""])[0]
    if not host:
        raise ApiError(400, "缺少 host")
    return 200, {"host": host, "points": db.metric_history(host, 60)}


def record_click(handler, body, query):
    require_user(handler)
    app_id = (body or {}).get("appId")
    if not app_id:
        raise ApiError(400, "缺少 appId")
    db.record_click(app_id)
    return 200, {"ok": True}


# ---------- favicon ----------

_icon_memory = {}


def allowed_favicon_hosts():
    current = db.get_state()
    hosts = set()
    if not current:
        return hosts
    for app in current["state"].get("apps", []):
        for key in ("href", "logoUrl"):
            value = app.get(key)
            if isinstance(value, str) and value:
                parsed = urllib.parse.urlparse(value)
                if parsed.hostname:
                    hosts.add(parsed.hostname.lower())
    return hosts


def favicon(handler, body, query):
    require_user(handler)
    raw = query.get("u", [""])[0]
    parsed = urllib.parse.urlparse(raw)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ApiError(400, "无效地址")
    if parsed.hostname.lower() not in allowed_favicon_hosts():
        raise ApiError(403, "该域名不在桌面应用列表中")

    key = hashlib.sha1(raw.encode()).hexdigest()
    cached = _icon_memory.get(key)
    if cached:
        return _binary(cached[0], cached[1], cache="public, max-age=86400")

    os.makedirs(FAVICON_DIR, exist_ok=True)
    for ext, ctype in (("png", "image/png"), ("ico", "image/x-icon"), ("jpg", "image/jpeg"),
                       ("svg", "image/svg+xml"), ("webp", "image/webp")):
        path = os.path.join(FAVICON_DIR, key + "." + ext)
        if os.path.exists(path):
            with open(path, "rb") as fh:
                data = fh.read()
            _icon_memory[key] = (data, ctype)
            return _binary(data, ctype, cache="public, max-age=86400")

    data, ctype = _fetch_icon(parsed)
    if not data:
        raise ApiError(404, "未找到图标")

    ext = {"image/png": "png", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico",
           "image/jpeg": "jpg", "image/svg+xml": "svg", "image/webp": "webp"}.get(ctype)
    if ext and len(data) < 512 * 1024:
        with open(os.path.join(FAVICON_DIR, key + "." + ext), "wb") as fh:
            fh.write(data)
    _icon_memory[key] = (data, ctype)
    return _binary(data, ctype, cache="public, max-age=86400")


def _fetch_icon(parsed):
    origin = f"{parsed.scheme}://{parsed.netloc}"
    candidates = [origin + "/favicon.ico"]
    for url in candidates:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=6, context=_ctx()) as resp:
                data = resp.read(512 * 1024)
                ctype = resp.headers.get("Content-Type", "").split(";")[0].strip().lower()
                if data and (ctype.startswith("image/") or _looks_like_image(data)):
                    return data, ctype or _sniff_ctype(data)
        except Exception:
            continue
    return None, None


def _looks_like_image(data):
    return data[:2] in (b"\x89P", b"GI") or data[:4] == b"\x00\x00\x01\x00" or data[:4] == b"<svg" or data[:5] == b"<?xml"


def _sniff_ctype(data):
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"\x00\x00\x01\x00":
        return "image/x-icon"
    if data[:2] == b"\xff\xd8":
        return "image/jpeg"
    if data[:4] == b"RIFF":
        return "image/webp"
    return "image/svg+xml"


def _ctx():
    return ssl._create_unverified_context()


def _binary(data, ctype, cache="no-store"):
    return 200, {"__binary__": data, "contentType": ctype, "cacheControl": cache}


# ---------- weather ----------

def get_weather(city):
    city = (city or "南京").strip()
    key = city.lower()
    now = time.time()
    hit = _weather_cache.get(key)
    if hit and now - hit[0] < WEATHER_TTL:
        return hit[1]

    geo = _geo_cache.get(key)
    if not geo or now - geo[0] > GEO_TTL:
        geo_data = _get_json(
            "https://geocoding-api.open-meteo.com/v1/search?"
            + urllib.parse.urlencode({"name": city, "count": 1, "language": "zh", "format": "json"})
        )
        results = (geo_data or {}).get("results") or []
        if not results:
            raise ApiError(404, "未找到城市")
        geo = (now, {"lat": results[0]["latitude"], "lon": results[0]["longitude"],
                     "name": results[0].get("name", city)})
        _geo_cache[key] = geo

    params = {
        "latitude": geo[1]["lat"], "longitude": geo[1]["lon"],
        "current": "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m",
        "daily": "weather_code,temperature_2m_max,temperature_2m_min",
        "timezone": "auto", "forecast_days": 4,
    }
    data = _get_json("https://api.open-meteo.com/v1/forecast?" + urllib.parse.urlencode(params))
    if not data:
        raise ApiError(502, "天气服务不可用")

    cur = data.get("current") or {}
    daily = data.get("daily") or {}
    days = []
    for i in range(min(4, len(daily.get("time") or []))):
        days.append({
            "date": daily["time"][i],
            "code": daily["weather_code"][i],
            "max": daily["temperature_2m_max"][i],
            "min": daily["temperature_2m_min"][i],
        })
    payload = {
        "city": geo[1]["name"],
        "temp": cur.get("temperature_2m"),
        "feels": cur.get("apparent_temperature"),
        "humidity": cur.get("relative_humidity_2m"),
        "wind": cur.get("wind_speed_10m"),
        "code": cur.get("weather_code"),
        "days": days,
        "updatedAt": db.now_iso(),
    }
    _weather_cache[key] = (now, payload)
    return payload


def weather(handler, body, query):
    require_user(handler)
    return 200, get_weather(normalize_city(query.get("city", ["南京"])[0]))


def _get_json(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=8) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as exc:
        print(f"[weather] {exc}", flush=True)
        return None
