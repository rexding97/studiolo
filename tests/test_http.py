import http.client
import json
import os
import sys
import tempfile
import threading
import unittest
from functools import partial

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))

import db
import rexhub


class HealthyCollector:
    def health(self):
        return {"running": True, "healthy": True}


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        web = os.path.join(self.temp.name, "web")
        os.mkdir(web)
        with open(os.path.join(web, "index.html"), "wb") as fh:
            fh.write(b"hello")
        db.configure(os.path.join(self.temp.name, "http.db"))
        db.init()
        db.set_password("admin", "secret", iterations=1000)
        rexhub.RUNTIME.update(initialized=True, collector=HealthyCollector())
        self.server = rexhub.BoundedThreadingHTTPServer(("127.0.0.1", 0), partial(rexhub.Handler, directory=web), max_workers=8)
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()
        self.port = self.server.server_address[1]
        self.cookie = None

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)
        rexhub.RUNTIME.update(initialized=False, collector=None)
        db.configure(os.path.join(self.temp.name, "closed.db"))
        self.temp.cleanup()

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        headers = dict(headers or {})
        if self.cookie and "Cookie" not in headers:
            headers["Cookie"] = "rex_sid=" + self.cookie
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        raw = response.read()
        payload = json.loads(raw) if raw and response.getheader("Content-Type", "").startswith("application/json") else raw
        result = (response.status, payload, response.getheaders())
        connection.close()
        return result

    def raw_with_length(self, value):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.putrequest("POST", "/api/v1/auth/login")
        connection.putheader("Content-Length", value)
        connection.endheaders()
        response = connection.getresponse()
        raw = response.read()
        connection.close()
        return response.status, json.loads(raw)

    def login(self):
        status, _, headers = self.request("POST", "/api/v1/auth/login",
                                         json.dumps({"username": "admin", "password": "secret"}))
        self.assertEqual(200, status)
        self.cookie = next(value.split(";")[0].split("=", 1)[1] for name, value in headers if name == "Set-Cookie")

    def test_static_head_and_api_head(self):
        status, raw, headers = self.request("HEAD", "/index.html")
        self.assertEqual(200, status)
        self.assertEqual(b"", raw)
        self.assertEqual("5", dict(headers)["Content-Length"])
        status, raw, headers = self.request("HEAD", "/api/v1/health")
        self.assertEqual(200, status)
        self.assertEqual(b"", raw)
        self.assertGreater(int(dict(headers)["Content-Length"]), 0)

    def test_content_length_strict(self):
        for value in ("-1", "abc", "+2"):
            status, payload = self.raw_with_length(value)
            self.assertEqual(400, status, value)
            self.assertIn("Content-Length", payload["error"])
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.putrequest("POST", "/api/v1/auth/login")
        connection.putheader("Content-Length", "0")
        connection.putheader("Content-Length", "0")
        connection.endheaders()
        response = connection.getresponse()
        response.read()
        self.assertEqual(400, response.status)
        connection.close()

    def test_origin_and_secure_cookie(self):
        status, _, _ = self.request("POST", "/api/v1/auth/logout", "{}", headers={"Origin": "https://evil.example"})
        self.assertEqual(403, status)
        os.environ["REXHUB_SECURE_COOKIE"] = "true"
        try:
            self.login()
            status, _, headers = self.request("POST", "/api/v1/auth/logout", "{}",
                                             headers={"Origin": f"http://127.0.0.1:{self.port}"})
        finally:
            os.environ.pop("REXHUB_SECURE_COOKIE", None)
        self.assertEqual(200, status)
        self.assertTrue(any(name == "Set-Cookie" and "Secure" in value for name, value in headers))

    def test_invalid_api_types_and_nested_config_are_400(self):
        self.login()
        original = {"layout": [], "apps": []}
        status, payload, _ = self.request("PUT", "/api/v1/state", json.dumps({"rev": 0, "state": original}))
        self.assertEqual(200, status)
        for state in ([], {"layout": None, "apps": []}, {"layout": [], "apps": [None]},
                      {"layout": [{"id": "x", "x": 0, "y": 0, "w": 1, "h": 1, "config": []}], "apps": []}):
            status, payload, _ = self.request("PUT", "/api/v1/state", json.dumps({"rev": 1, "state": state}))
            self.assertEqual(400, status)
            self.assertIn("error", payload)
        status, payload, _ = self.request("POST", "/api/v1/click", json.dumps({"appId": []}))
        self.assertEqual(400, status)
        self.assertEqual(1, db.get_state()["rev"])

    def test_snapshot_content_and_restore_routes(self):
        self.login()
        state = {"layout": [], "apps": [], "workspaces": []}
        status, payload, _ = self.request("PUT", "/api/v1/state", json.dumps({"rev": 0, "state": state}))
        self.assertEqual(200, status)
        status, payload, _ = self.request("GET", "/api/v1/state/snapshots/1")
        self.assertEqual(200, status)
        self.assertEqual(state, payload["state"])
        status, payload, _ = self.request("POST", "/api/v1/state/snapshots/1/restore", json.dumps({"force": True}))
        self.assertEqual(200, status)
        self.assertTrue(payload["unchanged"])
        status, payload, _ = self.request("GET", "/api/v1/state/snapshots/999")
        self.assertEqual(404, status)

    def test_health_and_readiness(self):
        status, payload, _ = self.request("GET", "/api/v1/health")
        self.assertEqual(200, status)
        self.assertTrue(payload["database"])
        status, payload, _ = self.request("GET", "/api/v1/readiness")
        self.assertEqual(200, status)
        self.assertTrue(payload["ready"])
        rexhub.RUNTIME["collector"] = None
        status, payload, _ = self.request("GET", "/api/v1/readiness")
        self.assertEqual(503, status)
        self.assertFalse(payload["ready"])

    def test_default_bind_is_loopback(self):
        self.assertEqual("127.0.0.1", rexhub.build_parser().parse_args([]).host)


if __name__ == "__main__":
    unittest.main()
