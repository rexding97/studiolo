import concurrent.futures
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))

import api
import db
import validation
import yaml_import


def empty_state():
    return {"layout": [], "apps": []}


def app_state(clicks=2):
    return {
        "layout": [{"id": "host-a", "kind": "widget", "x": 0, "y": 0, "w": 4, "h": 2}],
        "apps": [{"id": "a", "name": "A", "href": "http://127.0.0.1:8080", "containerId": "host-a",
                  "logoUrl": "", "port": "", "clicks": clicks}],
        "plugins": {"future": {"enabled": True}},
    }


class Handler:
    def __init__(self, cookie="", address="127.0.0.1", headers=None):
        self.headers = dict(headers or {})
        if cookie:
            self.headers["Cookie"] = "rex_sid=" + cookie
        self.client_address = (address, 1234)
        self.extra = []

    def extra_header(self, name, value):
        self.extra.append((name, value))


class DatabaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        db.configure(os.path.join(self.temp.name, "nested", "test.db"))
        db.init()

    def tearDown(self):
        db.configure(os.path.join(self.temp.name, "closing.db"))
        self.temp.cleanup()

    def test_concurrent_same_rev_has_one_winner(self):
        def write(index):
            state = empty_state()
            state["workspaces"] = [{"id": str(index)}]
            return db.put_state(state, 0)
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            results = list(pool.map(write, range(24)))
        winners = [result for result, conflict in results if conflict is None]
        conflicts = [conflict for result, conflict in results if conflict is not None]
        self.assertEqual(1, len(winners))
        self.assertEqual(23, len(conflicts))
        self.assertEqual({1}, set(conflicts))
        self.assertEqual(1, db.get_state()["rev"])

    def test_bad_import_is_zero_write_and_empty_desktop_is_valid(self):
        bad = "layout:\n  - id: broken\n    x: nope\napps: []\n"
        with self.assertRaises(yaml_import.ImportError):
            yaml_import.parse(bad)
        self.assertIsNone(db.get_state())
        state = yaml_import.parse("layout: []\napps: []\n")
        result, conflict = db.import_state(state, expected_rev=0)
        self.assertIsNone(conflict)
        self.assertEqual(1, result["rev"])
        self.assertEqual([], db.get_state()["state"]["apps"])
        extended = yaml_import.parse('layout: []\napps: []\nplugins: {"future": true}\nworkspaces: []\ncustom: retained\n')
        self.assertEqual({"future": True}, extended["plugins"])
        self.assertEqual("retained", extended["custom"])

    def test_frontend_yaml_aliases_survive_import_and_snapshot_restore(self):
        def scalar(value):
            return json.dumps(value, ensure_ascii=False)

        plugins = [{"id": "calendar", "enabled": True, "settings": {"view": "month"}}]
        mobile = {"x": 2, "y": 5, "w": 3, "h": 4}
        workspaces = [
            {"id": "workspace-one", "name": "主桌面", "layout": [], "apps": []},
            {"id": "workspace-two", "name": "实验室", "layout": [
                {"id": "mobile-widget", "kind": "widget", "widgetType": "notes",
                 "x": 1, "y": 1, "w": 4, "h": 2, "mobile": mobile, "config": {"text": "保留"}}
            ], "apps": [{"id": "internal", "name": "Internal", "href": "http://127.0.0.1:8080"}]},
        ]
        lines = [
            "# Studiolo 桌面 2D 坐标与主题配置文件", 'version: "5.0"', "profile:",
            '  title: "Studio"', '  activeWorkspaceId: "workspace-two"', "layout:",
            '  - id: "weather"', '    kind: "widget"', "    x: 1", "    y: 1", "    w: 4", "    h: 2",
            f"    mobileJson: {scalar(json.dumps(mobile, separators=(',', ':')))}",
            '    widgetType: "weather"',
            f"    configJson: {scalar(json.dumps({'city': '上海'}, separators=(',', ':')))}",
            "apps: []",
            f"pluginsJson: {scalar(json.dumps(plugins, ensure_ascii=False, separators=(',', ':')))}",
            f"workspacesJson: {scalar(json.dumps(workspaces, ensure_ascii=False, separators=(',', ':')))}",
        ]
        state = yaml_import.parse("\n".join(lines) + "\n")
        self.assertEqual(plugins, state["plugins"])
        self.assertEqual(workspaces, state["workspaces"])
        self.assertEqual("workspace-two", state["profile"]["activeWorkspaceId"])
        self.assertEqual(mobile, state["layout"][0]["mobile"])
        self.assertNotIn("mobileJson", state["layout"][0])
        imported, conflict = db.import_state(state, expected_rev=0)
        self.assertIsNone(conflict)
        db.put_state(empty_state(), imported["rev"])
        restored, conflict = db.restore_state(imported["rev"], expected_rev=imported["rev"] + 1)
        self.assertIsNone(conflict)
        self.assertEqual(state, restored and db.get_state()["state"])
        native = yaml_import.parse(json.dumps(state, ensure_ascii=False))
        self.assertEqual(state, native)

    def test_json_aliases_fail_clearly_when_corrupt_or_wrong_type(self):
        for alias in ("pluginsJson", "workspacesJson"):
            for value, message in (('"{broken"', "损坏"), ('"{}"', "必须是数组")):
                with self.subTest(alias=alias, value=value):
                    with self.assertRaises(yaml_import.ImportError) as caught:
                        yaml_import.parse(f"layout: []\napps: []\n{alias}: {value}\n")
                    self.assertIn(alias, str(caught.exception))
                    self.assertIn(message, str(caught.exception))
        layout = "layout:\n  - id: item\n    x: 0\n    y: 0\n    w: 1\n    h: 1\n"
        for value, message in (('"{broken"', "损坏"), ('"[]"', "必须是对象")):
            with self.subTest(mobileJson=value):
                with self.assertRaises(yaml_import.ImportError) as caught:
                    yaml_import.parse(layout + f"    mobileJson: {value}\napps: []\n")
                self.assertIn("mobileJson", str(caught.exception))
                self.assertIn(message, str(caught.exception))

    def test_force_import_and_restore_are_idempotent_and_restore_clicks(self):
        result, _ = db.import_state(app_state(), expected_rev=0)
        self.assertEqual(2, db.click_counts()["a"]["count"])
        same, _ = db.import_state(app_state(), force=True)
        self.assertEqual(result["rev"], same["rev"])
        self.assertTrue(same["unchanged"])
        db.record_click("a")
        changed = app_state(clicks=9)
        db.put_state(changed, 1)
        restored, conflict = db.restore_state(1, expected_rev=2)
        self.assertIsNone(conflict)
        self.assertEqual(3, restored["rev"])
        self.assertEqual(2, db.click_counts()["a"]["count"])
        db.record_click("a")
        restored_again, _ = db.restore_state(1, force=True)
        self.assertEqual(4, restored_again["rev"])
        self.assertEqual(2, db.click_counts()["a"]["count"])
        unchanged, _ = db.restore_state(1, force=True)
        self.assertEqual(4, unchanged["rev"])
        self.assertTrue(unchanged["unchanged"])
        snapshot = db.snapshot_json(1)
        self.assertEqual(app_state(), snapshot["state"])

    def test_restore_not_found_and_corrupt_snapshot_do_not_change_state(self):
        db.put_state(empty_state(), 0)
        result, conflict = db.restore_state(999, expected_rev=1)
        self.assertIsNone(result)
        self.assertEqual("not_found", conflict)
        db.conn().execute("UPDATE snapshot SET json=? WHERE rev=1", ('{"layout":null,"apps":[]}',))
        db.conn().commit()
        with self.assertRaises(validation.ValidationError):
            db.restore_state(1, force=True)
        self.assertEqual(empty_state(), db.get_state()["state"])

    def test_migration_backups_and_click_events(self):
        db.configure(os.path.join(self.temp.name, "closing.db"))
        path = os.path.join(self.temp.name, "legacy.db")
        legacy = sqlite3.connect(path)
        legacy.executescript("""
        CREATE TABLE state(id INTEGER PRIMARY KEY, json TEXT NOT NULL, rev INTEGER NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE clicks(app_id TEXT PRIMARY KEY, count INTEGER, last_click TEXT);
        CREATE TABLE click_event(id INTEGER PRIMARY KEY AUTOINCREMENT, app_id TEXT NOT NULL, ts TEXT NOT NULL);
        INSERT INTO clicks VALUES('old', 3, '2026-01-01T00:00:00+00:00');
        """)
        legacy.commit()
        legacy.close()
        db.configure(path)
        db.init()
        self.assertTrue(os.path.exists(path + ".pre-v1.bak"))
        self.assertEqual(1, db.conn().execute("PRAGMA user_version").fetchone()[0])
        self.assertEqual(3, db.click_counts(3650)["old"]["count"])

    def test_password_change_revokes_all_sessions(self):
        db.set_password("admin", "old", iterations=1000)
        first = db.create_session("admin")
        second = db.create_session("admin")
        self.assertEqual("admin", db.check_session(first))
        db.set_password("admin", "new", iterations=1000)
        self.assertIsNone(db.check_session(first))
        self.assertIsNone(db.check_session(second))
        self.assertFalse(db.verify_password("admin", "old"))
        self.assertTrue(db.verify_password("admin", "new"))

    def test_password_api_and_secure_cookie(self):
        db.set_password("admin", "old", iterations=1000)
        token = db.create_session("admin")
        handler = Handler(token)
        os.environ["REXHUB_SECURE_COOKIE"] = "1"
        try:
            status, _ = api.change_password(handler, {"currentPassword": "old", "newPassword": "new"}, {})
        finally:
            os.environ.pop("REXHUB_SECURE_COOKIE", None)
        self.assertEqual(200, status)
        self.assertIn("Secure", handler.extra[0][1])
        self.assertIsNone(db.check_session(token))

    def test_state_validation(self):
        valid = empty_state()
        valid["unknownFutureField"] = {"nested": [1, True, None]}
        validation.validate_state(valid)
        invalid = app_state()
        invalid["apps"][0]["containerId"] = "missing"
        with self.assertRaises(validation.ValidationError):
            validation.validate_state(invalid)
        for value in (-1, 0, 65536, True, "22x"):
            with self.assertRaises(validation.ValidationError):
                validation.validate_port(value)
        validation.validate_ssh_user("root")
        with self.assertRaises(validation.ValidationError):
            validation.validate_ssh_user("root;id")
        with self.assertRaises(validation.ValidationError):
            validation.validate_ip("127.0.0.1;id")

    def test_login_types_and_trusted_proxy_expiry(self):
        db.set_password("admin", "secret", iterations=1000)
        with self.assertRaises(api.ApiError) as caught:
            api.login(Handler(), [], {})
        self.assertEqual(400, caught.exception.status)
        os.environ["REXHUB_TRUSTED_PROXIES"] = "127.0.0.1"
        try:
            handler = Handler(headers={"X-Forwarded-For": "203.0.113.8"})
            for _ in range(8):
                with self.assertRaises(api.ApiError):
                    api.login(handler, {"username": "admin", "password": "bad"}, {})
            with self.assertRaises(api.ApiError) as limited:
                api.login(handler, {"username": "admin", "password": "secret"}, {})
            self.assertEqual(429, limited.exception.status)
            self.assertIn("203.0.113.8", api._login_fails)
            api._login_fails["expired"] = [0]
            api._login_fails["203.0.113.8"] = [0]
            status, _ = api.login(handler, {"username": "admin", "password": "secret"}, {})
            self.assertEqual(200, status)
            self.assertNotIn("expired", api._login_fails)
        finally:
            os.environ.pop("REXHUB_TRUSTED_PROXIES", None)
            with api._login_lock:
                api._login_fails.clear()

    def test_cli_bad_import_zero_write_and_force_import_idempotent(self):
        root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        database = os.path.join(self.temp.name, "cli.db")
        bad = os.path.join(self.temp.name, "bad.yaml")
        good = os.path.join(self.temp.name, "good.yaml")
        with open(bad, "w", encoding="utf-8") as fh:
            fh.write("layout:\n  - id: broken\n    x: nope\napps: []\n")
        with open(good, "w", encoding="utf-8") as fh:
            fh.write("layout: []\napps: []\n")
        command = [sys.executable, os.path.join(root, "server", "rexhub.py"), "--data", database, "--import-yaml"]
        failed = subprocess.run(command + [bad], cwd=root, capture_output=True, text=True, timeout=15)
        self.assertEqual(1, failed.returncode)
        self.assertIn("导入失败", failed.stderr)
        imported = subprocess.run(command + [good], cwd=root, capture_output=True, text=True, timeout=15)
        self.assertEqual(0, imported.returncode, imported.stderr)
        repeated = subprocess.run(command + [good, "--force-import"], cwd=root, capture_output=True, text=True, timeout=15)
        self.assertEqual(0, repeated.returncode, repeated.stderr)
        self.assertIn("rev 1", repeated.stdout)
        db.configure(database)
        self.assertEqual(1, db.get_state()["rev"])

    def test_revision_types_and_state_size_are_strict(self):
        with self.assertRaises(validation.ValidationError):
            db.put_state(empty_state(), 0.5)
        with self.assertRaises(validation.ValidationError):
            db.snapshots(1.5)
        with self.assertRaises(validation.ValidationError):
            db.put_state({"layout": [], "apps": [], "large": "x" * (2 * 1024 * 1024 + 1)}, 0)
        self.assertIsNone(db.get_state())


if __name__ == "__main__":
    unittest.main()
