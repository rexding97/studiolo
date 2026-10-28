"""Bounded host/probe collectors with independent scheduling and isolation."""

import os
import socket
import ssl
import subprocess
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import db
import validation

SSH_KEY = os.path.expanduser("~/.ssh/id_ed25519_rexhub")
SSH_OPTS = [
    "-i", SSH_KEY, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=4", "-o", "ControlMaster=auto",
    "-o", "ControlPath=" + os.path.expanduser("~/.ssh/rexhub-cm-%r@%h:%p"), "-o", "ControlPersist=60",
]
REMOTE_SCRIPT = r"""
read -r _ a1 b1 c1 d1 e1 f1 g1 h1 i1 j1 k1 < /proc/stat
sleep 0.25
read -r _ a2 b2 c2 d2 e2 f2 g2 h2 i2 j2 k2 < /proc/stat
t1=$((a1+b1+c1+d1+e1+f1+g1+h1+i1+j1+k1)); t2=$((a2+b2+c2+d2+e2+f2+g2+h2+i2+j2+k2))
u1=$((t1-d1-e1)); u2=$((t2-d2-e2)); dt=$((t2-t1)); du=$((u2-u1))
if [ "$dt" -gt 0 ]; then echo "CPU $du $dt"; fi
awk '/MemTotal/{t=$2} /MemAvailable/{a=$2} END{if(t>0) print "MEM", t, a}' /proc/meminfo
df -P / | awk 'NR==2 {gsub("%","",$5); print "DISK", $5}'
awk '{print "UPTIME", int($1)}' /proc/uptime
awk '{print "LOAD", $1}' /proc/loadavg
"""


def _tcp_ping(host, port, timeout=3.0):
    started = time.perf_counter()
    try:
        with socket.create_connection((host, port), timeout=timeout):
            pass
        return round((time.perf_counter() - started) * 1000, 1)
    except OSError:
        return None


def collect_local():
    import psutil
    procs = os.environ.get("PSUTIL_PROCFS_PATH")
    if procs:
        psutil.PROCFS_PATH = procs
    psutil.cpu_percent(interval=None)
    time.sleep(0.2)
    cpu = psutil.cpu_percent(interval=None)
    vm = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    try:
        load1 = os.getloadavg()[0]
    except OSError:
        load1 = None
    return {"cpu": round(cpu, 1), "mem": round(vm.percent, 1), "disk": round(disk.percent, 1),
            "uptime": int(time.time() - psutil.boot_time()), "load1": round(load1, 2) if load1 is not None else None,
            "pingMs": 0.0, "error": None}


def collect_remote(ip, port=22, user="root"):
    ip = validation.validate_ip(ip)
    port = validation.validate_port(port, "sshPort")
    user = validation.validate_ssh_user(user)
    ping_ms = _tcp_ping(ip, port, timeout=3)
    started = time.perf_counter()
    try:
        proc = subprocess.run(["ssh", *SSH_OPTS, "-p", str(port), "--", f"{user}@{ip}", REMOTE_SCRIPT],
                              capture_output=True, text=True, timeout=12)
    except subprocess.TimeoutExpired:
        return {"error": "ssh timeout", "pingMs": ping_ms}
    ssh_ms = round((time.perf_counter() - started) * 1000, 1)
    if proc.returncode != 0:
        msg = (proc.stderr or "ssh failed").strip().splitlines()
        return {"error": msg[-1][:180] if msg else "ssh failed", "pingMs": ping_ms}
    out = {}
    for line in proc.stdout.splitlines():
        parts = line.split()
        if not parts:
            continue
        try:
            if parts[0] == "CPU" and len(parts) == 3:
                busy, total = int(parts[1]), int(parts[2])
                out["cpu"] = round(busy * 100.0 / total, 1) if total > 0 else None
            elif parts[0] == "MEM" and len(parts) == 3:
                total, avail = int(parts[1]), int(parts[2])
                out["mem"] = round((total - avail) * 100.0 / total, 1) if total > 0 else None
            elif parts[0] == "DISK" and len(parts) == 2:
                out["disk"] = float(parts[1])
            elif parts[0] == "UPTIME" and len(parts) == 2:
                out["uptime"] = int(parts[1])
            elif parts[0] == "LOAD" and len(parts) == 2:
                out["load1"] = float(parts[1])
        except (ValueError, IndexError):
            continue
    if "cpu" not in out and "mem" not in out:
        return {"error": "unparsable output", "pingMs": ping_ms}
    out.update({"pingMs": ping_ms, "sshMs": ssh_ms, "error": None})
    return out


def _probe_context():
    ca_file = os.environ.get("REXHUB_PROBE_CA_FILE")
    return ssl.create_default_context(cafile=ca_file) if ca_file else ssl.create_default_context()


def _probe_one(app):
    app_id = app.get("id")
    started = time.perf_counter()
    try:
        href = validation.validate_url(app.get("href"), "href")
        request = urllib.request.Request(href, method="HEAD", headers={
            "User-Agent": "rexhub-probe/1.0", "Connection": "close"})
        with urllib.request.urlopen(request, timeout=5, context=_probe_context()) as response:
            code = response.status
            response.read(1)
        latency = round((time.perf_counter() - started) * 1000, 1)
        online = 200 <= code < 400
        return app_id, online, code, latency, None if online else f"HTTP {code}"
    except urllib.error.HTTPError as exc:
        latency = round((time.perf_counter() - started) * 1000, 1)
        online = 400 <= exc.code < 500
        return app_id, online, exc.code, latency, None if online else f"HTTP {exc.code}"
    except Exception as exc:
        latency = round((time.perf_counter() - started) * 1000, 1)
        return app_id, False, None, latency, str(exc)[:180] or exc.__class__.__name__


class Collector:
    def __init__(self, hosts_fn, apps_fn, metric_interval=15, probe_interval=30):
        self.hosts_fn = hosts_fn
        self.apps_fn = apps_fn
        self.metric_interval = metric_interval
        self.probe_interval = probe_interval
        self._stop = threading.Event()
        self._threads = []
        self._host_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="rexhub-host")
        self._probe_pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="rexhub-probe")
        self._heartbeat = {"hosts": 0.0, "probes": 0.0}
        self._last_run = {"hosts": None, "probes": None}
        self._errors = {"hosts": None, "probes": None}

    def start(self):
        if self._threads:
            return
        self._stop.clear()
        for name, target in (("hosts", self._run_hosts), ("probes", self._run_probes)):
            thread = threading.Thread(target=target, name=f"rexhub-collector-{name}", daemon=True)
            self._threads.append(thread)
            thread.start()

    def stop(self, timeout=20):
        self._stop.set()
        for thread in self._threads:
            thread.join(timeout=timeout)
        self._host_pool.shutdown(wait=True)
        self._probe_pool.shutdown(wait=True)
        self._threads = []

    def health(self):
        now = time.time()
        running = bool(self._threads) and all(thread.is_alive() for thread in self._threads)
        heartbeat = all(self._heartbeat.values()) and max(now - value for value in self._heartbeat.values()) < max(
            self.metric_interval, self.probe_interval, 30) * 2
        return {"running": running, "healthy": running and heartbeat, "lastRun": dict(self._last_run),
                "errors": dict(self._errors), "heartbeatAge": {key: max(0, round(now - value, 1))
                for key, value in self._heartbeat.items()}}

    def _run_hosts(self):
        while not self._stop.is_set():
            self._heartbeat["hosts"] = time.time()
            try:
                self._collect_metrics()
                self._errors["hosts"] = None
            except Exception as exc:
                self._errors["hosts"] = str(exc)[:180]
            self._last_run["hosts"] = db.now_iso()
            self._stop.wait(self.metric_interval)

    def _run_probes(self):
        while not self._stop.is_set():
            self._heartbeat["probes"] = time.time()
            try:
                self._collect_probes()
                self._errors["probes"] = None
            except Exception as exc:
                self._errors["probes"] = str(exc)[:180]
            self._last_run["probes"] = db.now_iso()
            self._stop.wait(self.probe_interval)

    def _collect_metrics(self):
        hosts = self.hosts_fn()
        futures = {}
        for host in hosts:
            try:
                if host.get("local"):
                    futures[self._host_pool.submit(collect_local)] = host
                elif host.get("ip"):
                    futures[self._host_pool.submit(collect_remote, host["ip"], host.get("sshPort", 22),
                                                   host.get("sshUser", "root"))] = host
            except Exception as exc:
                db.record_metric(host.get("id", "unknown"), {"error": str(exc)[:180]})
        for future, host in futures.items():
            try:
                data = future.result()
            except Exception as exc:
                data = {"error": str(exc)[:180]}
            try:
                db.record_metric(host["id"], data)
            except Exception as exc:
                print(f"[collector] metric save {host.get('id')}: {exc}", flush=True)

    def _collect_probes(self):
        futures = {}
        for app in self.apps_fn():
            if app.get("href"):
                futures[self._probe_pool.submit(_probe_one, app)] = app
        for future, app in futures.items():
            try:
                app_id, online, code, latency, error = future.result()
                if app_id:
                    db.save_probe(app_id, online, code, latency, error)
            except Exception as exc:
                if app.get("id"):
                    db.save_probe(app["id"], False, None, None, str(exc)[:180])
