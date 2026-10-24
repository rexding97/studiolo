"""后台采集：本机 psutil、远端 SSH 指标、应用探针。"""

import os
import socket
import ssl
import subprocess
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

import db

SSH_KEY = os.path.expanduser("~/.ssh/id_ed25519_rexhub")
SSH_OPTS = [
    "-i", SSH_KEY,
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=4",
    "-o", "ControlMaster=auto",
    "-o", "ControlPath=" + os.path.expanduser("~/.ssh/rexhub-cm-%r@%h:%p"),
    "-o", "ControlPersist=60",
]

REMOTE_SCRIPT = r"""
read -r _ a1 b1 c1 d1 e1 f1 g1 h1 i1 j1 k1 < /proc/stat
sleep 0.25
read -r _ a2 b2 c2 d2 e2 f2 g2 h2 i2 j2 k2 < /proc/stat
t1=$((a1+b1+c1+d1+e1+f1+g1+h1+i1+j1+k1)); t2=$((a2+b2+c2+d2+e2+f2+g2+h2+i2+j2+k2))
u1=$((t1-d1-e1)); u2=$((t2-d2-e2))
dt=$((t2-t1)); du=$((u2-u1))
if [ "$dt" -gt 0 ]; then echo "CPU $du $dt"; fi
awk '/MemTotal/{t=$2} /MemAvailable/{a=$2} END{if(t>0) print "MEM", t, a}' /proc/meminfo
df -P / | awk 'NR==2 {gsub("%","",$5); print "DISK", $5}'
awk '{print "UPTIME", int($1)}' /proc/uptime
awk '{print "LOAD", $1}' /proc/loadavg
"""


def _tcp_ping(host, port, timeout=3.0):
    t0 = time.perf_counter()
    try:
        with socket.create_connection((host, port), timeout=timeout):
            pass
        return round((time.perf_counter() - t0) * 1000, 1)
    except OSError:
        return None


def collect_local():
    import psutil

    psutil.cpu_percent(interval=None)  # prime
    time.sleep(0.2)
    cpu = psutil.cpu_percent(interval=None)
    vm = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    try:
        load1 = os.getloadavg()[0]
    except OSError:
        load1 = None
    return {
        "cpu": round(cpu, 1),
        "mem": round(vm.percent, 1),
        "disk": round(disk.percent, 1),
        "uptime": int(time.time() - psutil.boot_time()),
        "load1": round(load1, 2) if load1 is not None else None,
        "pingMs": 0.0,
        "error": None,
    }


def collect_remote(ip, port=22, user="root"):
    ping_ms = _tcp_ping(ip, port, timeout=3)
    t0 = time.perf_counter()
    try:
        proc = subprocess.run(
            ["ssh", *SSH_OPTS, "-p", str(port), f"{user}@{ip}", REMOTE_SCRIPT],
            capture_output=True, text=True, timeout=12,
        )
    except subprocess.TimeoutExpired:
        return {"error": "ssh timeout", "pingMs": ping_ms}
    ssh_ms = round((time.perf_counter() - t0) * 1000, 1)

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
    out["pingMs"] = ping_ms
    out["sshMs"] = ssh_ms
    out["error"] = None
    return out


def _probe_one(app):
    href = app.get("href") or ""
    parsed = urllib.parse.urlparse(href)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return app.get("id"), False, None, None, "invalid url"

    host = parsed.hostname
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    t0 = time.perf_counter()
    try:
        sock = socket.create_connection((host, port), timeout=4)
        sock.close()
    except OSError as exc:
        return app.get("id"), False, None, None, str(exc)[:120]
    latency = round((time.perf_counter() - t0) * 1000, 1)

    code = None
    try:
        if parsed.scheme == "https":
            ctx = ssl._create_unverified_context()
            raw = socket.create_connection((host, port), timeout=4)
            sock2 = ctx.wrap_socket(raw, server_hostname=host)
        else:
            sock2 = socket.create_connection((host, port), timeout=4)
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query
        req = f"HEAD {path} HTTP/1.1\r\nHost: {parsed.netloc}\r\nUser-Agent: rexhub-probe\r\nConnection: close\r\n\r\n"
        sock2.settimeout(4)
        sock2.sendall(req.encode())
        first = sock2.recv(128).decode("latin-1", "replace")
        sock2.close()
        if first.startswith("HTTP/"):
            code = int(first.split()[1])
    except Exception:
        pass

    return app.get("id"), True, code, latency, None


class Collector:
    def __init__(self, hosts_fn, apps_fn, metric_interval=15, probe_interval=30):
        self.hosts_fn = hosts_fn
        self.apps_fn = apps_fn
        self.metric_interval = metric_interval
        self.probe_interval = probe_interval
        self._stop = threading.Event()
        self._thread = None

    def start(self):
        self._thread = threading.Thread(target=self._run, name="rexhub-collector", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()

    def _run(self):
        time.sleep(1)
        next_probe = 0.0
        while not self._stop.is_set():
            try:
                self._collect_metrics()
            except Exception as exc:  # 采集失败不应拖垮进程
                print(f"[collector] metrics error: {exc}", flush=True)
            now = time.time()
            if now >= next_probe:
                try:
                    self._collect_probes()
                except Exception as exc:
                    print(f"[collector] probe error: {exc}", flush=True)
                next_probe = now + self.probe_interval
            self._stop.wait(self.metric_interval)

    def _collect_metrics(self):
        hosts = self.hosts_fn()
        local = [h for h in hosts if h.get("local")]
        remote = [h for h in hosts if not h.get("local")]
        for host in local:
            db.record_metric(host["id"], collect_local())
        if remote:
            with ThreadPoolExecutor(max_workers=min(4, len(remote))) as pool:
                futures = {
                    pool.submit(collect_remote, h["ip"], h.get("sshPort", 22), h.get("sshUser", "root")): h
                    for h in remote if h.get("ip")
                }
                for fut, host in futures.items():
                    try:
                        db.record_metric(host["id"], fut.result())
                    except Exception as exc:
                        db.record_metric(host["id"], {"error": str(exc)[:180]})

    def _collect_probes(self):
        apps = [a for a in self.apps_fn() if a.get("href")]
        if not apps:
            return
        with ThreadPoolExecutor(max_workers=min(24, len(apps))) as pool:
            for app_id, online, code, latency, error in pool.map(_probe_one, apps):
                if app_id:
                    db.save_probe(app_id, online, code, latency, error)
