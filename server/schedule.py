"""Read-only ICS and basic CalDAV event retrieval from configured widgets."""

import base64
import datetime as dt
import os
import re
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor

import db
import validation

MAX_RESPONSE = 2 * 1024 * 1024
CACHE_TTL = 300
STALE_TTL = 86400
MAX_EVENTS = 1000
_cache = {}
_locks = [threading.Lock() for _ in range(16)]
_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="rexhub-calendar")


def configured_sources():
    current = db.get_state()
    if not current:
        return []
    sources = []
    seen = set()
    for item in current["state"].get("layout", []):
        if item.get("widgetType") not in ("calendar", "schedule", "calendar-events"):
            continue
        config = item.get("config") if isinstance(item.get("config"), dict) else {}
        kind = "ics" if config.get("icsUrl") else "caldav" if config.get("caldavUrl") else None
        if not kind:
            continue
        url = config.get("icsUrl") or config.get("caldavUrl")
        validation.validate_url(url, f"{kind}Url")
        source_id = item["id"]
        if source_id in seen:
            continue
        seen.add(source_id)
        sources.append({"id": source_id, "kind": kind, "url": url, "name": config.get("title") or source_id})
        if len(sources) >= 8:
            break
    return sources


def _local_name(tag):
    return tag.rsplit("}", 1)[-1]


def _parse_date(value):
    value = value.strip()
    if re.fullmatch(r"\d{8}", value):
        return dt.datetime.strptime(value, "%Y%m%d").date().isoformat(), True
    if re.fullmatch(r"\d{8}T\d{6}Z?", value):
        parsed = dt.datetime.strptime(value.rstrip("Z"), "%Y%m%dT%H%M%S")
        if value.endswith("Z"):
            parsed = parsed.replace(tzinfo=dt.timezone.utc)
        return parsed.isoformat(), False
    raise ValueError("unsupported date format")


def parse_ics(text):
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    unfolded = []
    for line in lines:
        if line.startswith((" ", "\t")) and unfolded:
            unfolded[-1] += line[1:]
        else:
            unfolded.append(line)
    events = []
    current = None
    for line in unfolded:
        upper = line.upper()
        if upper == "BEGIN:VEVENT":
            current = {}
            continue
        if upper == "END:VEVENT":
            if current and current.get("start"):
                events.append(current)
                if len(events) >= MAX_EVENTS:
                    break
            current = None
            continue
        if current is None or ":" not in line:
            continue
        left, value = line.split(":", 1)
        name = left.split(";", 1)[0].upper()
        if name in ("DTSTART", "DTEND"):
            parsed, all_day = _parse_date(value)
            current["start" if name == "DTSTART" else "end"] = parsed
            if name == "DTSTART":
                current["allDay"] = all_day
        elif name == "SUMMARY":
            current["summary"] = value.replace("\\n", "\n").replace("\\,", ",").replace("\\;", ";")[:4096]
    for event in events:
        event.setdefault("summary", "")
        event.setdefault("allDay", False)
    return events


def parse_caldav(data):
    root = ET.fromstring(data)
    events = []
    for node in root.iter():
        if _local_name(node.tag) != "calendar-data" or not node.text:
            continue
        events.extend(parse_ics(node.text))
        if len(events) >= MAX_EVENTS:
            break
    return events[:MAX_EVENTS]


def _credentials(source):
    if source["kind"] != "caldav":
        return None
    key = re.sub(r"[^A-Za-z0-9]", "_", source["id"]).upper()
    username = os.environ.get(f"REXHUB_CALDAV_{key}_USERNAME")
    password = os.environ.get(f"REXHUB_CALDAV_{key}_PASSWORD")
    if username is None and password is None:
        return None
    if not username or not password:
        raise ValueError("CalDAV 用户名和密码必须同时配置")
    return base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")


class _SameHostRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, host):
        self.host = host

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parsed = urllib.parse.urlparse(newurl)
        if parsed.scheme not in ("http", "https") or parsed.hostname != self.host:
            raise urllib.error.HTTPError(newurl, code, "日程重定向主机不在 state 白名单中", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _fetch(source):
    headers = {"User-Agent": "rexhub-calendar/1.0", "Accept": "text/calendar, application/xml"}
    if source["kind"] == "caldav":
        body = b'''<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
<D:prop><D:getetag/><C:calendar-data/></D:prop>
<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"/></C:comp-filter></C:filter>
</C:calendar-query>'''
        request = urllib.request.Request(source["url"], data=body, method="REPORT", headers={
            **headers, "Content-Type": "application/xml; charset=utf-8", "Depth": "1"})
        credentials = _credentials(source)
        if credentials:
            request.add_header("Authorization", "Basic " + credentials)
    else:
        request = urllib.request.Request(source["url"], headers=headers)
    host = urllib.parse.urlparse(source["url"]).hostname
    opener = urllib.request.build_opener(_SameHostRedirect(host), urllib.request.HTTPSHandler(
        context=ssl.create_default_context()))
    with opener.open(request, timeout=8) as response:
        raw = response.read(MAX_RESPONSE + 1)
    if len(raw) > MAX_RESPONSE:
        raise ValueError("日程响应超过 2MB")
    text = raw.decode("utf-8-sig")
    events = parse_ics(text) if source["kind"] == "ics" else parse_caldav(text)
    return events


def _source_events(source):
    key = source["kind"] + ":" + source["url"]
    lock = _locks[hash(key) % len(_locks)]
    with lock:
        now = time.time()
        hit = _cache.get(key)
        if hit and now - hit[0] < CACHE_TTL:
            return dict(hit[1])
        try:
            events = _fetch(source)
            result = {"id": source["id"], "name": source["name"], "kind": source["kind"],
                      "status": "ok", "stale": False, "events": events, "updatedAt": db.now_iso(), "error": None}
            _cache[key] = (now, result)
            if len(_cache) > 64:
                oldest = min(_cache, key=lambda item: _cache[item][0])
                _cache.pop(oldest, None)
            return dict(result)
        except Exception as exc:
            message = str(exc)[:240] or exc.__class__.__name__
            if hit and now - hit[0] < STALE_TTL:
                result = dict(hit[1], status="stale", stale=True, error=message)
                return result
            return {"id": source["id"], "name": source["name"], "kind": source["kind"], "status": "error",
                    "stale": False, "events": [], "updatedAt": db.now_iso(), "error": message}


def events(source_id=None):
    sources = configured_sources()
    if source_id:
        sources = [source for source in sources if source["id"] == source_id]
        if not sources:
            raise validation.ValidationError("日程来源不存在或不在当前 state 中")
    if not sources:
        return {"sources": [], "events": [], "status": "ok", "stale": False, "serverTime": db.now_iso()}
    results = list(_pool.map(_source_events, sources))
    combined = []
    for result in results:
        for event in result["events"]:
            combined.append(dict(event, sourceId=result["id"]))
    combined.sort(key=lambda event: event.get("start") or "")
    status = "ok" if all(r["status"] == "ok" for r in results) else "partial" if any(r["events"] for r in results) else "error"
    return {"sources": [{k: v for k, v in result.items() if k != "events"} | {"count": len(result["events"])}
                        for result in results],
            "events": combined[:MAX_EVENTS], "status": status,
            "stale": any(r["stale"] for r in results), "serverTime": db.now_iso()}
