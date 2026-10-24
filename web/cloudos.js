/*
 * REX · Cloud OS v5.0 (120fps Pointer 物理跟手引擎 & 无闪烁 GPU 合成版)
 * 彻底解决流畅度问题的 5 项核心改造：
 * 1. 【废弃 HTML5 原生 Drag-and-Drop，全面升级为 120fps Pointer + rAF 跟手引擎】：
 *    - 原生 `draggable="true"` 会产生死板的系统透明残影、松手回弹顿挫且在 macOS 下 `dragover` 帧率不稳。
 *    - 现改为 `pointerdown / pointermove / pointerup` + `requestAnimationFrame`：拖动时生成 1:1 硬件加速浮层 (`.pointer-drag-avatar`)，用 `translate3d(x, y, 0) scale(1.05)` 零延迟紧贴鼠标；松手瞬间浮层按弹簧曲线精准飞入目标网格槽位！
 * 2. 【可中断平滑衔接的 Web Animations FLIP 引擎】：
 *    - 记录每个元素的 runningAnimation，如果前一次动画还没播完又发生新移动，实时读取当前视觉 `getBoundingClientRect()` 作为新起点并取消旧动画，彻底消除动画打架跳帧。
 * 3. 【切换编辑模式 / 改尺寸零 DOM 重建】：
 *    - 进出编辑模式只切换 `document.body.classList.toggle("edit-mode")`，不再调用 `renderWorkspace()` 清空重建 DOM！
 * 4. 【Favicon 内存状态缓存 (`logoStatusCache`)】：
 *    - 已探测成功或失败的网站原生 Logo 缓存在内存 Map 中，局部重绘时 0 毫秒同步命中，不再反复闪烁发起网络请求。
 * 5. 【非破坏性快照投射 (`baseSnapshot`)】：
 *    - 移动途中任何未被当前目标格直接碰撞的组件 100% 锁定在初始坐标，移开鼠标立刻归位。
 */
(function () {
  const STORAGE_KEY = "rex_cloudos_state_v4";
  const GRID_COLS = 12;

  // GitHub Pages 等纯静态托管时启用示例数据，不请求后端
  const DEMO_MODE =
    location.hostname.endsWith(".github.io") ||
    new URLSearchParams(location.search).has("demo");

  const SEARCH_ENGINES = {
    google: { name: "Google", url: "https://www.google.com/search?q=" },
    bing: { name: "Bing", url: "https://www.bing.com/search?q=" },
    github: { name: "GitHub", url: "https://github.com/search?q=" },
    baidu: { name: "Baidu", url: "https://www.baidu.com/s?wd=" }
  };

  // Favicon 探测缓存：appId -> string (有效图片 URL) | false (无有效图片)
  const logoStatusCache = new Map();
  // 正在运行的 FLIP 动画句柄缓存：flipKey -> Animation
  const activeFlipAnimations = new Map();

  let state = loadState();
  normalizeLayoutCoordinates(state.layout);

  let editMode = false;

  let editingAppId = null;
  let editingWidgetId = null;
  let openedFolderWidgetId = null;
  let recentlyDroppedAppId = null;
  let suppressNextClick = false;

  function cloneDefault() {
    return JSON.parse(JSON.stringify(window.REX_DEFAULT_STATE));
  }

  function migrateProfile(target) {
    const profile = target.profile || (target.profile = {});
    const title = String(profile.title || "").trim();
    if (!title || /^REX\b/i.test(title)) profile.title = "Studiolo";
    if (typeof profile.dockEnabled !== "boolean") profile.dockEnabled = true;
    profile.layoutMode = "bento";
    return target;
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return migrateProfile(cloneDefault());
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.layout) || !Array.isArray(parsed.apps)) {
        return migrateProfile(cloneDefault());
      }
      if (!parsed.profile.themeCustom) {
        parsed.profile.themePreset = "vision-glass";
        parsed.profile.themeCustom = JSON.parse(
          JSON.stringify(window.REX_THEME_PRESETS["vision-glass"].config)
        );
      }
      return migrateProfile(parsed);
    } catch (_) {
      return migrateProfile(cloneDefault());
    }
  }

  let applyingRemote = false;

  function saveState() {
    writeLocalState();
    if (applyingRemote) return;
    try {
      Remote.schedulePush(state);
    } catch (_) {
      // Remote 尚未初始化时保持纯本地模式
    }
  }

  function writeLocalState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (_) {}
  }

  /* =========================================================
   * 0. 远端同步层：登录、state 拉取/推送、runtime 轮询
   * ========================================================= */
  const Remote = (() => {
    let authed = false;
    let rev = 0;
    let pushTimer = null;
    let runtimeTimer = null;
    let lastRuntimeSignature = "";
    let overlayBound = false;
    let dirty = false;
    let syncing = false;
    let metaTicks = 0;

    const SYNC_LABELS = {
      idle: "未连接",
      ok: "已同步",
      saving: "保存中",
      offline: "离线",
      auth: "需登录"
    };

    function setSync(status, detail) {
      const el = document.getElementById("syncIndicator");
      if (!el) return;
      el.dataset.state = status;
      const label = el.querySelector("b");
      const text = detail || SYNC_LABELS[status] || status;
      if (label) label.textContent = text;
      el.title = text;
    }

    async function request(url, options) {
      try {
        const res = await fetch(url, Object.assign({ credentials: "same-origin" }, options || {}));
        let body = null;
        try {
          body = await res.json();
        } catch (_) {}
        return { res, body };
      } catch (err) {
        return { res: { ok: false, status: 0 }, body: null, networkError: err };
      }
    }

    function overlay() {
      const el = document.getElementById("authOverlay");
      if (!el) return null;
      if (!overlayBound) {
        overlayBound = true;
        const form = document.getElementById("authForm");
        if (form) {
          form.addEventListener("submit", async (event) => {
            event.preventDefault();
            const input = document.getElementById("authPassword");
            const hint = document.getElementById("authHint");
            if (!input || !input.value) return;
            hint.textContent = "正在验证…";
            const { res, body } = await request("/api/v1/auth/login", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ username: "admin", password: input.value })
            });
            if (!res.ok) {
              hint.textContent = (body && body.error) || "登录失败";
              input.select();
              return;
            }
            input.value = "";
            hint.textContent = "请输入访问密码";
            hide();
            authed = true;
            setSync("saving");
            logoStatusCache.clear();
            renderWorkspace();
            await pullState();
            startRuntime();
          });
        }
      }
      return el;
    }

    function show(message) {
      const el = overlay();
      if (!el) return;
      el.hidden = false;
      const hint = document.getElementById("authHint");
      if (message && hint) hint.textContent = message;
      setTimeout(() => {
        const input = document.getElementById("authPassword");
        if (input) input.focus();
      }, 60);
    }

    function hide() {
      const el = document.getElementById("authOverlay");
      if (el) el.hidden = true;
    }

    async function pullState() {
      syncing = true;
      const { res, body } = await request("/api/v1/state");
      syncing = false;
      if (res.status === 401) {
        authed = false;
        setSync("auth");
        show();
        return;
      }
      if (!res.ok || !body) {
        setSync("offline");
        return;
      }
      rev = body.rev || 0;
      if (!body.state) {
        schedulePush(0);
        return;
      }
      applyingRemote = true;
      state = migrateProfile(body.state);
      const fallback = cloneDefault();
      if (!state.profile) state.profile = fallback.profile;
      if (!state.profile.themeCustom) {
        state.profile.themePreset = "vision-glass";
        state.profile.themeCustom = JSON.parse(
          JSON.stringify(window.REX_THEME_PRESETS["vision-glass"].config)
        );
      }
      if (!Array.isArray(state.layout)) state.layout = [];
      if (!Array.isArray(state.apps)) state.apps = [];
      normalizeLayoutCoordinates(state.layout);
      writeLocalState();
      renderWorkspace();
      applyingRemote = false;
      dirty = false;
      setSync("ok");
    }

    function schedulePush(delay) {
      if (!authed || DEMO_MODE) return;
      dirty = true;
      if (pushTimer) clearTimeout(pushTimer);
      pushTimer = setTimeout(push, typeof delay === "number" ? delay : 800);
    }

    async function push() {
      pushTimer = null;
      if (!authed) return;
      const snapshot = JSON.parse(JSON.stringify(state));
      const sentRev = rev;
      setSync("saving");
      const { res, body } = await request("/api/v1/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rev: sentRev, state: snapshot })
      });
      if (res.status === 401) {
        authed = false;
        setSync("auth");
        show("登录已过期，请重新登录");
        return;
      }
      if (res.status === 409 && body) {
        rev = body.rev || rev;
        if (body.state) {
          applyingRemote = true;
          state = migrateProfile(body.state);
          normalizeLayoutCoordinates(state.layout);
          writeLocalState();
          renderWorkspace();
          applyingRemote = false;
        }
        dirty = false;
        setSync("ok", "已同步（载入远端最新）");
        console.warn("[remote] state conflict, loaded latest from server");
        return;
      }
      if (res.status === 0) {
        setSync("offline");
        return;
      }
      if (res.ok && body) {
        const firstSync = sentRev === 0;
        rev = body.rev || rev;
        dirty = false;
        setSync("ok");
        if (firstSync) {
          // 服务端首次拿到应用清单，favicon 白名单现在才生效
          logoStatusCache.clear();
          renderWorkspace();
        }
      }
    }

    async function checkRemoteState() {
      if (!authed || dirty || syncing) return;
      const { res, body } = await request("/api/v1/state/meta");
      if (!res.ok || !body) return;
      if (body.rev > rev) await pullState();
    }

    function startRuntime() {
      if (runtimeTimer) clearInterval(runtimeTimer);
      metaTicks = 0;
      refreshRuntime();
      runtimeTimer = setInterval(refreshRuntime, 12000);
    }

    async function refreshRuntime() {
      if (document.hidden || !authed) return;
      if (++metaTicks >= 4) {
        metaTicks = 0;
        checkRemoteState();
      }
      const { res, body } = await request("/api/v1/runtime");
      if (res.status === 401) {
        authed = false;
        setSync("auth");
        show("登录已过期，请重新登录");
        return;
      }
      if (!res.ok || !body) return;
      const signature = JSON.stringify([body.hosts, body.probes, body.weather]);
      if (signature === lastRuntimeSignature) return;
      lastRuntimeSignature = signature;
      applyRuntime(body);
    }

    function formatUptime(seconds) {
      const days = Math.floor(seconds / 86400);
      const hours = Math.floor((seconds % 86400) / 3600);
      return days > 0 ? `${days}d ${String(hours).padStart(2, "0")}h` : `${hours}h`;
    }

    function updateHostCards(hosts) {
      document.querySelectorAll("[data-host-id]").forEach((shell) => {
        const metric = (hosts || {})[shell.dataset.hostId];
        if (!metric) return;
        const ip = shell.dataset.hostIp || "";
        const pingEl = shell.querySelector("[data-host-ping]");
        const cpuEl = shell.querySelector("[data-host-cpu]");
        const memEl = shell.querySelector("[data-host-mem]");
        const diskEl = shell.querySelector("[data-host-disk]");
        const roleEl = shell.querySelector("[data-host-role]");
        if (pingEl && typeof metric.pingMs === "number") {
          pingEl.textContent = `${ip} · ${Math.round(metric.pingMs)}ms`;
        }
        if (cpuEl && typeof metric.cpu === "number") cpuEl.textContent = `${metric.cpu.toFixed(1)}%`;
        if (memEl && typeof metric.mem === "number") memEl.textContent = `${metric.mem.toFixed(1)}%`;
        if (diskEl && typeof metric.disk === "number") diskEl.textContent = `${metric.disk.toFixed(1)}%`;
        if (roleEl && metric.error) roleEl.textContent = `连接失败 · ${metric.error}`;
        shell.classList.toggle("host-offline", Boolean(metric.error));
      });
    }

    function updateProbeDots(probes) {
      document.querySelectorAll(".app-unit[data-app-id]").forEach((el) => {
        const probe = (probes || {})[el.dataset.appId];
        if (!probe) return;
        const dot = el.querySelector(".app-dot");
        if (!dot) return;
        dot.classList.toggle("online", Boolean(probe.online));
        dot.classList.toggle("offline", !probe.online);
        if (probe.latencyMs != null) el.dataset.latency = String(Math.round(probe.latencyMs));
      });
    }

    function applyRuntime(data) {
      const weather = data.weather || {};
      let weatherChanged = false;
      Object.keys(weather).forEach((city) => {
        const payload = weather[city];
        const prev = runtimeWeather.get(city);
        runtimeWeather.set(city, payload);
        if (
          !prev ||
          prev.temp !== payload.temp ||
          prev.code !== payload.code ||
          prev.humidity !== payload.humidity ||
          JSON.stringify(prev.days) !== JSON.stringify(payload.days)
        ) {
          weatherChanged = true;
        }
      });

      (state.apps || []).forEach((app) => {
        const probe = (data.probes || {})[app.id];
        if (probe) {
          app.status = probe.online ? "online" : "offline";
          if (typeof probe.latencyMs === "number") app.latency = Math.round(probe.latencyMs);
        }
        const click = (data.clicks || {})[app.id];
        if (click && typeof click.count === "number") {
          app.clicks = click.count;
        } else if (data.clicks) {
          app.clicks = 0;
        }
      });

      (state.layout || []).forEach((item) => {
        if (item.kind !== "widget" || item.widgetType !== "server-node") return;
        const metric = (data.hosts || {})[String(item.id).replace(/^host-/, "")];
        if (!metric) return;
        const cfg = item.config || (item.config = {});
        if (typeof metric.cpu === "number") cfg.cpu = metric.cpu.toFixed(1) + "%";
        if (typeof metric.mem === "number") cfg.mem = metric.mem.toFixed(1) + "%";
        if (typeof metric.disk === "number") cfg.disk = metric.disk.toFixed(1) + "%";
        if (typeof metric.pingMs === "number") cfg.pingMs = Math.round(metric.pingMs);
        if (typeof metric.uptime === "number") cfg.uptime = formatUptime(metric.uptime);
        cfg.offline = Boolean(metric.error);
      });

      updateHostCards(data.hosts);
      updateProbeDots(data.probes);
      if (weatherChanged) {
        document.querySelectorAll("[data-weather-city]").forEach((shell) => {
          const city = shell.dataset.weatherCity;
          if (!runtimeWeather.has(city)) return;
          paintWeatherShell(shell, findWeatherConfig(city) || { city });
        });
      }
      if (!DEMO_MODE) writeLocalState();
      const stamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
      const indicator = document.getElementById("syncIndicator");
      if (indicator) indicator.title = `已同步 · ${stamp}`;
      const tip = document.getElementById("syncTip");
      if (tip) tip.textContent = `最后刷新 ${stamp}`;
    }

    function recordClick(appId) {
      if (!authed) return;
      request("/api/v1/click", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId })
      });
    }

    function demoSnapshot() {
      const wobble = (base, amp) => Math.max(1, Math.min(99, base + (Math.random() - 0.5) * amp));
      const day = (offset) => {
        const d = new Date();
        d.setDate(d.getDate() + offset);
        return d.toISOString().slice(0, 10);
      };
      const probes = {};
      (state.apps || []).forEach((app) => {
        probes[app.id] = {
          online: true,
          httpCode: 200,
          latencyMs: 18 + Math.round(Math.random() * 90),
          checkedAt: new Date().toISOString(),
        };
      });
      return {
        hosts: {
          mac: { cpu: wobble(12, 6), mem: wobble(38, 2), disk: 61.5, uptime: 1036800, pingMs: 1 },
          office: { cpu: wobble(23, 10), mem: wobble(58, 2), disk: 42.0, uptime: 3196800, pingMs: 4 },
          fnas: { cpu: wobble(4, 3), mem: wobble(22, 1), disk: 55.3, uptime: 2764800, pingMs: 3 },
        },
        probes,
        weather: {
          "上海": {
            city: "上海",
            temp: 21.4,
            feels: 20.8,
            humidity: 64,
            wind: 9.2,
            code: 2,
            days: [
              { date: day(0), code: 2, max: 23, min: 15 },
              { date: day(1), code: 3, max: 22, min: 16 },
              { date: day(2), code: 61, max: 20, min: 14 },
              { date: day(3), code: 1, max: 24, min: 15 },
            ],
            updatedAt: new Date().toISOString(),
          },
        },
        clicks: {},
        serverTime: new Date().toISOString(),
      };
    }

    function startDemoRuntime() {
      setSync("ok", "示例模式");
      let timer = null;
      const tick = () => {
        if (document.hidden) return;
        applyRuntime(demoSnapshot());
      };
      tick();
      timer = setInterval(tick, 5000);
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) tick();
      });
      return timer;
    }

    async function init() {
      if (DEMO_MODE) {
        authed = true;
        hide();
        startDemoRuntime();
        return;
      }
      setSync("saving");
      const { res, body } = await request("/api/v1/auth/me");
      if (!res.ok) {
        setSync("offline");
        return; // 后端不可达：保持纯本地模式
      }
      if (!body || !body.authenticated) {
        setSync("auth");
        show();
        return;
      }
      authed = true;
      hide();
      logoStatusCache.clear();
      renderWorkspace();
      await pullState();
      startRuntime();
    }

    window.addEventListener("online", () => {
      setSync("saving");
      if (authed) {
        pullState();
        refreshRuntime();
      } else {
        init();
      }
    });

    window.addEventListener("offline", () => setSync("offline"));

    window.addEventListener("pagehide", () => {
      if (!authed || !dirty || DEMO_MODE) return;
      try {
        fetch("/api/v1/state", {
          method: "PUT",
          keepalive: true,
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rev, state })
        });
      } catch (_) {}
    });

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && authed) refreshRuntime();
    });

    return { init, schedulePush, recordClick, pullState };
  })();

  /* =========================================================
   * 1. 2D 绝对坐标棋盘碰撞与非破坏性快照投射算法
   * ========================================================= */
  function rectsOverlap(a, b) {
    return (
      a.x < b.x + b.w &&
      a.x + a.w > b.x &&
      a.y < b.y + b.h &&
      a.y + a.h > b.y
    );
  }

  function isAreaFree(layoutList, x, y, w, h, ignoreId = null) {
    if (x < 1 || y < 1 || x + w - 1 > GRID_COLS) return false;
    const testRect = { x, y, w, h };
    for (const item of layoutList) {
      if (item.id === ignoreId) continue;
      const itemRect = {
        x: item.x || 1,
        y: item.y || 1,
        w: item.kind === "app" ? 1 : item.w || 4,
        h: item.kind === "app" ? 1 : item.h || 2
      };
      if (rectsOverlap(testRect, itemRect)) return false;
    }
    return true;
  }

  function findFirstFreeSpot(layoutList, w, h, ignoreId = null, startRow = 1) {
    for (let r = Math.max(1, startRow); r <= 50; r++) {
      for (let c = 1; c <= GRID_COLS - w + 1; c++) {
        if (isAreaFree(layoutList, c, r, w, h, ignoreId)) {
          return { x: c, y: r };
        }
      }
    }
    return { x: 1, y: 1 };
  }

  function normalizeLayoutCoordinates(layoutList) {
    const placed = [];
    for (const item of layoutList) {
      item.w = item.kind === "app" ? 1 : Number(item.w) || 4;
      item.h = item.kind === "app" ? 1 : Number(item.h) || 2;
      if (
        typeof item.x === "number" &&
        typeof item.y === "number" &&
        isAreaFree(placed, item.x, item.y, item.w, item.h, item.id)
      ) {
        placed.push(item);
      } else {
        const spot = findFirstFreeSpot(placed, item.w, item.h, item.id, 1);
        item.x = spot.x;
        item.y = spot.y;
        placed.push(item);
      }
    }
  }

  function captureLayoutSnapshot() {
    const snap = new Map();
    state.layout.forEach((item) => {
      snap.set(item.id, {
        x: item.x || 1,
        y: item.y || 1,
        w: item.kind === "app" ? 1 : item.w || 4,
        h: item.kind === "app" ? 1 : item.h || 2
      });
    });
    return snap;
  }

  function restoreFromSnapshot(snap) {
    if (!snap) return;
    state.layout.forEach((item) => {
      const orig = snap.get(item.id);
      if (orig) {
        item.x = orig.x;
        item.y = orig.y;
      }
    });
  }

  function projectDragToCoord(itemId, targetX, targetY, baseSnap) {
    const snap = baseSnap || captureLayoutSnapshot();
    const item = state.layout.find((x) => x.id === itemId);
    if (!item) return false;

    const w = item.kind === "app" ? 1 : item.w || 4;
    const h = item.kind === "app" ? 1 : item.h || 2;
    const clampedX = Math.max(1, Math.min(GRID_COLS - w + 1, targetX));
    const clampedY = Math.max(1, targetY);

    const prevCoords = new Map();
    state.layout.forEach((it) => prevCoords.set(it.id, `${it.x},${it.y}`));

    restoreFromSnapshot(snap);

    const origSelf = snap.get(itemId) || { x: item.x, y: item.y, w, h };
    const targetRect = { x: clampedX, y: clampedY, w, h };

    const blockers = state.layout.filter((other) => {
      if (other.id === item.id) return false;
      const oRect = {
        x: other.x,
        y: other.y,
        w: other.kind === "app" ? 1 : other.w || 4,
        h: other.kind === "app" ? 1 : other.h || 2
      };
      return rectsOverlap(targetRect, oRect);
    });

    if (blockers.length === 0) {
      item.x = clampedX;
      item.y = clampedY;
    } else if (item.kind === "app" && blockers.some((b) => b.kind === "widget")) {
      return false;
    } else if (blockers.length === 1) {
      const b = blockers[0];
      const bw = b.kind === "app" ? 1 : b.w || 4;
      const bh = b.kind === "app" ? 1 : b.h || 2;

      item.x = clampedX;
      item.y = clampedY;

      if (bw <= origSelf.w && bh <= origSelf.h && isAreaFree(state.layout, origSelf.x, origSelf.y, bw, bh, b.id)) {
        b.x = origSelf.x;
        b.y = origSelf.y;
      } else if (isAreaFree(state.layout, clampedX, clampedY + h, bw, bh, b.id)) {
        b.x = clampedX;
        b.y = clampedY + h;
      } else {
        restoreFromSnapshot(snap);
        return false;
      }
    } else {
      item.x = clampedX;
      item.y = clampedY;
      let allFitInOrig = true;
      for (const b of blockers) {
        const bw = b.kind === "app" ? 1 : b.w || 4;
        const bh = b.kind === "app" ? 1 : b.h || 2;
        let placedInOrig = false;
        for (let ry = origSelf.y; ry <= origSelf.y + origSelf.h - bh && !placedInOrig; ry++) {
          for (let cx = origSelf.x; cx <= origSelf.x + origSelf.w - bw && !placedInOrig; cx++) {
            if (isAreaFree(state.layout, cx, ry, bw, bh, b.id)) {
              b.x = cx;
              b.y = ry;
              placedInOrig = true;
            }
          }
        }
        if (!placedInOrig) {
          allFitInOrig = false;
          break;
        }
      }
      if (!allFitInOrig) {
        restoreFromSnapshot(snap);
        return false;
      }
    }

    let anyChanged = false;
    state.layout.forEach((it) => {
      if (prevCoords.get(it.id) !== `${it.x},${it.y}`) anyChanged = true;
    });
    return anyChanged;
  }

  /* =========================================================
   * 2. 可中断平滑衔接的 FLIP 物理弹簧动画引擎
   * ========================================================= */
  function capturePositions(scopeSelector = "[data-flip-key]") {
    const rects = new Map();
    document.querySelectorAll(scopeSelector).forEach((el) => {
      // 采集当前实际视觉位置（含正在進行的动画偏移）
      rects.set(el.dataset.flipKey, el.getBoundingClientRect());
    });
    return rects;
  }

  function playFlipAnimation(prevRects, skipKey = null) {
    if (!prevRects || !prevRects.size) return;
    document.querySelectorAll("[data-flip-key]").forEach((el) => {
      const key = el.dataset.flipKey;
      if (key === skipKey) return;
      const first = prevRects.get(key);
      if (!first) return;

      // 如果该元素上有尚未结束的旧动画，先取消以读取真实的布局终点
      const running = activeFlipAnimations.get(key);
      if (running) {
        running.cancel();
        activeFlipAnimations.delete(key);
      }

      const last = el.getBoundingClientRect();
      const dx = first.left - last.left;
      const dy = first.top - last.top;
      const dw = first.width / Math.max(1, last.width);
      const dh = first.height / Math.max(1, last.height);

      if (Math.abs(dx) > 0.8 || Math.abs(dy) > 0.8 || Math.abs(dw - 1) > 0.02 || Math.abs(dh - 1) > 0.02) {
        const anim = el.animate(
          [
            { transform: `translate3d(${dx}px, ${dy}px, 0) scale(${dw}, ${dh})` },
            { transform: "translate3d(0, 0, 0) scale(1, 1)" }
          ],
          {
            duration: 280,
            easing: "cubic-bezier(0.22, 1, 0.36, 1)"
          }
        );
        activeFlipAnimations.set(key, anim);
        anim.onfinish = () => {
          if (activeFlipAnimations.get(key) === anim) activeFlipAnimations.delete(key);
        };
      }
    });
  }

  function renderWithFlip() {
    const before = capturePositions();
    renderWorkspace();
    playFlipAnimation(before);
    refreshContainerSelectOptions();
  }

  function syncGridCoordsWithFlip(skipFlipKey = null) {
    const before = capturePositions();
    state.layout.forEach((item) => {
      const domEl = document.querySelector(`[data-item-id="${item.id}"]`);
      if (domEl) {
        const w = item.kind === "app" ? 1 : item.w || 4;
        const h = item.kind === "app" ? 1 : item.h || 2;
        domEl.style.gridColumn = `${item.x} / span ${w}`;
        domEl.style.gridRow = `${item.y} / span ${h}`;
      }
    });
    playFlipAnimation(before, skipFlipKey);
  }

  /* =========================================================
   * 3. 120fps Pointer + rAF 零延迟物理跟手拖拽引擎
   * ========================================================= */
  let pointerDrag = null;

  function initGlobalPointerDragEngine() {
    let rafId = null;

    function updateAvatarTransform() {
      rafId = null;
      if (!pointerDrag || !pointerDrag.avatarEl) return;
      const tx = pointerDrag.clientX - pointerDrag.grabOffsetX;
      const ty = pointerDrag.clientY - pointerDrag.grabOffsetY;
      pointerDrag.avatarEl.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(1.05)`;
    }

    function clearPointerTimers() {
      if (!pointerDrag) return;
      if (pointerDrag.dwellTimer) {
        clearTimeout(pointerDrag.dwellTimer);
        pointerDrag.dwellTimer = null;
      }
      if (pointerDrag.folderTimer) {
        clearTimeout(pointerDrag.folderTimer);
        pointerDrag.folderTimer = null;
      }
      pointerDrag.folderTargetId = null;
      document.querySelectorAll(".folder-absorb-ready").forEach((el) => {
        el.classList.remove("folder-absorb-ready");
      });
    }

    function updateSlotIndicator(x, y, w, h, visible) {
      const ind = document.getElementById("gridSlotIndicator");
      if (!ind) return;
      if (!visible) {
        ind.classList.remove("active");
        return;
      }
      ind.style.gridColumn = `${x} / span ${w}`;
      ind.style.gridRow = `${y} / span ${h}`;
      ind.classList.add("active");
    }

    function pointerToGridCoord(gridEl, clientX, clientY) {
      const rect = gridEl.getBoundingClientRect();
      const gap = parseFloat(getComputedStyle(gridEl).gap) || 18;
      const colWidth = (rect.width - gap * (GRID_COLS - 1)) / GRID_COLS;
      const rowHeight = 132;
      const relX = Math.max(0, clientX - rect.left);
      const relY = Math.max(0, clientY - rect.top);
      const col = Math.max(1, Math.min(GRID_COLS, Math.floor(relX / (colWidth + gap)) + 1));
      const row = Math.max(1, Math.floor(relY / (rowHeight + gap)) + 1);
      return { col, row };
    }

    function isOverTrashDock(clientX, clientY) {
      const dock = document.getElementById("trashDock");
      if (!dock || !dock.classList.contains("visible")) return false;
      const r = dock.getBoundingClientRect();
      return clientX >= r.left - 12 && clientX <= r.right + 12 && clientY >= r.top - 12 && clientY <= r.bottom + 12;
    }

    function startDraggingSession(p) {
      p.started = true;
      suppressNextClick = true;
      hidePopover();
      document.body.classList.add("is-pointer-dragging");

      // 克隆视觉浮层 (1:1 尺寸锁定，硬件加速合成)
      const rect = p.sourceEl.getBoundingClientRect();
      const avatar = p.sourceEl.cloneNode(true);
      avatar.className = p.sourceEl.className + " pointer-drag-avatar";
      avatar.style.width = `${rect.width}px`;
      avatar.style.height = `${rect.height}px`;
      avatar.style.margin = "0";
      avatar.style.gridColumn = "auto";
      avatar.style.gridRow = "auto";
      avatar.style.transform = `translate3d(${rect.left}px, ${rect.top}px, 0) scale(1.05)`;
      document.body.appendChild(avatar);

      p.avatarEl = avatar;
      p.sourceEl.classList.add("is-being-dragged-source");
      showTrashDock(`拖到此处删除「${p.title}」`);
    }

    window.beginPointerDragCandidate = function (e, opts) {
      if (e.button !== 0) return;
      if (["TEXTAREA", "INPUT", "SELECT", "BUTTON"].includes(e.target.tagName)) return;
      if (e.target.closest(".widget-resize-corner") || e.target.closest(".widget-edit-toolbar")) return;

      const rect = opts.sourceEl.getBoundingClientRect();
      const w = opts.w || 1;
      const h = opts.h || 1;

      pointerDrag = {
        kind: opts.kind, // 'layout-item' | 'inner-app'
        layoutId: opts.layoutId || null,
        appId: opts.appId || null,
        fromWidgetId: opts.fromWidgetId || null,
        isBareApp: Boolean(opts.isBareApp),
        w,
        h,
        title: opts.title || "项目",
        sourceEl: opts.sourceEl,
        startX: e.clientX,
        startY: e.clientY,
        clientX: e.clientX,
        clientY: e.clientY,
        grabOffsetX: e.clientX - rect.left,
        grabOffsetY: e.clientY - rect.top,
        grabOffsetCols: Math.max(0, Math.min(w - 1, Math.floor(((e.clientX - rect.left) / Math.max(1, rect.width)) * w))),
        grabOffsetRows: Math.max(0, Math.min(h - 1, Math.floor(((e.clientY - rect.top) / Math.max(1, rect.height)) * h))),
        baseSnapshot: captureLayoutSnapshot(),
        started: false,
        avatarEl: null,
        dwellKey: null,
        dwellTimer: null,
        folderTimer: null,
        folderTargetId: null
      };
    };

    window.addEventListener(
      "pointermove",
      (e) => {
        if (!pointerDrag) return;
        pointerDrag.clientX = e.clientX;
        pointerDrag.clientY = e.clientY;

        if (!pointerDrag.started) {
          const dist = Math.hypot(e.clientX - pointerDrag.startX, e.clientY - pointerDrag.startY);
          if (dist < 6) return;
          startDraggingSession(pointerDrag);
        }

        e.preventDefault();
        if (!rafId) {
          rafId = requestAnimationFrame(updateAvatarTransform);
        }

        // 1. 检测是否悬停在底部回收站上
        const trashDock = document.getElementById("trashDock");
        if (isOverTrashDock(e.clientX, e.clientY)) {
          trashDock.classList.add("drag-hover");
          updateSlotIndicator(1, 1, 1, 1, false);
          clearPointerTimers();
          return;
        } else if (trashDock) {
          trashDock.classList.remove("drag-hover");
        }

        // 2. 如果当前打开着文件夹弹窗：检测是否仍在弹窗内排序，还是拖出了弹窗外围空白处！
        const folderBackdrop = document.getElementById("folderBackdrop");
        if (openedFolderWidgetId && folderBackdrop && folderBackdrop.classList.contains("open")) {
          const card = folderBackdrop.querySelector(".folder-expanded-card");
          const cardRect = card.getBoundingClientRect();
          const insideCard =
            e.clientX >= cardRect.left &&
            e.clientX <= cardRect.right &&
            e.clientY >= cardRect.top &&
            e.clientY <= cardRect.bottom;

          if (!insideCard) {
            // 拖出了文件夹弹窗到外部空白区域 -> 自动丝滑关闭文件夹，并将该应用升级为桌面 1×1 独立图标跟随鼠标！
            const appId = pointerDrag.appId;
            closeFolderModal();
            if (pointerDrag.kind === "inner-app" && appId) {
              const gridEl = document.querySelector(".atomic-grid");
              const { col, row } = gridEl ? pointerToGridCoord(gridEl, e.clientX, e.clientY) : { col: 1, row: 1 };
              const bareItem = promoteInnerAppToBareDesktop(appId, col, row);
              renderWithFlip();
              if (bareItem) {
                const newSourceEl = document.querySelector(`[data-item-id="${bareItem.id}"]`);
                if (newSourceEl) {
                  newSourceEl.classList.add("is-being-dragged-source");
                  pointerDrag.kind = "layout-item";
                  pointerDrag.layoutId = bareItem.id;
                  pointerDrag.isBareApp = true;
                  pointerDrag.fromWidgetId = null;
                  pointerDrag.w = 1;
                  pointerDrag.h = 1;
                  pointerDrag.grabOffsetCols = 0;
                  pointerDrag.grabOffsetRows = 0;
                  pointerDrag.sourceEl = newSourceEl;
                  pointerDrag.baseSnapshot = captureLayoutSnapshot();
                }
              }
            }
            return;
          }

          // 在打开的文件夹弹窗内部滑动排序
          const targetUnit = document
            .elementFromPoint(e.clientX, e.clientY)
            ?.closest(".folder-expanded-grid .app-unit");
          if (targetUnit && targetUnit.dataset.appId && targetUnit.dataset.appId !== pointerDrag.appId) {
            const targetAppId = targetUnit.dataset.appId;
            const key = `folder-sort:${pointerDrag.appId}->${targetAppId}`;
            if (pointerDrag.dwellKey !== key) {
              clearPointerTimers();
              pointerDrag.dwellKey = key;
              pointerDrag.dwellTimer = setTimeout(() => {
                if (!pointerDrag) return;
                const fromIdx = state.apps.findIndex((x) => x.id === pointerDrag.appId);
                const toIdx = state.apps.findIndex((x) => x.id === targetAppId);
                if (fromIdx !== -1 && toIdx !== -1 && fromIdx !== toIdx) {
                  const parentGrid = targetUnit.parentElement;
                  const before = capturePositions(".folder-expanded-grid [data-flip-key]");
                  const [m] = state.apps.splice(fromIdx, 1);
                  state.apps.splice(toIdx, 0, m);
                  saveState();
                  const children = Array.from(parentGrid.children);
                  if (children.indexOf(pointerDrag.sourceEl) < children.indexOf(targetUnit)) {
                    parentGrid.insertBefore(pointerDrag.sourceEl, targetUnit.nextSibling);
                  } else {
                    parentGrid.insertBefore(pointerDrag.sourceEl, targetUnit);
                  }
                  playFlipAnimation(before);
                }
              }, 90);
            }
          }
          return;
        }

        // 3. 在桌面主棋盘 `.atomic-grid` 上移动
        const gridEl = document.querySelector(".atomic-grid");
        if (!gridEl) return;

        // 3a. 如果当前拖的是桌面某个组件卡片内部的图标：检查是仍在原组件内排序，还是拖出了组件边界到桌面上
        if (pointerDrag.kind === "inner-app" && pointerDrag.appId) {
          const fromWidgetEl = pointerDrag.fromWidgetId
            ? gridEl.querySelector(`[data-item-id="${pointerDrag.fromWidgetId}"]`)
            : null;
          if (fromWidgetEl) {
            const wr = fromWidgetEl.getBoundingClientRect();
            const stillInside =
              e.clientX >= wr.left + 6 &&
              e.clientX <= wr.right - 6 &&
              e.clientY >= wr.top + 6 &&
              e.clientY <= wr.bottom - 6;

            if (stillInside) {
              const targetUnit = document
                .elementFromPoint(e.clientX, e.clientY)
                ?.closest(".widget-slot-grid .app-unit");
              if (targetUnit && targetUnit.dataset.appId && targetUnit.dataset.appId !== pointerDrag.appId) {
                const targetAppId = targetUnit.dataset.appId;
                const key = `slot-sort:${pointerDrag.appId}->${targetAppId}`;
                if (pointerDrag.dwellKey !== key) {
                  clearPointerTimers();
                  pointerDrag.dwellKey = key;
                  pointerDrag.dwellTimer = setTimeout(() => {
                    if (!pointerDrag) return;
                    const fromIdx = state.apps.findIndex((x) => x.id === pointerDrag.appId);
                    const toIdx = state.apps.findIndex((x) => x.id === targetAppId);
                    if (fromIdx !== -1 && toIdx !== -1 && fromIdx !== toIdx) {
                      const parentGrid = targetUnit.parentElement;
                      const before = capturePositions();
                      const [m] = state.apps.splice(fromIdx, 1);
                      state.apps.splice(toIdx, 0, m);
                      saveState();
                      const children = Array.from(parentGrid.children);
                      if (children.indexOf(pointerDrag.sourceEl) < children.indexOf(targetUnit)) {
                        parentGrid.insertBefore(pointerDrag.sourceEl, targetUnit.nextSibling);
                      } else {
                        parentGrid.insertBefore(pointerDrag.sourceEl, targetUnit);
                      }
                      playFlipAnimation(before);
                    }
                  }, 90);
                }
              }
              return;
            }
          }

          // 已经拖出了原组件边界 -> 立即在桌面上转为 1×1 独立图标！
          const { col, row } = pointerToGridCoord(gridEl, e.clientX, e.clientY);
          const bareItem = promoteInnerAppToBareDesktop(pointerDrag.appId, col, row);
          renderWithFlip();
          if (bareItem) {
            const newSourceEl = document.querySelector(`[data-item-id="${bareItem.id}"]`);
            if (newSourceEl) {
              newSourceEl.classList.add("is-being-dragged-source");
              pointerDrag.kind = "layout-item";
              pointerDrag.layoutId = bareItem.id;
              pointerDrag.isBareApp = true;
              pointerDrag.fromWidgetId = null;
              pointerDrag.w = 1;
              pointerDrag.h = 1;
              pointerDrag.grabOffsetCols = 0;
              pointerDrag.grabOffsetRows = 0;
              pointerDrag.sourceEl = newSourceEl;
              pointerDrag.baseSnapshot = captureLayoutSnapshot();
            }
          }
          return;
        }

        // 3b. 如果拖动的是 `1×1` 独立应用，检查鼠标是否悬停在某个文件夹/服务器组件的中心区域（准备放入文件夹）
        if (pointerDrag.kind === "layout-item" && pointerDrag.isBareApp && pointerDrag.appId) {
          const underEl = document.elementFromPoint(e.clientX, e.clientY);
          const targetShell = underEl ? underEl.closest(".widget-shell") : null;
          if (targetShell && targetShell.dataset.itemId) {
            const targetLayoutItem = state.layout.find((x) => x.id === targetShell.dataset.itemId);
            if (
              targetLayoutItem &&
              (targetLayoutItem.widgetType === "server-node" || targetLayoutItem.widgetType === "app-folder")
            ) {
              const sr = targetShell.getBoundingClientRect();
              const rx = (e.clientX - sr.left) / sr.width;
              const ry = (e.clientY - sr.top) / sr.height;
              if (rx > 0.2 && rx < 0.8 && ry > 0.2 && ry < 0.8) {
                updateSlotIndicator(1, 1, 1, 1, false);
                if (pointerDrag.folderTargetId !== targetLayoutItem.id) {
                  clearPointerTimers();
                  pointerDrag.folderTargetId = targetLayoutItem.id;
                  targetShell.classList.add("folder-absorb-ready");
                  pointerDrag.folderTimer = setTimeout(() => {
                    if (!pointerDrag) return;
                    const appId = pointerDrag.appId;
                    const bareId = pointerDrag.layoutId;
                    finishPointerDragSession(false);
                    absorbAppIntoFolderAndOpen(appId, bareId, targetLayoutItem.id);
                  }, 380);
                }
                return;
              }
            }
          }
          if (pointerDrag.folderTargetId) {
            clearPointerTimers();
          }
        }

        // 3c. 计算鼠标指向的 2D 棋盘坐标 (targetX, targetY) 并显示实时落点光影框
        if (pointerDrag.kind === "layout-item" && pointerDrag.layoutId) {
          const { col, row } = pointerToGridCoord(gridEl, e.clientX, e.clientY);
          const targetX = Math.max(1, Math.min(GRID_COLS - pointerDrag.w + 1, col - pointerDrag.grabOffsetCols));
          const targetY = Math.max(1, row - pointerDrag.grabOffsetRows);

          updateSlotIndicator(targetX, targetY, pointerDrag.w, pointerDrag.h, true);

          const key = `grid:${pointerDrag.layoutId}@${targetX},${targetY}`;
          if (pointerDrag.dwellKey !== key) {
            if (pointerDrag.dwellTimer) clearTimeout(pointerDrag.dwellTimer);
            pointerDrag.dwellKey = key;
            pointerDrag.dwellTimer = setTimeout(() => {
              if (!pointerDrag || pointerDrag.kind !== "layout-item") return;
              const changed = projectDragToCoord(
                pointerDrag.layoutId,
                targetX,
                targetY,
                pointerDrag.baseSnapshot
              );
              if (changed) {
                syncGridCoordsWithFlip();
              }
            }, 95);
          }
        }
      },
      { passive: false }
    );

    function finishPointerDragSession(commitDrop = true) {
      if (!pointerDrag) return;
      const p = pointerDrag;
      pointerDrag = null;

      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (p.dwellTimer) clearTimeout(p.dwellTimer);
      if (p.folderTimer) clearTimeout(p.folderTimer);
      document.querySelectorAll(".folder-absorb-ready").forEach((el) => {
        el.classList.remove("folder-absorb-ready");
      });
      updateSlotIndicator(1, 1, 1, 1, false);
      document.body.classList.remove("is-pointer-dragging");
      hideTrashDock();

      if (!p.started) return;

      // 情况 1：松手在底部回收站上 -> 执行删除
      if (commitDrop && isOverTrashDock(p.clientX, p.clientY)) {
        if (p.avatarEl) p.avatarEl.remove();
        if (p.kind === "inner-app" && p.appId) {
          state.apps = state.apps.filter((a) => a.id !== p.appId);
          state.layout = state.layout.filter((x) => !(x.kind === "app" && x.appId === p.appId));
        } else if (p.kind === "layout-item" && p.layoutId) {
          const item = state.layout.find((x) => x.id === p.layoutId);
          if (item) {
            state.layout = state.layout.filter((x) => x.id !== item.id);
            if (item.kind === "app" && item.appId) {
              const appObj = state.apps.find((a) => a.id === item.appId);
              if (appObj && (!appObj.containerId || appObj.containerId === "desktop")) {
                state.apps = state.apps.filter((a) => a.id !== item.appId);
              }
            }
          }
        }
        saveState();
        renderWithFlip();
        if (openedFolderWidgetId) renderFolderModalContent(openedFolderWidgetId);
        return;
      }

      // 情况 2：把 1×1 独立应用直接松手在某个文件夹/服务器组件上 -> 放入文件夹并打开
      if (commitDrop && p.kind === "layout-item" && p.isBareApp && p.appId && p.folderTargetId) {
        if (p.avatarEl) p.avatarEl.remove();
        absorbAppIntoFolderAndOpen(p.appId, p.layoutId, p.folderTargetId);
        return;
      }

      // 情况 3：正常落位 -> 先提交最终坐标，再让浮层以 180ms 弹簧动画飞入目标格，无缝交接给真实 DOM！
      const gridEl = document.querySelector(".atomic-grid");
      if (commitDrop && gridEl && p.kind === "layout-item" && p.layoutId) {
        const { col, row } = pointerToGridCoord(gridEl, p.clientX, p.clientY);
        const targetX = Math.max(1, Math.min(GRID_COLS - p.w + 1, col - p.grabOffsetCols));
        const targetY = Math.max(1, row - p.grabOffsetRows);
        if (projectDragToCoord(p.layoutId, targetX, targetY, p.baseSnapshot)) {
          syncGridCoordsWithFlip(`layout-${p.layoutId}`);
        }
        saveState();
      }

      if (p.avatarEl && p.sourceEl && document.body.contains(p.sourceEl)) {
        const destRect = p.sourceEl.getBoundingClientRect();
        const anim = p.avatarEl.animate(
          [
            { transform: p.avatarEl.style.transform },
            { transform: `translate3d(${destRect.left}px, ${destRect.top}px, 0) scale(1)` }
          ],
          { duration: 190, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
        );
        anim.onfinish = () => {
          p.avatarEl.remove();
          p.sourceEl.classList.remove("is-being-dragged-source");
        };
      } else {
        if (p.avatarEl) p.avatarEl.remove();
        if (p.sourceEl) p.sourceEl.classList.remove("is-being-dragged-source");
      }
    }

    window.addEventListener("pointerup", () => finishPointerDragSession(true));
    window.addEventListener("pointercancel", () => finishPointerDragSession(false));

    // 拦截紧随拖拽结束后的那一次合成 click 事件，防止松手时误打开网页链接
    window.addEventListener(
      "click",
      (e) => {
        if (suppressNextClick) {
          e.preventDefault();
          e.stopPropagation();
          suppressNextClick = false;
        }
      },
      true
    );
  }

  /* =========================================================
   * 4. 可编程主题引擎 (Theme Studio)
   * ========================================================= */
  function applyTheme() {
    const defaults = window.REX_THEME_PRESETS["vision-glass"].config;
    const values = Object.assign({}, defaults, state.profile.themeCustom || {});
    const root = document.documentElement;

    (window.REX_THEME_TOKENS || []).forEach((token) => {
      const value = values[token.key] !== undefined ? values[token.key] : token.default;
      if (token.dataset) {
        document.body.dataset[token.dataset] = String(value);
        return;
      }
      if (!token.apply) return;
      const vars = token.apply(value, values) || {};
      Object.entries(vars).forEach(([name, cssValue]) => {
        root.style.setProperty(name, cssValue);
      });
    });
  }

  /* =========================================================
   * 5. 文件夹吸入与拖出到桌面空白坐标
   * ========================================================= */
  function promoteInnerAppToBareDesktop(appId, targetX = null, targetY = null) {
    const app = state.apps.find((a) => a.id === appId);
    if (!app) return null;

    app.containerId = "desktop";
    let bareItem = state.layout.find((x) => x.kind === "app" && x.appId === appId);
    if (!bareItem) {
      const spot =
        targetX && targetY && isAreaFree(state.layout, targetX, targetY, 1, 1)
          ? { x: targetX, y: targetY }
          : findFirstFreeSpot(state.layout, 1, 1, null, targetY || 1);
      bareItem = {
        id: "bare-" + appId + "-" + Date.now(),
        kind: "app",
        appId: appId,
        x: spot.x,
        y: spot.y,
        w: 1,
        h: 1
      };
      state.layout.push(bareItem);
    }
    saveState();
    return bareItem;
  }

  function absorbAppIntoFolderAndOpen(appId, bareLayoutId, targetWidgetId) {
    const app = state.apps.find((a) => a.id === appId);
    if (!app) return;

    app.containerId = targetWidgetId;
    if (bareLayoutId) {
      state.layout = state.layout.filter((x) => x.id !== bareLayoutId);
    } else {
      state.layout = state.layout.filter((x) => !(x.kind === "app" && x.appId === appId));
    }

    recentlyDroppedAppId = app.id;
    saveState();
    renderWithFlip();
    openFolderModal(targetWidgetId);
    setTimeout(() => {
      recentlyDroppedAppId = null;
    }, 1000);
  }

  function showTrashDock(label) {
    const dock = document.getElementById("trashDock");
    const textEl = document.getElementById("trashDockText");
    if (!dock) return;
    if (textEl) textEl.textContent = label || "拖到此处即可删除";
    dock.classList.add("visible");
  }

  function hideTrashDock() {
    const dock = document.getElementById("trashDock");
    if (!dock) return;
    dock.classList.remove("visible", "drag-hover");
  }

  /* =========================================================
   * 6. 壁纸引擎与实时时钟
   * ========================================================= */
  let wallpaperAnimation = null;
  let wallpaperVideoEl = null;
  let wallpaperResizeHandler = null;

  function stopDynamicWallpaper() {
    if (wallpaperAnimation) {
      cancelAnimationFrame(wallpaperAnimation);
      wallpaperAnimation = null;
    }
    if (wallpaperResizeHandler) {
      window.removeEventListener("resize", wallpaperResizeHandler);
      wallpaperResizeHandler = null;
    }
    if (wallpaperVideoEl) {
      wallpaperVideoEl.pause();
      wallpaperVideoEl.remove();
      wallpaperVideoEl = null;
    }
    const canvas = document.getElementById("wallpaperCanvas");
    if (canvas) canvas.remove();
    const stage = document.getElementById("wallpaperStage");
    if (stage) stage.classList.remove("has-dynamic");
  }

  function prefersReducedMotion() {
    return Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function startCanvasWallpaper(sceneName, dim) {
    const stage = document.getElementById("wallpaperStage");
    if (!stage) return;

    const canvas = document.createElement("canvas");
    canvas.id = "wallpaperCanvas";
    canvas.className = "wallpaper-canvas";
    stage.appendChild(canvas);
    stage.classList.add("has-dynamic");

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    let width = 1;
    let height = 1;

    const resize = () => {
      width = Math.max(1, stage.clientWidth);
      height = Math.max(1, stage.clientHeight);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = width + "px";
      canvas.style.height = height + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    wallpaperResizeHandler = resize;
    window.addEventListener("resize", resize);

    const stars = Array.from({ length: 150 }, () => ({
      x: Math.random(),
      y: Math.random(),
      r: 0.4 + Math.random() * 1.3,
      speed: 0.004 + Math.random() * 0.012,
      phase: Math.random() * Math.PI * 2
    }));

    const started = performance.now();
    const draw = (now) => {
      wallpaperAnimation = requestAnimationFrame(draw);
      if (document.hidden) return;

      const t = (now - started) / 1000;
      const w = width;
      const h = height;

      if (sceneName === "starfield") {
        ctx.fillStyle = "#050814";
        ctx.fillRect(0, 0, w, h);

        const glow = ctx.createRadialGradient(w * 0.7, h * 0.25, 0, w * 0.7, h * 0.25, Math.max(w, h) * 0.7);
        glow.addColorStop(0, "rgba(129,140,248,0.18)");
        glow.addColorStop(1, "rgba(5,8,20,0)");
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, w, h);

        stars.forEach((star) => {
          const y = (star.y + t * star.speed) % 1;
          const alpha = 0.3 + 0.7 * Math.abs(Math.sin(t * 0.5 + star.phase));
          ctx.beginPath();
          ctx.arc(star.x * w, y * h, star.r, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(226,232,240,${alpha * 0.8})`;
          ctx.fill();
        });
      } else if (sceneName === "mesh") {
        const base = ctx.createLinearGradient(0, 0, w, h);
        base.addColorStop(0, "#1c1917");
        base.addColorStop(1, "#0c0a1a");
        ctx.fillStyle = base;
        ctx.fillRect(0, 0, w, h);

        const blobs = [
          { cx: 0.25, cy: 0.3, color: "251,191,36", phase: 0 },
          { cx: 0.75, cy: 0.65, color: "249,115,22", phase: 2.1 },
          { cx: 0.55, cy: 0.2, color: "124,45,18", phase: 4.2 }
        ];
        blobs.forEach((blob) => {
          const x = (blob.cx + Math.sin(t * 0.08 + blob.phase) * 0.08) * w;
          const y = (blob.cy + Math.cos(t * 0.06 + blob.phase) * 0.08) * h;
          const radius = Math.max(w, h) * 0.45;
          const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
          gradient.addColorStop(0, `rgba(${blob.color},0.3)`);
          gradient.addColorStop(1, `rgba(${blob.color},0)`);
          ctx.fillStyle = gradient;
          ctx.fillRect(0, 0, w, h);
        });
      } else {
        const sky = ctx.createLinearGradient(0, 0, 0, h);
        sky.addColorStop(0, "#060b1a");
        sky.addColorStop(0.55, "#0b1b33");
        sky.addColorStop(1, "#0a2f45");
        ctx.fillStyle = sky;
        ctx.fillRect(0, 0, w, h);

        for (let i = 0; i < 3; i += 1) {
          const band = ctx.createLinearGradient(0, h * (0.2 + i * 0.18), w, h * (0.5 + i * 0.18));
          band.addColorStop(0, "rgba(16,185,129,0)");
          band.addColorStop(0.45, `rgba(56,189,248,${0.12 - i * 0.025})`);
          band.addColorStop(0.7, `rgba(168,85,247,${0.14 - i * 0.025})`);
          band.addColorStop(1, "rgba(16,185,129,0)");
          ctx.fillStyle = band;
          ctx.beginPath();
          ctx.moveTo(0, h);
          for (let x = 0; x <= w; x += 14) {
            const y = h * (0.5 + i * 0.07) + Math.sin(x * 0.004 + t * (0.16 + i * 0.04)) * (26 + i * 9);
            ctx.lineTo(x, y);
          }
          ctx.lineTo(w, h);
          ctx.closePath();
          ctx.fill();
        }
      }

      if (dim > 0) {
        ctx.fillStyle = `rgba(2,6,20,${dim})`;
        ctx.fillRect(0, 0, w, h);
      }
    };

    wallpaperAnimation = requestAnimationFrame(draw);
  }

  function startVideoWallpaper(url, poster, dim) {
    const stage = document.getElementById("wallpaperStage");
    if (!stage) return;

    const video = document.createElement("video");
    video.id = "wallpaperVideo";
    video.className = "wallpaper-video";
    video.autoplay = true;
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = "auto";
    if (poster) video.poster = poster;
    video.src = url;
    if (dim > 0) video.style.filter = `brightness(${Math.max(0.4, 1 - dim)})`;
    stage.appendChild(video);
    stage.classList.add("has-dynamic");
    wallpaperVideoEl = video;
    video.play().catch(() => {});
  }

  function applyWallpaper() {
    const stage = document.getElementById("wallpaperStage");
    const photoLayer = document.getElementById("wallpaperPhoto");
    if (!stage || !photoLayer) return;

    stopDynamicWallpaper();
    stage.classList.remove("has-photo");
    photoLayer.style.backgroundImage = "none";

    if (state.profile.customWallpaperUrl) {
      stage.dataset.scene = "scene-aurora";
      photoLayer.style.backgroundImage = `linear-gradient(180deg, rgba(8,13,26,0.26), rgba(8,13,26,0.56)), url('${state.profile.customWallpaperUrl}')`;
      stage.classList.add("has-photo");
      return;
    }

    const pack = (window.REX_THEME_PACKS || []).find((item) => item.id === state.profile.themePack);
    if (pack && pack.wallpaper) {
      const wallpaper = pack.wallpaper;
      const allowDynamic = state.profile.dynamicWallpaper !== false && !prefersReducedMotion();

      if (!allowDynamic) {
        stage.dataset.scene = "scene-aurora";
        if (wallpaper.fallback) {
          photoLayer.style.backgroundImage = wallpaper.fallback;
          stage.classList.add("has-photo");
        }
        return;
      }
      if (wallpaper.type === "canvas" && wallpaper.scene) {
        startCanvasWallpaper(wallpaper.scene, Number(wallpaper.dim || 0));
        return;
      }
      if (wallpaper.type === "video" && wallpaper.value) {
        startVideoWallpaper(wallpaper.value, wallpaper.poster, Number(wallpaper.dim || 0));
        return;
      }
      if (wallpaper.type === "gradient" && wallpaper.value) {
        stage.dataset.scene = "scene-aurora";
        photoLayer.style.backgroundImage = wallpaper.value;
        stage.classList.add("has-photo");
        return;
      }
    }

    const preset =
      window.REX_WALLPAPERS.find((item) => item.id === state.profile.wallpaper) ||
      window.REX_WALLPAPERS[0];

    if (preset.type === "photo" && preset.url) {
      stage.dataset.scene = "scene-aurora";
      photoLayer.style.backgroundImage = `linear-gradient(180deg, rgba(8,13,26,0.24), rgba(8,13,26,0.5)), url('${preset.url}')`;
      stage.classList.add("has-photo");
    } else {
      stage.dataset.scene = preset.type || "scene-aurora";
    }
  }

  function updateClock() {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    const clockEl = document.getElementById("heroClock");
    if (clockEl) clockEl.textContent = `${hh}:${mm}:${ss}`;

    document.querySelectorAll(".live-widget-clock").forEach((el) => {
      el.textContent = `${hh}:${mm}`;
    });

    const weekdays = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
    const h = now.getHours();
    const greet = h < 6 ? "夜深了" : h < 12 ? "早上好" : h < 18 ? "下午好" : "晚上好";
    const subEl = document.getElementById("heroGreeting");
    if (subEl) {
      subEl.textContent = `${now.getMonth() + 1}月${now.getDate()}日 ${weekdays[now.getDay()]} · ${greet}，${state.profile.owner || "you"}`;
    }
  }

  /* =========================================================
   * 7. 应用图标构建器 (带内存 Favicon 缓存，零闪烁)
   * ========================================================= */
  function deriveCandidateLogos(app) {
    const list = [];
    if (app.useSiteLogo !== false && app.href && /^https?:\/\//i.test(app.href)) {
      if (DEMO_MODE) {
        try {
          const u = new URL(app.href);
          list.push(`${u.origin}/favicon.ico`);
          list.push(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(u.hostname)}&sz=64`);
        } catch (_) {}
      } else {
        list.push(`/api/v1/favicon?u=${encodeURIComponent(app.href)}`);
      }
    }
    if (app.logoUrl && app.logoUrl.trim()) list.push(app.logoUrl.trim());
    return list;
  }

  function getIconSvg(key) {
    const lib = window.REX_ICON_LIBRARY || {};
    return (lib[key] && lib[key].svg) || (lib.globe && lib.globe.svg) || "";
  }

  function createAppUnit(app, opts = {}) {
    const a = document.createElement("a");
    a.className = "app-unit" + (recentlyDroppedAppId === app.id ? " just-dropped" : "");
    a.href = app.href;
    a.target = "_blank";
    a.rel = "noopener";
    a.dataset.appId = app.id;
    a.dataset.itemId = app.id;
    a.dataset.flipKey = `app-${opts.contextKey || "ctx"}-${app.id}`;
    a.draggable = false;

    const bgStyle =
      app.color ||
      (window.REX_ICON_LIBRARY[app.icon] && window.REX_ICON_LIBRARY[app.icon].bg) ||
      "linear-gradient(145deg, #2563eb, #0ea5e9)";

    const cachedLogo = logoStatusCache.get(app.id);
    const hasImmediateLogo = typeof cachedLogo === "string" && cachedLogo.length > 0;

    a.innerHTML = `
      <span class="app-badge-edit" title="点击编辑此应用">✎</span>
      <span class="app-dot ${app.status || "online"}"></span>
      <div class="app-squircle ${hasImmediateLogo ? "has-real-logo" : ""}" style="background: ${bgStyle}">
        <img class="app-real-logo" ${hasImmediateLogo ? `src="${escapeHtml(cachedLogo)}"` : ""} alt="" />
        <div class="app-svg-wrap">${getIconSvg(app.icon)}</div>
      </div>
      <div class="app-label">${escapeHtml(app.name)}</div>
    `;

    a.querySelectorAll("img, svg").forEach((ch) => ch.setAttribute("draggable", "false"));

    // 如果尚未缓存过该应用的网站 Logo，则探测一次并写入缓存
    if (cachedLogo === undefined) {
      const candidates = deriveCandidateLogos(app);
      if (candidates.length === 0) {
        logoStatusCache.set(app.id, false);
      } else {
        const imgEl = a.querySelector(".app-real-logo");
        const squircleEl = a.querySelector(".app-squircle");
        let idx = 0;
        const tryNext = () => {
          if (idx >= candidates.length) {
            logoStatusCache.set(app.id, false);
            return;
          }
          imgEl.src = candidates[idx++];
        };
        imgEl.onload = () => {
          if (imgEl.naturalWidth >= 12) {
            logoStatusCache.set(app.id, imgEl.src);
            squircleEl.classList.add("has-real-logo");
          } else {
            tryNext();
          }
        };
        imgEl.onerror = tryNext;
        tryNext();
      }
    }

    a.addEventListener("click", (e) => {
      e.stopPropagation();
      if (editMode) {
        e.preventDefault();
        window.openAppModal(app.id);
        return;
      }
      app.clicks = (Number(app.clicks) || 0) + 1;
      Remote.recordClick(app.id);
      saveState();
    });

    a.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      hidePopover();
      window.openAppModal(app.id);
    });

    a.addEventListener("mouseenter", () => {
      if (!editMode && !pointerDrag) showPopover(app, a);
    });
    a.addEventListener("mouseleave", hidePopover);

    // 绑定 120fps Pointer 跟手拖拽（组件内部或文件夹内部的图标）
    if (!opts.standaloneLayoutId) {
      a.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        window.beginPointerDragCandidate(e, {
          kind: "inner-app",
          appId: app.id,
          fromWidgetId: app.containerId,
          w: 1,
          h: 1,
          title: app.name,
          sourceEl: a
        });
      });
    }

    return a;
  }

  function createMoreOverflowUnit(widgetItem, hiddenApps, totalCount) {
    const btn = document.createElement("div");
    btn.className = "app-unit";
    btn.title = `还有 ${hiddenApps.length} 个应用，点击展开全部 ${totalCount} 项`;

    const previewFour = hiddenApps.slice(0, 4);
    let dotsHtml = "";
    for (let i = 0; i < 4; i++) {
      const item = previewFour[i];
      if (item) {
        const bg = item.color || "linear-gradient(145deg, #38bdf8, #6366f1)";
        dotsHtml += `<div class="mini-preview-dot" style="background:${bg}">${getIconSvg(item.icon)}</div>`;
      } else {
        dotsHtml += `<div class="mini-preview-dot" style="background:rgba(255,255,255,0.18)"></div>`;
      }
    }

    btn.innerHTML = `
      <div class="more-folder-squircle">
        ${dotsHtml}
      </div>
      <div class="app-label">··· (${totalCount})</div>
    `;

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openFolderModal(widgetItem.id);
    });

    return btn;
  }

  /* =========================================================
   * 8. 2D 绝对坐标网格元素绑定
   * ========================================================= */
  function attachLayoutDragEvents(el, layoutItem) {
    const w = layoutItem.kind === "app" ? 1 : layoutItem.w || 4;
    const h = layoutItem.kind === "app" ? 1 : layoutItem.h || 2;
    el.style.gridColumn = `${layoutItem.x || 1} / span ${w}`;
    el.style.gridRow = `${layoutItem.y || 1} / span ${h}`;

    el.dataset.itemId = layoutItem.id;
    el.dataset.flipKey = `layout-${layoutItem.id}`;

    el.addEventListener("pointerdown", (e) => {
      if (layoutItem.kind === "widget" && e.target.closest(".app-unit")) return;
      const itemTitle =
        layoutItem.kind === "app"
          ? (state.apps.find((a) => a.id === layoutItem.appId) || {}).name || "应用"
          : (layoutItem.config && layoutItem.config.title) || "组件";

      window.beginPointerDragCandidate(e, {
        kind: "layout-item",
        layoutId: layoutItem.id,
        isBareApp: layoutItem.kind === "app",
        appId: layoutItem.kind === "app" ? layoutItem.appId : null,
        w,
        h,
        title: itemTitle,
        sourceEl: el
      });
    });
  }

  /* =========================================================
   * 9. 可复用组件工具栏 & 防重叠渲染器
   * ========================================================= */
  function buildWidgetEditControls(shellEl, widgetItem) {
    const bar = document.createElement("div");
    bar.className = "widget-edit-toolbar";
    bar.innerHTML = `
      <span style="font-size:10px;color:#fde047;font-weight:700;padding:0 3px">${widgetItem.w}×${widgetItem.h}</span>
      <button type="button" class="tiny-btn" data-w-delta="-1" title="缩小列宽">W-</button>
      <button type="button" class="tiny-btn" data-w-delta="1" title="增加列宽">W+</button>
      <button type="button" class="tiny-btn" data-h-delta="-1" title="缩小行高">H-</button>
      <button type="button" class="tiny-btn" data-h-delta="1" title="增加行高">H+</button>
      <button type="button" class="tiny-btn" data-open-wcfg style="background:var(--theme-accent);color:#0f172a;font-weight:700">⚙</button>
    `;

    bar.querySelectorAll("[data-w-delta]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const d = Number(btn.dataset.wDelta);
        const nextW = Math.max(2, Math.min(12, (widgetItem.w || 4) + d));
        widgetItem.w = nextW;
        if (widgetItem.x + widgetItem.w - 1 > GRID_COLS) {
          widgetItem.x = Math.max(1, GRID_COLS - widgetItem.w + 1);
        }
        saveState();
        renderWithFlip();
      });
    });

    bar.querySelectorAll("[data-h-delta]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const d = Number(btn.dataset.hDelta);
        widgetItem.h = Math.max(1, Math.min(4, (widgetItem.h || 2) + d));
        saveState();
        renderWithFlip();
      });
    });

    bar.querySelector("[data-open-wcfg]").addEventListener("click", (e) => {
      e.stopPropagation();
      window.openWidgetConfigModal(widgetItem.id);
    });

    shellEl.appendChild(bar);

    const corner = document.createElement("div");
    corner.className = "widget-resize-corner";
    corner.title = "按住拖拽可直接自由调整组件长宽";
    corner.textContent = "⤡";

    corner.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = widgetItem.w || 4;
      const startH = widgetItem.h || 2;
      const gridEl = shellEl.parentElement;
      const colStep = gridEl ? gridEl.clientWidth / 12 : 110;
      const rowStep = 140;

      function onMove(ev) {
        const deltaCols = Math.round((ev.clientX - startX) / colStep);
        const deltaRows = Math.round((ev.clientY - startY) / rowStep);
        const maxAllowedW = GRID_COLS - (widgetItem.x || 1) + 1;
        const nextW = Math.max(2, Math.min(maxAllowedW, startW + deltaCols));
        const nextH = Math.max(1, Math.min(4, startH + deltaRows));
        if (nextW !== widgetItem.w || nextH !== widgetItem.h) {
          widgetItem.w = nextW;
          widgetItem.h = nextH;
          saveState();
          renderWithFlip();
        }
      }

      function onUp() {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      }

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });

    shellEl.appendChild(corner);
  }

  function computeSlotGridSpec(w, h) {
    const cols = Math.max(2, Math.min(8, w >= 5 ? w - 1 : w === 4 ? 3 : 2));
    const rows = Math.max(1, h);
    return { cols, rows, capacity: cols * rows };
  }

  function getSortedAppsForContainer(containerId, sortBy = "order") {
    const list = state.apps.filter((a) => a.containerId === containerId);
    if (sortBy === "clicks") {
      return [...list].sort((a, b) => (Number(b.clicks) || 0) - (Number(a.clicks) || 0));
    }
    return list;
  }

  function renderAppContainerWidget(widgetItem) {
    const isServer = widgetItem.widgetType === "server-node";
    const cfg = widgetItem.config || {};
    const sortBy = cfg.sortBy || "order";
    const allApps = getSortedAppsForContainer(widgetItem.id, sortBy);

    const w = widgetItem.w || 4;
    const h = widgetItem.h || 2;
    const { cols, capacity } = computeSlotGridSpec(w, h);

    const shell = document.createElement("section");
    shell.className = `widget-shell w-${w} h-${h}`;
    if (isServer) {
      shell.dataset.hostId = String(widgetItem.id).replace(/^host-/, "");
      shell.dataset.hostIp = cfg.ip || "";
    }
    buildWidgetEditControls(shell, widgetItem);

    const top = document.createElement("div");
    top.className = "widget-topbar";
    top.innerHTML = `
      <div class="widget-title-area">
        <span class="live-dot"></span>
        <span class="widget-title" title="${escapeHtml(cfg.title || "")}">${escapeHtml(cfg.title || "未命名组件")}</span>
        <span class="widget-tag"${isServer ? " data-host-ping" : ""}>${escapeHtml(isServer ? `${cfg.ip || ""} · ${cfg.pingMs || 2}ms` : cfg.badge || `${allApps.length} 项`)}</span>
      </div>
      <div class="widget-actions">
        <button type="button" class="tiny-btn" data-toggle-sort title="切换按默认顺序或近 7 天热度排序">
          ${sortBy === "clicks" ? "🔥" : "⇅"}
        </button>
        <button type="button" class="tiny-btn" data-cfg-btn title="配置此组件">⚙</button>
      </div>
    `;

    top.querySelector("[data-toggle-sort]").addEventListener("click", (e) => {
      e.stopPropagation();
      cfg.sortBy = cfg.sortBy === "clicks" ? "order" : "clicks";
      saveState();
      renderWithFlip();
    });

    top.querySelector("[data-cfg-btn]").addEventListener("click", (e) => {
      e.stopPropagation();
      window.openWidgetConfigModal(widgetItem.id);
    });

    shell.appendChild(top);

    const slotGrid = document.createElement("div");
    slotGrid.className = "widget-slot-grid";
    slotGrid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;

    if (allApps.length === 0) {
      const emptyBtn = document.createElement("div");
      emptyBtn.className = "app-unit";
      emptyBtn.style.gridColumn = `span ${cols}`;
      emptyBtn.innerHTML = `
        <div class="app-squircle" style="background:rgba(255,255,255,0.12);border:1.5px dashed rgba(255,255,255,0.38)">
          <div class="app-svg-wrap"><svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg></div>
        </div>
        <div class="app-label">+ 添加或拖入应用</div>
      `;
      emptyBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        window.openAppModal(null, widgetItem.id);
      });
      slotGrid.appendChild(emptyBtn);
    } else if (allApps.length <= capacity) {
      allApps.forEach((app) => {
        slotGrid.appendChild(createAppUnit(app, { contextKey: widgetItem.id }));
      });
    } else {
      const visibleSlice = allApps.slice(0, capacity - 1);
      const hiddenSlice = allApps.slice(capacity - 1);
      visibleSlice.forEach((app) => {
        slotGrid.appendChild(createAppUnit(app, { contextKey: widgetItem.id }));
      });
      slotGrid.appendChild(createMoreOverflowUnit(widgetItem, hiddenSlice, allApps.length));
    }

    shell.appendChild(slotGrid);

    const foot = document.createElement("div");
    foot.className = "widget-foot-metrics";
    if (isServer) {
      foot.innerHTML = `
        <span data-host-role style="overflow:hidden;text-overflow:ellipsis">${escapeHtml(cfg.role || cfg.badge || "服务器节点")}</span>
        <span style="flex-shrink:0;white-space:nowrap">CPU <strong data-host-cpu>${escapeHtml(cfg.cpu || "--")}</strong> · MEM <strong data-host-mem>${escapeHtml(cfg.mem || "--")}</strong> · DISK <strong data-host-disk>${escapeHtml(cfg.disk || "--")}</strong></span>
      `;
    } else {
      foot.innerHTML = `
        <span style="overflow:hidden;text-overflow:ellipsis">${escapeHtml(cfg.subtitle || "支持拖入或拖出图标")}</span>
        <span style="flex-shrink:0">共 ${allApps.length} 项</span>
      `;
    }
    shell.appendChild(foot);

    shell.addEventListener("click", (e) => {
      if (editMode) return;
      if (e.target.closest("a.app-unit") || e.target.closest("button")) return;
      openFolderModal(widgetItem.id);
    });

    attachLayoutDragEvents(shell, widgetItem);
    return shell;
  }

  const WEATHER_TEXT = {
    0: "晴", 1: "大部晴朗", 2: "多云", 3: "阴",
    45: "雾", 48: "雾凇",
    51: "小毛雨", 53: "毛雨", 55: "强毛雨", 56: "冻毛雨", 57: "强冻毛雨",
    61: "小雨", 63: "中雨", 65: "大雨", 66: "冻雨", 67: "强冻雨",
    71: "小雪", 73: "中雪", 75: "大雪", 77: "雪粒",
    80: "阵雨", 81: "强阵雨", 82: "暴雨", 85: "阵雪", 86: "强阵雪",
    95: "雷暴", 96: "雷暴伴冰雹", 99: "强雷暴伴冰雹"
  };

  // 后端 /runtime 下发的实时天气：原始城市名 -> payload
  const runtimeWeather = new Map();

  function weatherSvg(code, size) {
    const box = `width="${size}" height="${size}" viewBox="0 0 32 32" fill="none"`;
    if (code === 0 || code === 1) {
      return `<svg ${box}><circle cx="16" cy="16" r="6.5" fill="#fde047"/><g stroke="#fde047" stroke-width="2" stroke-linecap="round"><path d="M16 3v3M16 26v3M3 16h3M26 16h3M6.8 6.8l2.1 2.1M23.1 23.1l2.1 2.1M25.2 6.8l-2.1 2.1M8.9 23.1l-2.1 2.1"/></g></svg>`;
    }
    if (code >= 95) {
      return `<svg ${box}><path d="M10 20H23C26 20 28 18 28 15.5C28 13 26 11 23.7 10.9C23 7.4 20 4.8 16.4 4.8C12.4 4.8 9.1 8 9.1 12C7.1 12.4 5.6 14.2 5.6 16.3C5.6 18.5 7.8 20 10 20Z" fill="white" fill-opacity=".9"/><path d="M16 21l-3 6h4l-2 4 6-7h-4l2-3z" fill="#facc15"/></svg>`;
    }
    if (code >= 71 && code <= 86) {
      return `<svg ${box}><path d="M10 18H23C26 18 28 16 28 13.5C28 11 26 9 23.7 8.9C23 5.4 20 2.8 16.4 2.8C12.4 2.8 9.1 6 9.1 10C7.1 10.4 5.6 12.2 5.6 14.3C5.6 16.5 7.8 18 10 18Z" fill="white" fill-opacity=".9"/><g fill="#bae6fd"><circle cx="12" cy="23" r="1.5"/><circle cx="18" cy="26" r="1.5"/><circle cx="24" cy="22" r="1.5"/></g></svg>`;
    }
    if (code >= 51) {
      return `<svg ${box}><path d="M10 17H23C26 17 28 15 28 12.5C28 10 26 8 23.7 7.9C23 4.4 20 1.8 16.4 1.8C12.4 1.8 9.1 5 9.1 9C7.1 9.4 5.6 11.2 5.6 13.3C5.6 15.5 7.8 17 10 17Z" fill="white" fill-opacity=".9"/><g stroke="#7dd3fc" stroke-width="2" stroke-linecap="round"><path d="M12 21l-1.5 4M18 21l-1.5 4M24 21l-1.5 4"/></g></svg>`;
    }
    return `<svg ${box}><circle cx="12" cy="12" r="5.5" fill="#fde047"/><path d="M10 24H23C25.5 24 27.5 22 27.5 19.5C27.5 17.2 25.7 15.3 23.5 15.1C22.9 11.6 19.9 9 16.3 9C12.3 9 9 12.2 9 16.2C7 16.6 5.5 18.4 5.5 20.5C5.5 22.5 7.7 24 10 24Z" fill="white" fill-opacity=".9"/></svg>`;
  }

  function findWeatherConfig(city) {
    for (const item of state.layout || []) {
      if (item.widgetType === "weather" && ((item.config || {}).city === city)) return item.config;
    }
    return null;
  }

  function weatherView(cfg) {
    const live = runtimeWeather.get(cfg.city);
    const temp = live && live.temp != null ? `${Math.round(live.temp)}°` : (cfg.temp || "21°");
    const code = live && live.code != null ? live.code : 2;
    const cond = live && live.code != null ? (WEATHER_TEXT[live.code] || "多云") : (cfg.condition || "多云");
    const day = live && Array.isArray(live.days) && live.days[0] ? live.days[0] : null;
    const range = day ? `${Math.round(day.max)}° / ${Math.round(day.min)}°` : (cfg.range || "24° / 15°");
    const humidity = live && live.humidity != null ? `${Math.round(live.humidity)}%` : (cfg.humidity || "60%");
    return { temp, cond, range, humidity, code, live };
  }

  function paintWeatherShell(shell, cfg) {
    const city = shell.dataset.weatherCity || "";
    const view = weatherView(cfg || { city });
    const widthClass = (shell.className.match(/w-(\d+)/) || [])[1];
    const size = Number(widthClass || 3) <= 2 ? 38 : 48;
    const mid = shell.querySelector(".wx-mid");
    const foot = shell.querySelector(".widget-foot-metrics");
    if (mid) {
      mid.innerHTML = `
        <div>
          <div class="wx-temp" style="font-size:${size <= 38 ? "32px" : "40px"};font-weight:720;line-height:1;letter-spacing:-0.04em">${escapeHtml(view.temp)}</div>
          <div class="wx-cond" style="font-size:11.5px;color:var(--text-secondary);margin-top:4px">${escapeHtml(view.cond)}</div>
        </div>
        <span class="wx-icon">${weatherSvg(view.code, size)}</span>
      `;
    }
    if (foot) {
      foot.innerHTML = `
        <span class="wx-range">${escapeHtml(view.range)}</span>
        <span class="wx-hum">湿度 ${escapeHtml(view.humidity)}</span>
      `;
    }
  }

  function renderWeatherWidget(widgetItem) {
    const cfg = widgetItem.config || {};
    const w = widgetItem.w || 3;
    const h = widgetItem.h || 2;
    const shell = document.createElement("section");
    shell.className = `widget-shell w-${w} h-${h}`;
    shell.dataset.weatherCity = cfg.city || "";
    buildWidgetEditControls(shell, widgetItem);

    const top = document.createElement("div");
    top.className = "widget-topbar";
    top.innerHTML = `
      <div class="widget-title-area">
        <span class="widget-title">${escapeHtml(cfg.title || "实时天气")}</span>
        <span class="widget-tag">${escapeHtml(cfg.city || "南京 · 鼓楼")}</span>
      </div>
      <div class="widget-actions">
        <button type="button" class="tiny-btn" data-cfg-btn>⚙</button>
      </div>
    `;
    top.querySelector("[data-cfg-btn]").addEventListener("click", (e) => {
      e.stopPropagation();
      window.openWidgetConfigModal(widgetItem.id);
    });
    shell.appendChild(top);

    const mid = document.createElement("div");
    mid.className = "wx-mid";
    mid.style.cssText = "display:flex;align-items:center;justify-content:space-between;min-height:0";
    shell.appendChild(mid);

    const foot = document.createElement("div");
    foot.className = "widget-foot-metrics";
    shell.appendChild(foot);

    paintWeatherShell(shell, cfg);
    attachLayoutDragEvents(shell, widgetItem);
    return shell;
  }

  function renderCalendarWidget(widgetItem) {
    const cfg = widgetItem.config || {};
    const w = widgetItem.w || 3;
    const h = widgetItem.h || 2;
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    const today = now.getDate();
    const firstDay = new Date(y, m, 1).getDay();
    const totalDays = new Date(y, m + 1, 0).getDate();

    let cells = ["日", "一", "二", "三", "四", "五", "六"].map((d) => `<div class="cal-head">${d}</div>`).join("");
    for (let i = 0; i < firstDay; i++) cells += `<div class="cal-num dim">·</div>`;
    for (let d = 1; d <= totalDays; d++) {
      cells += `<div class="cal-num ${d === today ? "today" : ""}">${d}</div>`;
    }

    const shell = document.createElement("section");
    shell.className = `widget-shell w-${w} h-${h}`;
    buildWidgetEditControls(shell, widgetItem);

    const top = document.createElement("div");
    top.className = "widget-topbar";
    top.innerHTML = `
      <div class="widget-title-area">
        <span class="widget-title">${escapeHtml(cfg.title || `${y}年 ${m + 1}月`)}</span>
        <span class="widget-tag">${today}日</span>
      </div>
      <div class="widget-actions">
        <button type="button" class="tiny-btn" data-cfg-btn>⚙</button>
      </div>
    `;
    top.querySelector("[data-cfg-btn]").addEventListener("click", (e) => {
      e.stopPropagation();
      window.openWidgetConfigModal(widgetItem.id);
    });
    shell.appendChild(top);

    const grid = document.createElement("div");
    grid.className = "cal-grid";
    grid.innerHTML = cells;
    shell.appendChild(grid);

    const foot = document.createElement("div");
    foot.className = "widget-foot-metrics";
    foot.innerHTML = `<span>农历与节气同步</span><span>第 ${Math.ceil((today + firstDay) / 7)} 周</span>`;
    shell.appendChild(foot);

    attachLayoutDragEvents(shell, widgetItem);
    return shell;
  }

  function renderNotesWidget(widgetItem) {
    const cfg = widgetItem.config || {};
    const w = widgetItem.w || 3;
    const h = widgetItem.h || 2;
    const shell = document.createElement("section");
    shell.className = `widget-shell w-${w} h-${h}`;
    buildWidgetEditControls(shell, widgetItem);

    const top = document.createElement("div");
    top.className = "widget-topbar";
    top.innerHTML = `
      <div class="widget-title-area">
        <span class="widget-title">${escapeHtml(cfg.title || "随手便签")}</span>
        <span class="widget-tag">${escapeHtml(cfg.badge || "实时保存")}</span>
      </div>
      <div class="widget-actions">
        <button type="button" class="tiny-btn" data-cfg-btn>⚙</button>
      </div>
    `;
    top.querySelector("[data-cfg-btn]").addEventListener("click", (e) => {
      e.stopPropagation();
      window.openWidgetConfigModal(widgetItem.id);
    });
    shell.appendChild(top);

    const area = document.createElement("textarea");
    area.className = "notes-textarea";
    area.value = cfg.text || "";
    area.placeholder = "在此输入备忘内容...";
    area.addEventListener("input", () => {
      cfg.text = area.value;
      saveState();
    });
    shell.appendChild(area);

    const foot = document.createElement("div");
    foot.className = "widget-foot-metrics";
    foot.innerHTML = `<span>自动持久化至 YAML</span><span>备忘录</span>`;
    shell.appendChild(foot);

    attachLayoutDragEvents(shell, widgetItem);
    return shell;
  }

  function renderClockMetricWidget(widgetItem) {
    const cfg = widgetItem.config || {};
    const w = widgetItem.w || 3;
    const h = widgetItem.h || 1;
    const shell = document.createElement("section");
    shell.className = `widget-shell w-${w} h-${h}`;
    buildWidgetEditControls(shell, widgetItem);

    const top = document.createElement("div");
    top.className = "widget-topbar";
    top.innerHTML = `
      <div class="widget-title-area">
        <span class="live-dot"></span>
        <span class="widget-title">${escapeHtml(cfg.title || "系统脉冲")}</span>
      </div>
      <div class="widget-actions">
        <button type="button" class="tiny-btn" data-cfg-btn>⚙</button>
      </div>
    `;
    top.querySelector("[data-cfg-btn]").addEventListener("click", (e) => {
      e.stopPropagation();
      window.openWidgetConfigModal(widgetItem.id);
    });
    shell.appendChild(top);

    const mid = document.createElement("div");
    mid.style.cssText = "display:flex;align-items:baseline;justify-content:space-between;align-self:center";
    mid.innerHTML = `
      <div class="live-widget-clock" style="font-size:26px;font-weight:720;font-variant-numeric:tabular-nums">--:--</div>
      <div style="font-size:11px;color:var(--text-secondary)">${escapeHtml(cfg.subtitle || cfg.badge || "在线")}</div>
    `;
    shell.appendChild(mid);

    const foot = document.createElement("div");
    foot.className = "widget-foot-metrics";
    shell.appendChild(foot);

    attachLayoutDragEvents(shell, widgetItem);
    return shell;
  }

  function renderBareAppItem(layoutItem) {
    const app = state.apps.find((a) => a.id === layoutItem.appId);
    if (!app) return null;

    const wrap = document.createElement("div");
    wrap.className = "bare-desktop-app";
    const unit = createAppUnit(app, {
      contextKey: `bare-${layoutItem.id}`,
      standaloneLayoutId: layoutItem.id
    });
    wrap.appendChild(unit);
    attachLayoutDragEvents(wrap, layoutItem);
    return wrap;
  }

  function applyProfileChrome() {
    const title = (state.profile && state.profile.title) || "Studiolo";
    const brand = document.querySelector(".brand-name");
    if (brand) brand.textContent = title;
    if (document.title !== title) document.title = title;
    if (DEMO_MODE) {
      const meta = document.querySelector(".brand-meta");
      if (meta) meta.textContent = "在线示例 · 数据为演示";
    }
  }

  /* =========================================================
   * 10. 桌面主工作区渲染 (精简 DOM 树，移除 48 个冗余占位节点)
   * ========================================================= */
  function renderWorkspace() {
    applyProfileChrome();
    const ws = document.getElementById("workspace");
    const dock = document.getElementById("stageDock");
    if (!ws) return;
    ws.innerHTML = "";
    document.body.classList.toggle("edit-mode", editMode);

    const grid = document.createElement("div");
    grid.className = "atomic-grid";

    // 单个轻量落点光影指示器（替代原本 48 个 grid-cell-guide DOM 节点）
    const slotInd = document.createElement("div");
    slotInd.id = "gridSlotIndicator";
    slotInd.className = "grid-slot-indicator";
    grid.appendChild(slotInd);

    state.layout.forEach((item) => {
      let el = null;
      if (item.kind === "app") {
        el = renderBareAppItem(item);
      } else if (item.kind === "widget") {
        if (item.widgetType === "server-node" || item.widgetType === "app-folder") {
          el = renderAppContainerWidget(item);
        } else if (item.widgetType === "weather") {
          el = renderWeatherWidget(item);
        } else if (item.widgetType === "calendar") {
          el = renderCalendarWidget(item);
        } else if (item.widgetType === "notes") {
          el = renderNotesWidget(item);
        } else if (item.widgetType === "clock-metric") {
          el = renderClockMetricWidget(item);
        }
      }
      if (el) grid.appendChild(el);
    });

    ws.appendChild(grid);
    renderDock(dock);
    updateClock();
  }

  function renderDock(dock) {
    if (!dock) return;
    dock.innerHTML = "";
    if (state.profile.dockEnabled === false) {
      dock.hidden = true;
      document.body.classList.remove("dock-on");
      return;
    }
    let apps = state.apps.filter((a) => a.pinned);
    if (!apps.length) {
      apps = state.apps
        .slice()
        .sort((a, b) => (Number(b.clicks) || 0) - (Number(a.clicks) || 0));
    }
    apps = apps.slice(0, 10);
    if (!apps.length) {
      dock.hidden = true;
      document.body.classList.remove("dock-on");
      return;
    }
    apps.forEach((app) => dock.appendChild(createAppUnit(app, { contextKey: "dock" })));
    dock.hidden = false;
    document.body.classList.add("dock-on");
  }

  /* =========================================================
   * 11. 文件夹放大面板：仅点击遮罩空白处关闭
   * ========================================================= */
  function openFolderModal(widgetId) {
    openedFolderWidgetId = widgetId;
    const backdrop = document.getElementById("folderBackdrop");
    renderFolderModalContent(widgetId);
    backdrop.classList.add("open");
  }

  function closeFolderModal() {
    openedFolderWidgetId = null;
    const backdrop = document.getElementById("folderBackdrop");
    if (backdrop) backdrop.classList.remove("open");
  }

  function initFolderAutoClose() {
    // 文件夹弹窗只响应遮罩点击，鼠标移出不再自动收起
  }

  function renderFolderModalContent(widgetId) {
    const widgetItem = state.layout.find((x) => x.id === widgetId);
    if (!widgetItem) return;
    const cfg = widgetItem.config || {};
    const sortBy = cfg.sortBy || "order";
    const apps = getSortedAppsForContainer(widgetId, sortBy);

    document.getElementById("folderModalTitle").textContent = cfg.title || "应用文件夹";
    document.getElementById("folderModalMeta").textContent =
      widgetItem.widgetType === "server-node"
        ? `${cfg.role || ""} · 组网 ${cfg.ip || ""} · 局域网 ${cfg.lanIp || ""} · 共 ${apps.length} 个应用`
        : `${cfg.subtitle || "应用集合"} · 共 ${apps.length} 个图标`;

    const sortBtn = document.getElementById("folderSortBtn");
    sortBtn.textContent = sortBy === "clicks" ? "🔥 当前：按近 7 天热度排序" : "⇅ 当前：按默认顺序排列";
    sortBtn.onclick = () => {
      cfg.sortBy = cfg.sortBy === "clicks" ? "order" : "clicks";
      saveState();
      renderFolderModalContent(widgetId);
      renderWithFlip();
    };

    document.getElementById("folderConfigWidgetBtn").onclick = () => {
      closeFolderModal();
      window.openWidgetConfigModal(widgetId);
    };

    document.getElementById("folderAddAppBtn").onclick = () => {
      window.openAppModal(null, widgetId);
    };

    const grid = document.getElementById("folderExpandedGrid");
    grid.innerHTML = "";
    apps.forEach((app) => {
      grid.appendChild(createAppUnit(app, { contextKey: `folder-${widgetId}` }));
    });
  }

  /* =========================================================
   * 12. 🎨 主题工坊弹窗 (Theme Studio Modal)
   * ========================================================= */
  function initThemeStudioModal() {
    const groupsHost = document.getElementById("themeTokenGroups");
    if (!groupsHost) return;

    const GROUP_LABELS = {
      surface: "表面与材质",
      icon: "图标与 Logo",
      color: "颜色与文字",
      type: "字体与排版"
    };

    function currentTokens() {
      return Object.assign(
        {},
        window.REX_THEME_PRESETS["vision-glass"].config,
        state.profile.themeCustom || {}
      );
    }

    function buildControl(token, value) {
      const field = document.createElement("div");
      field.className = "form-field";

      if (token.type === "toggle") {
        field.classList.add("theme-toggle-field");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = value !== false;
        input.addEventListener("change", () => updateToken(token, input.checked));
        const label = document.createElement("label");
        label.textContent = token.label;
        field.appendChild(input);
        field.appendChild(label);
        return field;
      }

      const label = document.createElement("label");
      label.textContent = token.label;

      if (token.type === "range") {
        const valueEl = document.createElement("span");
        valueEl.className = "theme-range-value";
        valueEl.textContent = value;
        label.appendChild(valueEl);
      }

      field.appendChild(label);

      let input;
      if (token.type === "select") {
        input = document.createElement("select");
        token.options.forEach((opt) => {
          const option = document.createElement("option");
          option.value = opt.value;
          option.textContent = opt.label;
          input.appendChild(option);
        });
        input.value = value;
      } else if (token.type === "color") {
        input = document.createElement("input");
        input.type = "color";
        input.className = "theme-color-input";
        input.value = value;
      } else if (token.type === "range") {
        input = document.createElement("input");
        input.type = "range";
        input.min = token.min;
        input.max = token.max;
        input.step = token.step;
        input.value = value;
        const valueEl = label.querySelector(".theme-range-value");
        input.addEventListener("input", () => {
          if (valueEl) valueEl.textContent = input.value;
        });
      } else {
        input = document.createElement("input");
        input.type = "text";
        input.value = value;
      }

      const eventName = token.type === "select" || token.type === "color" ? "change" : "input";
      input.addEventListener(eventName, () => {
        updateToken(token, token.type === "range" ? Number(input.value) : input.value);
      });
      field.appendChild(input);
      return field;
    }

    function updateToken(token, value) {
      state.profile.themeCustom = Object.assign({}, currentTokens(), { [token.key]: value });
      state.profile.themePreset = "custom";
      saveState();
      applyTheme();
    }

    function renderTokenEditor() {
      const values = currentTokens();
      const groups = {};
      (window.REX_THEME_TOKENS || []).forEach((token) => {
        const group = token.group || "other";
        if (!groups[group]) groups[group] = [];
        groups[group].push(token);
      });

      groupsHost.innerHTML = "";
      Object.keys(groups).forEach((group) => {
        const section = document.createElement("section");
        section.className = "theme-group";

        const title = document.createElement("div");
        title.className = "theme-group-title";
        title.textContent = GROUP_LABELS[group] || group;
        section.appendChild(title);

        const grid = document.createElement("div");
        grid.className = "form-grid";
        groups[group].forEach((token) => {
          grid.appendChild(buildControl(token, values[token.key] ?? token.default));
        });
        section.appendChild(grid);
        groupsHost.appendChild(section);
      });
    }

    function themeToYaml(tokens) {
      const lines = ["# Studiolo 主题", "id: custom", 'name: "我的主题"', "tokens:"];
      (window.REX_THEME_TOKENS || []).forEach((token) => {
        if (tokens[token.key] === undefined) return;
        lines.push(`  ${token.key}: ${JSON.stringify(tokens[token.key])}`);
      });
      return lines.join("\n") + "\n";
    }

    function parseTheme(text) {
      const trimmed = text.trim();
      if (trimmed.startsWith("{")) {
        const data = JSON.parse(trimmed);
        return data.tokens || data;
      }
      const tokens = {};
      let inTokens = false;
      text.split(/\r?\n/).forEach((raw) => {
        const line = raw.replace(/\s+$/, "");
        if (!line.trim() || line.trim().startsWith("#")) return;
        if (/^tokens\s*:/.test(line)) {
          inTokens = true;
          return;
        }
        if (!inTokens) return;
        const match = line.match(/^\s+([A-Za-z0-9_]+)\s*:\s*(.*)$/);
        if (match) tokens[match[1]] = parseScalar(match[2]);
      });
      return tokens;
    }

    function applyThemeTokens(tokens) {
      const known = {};
      (window.REX_THEME_TOKENS || []).forEach((token) => {
        if (tokens[token.key] !== undefined) known[token.key] = tokens[token.key];
      });
      if (!Object.keys(known).length) throw new Error("没有可识别的主题参数");

      state.profile.themeCustom = Object.assign({}, currentTokens(), known);
      state.profile.themePreset = "custom";
      saveState();
      applyTheme();
      renderTokenEditor();
    }

    window.openThemeStudio = function () {
      renderTokenEditor();
    };

    function applyThemePack(pack) {
      state.profile.themePack = pack.id;
      state.profile.themePreset = "custom";
      state.profile.themeCustom = Object.assign({}, state.profile.themeCustom || {}, pack.tokens || {});
      state.profile.customWallpaperUrl = "";
      saveState();
      applyTheme();
      applyWallpaper();
      if (window.openThemeStudio) window.openThemeStudio();
      if (window.renderThemeStore) window.renderThemeStore();
    }

    function renderThemeStore() {
      const host = document.getElementById("themeStoreGrid");
      if (!host) return;
      host.innerHTML = "";

      (window.REX_THEME_PACKS || []).forEach((pack) => {
        const active = state.profile.themePack === pack.id;
        const preview =
          (pack.wallpaper && (pack.wallpaper.fallback || pack.wallpaper.value)) ||
          "linear-gradient(135deg, #1e293b, #0f172a)";
        const card = document.createElement("div");
        card.className = `theme-store-card ${active ? "active" : ""}`;
        card.innerHTML = `
          <div class="theme-store-preview" style="background:${preview}">
            <span class="theme-store-badge">${escapeHtml(pack.badge || "")}</span>
          </div>
          <div class="theme-store-meta">
            <strong>${escapeHtml(pack.name)}</strong>
            <span>${escapeHtml(pack.author || "")}</span>
          </div>
          <div class="theme-store-desc">${escapeHtml(pack.desc || "")}</div>
          <button type="button" class="glass-btn theme-store-apply">${active ? "✓ 当前使用" : "应用主题"}</button>
        `;
        card.querySelector(".theme-store-apply").addEventListener("click", (event) => {
          event.stopPropagation();
          applyThemePack(pack);
        });
        host.appendChild(card);
      });
    }

    window.renderThemeStore = renderThemeStore;
    window.applyThemePack = applyThemePack;

    document.getElementById("exportThemeBtn").addEventListener("click", () => {
      const content = themeToYaml(currentTokens());
      const blob = new Blob([content], { type: "text/yaml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "studiolo-theme.yaml";
      a.click();
      URL.revokeObjectURL(url);
    });

    const importFile = document.getElementById("importThemeFile");
    document.getElementById("importThemeBtn").addEventListener("click", () => importFile.click());
    importFile.addEventListener("change", (event) => {
      const file = event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          applyThemeTokens(parseTheme(String(reader.result)));
        } catch (err) {
          alert("导入主题失败：" + err.message);
        }
        importFile.value = "";
      };
      reader.readAsText(file);
    });

    document.getElementById("resetThemeBtn").addEventListener("click", () => {
      const preset = window.REX_THEME_PRESETS["vision-glass"];
      state.profile.themePreset = preset.id;
      state.profile.themePack = "";
      state.profile.themeCustom = JSON.parse(JSON.stringify(preset.config));
      saveState();
      applyTheme();
      applyWallpaper();
      renderTokenEditor();
    });
  }

  /* =========================================================
   * 13. 组件配置器弹窗 & 新增组件商店
   * ========================================================= */
  function initWidgetModals() {
    const cfgBackdrop = document.getElementById("widgetConfigBackdrop");
    const storeBackdrop = document.getElementById("widgetStoreBackdrop");

    window.openWidgetConfigModal = function (widgetId) {
      const item = state.layout.find((x) => x.id === widgetId && x.kind === "widget");
      if (!item) return;
      editingWidgetId = widgetId;
      const cfg = item.config || {};
      const blueprint = window.REX_WIDGET_CATALOG[item.widgetType] || {};

      document.getElementById("wcfgModalTitle").textContent = `配置组件 · ${blueprint.name || item.widgetType}`;
      document.getElementById("wcfgTitleInput").value = cfg.title || "";
      document.getElementById("wcfgBadgeInput").value = cfg.badge || "";
      document.getElementById("wcfgWidthSelect").value = String(item.w || 4);
      document.getElementById("wcfgHeightSelect").value = String(item.h || 2);

      const dynamicBox = document.getElementById("wcfgDynamicFields");
      if (item.widgetType === "server-node") {
        dynamicBox.innerHTML = `
          <div class="form-field">
            <label>组网 / 公网 IP</label>
            <input type="text" id="wcfgIp" value="${escapeHtml(cfg.ip || "")}" />
          </div>
          <div class="form-field">
            <label>局域网 LAN IP</label>
            <input type="text" id="wcfgLanIp" value="${escapeHtml(cfg.lanIp || "")}" />
          </div>
          <div class="form-field form-full">
            <label>主机角色说明</label>
            <input type="text" id="wcfgRole" value="${escapeHtml(cfg.role || "")}" />
          </div>
          <div class="form-field">
            <label>CPU / 内存显示</label>
            <div style="display:flex;gap:8px">
              <input type="text" id="wcfgCpu" value="${escapeHtml(cfg.cpu || "15%")}" placeholder="CPU" />
              <input type="text" id="wcfgMem" value="${escapeHtml(cfg.mem || "40%")}" placeholder="MEM" />
            </div>
          </div>
          <div class="form-field">
            <label>图标默认排序策略</label>
            <select id="wcfgSortBy">
              <option value="order" ${cfg.sortBy !== "clicks" ? "selected" : ""}>⇅ 按默认顺序展示前几项</option>
              <option value="clicks" ${cfg.sortBy === "clicks" ? "selected" : ""}>🔥 按近 7 天热度排序</option>
            </select>
          </div>
        `;
      } else if (item.widgetType === "app-folder") {
        dynamicBox.innerHTML = `
          <div class="form-field form-full">
            <label>文件夹底部副标题描述</label>
            <input type="text" id="wcfgSubtitle" value="${escapeHtml(cfg.subtitle || "")}" />
          </div>
          <div class="form-field form-full">
            <label>图标默认排序策略</label>
            <select id="wcfgSortBy">
              <option value="order" ${cfg.sortBy !== "clicks" ? "selected" : ""}>⇅ 按默认顺序展示前几项</option>
              <option value="clicks" ${cfg.sortBy === "clicks" ? "selected" : ""}>🔥 按近 7 天热度排序</option>
            </select>
          </div>
        `;
      } else if (item.widgetType === "weather") {
        dynamicBox.innerHTML = `
          <div class="form-field">
            <label>城市 / 地区名称</label>
            <input type="text" id="wcfgCity" value="${escapeHtml(cfg.city || "南京 · 鼓楼")}" />
          </div>
          <div class="form-field">
            <label>当前温度</label>
            <input type="text" id="wcfgTemp" value="${escapeHtml(cfg.temp || "21°")}" />
          </div>
          <div class="form-field">
            <label>天气状况</label>
            <input type="text" id="wcfgCond" value="${escapeHtml(cfg.condition || "晴间多云")}" />
          </div>
          <div class="form-field">
            <label>最高 / 最低温</label>
            <input type="text" id="wcfgRange" value="${escapeHtml(cfg.range || "最高 24° · 最低 15°")}" />
          </div>
        `;
      } else if (item.widgetType === "notes") {
        dynamicBox.innerHTML = `
          <div class="form-field form-full">
            <label>便签内容</label>
            <textarea id="wcfgNoteText" style="min-height:110px">${escapeHtml(cfg.text || "")}</textarea>
          </div>
        `;
      } else {
        dynamicBox.innerHTML = `
          <div class="form-field form-full">
            <label>附加说明文字</label>
            <input type="text" id="wcfgSubtitle" value="${escapeHtml(cfg.subtitle || "")}" />
          </div>
        `;
      }

      cfgBackdrop.hidden = false;
    };

    document.getElementById("closeWcfgModalBtn").addEventListener("click", () => (cfgBackdrop.hidden = true));
    cfgBackdrop.addEventListener("click", (e) => {
      if (e.target === cfgBackdrop) cfgBackdrop.hidden = true;
    });

    document.getElementById("saveWcfgBtn").addEventListener("click", () => {
      const item = state.layout.find((x) => x.id === editingWidgetId);
      if (!item) return;
      item.w = Number(document.getElementById("wcfgWidthSelect").value) || 4;
      item.h = Number(document.getElementById("wcfgHeightSelect").value) || 2;
      if (item.x + item.w - 1 > GRID_COLS) {
        item.x = Math.max(1, GRID_COLS - item.w + 1);
      }
      item.config = item.config || {};
      item.config.title = document.getElementById("wcfgTitleInput").value.trim() || "未命名组件";
      item.config.badge = document.getElementById("wcfgBadgeInput").value.trim();

      const getVal = (id) => {
        const el = document.getElementById(id);
        return el ? el.value.trim() : undefined;
      };

      if (item.widgetType === "server-node") {
        item.config.ip = getVal("wcfgIp");
        item.config.lanIp = getVal("wcfgLanIp");
        item.config.role = getVal("wcfgRole");
        item.config.cpu = getVal("wcfgCpu");
        item.config.mem = getVal("wcfgMem");
        item.config.sortBy = getVal("wcfgSortBy") || "order";
      } else if (item.widgetType === "app-folder") {
        item.config.subtitle = getVal("wcfgSubtitle");
        item.config.sortBy = getVal("wcfgSortBy") || "order";
      } else if (item.widgetType === "weather") {
        item.config.city = getVal("wcfgCity");
        item.config.temp = getVal("wcfgTemp");
        item.config.condition = getVal("wcfgCond");
        item.config.range = getVal("wcfgRange");
      } else if (item.widgetType === "notes") {
        item.config.text = getVal("wcfgNoteText");
      } else {
        item.config.subtitle = getVal("wcfgSubtitle");
      }

      saveState();
      renderWithFlip();
      cfgBackdrop.hidden = true;
    });

    document.getElementById("deleteWidgetBtn").addEventListener("click", () => {
      if (!editingWidgetId) return;
      state.layout = state.layout.filter((x) => x.id !== editingWidgetId);
      saveState();
      renderWithFlip();
      cfgBackdrop.hidden = true;
    });

    const catalogGrid = document.getElementById("widgetCatalogGrid");
    Object.entries(window.REX_WIDGET_CATALOG).forEach(([typeKey, meta]) => {
      const card = document.createElement("div");
      card.className = "catalog-card";
      card.innerHTML = `
        <div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <strong style="font-size:14.5px">${escapeHtml(meta.name)}</strong>
            <span class="widget-tag">${escapeHtml(meta.badge)} (${meta.defaultW}×${meta.defaultH})</span>
          </div>
          <div style="font-size:12px;color:var(--text-secondary);line-height:1.45">${escapeHtml(meta.desc)}</div>
        </div>
        <button type="button" class="glass-btn" style="align-self:flex-start;padding:6px 14px;font-size:12px">+ 添加此组件到桌面</button>
      `;
      card.querySelector("button").addEventListener("click", () => {
        const newId = `${typeKey}-${Date.now()}`;
        const spot = findFirstFreeSpot(state.layout, meta.defaultW, meta.defaultH, null, 1);
        const newWidget = {
          id: newId,
          kind: "widget",
          widgetType: typeKey,
          x: spot.x,
          y: spot.y,
          w: meta.defaultW,
          h: meta.defaultH,
          config: JSON.parse(JSON.stringify(meta.defaultConfig))
        };
        state.layout.push(newWidget);
        saveState();
        renderWithFlip();
        storeBackdrop.hidden = true;
        window.openWidgetConfigModal(newId);
      });
      catalogGrid.appendChild(card);
    });

    window.openWidgetStoreModal = () => (storeBackdrop.hidden = false);
    document.getElementById("bannerAddWidgetBtn").addEventListener("click", window.openWidgetStoreModal);
    document.getElementById("closeWidgetStoreBtn").addEventListener("click", () => (storeBackdrop.hidden = true));
    storeBackdrop.addEventListener("click", (e) => {
      if (e.target === storeBackdrop) storeBackdrop.hidden = true;
    });
  }

  /* =========================================================
   * 14. 应用图标编辑器弹窗
   * ========================================================= */
  function refreshContainerSelectOptions() {
    const sel = document.getElementById("appContainerSelect");
    if (!sel) return;
    const currentVal = sel.value;
    const containers = state.layout.filter(
      (x) => x.kind === "widget" && (x.widgetType === "server-node" || x.widgetType === "app-folder")
    );
    sel.innerHTML =
      `<option value="desktop">🌟 仅作为桌面 1×1 独立图标</option>` +
      containers
        .map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.config.title || c.id)}</option>`)
        .join("");
    if (currentVal) sel.value = currentVal;
  }

  function initAppModal() {
    const backdrop = document.getElementById("appModalBackdrop");
    const picker = document.getElementById("iconPickerGrid");
    const colorInput = document.getElementById("appColorInput");
    let selectedIcon = "globe";

    Object.entries(window.REX_ICON_LIBRARY).forEach(([key, val]) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "icon-pick-btn";
      btn.dataset.iconKey = key;
      btn.innerHTML = `${val.svg}<span>${val.label}</span>`;
      btn.addEventListener("click", () => {
        selectedIcon = key;
        picker.querySelectorAll(".icon-pick-btn").forEach((b) =>
          b.classList.toggle("selected", b.dataset.iconKey === key)
        );
        colorInput.value = val.bg;
      });
      picker.appendChild(btn);
    });

    window.openAppModal = function (appId, defaultContainerId = "folder-bookmarks") {
      refreshContainerSelectOptions();
      editingAppId = appId;
      const app = state.apps.find((a) => a.id === appId);
      document.getElementById("appModalTitle").textContent = app ? `定制应用 · ${app.name}` : "新增应用或网站图标";
      document.getElementById("appNameInput").value = app ? app.name : "";
      document.getElementById("appDescInput").value = app ? app.desc : "";
      document.getElementById("appHrefInput").value = app ? app.href : "https://";
      document.getElementById("appLogoUrlInput").value = app ? app.logoUrl || "" : "";
      document.getElementById("appUseSiteLogoCheck").checked = app ? app.useSiteLogo !== false : true;
      document.getElementById("appContainerSelect").value = app ? app.containerId || "desktop" : defaultContainerId;
      document.getElementById("appStatusSelect").value = app ? app.status || "online" : "online";
      document.getElementById("appPortInput").value = app ? app.port || "" : "443";
      document.getElementById("appNoteInput").value = app ? app.note || "" : "";
      document.getElementById("appPinnedCheck").checked = app ? Boolean(app.pinned) : false;

      const isOnDesktopBare = app && state.layout.some((x) => x.kind === "app" && x.appId === app.id);
      document.getElementById("appStandaloneCheck").checked = Boolean(isOnDesktopBare);

      selectedIcon = app ? app.icon : "globe";
      colorInput.value =
        (app && app.color) ||
        (window.REX_ICON_LIBRARY[selectedIcon] && window.REX_ICON_LIBRARY[selectedIcon].bg) ||
        "linear-gradient(145deg, #2563eb 0%, #38bdf8 100%)";

      picker.querySelectorAll(".icon-pick-btn").forEach((b) =>
        b.classList.toggle("selected", b.dataset.iconKey === selectedIcon)
      );

      document.getElementById("deleteAppBtn").style.visibility = app ? "visible" : "hidden";
      backdrop.hidden = false;
    };

    document.getElementById("closeAppModalBtn").addEventListener("click", () => (backdrop.hidden = true));
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) backdrop.hidden = true;
    });

    document.getElementById("saveAppBtn").addEventListener("click", () => {
      const name = document.getElementById("appNameInput").value.trim() || "未命名应用";
      const desc = document.getElementById("appDescInput").value.trim();
      const href = document.getElementById("appHrefInput").value.trim() || "#";
      const logoUrl = document.getElementById("appLogoUrlInput").value.trim();
      const useSiteLogo = document.getElementById("appUseSiteLogoCheck").checked;
      const containerId = document.getElementById("appContainerSelect").value;
      const status = document.getElementById("appStatusSelect").value;
      const port = document.getElementById("appPortInput").value.trim();
      const note = document.getElementById("appNoteInput").value.trim();
      const color = colorInput.value.trim();
      const pinned = document.getElementById("appPinnedCheck").checked;
      const wantBareDesktop = document.getElementById("appStandaloneCheck").checked || containerId === "desktop";

      let targetId = editingAppId;
      if (editingAppId) {
        logoStatusCache.delete(editingAppId);
        const target = state.apps.find((a) => a.id === editingAppId);
        if (target) {
          Object.assign(target, {
            name,
            desc,
            href,
            logoUrl,
            useSiteLogo,
            containerId,
            status,
            port,
            note,
            icon: selectedIcon,
            color,
            pinned
          });
        }
      } else {
        targetId = "app-" + Date.now();
        state.apps.push({
          id: targetId,
          name,
          desc,
          href,
          logoUrl,
          useSiteLogo,
          containerId,
          icon: selectedIcon,
          color,
          status,
          latency: 12,
          port,
          note,
          pinned,
          clicks: 1
        });
      }

      const bareIdx = state.layout.findIndex((x) => x.kind === "app" && x.appId === targetId);
      if (wantBareDesktop && bareIdx === -1) {
        const spot = findFirstFreeSpot(state.layout, 1, 1, null, 1);
        state.layout.push({
          id: "bare-" + Date.now(),
          kind: "app",
          appId: targetId,
          x: spot.x,
          y: spot.y,
          w: 1,
          h: 1
        });
      } else if (!wantBareDesktop && bareIdx !== -1) {
        state.layout.splice(bareIdx, 1);
      }

      saveState();
      renderWithFlip();
      if (openedFolderWidgetId) renderFolderModalContent(openedFolderWidgetId);
      backdrop.hidden = true;
    });

    document.getElementById("deleteAppBtn").addEventListener("click", () => {
      if (!editingAppId) return;
      state.apps = state.apps.filter((a) => a.id !== editingAppId);
      state.layout = state.layout.filter((x) => !(x.kind === "app" && x.appId === editingAppId));
      saveState();
      renderWithFlip();
      if (openedFolderWidgetId) renderFolderModalContent(openedFolderWidgetId);
      backdrop.hidden = true;
    });
  }

  /* =========================================================
   * 15. 悬停透视卡片 (Hover Popover) & Omni-Bar 搜索
   * ========================================================= */
  function showPopover(app, anchorEl) {
    const pop = document.getElementById("appPopover");
    if (!pop) return;

    const containerWidget = state.layout.find((x) => x.id === app.containerId);
    const containerTitle = containerWidget && containerWidget.config ? containerWidget.config.title : "桌面独立应用";
    const statusLabel =
      app.status === "lan"
        ? `仅内网 · ${app.latency || 2}ms`
        : app.status === "offline"
        ? "离线"
        : `在线 · ${app.latency || 12}ms`;

    pop.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <strong style="font-size:14.5px">${escapeHtml(app.name)}</strong>
        <span class="widget-tag">${statusLabel}</span>
      </div>
      <div style="font-size:11.5px;color:#7dd3fc;font-family:ui-monospace,monospace;word-break:break-all;margin-bottom:8px">
        ${escapeHtml(app.href)}
      </div>
      <div style="display:flex;justify-content:space-between;font-size:11.5px;color:var(--text-secondary);padding:7px 0;border-top:1px solid rgba(255,255,255,0.14);border-bottom:1px solid rgba(255,255,255,0.14)">
        <span>所属位置: <strong>${escapeHtml(containerTitle.split("·")[0].trim())}</strong></span>
        <span>热度: <strong>🔥 ${app.clicks || 0} 次</strong></span>
      </div>
      <div style="margin-top:8px;font-size:12px;color:rgba(255,255,255,0.9);line-height:1.45">
        ${escapeHtml(app.note || app.desc || "支持自由放置在任意 (x, y) 网格坐标，或拖到底部回收站删除。")}
      </div>
    `;

    const rect = anchorEl.getBoundingClientRect();
    const w = 295;
    let left = rect.left + rect.width / 2 - w / 2;
    left = Math.max(14, Math.min(window.innerWidth - w - 14, left));
    let top = rect.bottom + 10;
    if (top + 180 > window.innerHeight) top = rect.top - 170;

    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    pop.classList.add("visible");
  }

  function hidePopover() {
    const pop = document.getElementById("appPopover");
    if (pop) pop.classList.remove("visible");
  }

  function initOmniSearch() {
    const input = document.getElementById("omniInput");
    const drop = document.getElementById("omniDropdown");
    const engineBtn = document.getElementById("engineCycleBtn");

    function refreshEngine() {
      const eng = SEARCH_ENGINES[state.profile.searchEngine] || SEARCH_ENGINES.google;
      engineBtn.textContent = `${eng.name} ▾`;
    }
    refreshEngine();

    engineBtn.addEventListener("click", () => {
      const keys = Object.keys(SEARCH_ENGINES);
      state.profile.searchEngine = keys[(keys.indexOf(state.profile.searchEngine) + 1) % keys.length];
      saveState();
      refreshEngine();
      input.focus();
    });

    input.addEventListener("input", () => {
      const q = input.value.trim().toLowerCase();
      if (!q) {
        drop.hidden = true;
        return;
      }
      const matches = state.apps.filter((a) =>
        `${a.name} ${a.desc} ${a.href} ${a.note || ""}`.toLowerCase().includes(q)
      );
      const eng = SEARCH_ENGINES[state.profile.searchEngine] || SEARCH_ENGINES.google;
      let html = "";

      matches.slice(0, 7).forEach((app, i) => {
        html += `
          <a class="omni-row ${i === 0 ? "active" : ""}" href="${escapeHtml(app.href)}" target="_blank" rel="noopener">
            <div style="display:flex;align-items:center;gap:10px">
              <div style="width:32px;height:32px;border-radius:10px;background:${app.color || "#2563eb"};display:grid;place-items:center">
                <div style="width:18px;height:18px">${getIconSvg(app.icon)}</div>
              </div>
              <div>
                <div style="font-size:13.5px;font-weight:600">${escapeHtml(app.name)}</div>
                <div style="font-size:11.5px;color:var(--text-secondary)">${escapeHtml(app.desc || app.href)}</div>
              </div>
            </div>
            <span class="widget-tag">打开应用 ↵</span>
          </a>
        `;
      });

      const webHref = eng.url + encodeURIComponent(input.value.trim());
      html += `
        <a class="omni-row ${matches.length === 0 ? "active" : ""}" href="${webHref}" target="_blank" rel="noopener">
          <div style="display:flex;align-items:center;gap:10px">
            <div style="width:32px;height:32px;border-radius:10px;background:rgba(255,255,255,0.18);display:grid;place-items:center">
              <div style="width:18px;height:18px">${getIconSvg("globe")}</div>
            </div>
            <div>
              <div style="font-size:13.5px;font-weight:600">使用 ${eng.name} 搜索 “${escapeHtml(input.value.trim())}”</div>
              <div style="font-size:11.5px;color:var(--text-secondary)">跳转到外部网页搜索结果</div>
            </div>
          </div>
          <span class="widget-tag">全网搜索 ↵</span>
        </a>
      `;

      drop.innerHTML = html;
      drop.hidden = false;
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        input.value = "";
        drop.hidden = true;
      } else if (e.key === "Enter") {
        const first = drop.querySelector(".omni-row.active") || drop.querySelector(".omni-row");
        if (first && !drop.hidden) {
          e.preventDefault();
          window.open(first.href, "_blank", "noopener");
          drop.hidden = true;
        }
      }
    });

    document.addEventListener("click", (e) => {
      if (!e.target.closest(".omni-container")) drop.hidden = true;
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
        e.preventDefault();
        input.focus();
      }
    });
  }

  /* =========================================================
   * 16. YAML 导出 / 导入中心
   * ========================================================= */
  function escYaml(val) {
    if (val === null || val === undefined) return '""';
    const s = String(val);
    if (s === "" || /[:#\n"'{}\[\],&*!|>%@`]/.test(s) || /^\s|\s$/.test(s)) {
      return JSON.stringify(s);
    }
    return s;
  }

  function stateToYaml(st) {
    const lines = [];
    lines.push("# Studiolo 桌面 2D 坐标与主题配置文件");
    lines.push(`version: ${escYaml(st.version || "5.0")}`);
    lines.push("profile:");
    for (const [k, v] of Object.entries(st.profile || {})) {
      if (k === "themeCustom") {
        lines.push(`  themeCustomJson: ${JSON.stringify(JSON.stringify(v || {}))}`);
      } else {
        lines.push(`  ${k}: ${escYaml(v)}`);
      }
    }
    lines.push("layout:");
    for (const item of st.layout || []) {
      lines.push(`  - id: ${escYaml(item.id)}`);
      lines.push(`    kind: ${escYaml(item.kind)}`);
      lines.push(`    x: ${Number(item.x) || 1}`);
      lines.push(`    y: ${Number(item.y) || 1}`);
      lines.push(`    w: ${Number(item.kind === "app" ? 1 : item.w || 4)}`);
      lines.push(`    h: ${Number(item.kind === "app" ? 1 : item.h || 2)}`);
      if (item.kind === "app") {
        lines.push(`    appId: ${escYaml(item.appId)}`);
      } else {
        lines.push(`    widgetType: ${escYaml(item.widgetType)}`);
        lines.push(`    configJson: ${JSON.stringify(JSON.stringify(item.config || {}))}`);
      }
    }
    lines.push("apps:");
    for (const a of st.apps || []) {
      lines.push(`  - id: ${escYaml(a.id)}`);
      lines.push(`    name: ${escYaml(a.name)}`);
      lines.push(`    desc: ${escYaml(a.desc)}`);
      lines.push(`    href: ${escYaml(a.href)}`);
      lines.push(`    containerId: ${escYaml(a.containerId)}`);
      lines.push(`    icon: ${escYaml(a.icon)}`);
      lines.push(`    logoUrl: ${escYaml(a.logoUrl || "")}`);
      lines.push(`    useSiteLogo: ${a.useSiteLogo !== false}`);
      lines.push(`    color: ${escYaml(a.color)}`);
      lines.push(`    status: ${escYaml(a.status)}`);
      lines.push(`    port: ${escYaml(a.port || "")}`);
      lines.push(`    note: ${escYaml(a.note || "")}`);
      lines.push(`    pinned: ${Boolean(a.pinned)}`);
      lines.push(`    clicks: ${Number(a.clicks) || 0}`);
    }
    return lines.join("\n") + "\n";
  }

  function parseScalar(raw) {
    const t = raw.trim();
    if (!t) return "";
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      try {
        if (t.startsWith('"')) return JSON.parse(t);
        return t.slice(1, -1);
      } catch (_) {
        return t.slice(1, -1);
      }
    }
    if (t === "true") return true;
    if (t === "false") return false;
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    return t;
  }

  function yamlToState(yamlText) {
    const trimmed = yamlText.trim();
    if (trimmed.startsWith("{")) return JSON.parse(trimmed);

    const next = cloneDefault();
    next.layout = [];
    next.apps = [];
    let section = null;
    let curr = null;

    for (const rawLine of yamlText.split(/\r?\n/)) {
      const line = rawLine.replace(/\s+$/, "");
      if (!line.trim() || line.trim().startsWith("#")) continue;

      if (/^version\s*:/.test(line)) {
        next.version = String(parseScalar(line.split(":").slice(1).join(":")));
        continue;
      }
      if (/^profile\s*:/.test(line)) {
        section = "profile";
        curr = null;
        continue;
      }
      if (/^layout\s*:/.test(line)) {
        section = "layout";
        curr = null;
        continue;
      }
      if (/^apps\s*:/.test(line)) {
        section = "apps";
        curr = null;
        continue;
      }

      if (section === "profile") {
        const m = line.match(/^\s+([a-zA-Z0-9_]+)\s*:\s*(.*)$/);
        if (m) {
          const k = m[1];
          const v = parseScalar(m[2]);
          if (k === "themeCustomJson") {
            try {
              next.profile.themeCustom = JSON.parse(String(v));
            } catch (_) {}
          } else {
            next.profile[k] = v;
          }
        }
      } else if (section === "layout" || section === "apps") {
        const itemStart = line.match(/^\s*-\s+([a-zA-Z0-9_]+)\s*:\s*(.*)$/);
        if (itemStart) {
          curr = {};
          curr[itemStart[1]] = parseScalar(itemStart[2]);
          next[section].push(curr);
          continue;
        }
        const prop = line.match(/^\s+([a-zA-Z0-9_]+)\s*:\s*(.*)$/);
        if (prop && curr) {
          const k = prop[1];
          const v = parseScalar(prop[2]);
          if (k === "configJson") {
            try {
              curr.config = JSON.parse(String(v));
            } catch (_) {
              curr.config = {};
            }
          } else {
            curr[k] = v;
          }
        }
      }
    }

    if (!next.apps.length) throw new Error("YAML 中未解析到有效的 apps 列表");
    if (!next.layout.length) next.layout = cloneDefault().layout;
    normalizeLayoutCoordinates(next.layout);
    return next;
  }

  function initConfigModal() {
    const wpGrid = document.getElementById("wpPickerGrid");
    const customUrlInput = document.getElementById("customWpUrlInput");
    const yamlBox = document.getElementById("yamlTextarea");
    const statusMsg = document.getElementById("yamlStatusMsg");

    function renderSwatches() {
      wpGrid.innerHTML = "";
      window.REX_WALLPAPERS.forEach((wp) => {
        const d = document.createElement("div");
        d.className = `wp-swatch ${state.profile.wallpaper === wp.id && !state.profile.customWallpaperUrl ? "active" : ""}`;
        d.style.background = wp.preview;
        d.textContent = wp.name;
        d.addEventListener("click", () => {
          state.profile.wallpaper = wp.id;
          state.profile.customWallpaperUrl = "";
          state.profile.themePack = "";
          customUrlInput.value = "";
          saveState();
          applyWallpaper();
          renderSwatches();
          yamlBox.value = stateToYaml(state);
        });
        wpGrid.appendChild(d);
      });
    }

    window.openConfigModal = function () {
      renderSwatches();
      customUrlInput.value = state.profile.customWallpaperUrl || "";
      yamlBox.value = stateToYaml(state);
      statusMsg.textContent = "";
    };

    document.getElementById("applyCustomWpBtn").addEventListener("click", () => {
      state.profile.customWallpaperUrl = customUrlInput.value.trim();
      saveState();
      applyWallpaper();
      renderSwatches();
      yamlBox.value = stateToYaml(state);
    });

    document.getElementById("downloadYamlBtn").addEventListener("click", () => {
      const content = stateToYaml(state);
      yamlBox.value = content;
      const blob = new Blob([content], { type: "text/yaml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "rex-cloudos-v5.yaml";
      a.click();
      URL.revokeObjectURL(url);
      statusMsg.textContent = "已导出 rex-cloudos-v5.yaml";
    });

    document.getElementById("applyYamlBtn").addEventListener("click", () => {
      try {
        state = yamlToState(yamlBox.value);
        saveState();
        applyWallpaper();
        applyTheme();
        renderWithFlip();
        statusMsg.style.color = "#34d399";
        statusMsg.textContent = "YAML 配置已成功加载！";
      } catch (err) {
        statusMsg.style.color = "#fb7185";
        statusMsg.textContent = "解析失败: " + err.message;
      }
    });

    const fileInput = document.getElementById("uploadYamlFile");
    document.getElementById("uploadYamlBtn").addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        yamlBox.value = r.result;
        document.getElementById("applyYamlBtn").click();
      };
      r.readAsText(f);
    });

    document.getElementById("resetDefaultBtn").addEventListener("click", () => {
      state = cloneDefault();
      saveState();
      applyWallpaper();
      applyTheme();
      renderWithFlip();
      yamlBox.value = stateToYaml(state);
      statusMsg.style.color = "#38bdf8";
      statusMsg.textContent = "已恢复默认桌面与主题配置";
    });
  }

  /* =========================================================
   * 18. 统一设置面板
   * ========================================================= */
  function initSettingsPanel() {
    const backdrop = document.getElementById("settingsBackdrop");
    if (!backdrop) return;
    const tabs = Array.from(document.querySelectorAll("[data-settings-tab]"));
    const panels = Array.from(document.querySelectorAll("[data-settings-panel]"));

    const TAB_META = {
      desktop: ["桌面", "名称、Dock 与显示行为"],
      appearance: ["外观", "主题、字体、壁纸与显示效果"],
      data: ["数据", "YAML 备份、导入与重置"]
    };

    function selectTab(name) {
      tabs.forEach((btn) => btn.classList.toggle("active", btn.dataset.settingsTab === name));
      panels.forEach((panel) => {
        panel.hidden = panel.dataset.settingsPanel !== name;
      });
      const body = backdrop.querySelector(".settings-body");
      if (body) body.scrollTop = 0;

      const meta = TAB_META[name] || TAB_META.desktop;
      const titleEl = document.getElementById("settingsTitle");
      const subEl = document.getElementById("settingsSub");
      if (titleEl) titleEl.textContent = meta[0];
      if (subEl) subEl.textContent = meta[1];

      if (name === "appearance") {
        if (window.openThemeStudio) window.openThemeStudio();
        if (window.renderThemeStore) window.renderThemeStore();
      }
    }

    window.openSettings = function (tab) {
      const titleInput = document.getElementById("desktopTitleInput");
      if (titleInput) titleInput.value = state.profile.title || "Studiolo";
      const dockToggle = document.getElementById("dockEnabledToggle");
      if (dockToggle) dockToggle.checked = state.profile.dockEnabled !== false;
      const dynamicToggle = document.getElementById("dynamicWallpaperToggle");
      if (dynamicToggle) dynamicToggle.checked = state.profile.dynamicWallpaper !== false;
      if (window.openConfigModal) window.openConfigModal();
      selectTab(tab || "desktop");
      backdrop.hidden = false;
    };

    window.closeSettings = function () {
      backdrop.hidden = true;
    };

    document.getElementById("openSettingsBtn").addEventListener("click", () => window.openSettings("desktop"));
    document.getElementById("closeSettingsBtn").addEventListener("click", window.closeSettings);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) window.closeSettings();
    });

    tabs.forEach((btn) => {
      btn.addEventListener("click", () => selectTab(btn.dataset.settingsTab));
    });

    const titleInput = document.getElementById("desktopTitleInput");
    if (titleInput) {
      titleInput.addEventListener("input", () => {
        state.profile.title = titleInput.value.trim() || "Studiolo";
        applyProfileChrome();
        saveState();
      });
    }

    const dockToggle = document.getElementById("dockEnabledToggle");
    if (dockToggle) {
      dockToggle.addEventListener("change", () => {
        state.profile.dockEnabled = dockToggle.checked;
        saveState();
        renderWorkspace();
      });
    }

    const dynamicToggle = document.getElementById("dynamicWallpaperToggle");
    if (dynamicToggle) {
      dynamicToggle.addEventListener("change", () => {
        state.profile.dynamicWallpaper = dynamicToggle.checked;
        saveState();
        applyWallpaper();
      });
    }
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* =========================================================
   * 17. 启动入口 (进出编辑模式零 DOM 重建！)
   * ========================================================= */
  document.addEventListener("DOMContentLoaded", () => {
    applyWallpaper();
    applyTheme();
    updateClock();
    setInterval(updateClock, 1000);

    const editBtn = document.getElementById("toggleEditModeBtn");
    const editBanner = document.getElementById("editBanner");
    function setEdit(flag) {
      if (editMode === flag) return;
      editMode = flag;
      // 关键性能优化：进出编辑模式仅切换 body class，不销毁重建任何 DOM 节点！
      document.body.classList.toggle("edit-mode", editMode);
      editBtn.classList.toggle("active-edit", editMode);
      editBtn.textContent = editMode ? "✓ 完成编辑" : "✦ 编辑桌面";
      editBanner.hidden = !editMode;
      hidePopover();
    }

    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setEdit(!editMode);
    });
    document.getElementById("exitEditBannerBtn").addEventListener("click", () => setEdit(false));
    document.getElementById("bannerAddAppBtn").addEventListener("click", () => window.openAppModal(null, "folder-bookmarks"));
    document.getElementById("bannerYamlBtn").addEventListener("click", () => window.openSettings("data"));

    // 点击桌面任意空白区域自动退出编辑模式
    document.addEventListener("click", (e) => {
      if (!editMode) return;
      if (
        e.target.closest(".widget-shell") ||
        e.target.closest(".app-unit") ||
        e.target.closest(".topbar") ||
        e.target.closest(".edit-drawer") ||
        e.target.closest(".omni-container") ||
        e.target.closest(".modal-panel") ||
        e.target.closest(".folder-expanded-card")
      ) {
        return;
      }
      setEdit(false);
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (openedFolderWidgetId) closeFolderModal();
        else if (editMode) setEdit(false);
      }
    });

    const folderBackdrop = document.getElementById("folderBackdrop");
    document.getElementById("closeFolderModalBtn").addEventListener("click", closeFolderModal);
    folderBackdrop.addEventListener("click", (e) => {
      if (e.target === folderBackdrop) closeFolderModal();
    });

    initGlobalPointerDragEngine();
    initFolderAutoClose();
    initOmniSearch();
    initThemeStudioModal();
    initWidgetModals();
    initAppModal();
    initConfigModal();
    initSettingsPanel();
    renderWorkspace();
    Remote.init();
  });
})();
