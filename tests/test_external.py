import concurrent.futures
import http.server
import os
import ssl
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))

import api
import collectors
import db
import schedule
import validation


class Handler:
    def __init__(self, cookie=""):
        self.headers = {"Cookie": "rex_sid=" + cookie} if cookie else {}
        self.client_address = ("127.0.0.1", 1234)

    def extra_header(self, name, value):
        pass


class ExternalHandler(http.server.BaseHTTPRequestHandler):
    icon = b"\x89PNG\r\n\x1a\n" + b"test-image"
    content_type = "image/png"
    calendar_fail = False
    redirect_location = None
    report_auth = None
    methods = []

    def log_message(self, *args):
        pass

    def do_HEAD(self):
        self.methods.append(("HEAD", self.path))
        if self.path == "/offline":
            self.send_response(503)
        else:
            self.send_response(200)
        self.end_headers()

    def do_GET(self):
        self.methods.append(("GET", self.path))
        if self.path in ("/favicon.ico", "/calendar.ics") and self.redirect_location:
            self.send_response(302)
            self.send_header("Location", self.redirect_location)
            self.end_headers()
            return
        if self.path == "/favicon.ico":
            self.send_response(200)
            self.send_header("Content-Type", self.content_type)
            self.send_header("Content-Length", str(len(self.icon)))
            self.end_headers()
            self.wfile.write(self.icon)
            return
        if self.path == "/calendar.ics":
            if self.calendar_fail:
                self.send_response(500)
                self.end_headers()
                return
            data = (b"BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20261027T010203Z\r\n"
                    b"DTEND:20261027T020203Z\r\nSUMMARY:Release\\, backend\r\nEND:VEVENT\r\n"
                    b"BEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20261028\r\nSUMMARY:Holiday\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        self.send_response(404)
        self.end_headers()

    def do_REPORT(self):
        self.methods.append(("REPORT", self.path))
        ExternalHandler.report_auth = self.headers.get("Authorization")
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        if b"calendar-query" not in body:
            self.send_response(400)
            self.end_headers()
            return
        data = b'''<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
<D:response><C:calendar-data>BEGIN:VCALENDAR
BEGIN:VEVENT
DTSTART:20261029T100000Z
DTEND:20261029T110000Z
SUMMARY:CalDAV event
END:VEVENT
END:VCALENDAR</C:calendar-data></D:response></D:multistatus>'''
        self.send_response(207)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class ExternalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        db.configure(os.path.join(self.temp.name, "external.db"))
        db.init()
        db.set_password("admin", "secret", iterations=1000)
        self.token = db.create_session("admin")
        ExternalHandler.icon = b"\x89PNG\r\n\x1a\n" + b"test-image"
        ExternalHandler.content_type = "image/png"
        ExternalHandler.calendar_fail = False
        ExternalHandler.redirect_location = None
        ExternalHandler.methods = []
        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), ExternalHandler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        schedule._cache.clear()
        api._icon_memory.clear()
        api._weather_cache.clear()
        api._weather_negative.clear()
        api._geo_cache.clear()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(5)
        db.configure(os.path.join(self.temp.name, "closed.db"))
        self.temp.cleanup()

    def put_layout(self, layout, apps=None):
        return db.put_state({"layout": layout, "apps": apps or []}, db.get_state()["rev"] if db.get_state() else 0)

    def test_ics_and_basic_caldav_are_real_and_read_only(self):
        layout = [
            {"id": "cal-ics", "kind": "widget", "widgetType": "calendar", "x": 0, "y": 0, "w": 4, "h": 2,
             "config": {"icsUrl": self.base + "/calendar.ics", "title": "ICS"}},
            {"id": "cal-dav", "kind": "widget", "widgetType": "calendar", "x": 4, "y": 0, "w": 4, "h": 2,
             "config": {"caldavUrl": self.base + "/caldav", "title": "DAV"}},
        ]
        self.put_layout(layout)
        os.environ["REXHUB_CALDAV_CAL_DAV_USERNAME"] = "user"
        os.environ["REXHUB_CALDAV_CAL_DAV_PASSWORD"] = "pass"
        try:
            result = schedule.events()
        finally:
            os.environ.pop("REXHUB_CALDAV_CAL_DAV_USERNAME", None)
            os.environ.pop("REXHUB_CALDAV_CAL_DAV_PASSWORD", None)
        self.assertEqual("ok", result["status"])
        self.assertEqual(3, len(result["events"]))
        self.assertEqual("Release, backend", result["events"][0]["summary"])
        self.assertEqual("CalDAV event", result["events"][2]["summary"])
        self.assertTrue(ExternalHandler.report_auth.startswith("Basic "))
        methods = [method for method, path in ExternalHandler.methods if path == "/caldav"]
        self.assertEqual(["REPORT"], methods)
        with self.assertRaises(validation.ValidationError):
            schedule.events("not-configured")

    def test_calendar_failure_returns_stale(self):
        self.put_layout([{"id": "cal", "kind": "widget", "widgetType": "calendar", "x": 0, "y": 0, "w": 4, "h": 2,
                          "config": {"icsUrl": self.base + "/calendar.ics"}}])
        self.assertEqual("ok", schedule.events()["status"])
        ExternalHandler.calendar_fail = True
        with mock.patch.object(schedule, "CACHE_TTL", 0):
            result = schedule.events()
        self.assertTrue(result["stale"])
        self.assertEqual("stale", result["sources"][0]["status"])
        self.assertEqual(2, len(result["events"]))
        self.assertIn("500", result["sources"][0]["error"])

    def test_probe_http_failure_is_not_online_and_ssh_uses_separator(self):
        self.assertTrue(collectors._probe_one({"id": "ok", "href": self.base})[1])
        failed = collectors._probe_one({"id": "bad", "href": self.base + "/offline"})
        self.assertFalse(failed[1])
        self.assertEqual(503, failed[2])
        with mock.patch.object(collectors, "_tcp_ping", return_value=1), \
             mock.patch.object(collectors.subprocess, "run") as run:
            run.return_value.stdout = "CPU 1 2\nMEM 10 5\n"
            run.return_value.returncode = 0
            run.return_value.stderr = ""
            collectors.collect_remote("127.0.0.1", 22, "root")
            args = run.call_args.args[0]
            self.assertIn("--", args)
            self.assertEqual("root@127.0.0.1", args[args.index("--") + 1])
        with self.assertRaises(validation.ValidationError):
            collectors.collect_remote("127.0.0.1;id")
        self.assertEqual(ssl.CERT_REQUIRED, collectors._probe_context().verify_mode)

    def test_collector_heartbeats_and_stop_join(self):
        collector = collectors.Collector(lambda: [], lambda: [], metric_interval=0.01, probe_interval=0.01)
        collector.start()
        time.sleep(0.06)
        self.assertTrue(collector.health()["healthy"])
        threads = list(collector._threads)
        collector.stop()
        self.assertFalse(any(thread.is_alive() for thread in threads))
        self.assertEqual([], collector._threads)

    def test_favicon_bitmap_tls_cache_and_svg_rejection(self):
        self.put_layout([], [{"id": "a", "href": self.base, "logoUrl": "", "clicks": 0}])
        with tempfile.TemporaryDirectory() as icons:
            with mock.patch.object(api, "FAVICON_DIR", icons):
                status, payload = api.favicon(Handler(self.token), None, {"u": [self.base]})
                self.assertEqual(200, status)
                self.assertEqual("image/png", payload["contentType"])
                files = os.listdir(icons)
                self.assertEqual(1, len(files))
                status, payload = api.favicon(Handler(self.token), None, {"u": [self.base + "/different-key"]})
                self.assertEqual(200, status)
                self.assertEqual(1, len(os.listdir(icons)))
        self.assertEqual(ssl.CERT_REQUIRED, api._ctx().verify_mode)
        self.assertTrue(api._ctx().check_hostname)
        ExternalHandler.icon = b"<svg xmlns='http://www.w3.org/2000/svg'></svg>"
        ExternalHandler.content_type = "image/svg+xml"
        api._icon_memory.clear()
        with tempfile.TemporaryDirectory() as icons, mock.patch.object(api, "FAVICON_DIR", icons):
            with self.assertRaises(api.ApiError) as caught:
                api.favicon(Handler(self.token), None, {"u": [self.base + "?uncached=1"]})
            self.assertEqual(404, caught.exception.status)

    def test_external_redirect_cannot_escape_configured_host(self):
        self.put_layout(
            [{"id": "cal", "kind": "widget", "widgetType": "calendar", "x": 0, "y": 0, "w": 4, "h": 2,
              "config": {"icsUrl": self.base + "/calendar.ics"}}],
            [{"id": "a", "href": self.base, "logoUrl": "", "clicks": 0}],
        )
        ExternalHandler.redirect_location = self.base.replace("127.0.0.1", "localhost") + "/favicon.ico"
        with tempfile.TemporaryDirectory() as icons, mock.patch.object(api, "FAVICON_DIR", icons):
            with self.assertRaises(api.ApiError) as caught:
                api.favicon(Handler(self.token), None, {"u": [self.base]})
            self.assertEqual(404, caught.exception.status)
        result = schedule.events()
        self.assertEqual("error", result["status"])
        self.assertIn("白名单", result["sources"][0]["error"])

    def test_weather_singleflight_stale_and_runtime_does_not_wait(self):
        calls = []
        def fetch(city, key, now):
            calls.append(key)
            time.sleep(0.05)
            if len(calls) > 1:
                raise api.ApiError(502, "down")
            return {"city": city, "temp": 20, "stale": False}
        with mock.patch.object(api, "_fetch_weather", side_effect=fetch):
            with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
                values = list(pool.map(lambda _: api.get_weather("南京"), range(6)))
            self.assertEqual(1, len(calls))
            self.assertEqual(20, values[0]["temp"])
            with mock.patch.object(api, "WEATHER_TTL", 0):
                stale = api.get_weather("南京")
            self.assertTrue(stale["stale"])
        self.put_layout([{"id": "weather", "kind": "widget", "widgetType": "weather", "x": 0, "y": 0, "w": 4, "h": 2,
                          "config": {"city": "上海"}}])
        with mock.patch.object(api, "_schedule_weather") as scheduled:
            started = time.monotonic()
            status, payload = api.runtime(Handler(self.token), None, {})
            self.assertLess(time.monotonic() - started, 0.2)
            self.assertEqual(200, status)
            self.assertEqual("loading", payload["weather"]["上海"]["status"])
            scheduled.assert_called_once_with("上海")


if __name__ == "__main__":
    unittest.main()
