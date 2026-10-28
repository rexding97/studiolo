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
  const MOBILE_GRID_COLS = 4;
  const mobileLayoutQuery = window.matchMedia("(max-width: 720px)");
  const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  const modalStack = [];
  let workspaceRenderFrame = null;
  let gridSyncFrame = null;

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
  const logoProbeCache = new Map();
  let logoCacheGeneration = 0;
  // 正在运行的 FLIP 动画句柄缓存：flipKey -> Animation
  const activeFlipAnimations = new Map();
  const hostTrendCache = new Map();
  const calendarEventCache = new Map();
  let remoteWidgetSignature = "";

  let state = loadState();
  normalizeLayoutCoordinates(state.layout);
  normalizeMobileLayout(state.layout);

  let editMode = false;
  let editingAppId = null;
  let editingWidgetId = null;
  let openedFolderWidgetId = null;
  let recentlyDroppedAppId = null;
  let suppressNextClick = false;
  let applyingRemote = false;
  let localSaveTimer = null;
  let lastHistoryState = StudioloCore.clone(state);
  let toastTimer = null;
  const undoStack = [];
  const redoStack = [];
  const HISTORY_LIMIT = 50;

  function cloneDefault() {
    return StudioloCore.clone(window.REX_DEFAULT_STATE);
  }

  function migrateProfile(target) {
    const profile = target.profile || (target.profile = {});
    const title = String(profile.title || "").trim();
    if (!title || /^REX\b/i.test(title)) profile.title = "Studiolo";
    if (typeof profile.dockEnabled !== "boolean") profile.dockEnabled = true;
    profile.layoutMode = "bento";
    if (!profile.themeCustom || typeof profile.themeCustom !== "object" || Array.isArray(profile.themeCustom)) {
      profile.themePreset = "vision-glass";
      profile.themeCustom = StudioloCore.clone(window.REX_THEME_PRESETS["vision-glass"].config);
    }
    return target;
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return migrateProfile(StudioloCore.normalizeState(cloneDefault(), { repair: true }));
      return migrateProfile(StudioloCore.normalizeState(JSON.parse(raw), { repair: true }));
    } catch (_) {
      return migrateProfile(StudioloCore.normalizeState(cloneDefault(), { repair: true }));
    }
  }

  function syncActiveWorkspace(target) {
    if (!target || !Array.isArray(target.workspaces) || !target.workspaces.length) return target;
    const activeId = target.profile.activeWorkspaceId || target.workspaces[0].id;
    const active = target.workspaces.find((workspace) => workspace.id === activeId) || target.workspaces[0];
    target.profile.activeWorkspaceId = active.id;
    active.layout = target.layout;
    active.apps = target.apps;
    return target;
  }

  function recordHistory() {
    const serialized = JSON.stringify(state);
    if (serialized === JSON.stringify(lastHistoryState)) return;
    undoStack.push(StudioloCore.clone(lastHistoryState));
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack.length = 0;
    lastHistoryState = StudioloCore.clone(state);
  }

  function saveState(options) {
    const opts = options || {};
    syncActiveWorkspace(state);
    if (opts.history !== false && !applyingRemote) recordHistory();
    else lastHistoryState = StudioloCore.clone(state);
    if (localSaveTimer) clearTimeout(localSaveTimer);
    localSaveTimer = setTimeout(writeLocalState, 120);
    if (applyingRemote || opts.remote === false) return;
    try {
      Remote.schedulePush(state);
    } catch (_) {}
  }

  function writeLocalState() {
    if (localSaveTimer) clearTimeout(localSaveTimer);
    localSaveTimer = null;
    syncActiveWorkspace(state);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (_) {}
  }

  function applyStatePresentation() {
    applyWallpaper();
    applyTheme();
    applyProfileChrome();
    renderWithFlip();
  }

  function replaceState(nextState, options) {
    const opts = options || {};
    const candidate = StudioloCore.normalizeState(StudioloCore.clone(nextState), { repair: opts.repair === true });
    state = migrateProfile(candidate);
    normalizeLayoutCoordinates(state.layout);
    normalizeMobileLayout(state.layout);
    if (opts.clearHistory) {
      undoStack.length = 0;
      redoStack.length = 0;
    }
    saveState({ history: opts.history !== false, remote: opts.remote !== false });
    applyStatePresentation();
    return state;
  }

  function commitState(mutator, options) {
    const draft = StudioloCore.clone(state);
    const result = typeof mutator === "function" ? mutator(draft) || draft : mutator;
    return replaceState(result, options);
  }

  function undo() {
    if (!undoStack.length) return false;
    redoStack.push(StudioloCore.clone(state));
    const previous = undoStack.pop();
    replaceState(previous, { history: false });
    lastHistoryState = StudioloCore.clone(state);
    return true;
  }

  function redo() {
    if (!redoStack.length) return false;
    undoStack.push(StudioloCore.clone(state));
    const next = redoStack.pop();
    replaceState(next, { history: false });
    lastHistoryState = StudioloCore.clone(state);
    return true;
  }

  function showToast(message, showUndo) {
    const host = document.getElementById("globalToast");
    if (!host) return;
    if (toastTimer) clearTimeout(toastTimer);
    host.textContent = message;
    host.style.cssText = "position:fixed;z-index:10000;left:50%;bottom:28px;transform:translateX(-50%);display:flex;align-items:center;gap:14px;padding:12px 18px;border:1px solid rgba(255,255,255,.25);border-radius:14px;background:rgba(15,23,42,.94);color:#fff;box-shadow:0 12px 40px rgba(0,0,0,.35);font-size:13px";
    if (showUndo) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "撤销";
      button.style.cssText = "border:0;background:transparent;color:#7dd3fc;font-weight:700;cursor:pointer;padding:4px";
      button.addEventListener("click", () => {
        undo();
        host.hidden = true;
        host.style.display = "none";
      });
      host.appendChild(button);
    }
    host.hidden = false;
    toastTimer = setTimeout(() => {
      host.hidden = true;
      host.style.display = "none";
    }, 8000);
  }

  window.addEventListener("pagehide", writeLocalState);

  function associateFormLabels(container) {
    if (!container) return;
    container.querySelectorAll("label").forEach((label) => {
      const control = label.parentElement.querySelector("input, select, textarea");
      if (!control || label.contains(control)) return;
      associateFormLabels.sequence = (associateFormLabels.sequence || 0) + 1;
      if (!control.id) control.id = `form-control-${associateFormLabels.sequence}`;
      label.htmlFor = control.id;
    });
  }

  function modalFocusable(container) {
    return Array.from(container.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter((element) => !element.closest("[hidden]") && element.getAttribute("aria-hidden") !== "true");
  }

  function applyModalInert() {
    const active = modalStack.length ? modalStack[modalStack.length - 1].element : null;
    Array.from(document.body.children).forEach((element) => {
      if (element.tagName === "SCRIPT") return;
      if (element === active) {
        element.inert = false;
        if (element.hasAttribute("data-modal-previous-aria")) {
          const previous = element.getAttribute("data-modal-previous-aria");
          if (previous) element.setAttribute("aria-hidden", previous);
          else element.removeAttribute("aria-hidden");
          element.removeAttribute("data-modal-previous-aria");
        }
        return;
      }
      if (active) {
        if (!element.hasAttribute("data-modal-previous-aria")) {
          element.setAttribute("data-modal-previous-aria", element.getAttribute("aria-hidden") || "");
        }
        element.inert = true;
        element.setAttribute("aria-hidden", "true");
      } else {
        element.inert = false;
        if (element.hasAttribute("data-modal-previous-aria")) {
          const previous = element.getAttribute("data-modal-previous-aria");
          if (previous) element.setAttribute("aria-hidden", previous);
          else element.removeAttribute("aria-hidden");
          element.removeAttribute("data-modal-previous-aria");
        }
      }
    });
  }

  function openModal(element, options = {}) {
    if (!element) return;
    const existing = modalStack.findIndex((entry) => entry.element === element);
    if (existing >= 0) modalStack.splice(existing, 1);
    const entry = { element, options, previousFocus: document.activeElement };
    modalStack.push(entry);
    element.hidden = false;
    element.inert = false;
    if (!element.hasAttribute("role")) element.setAttribute("role", "dialog");
    element.setAttribute("aria-modal", "true");
    element.removeAttribute("aria-hidden");
    applyModalInert();
    requestAnimationFrame(() => {
      if (modalStack[modalStack.length - 1] !== entry) return;
      const target = options.initialFocus || modalFocusable(element)[0] || element;
      if (!target.hasAttribute("tabindex") && target === element) target.tabIndex = -1;
      target.focus({ preventScroll: true });
    });
  }

  function closeModal(element, restoreFocus = true) {
    const index = modalStack.findIndex((entry) => entry.element === element);
    if (index < 0) {
      if (element) element.hidden = true;
      return;
    }
    const [entry] = modalStack.splice(index, 1);
    element.hidden = true;
    element.classList.remove("open");
    if (typeof entry.options.onClose === "function") entry.options.onClose();
    applyModalInert();
    if (restoreFocus) {
      const target = entry.previousFocus && entry.previousFocus.isConnected
        ? entry.previousFocus
        : document.getElementById("toggleEditModeBtn");
      if (target && target.isConnected && !target.inert) target.focus({ preventScroll: true });
    }
  }

  document.addEventListener("keydown", (event) => {
    if (!modalStack.length) return;
    const entry = modalStack[modalStack.length - 1];
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (entry.options.closable === false) return;
      if (typeof entry.options.onEscape === "function") entry.options.onEscape();
      else closeModal(entry.element);
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = modalFocusable(entry.element);
    if (!focusable.length) {
      event.preventDefault();
      entry.element.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    } else if (!entry.element.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
    }
  }, true);

  /* =========================================================
   * 0. 远端同步层：登录、state 拉取/推送、runtime 轮询
   * ========================================================= */
  const Remote = (() => {
    let authed = false;
    let runtimeTimer = null;
    let lastRuntimeSignature = "";
    let overlayBound = false;
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

    function showConflict(context) {
      return new Promise((resolve) => {
        const host = document.getElementById("conflictDialog");
        if (!host) return resolve("defer");
        host.innerHTML = "";
        host.style.cssText = "position:fixed;inset:0;z-index:10001;display:grid;place-items:center;padding:20px;background:rgba(2,6,23,.72)";
        const panel = document.createElement("div");
        panel.style.cssText = "width:min(620px,100%);max-height:85vh;overflow:auto;padding:24px;border:1px solid rgba(255,255,255,.2);border-radius:18px;background:#111c31;color:#fff;box-shadow:0 24px 80px rgba(0,0,0,.5)";
        const title = document.createElement("h3");
        title.textContent = "检测到同步冲突";
        const description = document.createElement("p");
        description.textContent = `远端版本为 rev ${context.rev}。本地修改尚未被覆盖，请选择如何处理。`;
        const details = document.createElement("pre");
        details.style.cssText = "white-space:pre-wrap;word-break:break-word;max-height:260px;overflow:auto;padding:12px;border-radius:10px;background:rgba(0,0,0,.25);font-size:11px";
        details.textContent = `本地快照：\n${JSON.stringify(context.latestLocalState, null, 2)}\n\n远端快照：\n${JSON.stringify(context.remoteState, null, 2)}`;
        const actions = document.createElement("div");
        actions.style.cssText = "display:flex;gap:10px;flex-wrap:wrap;margin-top:16px";
        panel.append(title, description, details, actions);
        host.appendChild(panel);
        openModal(host, { onEscape: () => finish("defer") });

        function finish(action) {
          closeModal(host);
          host.style.display = "none";
          host.innerHTML = "";
          resolve(action);
        }
        function addButton(label, action, primary) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = label;
          button.style.cssText = `padding:9px 13px;border:1px solid rgba(255,255,255,.25);border-radius:10px;background:${primary ? "#0284c7" : "rgba(255,255,255,.1)"};color:#fff;cursor:pointer`;
          button.addEventListener("click", async () => {
            if (action !== "snapshots") return finish(action);
            button.disabled = true;
            const result = await request("/api/v1/state/snapshots?limit=20");
            const snapshots = result.body && Array.isArray(result.body.snapshots) ? result.body.snapshots : [];
            details.textContent = snapshots.length
              ? snapshots.map((item) => `rev ${item.rev} · ${item.createdAt || "未知时间"}`).join("\n")
              : "没有可查看的远端快照。";
            button.disabled = false;
          });
          actions.appendChild(button);
        }
        addButton("保留本地并覆盖远端", "local", true);
        addButton("载入远端", "remote");
        addButton("查看远端快照", "snapshots");
        addButton("稍后决定", "defer");
      });
    }

    const sync = StudioloRemote.createSync({
      request,
      storage: localStorage,
      storageKey: STORAGE_KEY + "_outbox",
      debounceMs: 700,
      getState: () => StudioloCore.clone(state),
      onStatus: setSync,
      onAuthRequired: () => {
        authed = false;
        show("登录已过期，请重新登录");
      },
      onFirstSync: () => {
        clearLogoCaches();
        renderWorkspace();
      },
      onConflict: showConflict,
      onApplyRemote: (remoteState) => {
        applyingRemote = true;
        try {
          replaceState(remoteState, { repair: true, history: false, remote: false, clearHistory: true });
          writeLocalState();
        } catch (error) {
          setSync("offline", "远端配置无效，未应用");
          console.error("[remote] invalid state", error);
        } finally {
          applyingRemote = false;
        }
      }
    });

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
            sync.setAuthenticated(true);
            setSync("saving");
            clearLogoCaches();
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
      openModal(el, { closable: false, initialFocus: document.getElementById("authPassword") });
      const hint = document.getElementById("authHint");
      if (message && hint) hint.textContent = message;
    }

    function hide() {
      const el = document.getElementById("authOverlay");
      if (el) closeModal(el);
    }

    function schedulePush(snapshot, delay) {
      if (DEMO_MODE) return;
      sync.enqueue(snapshot, delay);
    }

    function pullState() {
      if (DEMO_MODE) return Promise.resolve({ skipped: true });
      sync.setAuthenticated(authed);
      return sync.pull();
    }

    async function checkRemoteState() {
      if (!authed || !sync.canPull()) return;
      const { res, body } = await request("/api/v1/state/meta");
      if (!res.ok || !body) return;
      if (body.rev > sync.getRevision()) await pullState();
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
        if (pingEl && typeof metric.pingMs === "number") pingEl.textContent = `${ip} · ${Math.round(metric.pingMs)}ms`;
        if (cpuEl && typeof metric.cpu === "number") cpuEl.textContent = `${metric.cpu.toFixed(1)}%`;
        if (memEl && typeof metric.mem === "number") memEl.textContent = `${metric.mem.toFixed(1)}%`;
        if (diskEl && typeof metric.disk === "number") diskEl.textContent = `${metric.disk.toFixed(1)}%`;
        if (roleEl && metric.error) roleEl.textContent = `连接失败 · ${metric.error}`;
        const timestamp = Date.parse(metric.ts || "");
        const age = Number.isFinite(timestamp) ? Math.max(0, Date.now() - timestamp) : Infinity;
        const stale = Boolean(metric.error) || age > 120000;
        const sampleEl = shell.querySelector("[data-host-sample]");
        if (sampleEl) {
          const time = Number.isFinite(timestamp) ? new Date(timestamp).toLocaleTimeString("zh-CN", { hour12: false }) : "未知时间";
          sampleEl.textContent = metric.error ? `离线 · ${metric.error}` : stale ? `陈旧采样 · ${time}` : `最近采样 · ${time}`;
        }
        shell.classList.toggle("host-offline", Boolean(metric.error));
        shell.classList.toggle("host-stale", stale);
        loadHostTrend(shell.dataset.hostId);
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
        if (item.kind !== "widget") return;
        const definition = StudioloWidgets.get(item.widgetType);
        if (!definition || definition.runtime !== "server-metrics") return;
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
      (state.layout || []).forEach((item) => {
        const definition = item.kind === "widget" && StudioloWidgets.get(item.widgetType);
        if (definition && definition.runtime === "calendar") loadCalendarEvents(item);
      });
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
          mac: { cpu: wobble(12, 6), mem: wobble(38, 2), disk: 61.5, uptime: 1036800, pingMs: 1, ts: new Date().toISOString() },
          office: { cpu: wobble(23, 10), mem: wobble(58, 2), disk: 42.0, uptime: 3196800, pingMs: 4, ts: new Date().toISOString() },
          fnas: { cpu: wobble(4, 3), mem: wobble(22, 1), disk: 55.3, uptime: 2764800, pingMs: 3, ts: new Date().toISOString() },
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
      clearLogoCaches();
      renderWorkspace();
      await pullState();
      startRuntime();
    }

    window.addEventListener("online", async () => {
      setSync("saving");
      if (authed) {
        sync.setAuthenticated(true);
        await sync.reconnect();
        refreshRuntime();
      } else {
        init();
      }
    });

    window.addEventListener("offline", () => setSync("offline"));

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && authed) refreshRuntime();
    });

    return {
      init,
      schedulePush,
      recordClick,
      pullState,
      flush: sync.flush,
      hasPending: sync.hasPending,
      getRevision: sync.getRevision,
      getGeneration: sync.getGeneration,
      acceptRemote: sync.acceptRemote,
      isReady: () => authed && !DEMO_MODE,
      request
    };
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

  function isMobileLayout() {
    return mobileLayoutQuery.matches;
  }

  function getLayoutRect(item, useMobile = isMobileLayout()) {
    const source = useMobile && item.mobile ? item.mobile : item;
    const columns = useMobile ? MOBILE_GRID_COLS : GRID_COLS;
    const fallbackW = item.kind === "app" ? 1 : Math.min(columns, Number(item.w) || 4);
    const fallbackH = item.kind === "app" ? 1 : Number(item.h) || 2;
    return {
      x: Math.max(1, Math.min(columns, Math.round(Number(source.x) || 1))),
      y: Math.max(1, Math.round(Number(source.y) || 1)),
      w: item.kind === "app" ? 1 : Math.max(1, Math.min(columns, Math.round(Number(source.w) || fallbackW))),
      h: item.kind === "app" ? 1 : Math.max(1, Math.min(100, Math.round(Number(source.h) || fallbackH)))
    };
  }

  function setLayoutRect(item, rect, useMobile = isMobileLayout()) {
    const columns = useMobile ? MOBILE_GRID_COLS : GRID_COLS;
    const normalized = {
      x: Math.max(1, Math.min(columns - rect.w + 1, Math.round(rect.x))),
      y: Math.max(1, Math.round(rect.y)),
      w: item.kind === "app" ? 1 : Math.max(1, Math.min(columns, Math.round(rect.w))),
      h: item.kind === "app" ? 1 : Math.max(1, Math.min(100, Math.round(rect.h)))
    };
    normalized.x = Math.max(1, Math.min(columns - normalized.w + 1, normalized.x));
    if (useMobile) item.mobile = normalized;
    else Object.assign(item, normalized);
  }

  function isAreaFree(layoutList, x, y, w, h, ignoreId = null, useMobile = isMobileLayout()) {
    const columns = useMobile ? MOBILE_GRID_COLS : GRID_COLS;
    if (x < 1 || y < 1 || x + w - 1 > columns) return false;
    const testRect = { x, y, w, h };
    return !layoutList.some((item) => item.id !== ignoreId && rectsOverlap(testRect, getLayoutRect(item, useMobile)));
  }

  function findFirstFreeSpot(layoutList, w, h, ignoreId = null, startRow = 1, useMobile = isMobileLayout()) {
    const columns = useMobile ? MOBILE_GRID_COLS : GRID_COLS;
    for (let r = Math.max(1, startRow); r <= 10000; r++) {
      for (let c = 1; c <= columns - w + 1; c++) {
        if (isAreaFree(layoutList, c, r, w, h, ignoreId, useMobile)) return { x: c, y: r };
      }
    }
    return null;
  }

  function normalizeLayoutCoordinates(layoutList) {
    const placed = [];
    for (const item of layoutList) {
      item.w = item.kind === "app" ? 1 : Number(item.w) || 4;
      item.h = item.kind === "app" ? 1 : Number(item.h) || 2;
      const rect = getLayoutRect(item, false);
      if (isAreaFree(placed, rect.x, rect.y, rect.w, rect.h, item.id, false)) {
        setLayoutRect(item, rect, false);
        placed.push(item);
      } else {
        const spot = findFirstFreeSpot(placed, rect.w, rect.h, item.id, 1, false);
        if (spot) setLayoutRect(item, Object.assign({}, rect, spot), false);
        placed.push(item);
      }
    }
  }

  function normalizeMobileLayout(layoutList) {
    const placed = [];
    for (const item of layoutList) {
      const rect = getLayoutRect(item, true);
      if (isAreaFree(placed, rect.x, rect.y, rect.w, rect.h, item.id, true)) {
        setLayoutRect(item, rect, true);
      } else {
        const spot = findFirstFreeSpot(placed, rect.w, rect.h, item.id, 1, true);
        if (spot) setLayoutRect(item, Object.assign({}, rect, spot), true);
      }
      placed.push(item);
    }
  }

  function captureLayoutSnapshot() {
    const snap = new Map();
    state.layout.forEach((item) => {
      snap.set(item.id, {
        desktop: getLayoutRect(item, false),
        mobile: getLayoutRect(item, true)
      });
    });
    return snap;
  }

  function restoreFromSnapshot(snap, useMobile = null) {
    if (!snap) return;
    state.layout.forEach((item) => {
      const original = snap.get(item.id);
      if (!original) return;
      if (useMobile === null || useMobile === false) setLayoutRect(item, original.desktop, false);
      if (useMobile === null || useMobile === true) setLayoutRect(item, original.mobile, true);
    });
  }

  function projectLayoutTransaction(itemId, requestedRect, baseSnap, options = {}) {
    const useMobile = options.useMobile === undefined ? isMobileLayout() : options.useMobile;
    const snap = baseSnap || captureLayoutSnapshot();
    const item = state.layout.find((entry) => entry.id === itemId);
    if (!item) return false;
    const before = new Map(state.layout.map((entry) => [entry.id, JSON.stringify(getLayoutRect(entry, useMobile))]));
    restoreFromSnapshot(snap, useMobile);

    const original = snap.get(itemId);
    const originalSelf = original ? (useMobile ? original.mobile : original.desktop) : getLayoutRect(item, useMobile);
    const current = getLayoutRect(item, useMobile);
    const columns = useMobile ? MOBILE_GRID_COLS : GRID_COLS;
    const requested = Object.assign({}, current, requestedRect || {});
    const w = item.kind === "app" ? 1 : Math.max(1, Math.min(columns, Math.round(Number(requested.w) || current.w)));
    const h = item.kind === "app" ? 1 : Math.max(1, Math.min(100, Math.round(Number(requested.h) || current.h)));
    const target = {
      x: Math.max(1, Math.min(columns - w + 1, Math.round(Number(requested.x) || current.x))),
      y: Math.max(1, Math.round(Number(requested.y) || current.y)),
      w,
      h
    };
    setLayoutRect(item, target, useMobile);
    const placed = [item];

    for (const other of state.layout) {
      if (other.id === item.id) continue;
      let candidate = getLayoutRect(other, useMobile);
      const collides = () => placed.some((entry) => rectsOverlap(candidate, getLayoutRect(entry, useMobile)));
      if (!collides()) {
        placed.push(other);
        continue;
      }
      if (item.kind === "app" && other.kind === "widget") {
        restoreFromSnapshot(snap, useMobile);
        return false;
      }
      if (
        candidate.w <= originalSelf.w &&
        candidate.h <= originalSelf.h &&
        isAreaFree(placed, originalSelf.x, originalSelf.y, candidate.w, candidate.h, null, useMobile)
      ) {
        candidate = Object.assign({}, candidate, { x: originalSelf.x, y: originalSelf.y });
      } else {
        const spot =
          findFirstFreeSpot(placed, candidate.w, candidate.h, null, target.y, useMobile) ||
          findFirstFreeSpot(placed, candidate.w, candidate.h, null, 1, useMobile);
        if (!spot) {
          restoreFromSnapshot(snap, useMobile);
          return false;
        }
        candidate = Object.assign({}, candidate, spot);
      }
      setLayoutRect(other, candidate, useMobile);
      placed.push(other);
    }

    return state.layout.some((entry) => before.get(entry.id) !== JSON.stringify(getLayoutRect(entry, useMobile)));
  }

  function projectDragToCoord(itemId, targetX, targetY, baseSnap) {
    const item = state.layout.find((entry) => entry.id === itemId);
    if (!item) return false;
    const current = getLayoutRect(item);
    return projectLayoutTransaction(itemId, { x: targetX, y: targetY, w: current.w, h: current.h }, baseSnap);
  }

  function commitLayoutRect(itemId, rect, options = {}) {
    const changed = projectLayoutTransaction(itemId, rect, options.baseSnapshot || captureLayoutSnapshot(), options);
    if (!changed) return false;
    syncGridCoordsWithFlip(options.skipFlipKey || null);
    if (options.persist !== false) saveState();
    if (options.structure) scheduleRenderWithFlip();
    return true;
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
    if (prefersReducedMotion()) {
      activeFlipAnimations.forEach((animation) => animation.cancel());
      activeFlipAnimations.clear();
      return;
    }
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
    if (workspaceRenderFrame) cancelAnimationFrame(workspaceRenderFrame);
    workspaceRenderFrame = null;
    const before = capturePositions();
    renderWorkspace();
    playFlipAnimation(before);
    refreshContainerSelectOptions();
  }

  function scheduleRenderWithFlip() {
    if (workspaceRenderFrame) return;
    const before = capturePositions();
    workspaceRenderFrame = requestAnimationFrame(() => {
      workspaceRenderFrame = null;
      renderWorkspace();
      playFlipAnimation(before);
      refreshContainerSelectOptions();
    });
  }

  function applyLayoutElementRect(item, domEl) {
    const rect = getLayoutRect(item);
    domEl.style.gridColumn = `${rect.x} / span ${rect.w}`;
    domEl.style.gridRow = `${rect.y} / span ${rect.h}`;
    domEl.classList.toggle(`w-${rect.w}`, true);
    Array.from(domEl.classList).forEach((name) => {
      if (/^[wh]-\d+$/.test(name) && name !== `w-${rect.w}` && name !== `h-${rect.h}`) domEl.classList.remove(name);
    });
    domEl.classList.add(`w-${rect.w}`, `h-${rect.h}`);
    const sizeLabel = domEl.querySelector("[data-size-label]");
    if (sizeLabel) sizeLabel.textContent = `${rect.w}×${rect.h}`;
  }

  function syncGridCoordsWithFlip(skipFlipKey = null) {
    if (gridSyncFrame) return;
    const before = capturePositions();
    gridSyncFrame = requestAnimationFrame(() => {
      gridSyncFrame = null;
      state.layout.forEach((item) => {
        const domEl = document.querySelector(`[data-item-id="${item.id}"]`);
        if (domEl) applyLayoutElementRect(item, domEl);
      });
      playFlipAnimation(before, skipFlipKey);
    });
  }

  function measureGridTracks(gridEl) {
    const style = getComputedStyle(gridEl);
    const bounds = gridEl.getBoundingClientRect();
    const columnTracks = style.gridTemplateColumns.split(/\s+/).filter((value) => value.endsWith("px"));
    const columns = Math.max(1, columnTracks.length || (isMobileLayout() ? MOBILE_GRID_COLS : GRID_COLS));
    const columnGap = parseFloat(style.columnGap) || 0;
    const rowGap = parseFloat(style.rowGap) || 0;
    const columnWidth = parseFloat(columnTracks[0]) || (bounds.width - columnGap * (columns - 1)) / columns;
    let rowHeight = parseFloat(style.gridAutoRows);
    if (!Number.isFinite(rowHeight) || rowHeight <= 0) {
      const first = gridEl.querySelector("[data-item-id]");
      rowHeight = first ? first.getBoundingClientRect().height : 132;
    }
    return { bounds, columns, columnWidth, columnGap, rowHeight, rowGap };
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
      const tracks = measureGridTracks(gridEl);
      const relX = Math.max(0, clientX - tracks.bounds.left);
      const relY = Math.max(0, clientY - tracks.bounds.top);
      const col = Math.max(1, Math.min(tracks.columns, Math.floor(relX / (tracks.columnWidth + tracks.columnGap)) + 1));
      const row = Math.max(1, Math.floor(relY / (tracks.rowHeight + tracks.rowGap)) + 1);
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
          const targetX = Math.max(1, Math.min((isMobileLayout() ? MOBILE_GRID_COLS : GRID_COLS) - pointerDrag.w + 1, col - pointerDrag.grabOffsetCols));
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

      if (!p.started) {
        suppressNextClick = false;
        return;
      }
      if (!commitDrop) {
        restoreFromSnapshot(p.baseSnapshot);
        suppressNextClick = false;
        if (p.avatarEl) p.avatarEl.remove();
        if (p.sourceEl) p.sourceEl.classList.remove("is-being-dragged-source");
        syncGridCoordsWithFlip();
        return;
      }

      // 情况 1：松手在底部回收站上 -> 执行删除
      if (commitDrop && isOverTrashDock(p.clientX, p.clientY)) {
        if (p.avatarEl) p.avatarEl.remove();
        if (p.kind === "inner-app" && p.appId) {
          state.apps = state.apps.filter((a) => a.id !== p.appId);
          state.layout = state.layout.filter((x) => !(x.kind === "app" && x.appId === p.appId));
        } else if (p.kind === "layout-item" && p.layoutId) {
          const item = state.layout.find((x) => x.id === p.layoutId);
          if (item) {
            if (
              item.kind === "widget" &&
              ["server-node", "app-folder"].includes(item.widgetType) &&
              state.apps.some((app) => app.containerId === item.id)
            ) {
              editingWidgetId = item.id;
              document.getElementById("deleteWidgetBtn").click();
              return;
            }
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
        showToast("项目已删除", true);
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
        const targetX = Math.max(1, Math.min((isMobileLayout() ? MOBILE_GRID_COLS : GRID_COLS) - p.w + 1, col - p.grabOffsetCols));
        const targetY = Math.max(1, row - p.grabOffsetRows);
        if (projectDragToCoord(p.layoutId, targetX, targetY, p.baseSnapshot)) {
          syncGridCoordsWithFlip(`layout-${p.layoutId}`);
        }
        saveState();
      }

      if (p.avatarEl && p.sourceEl && document.body.contains(p.sourceEl) && !prefersReducedMotion()) {
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
      const useMobile = isMobileLayout();
      const targetSpot = targetX && targetY && isAreaFree(state.layout, targetX, targetY, 1, 1, null, useMobile)
        ? { x: targetX, y: targetY }
        : findFirstFreeSpot(state.layout, 1, 1, null, targetY || 1, useMobile);
      const otherSpot = findFirstFreeSpot(state.layout, 1, 1, null, 1, !useMobile) || { x: 1, y: 1 };
      const spot = targetSpot || otherSpot;
      bareItem = {
        id: "bare-" + appId + "-" + Date.now(),
        kind: "app",
        appId: appId,
        x: useMobile ? otherSpot.x : spot.x,
        y: useMobile ? otherSpot.y : spot.y,
        w: 1,
        h: 1,
        mobile: {
          x: useMobile ? spot.x : otherSpot.x,
          y: useMobile ? spot.y : otherSpot.y,
          w: 1,
          h: 1
        }
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
  let wallpaperDraw = null;
  let wallpaperLastFrame = 0;

  function pauseDynamicWallpaper() {
    if (wallpaperAnimation) cancelAnimationFrame(wallpaperAnimation);
    wallpaperAnimation = null;
    if (wallpaperVideoEl) wallpaperVideoEl.pause();
  }

  function resumeDynamicWallpaper() {
    if (document.hidden || prefersReducedMotion()) return;
    if (wallpaperDraw && !wallpaperAnimation) wallpaperAnimation = requestAnimationFrame(wallpaperDraw);
    if (wallpaperVideoEl) wallpaperVideoEl.play().catch(showStaticWallpaperFallback);
  }

  function stopDynamicWallpaper() {
    pauseDynamicWallpaper();
    wallpaperDraw = null;
    if (wallpaperResizeHandler) {
      window.removeEventListener("resize", wallpaperResizeHandler);
      wallpaperResizeHandler = null;
    }
    if (wallpaperVideoEl) {
      wallpaperVideoEl.remove();
      wallpaperVideoEl = null;
    }
    const canvas = document.getElementById("wallpaperCanvas");
    if (canvas) canvas.remove();
    const stage = document.getElementById("wallpaperStage");
    if (stage) stage.classList.remove("has-dynamic");
  }

  function showStaticWallpaperFallback() {
    const stage = document.getElementById("wallpaperStage");
    const photoLayer = document.getElementById("wallpaperPhoto");
    if (!stage || !photoLayer) return;
    stopDynamicWallpaper();
    const pack = (window.REX_THEME_PACKS || []).find((item) => item.id === state.profile.themePack);
    const wallpaper = pack && pack.wallpaper;
    stage.dataset.scene = "scene-aurora";
    const fallback = wallpaper && (wallpaper.fallback || (wallpaper.type === "gradient" && wallpaper.value));
    photoLayer.style.backgroundImage = fallback || "none";
    stage.classList.toggle("has-photo", Boolean(fallback));
  }

  function prefersReducedMotion() {
    return reducedMotionQuery.matches;
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pauseDynamicWallpaper();
    else resumeDynamicWallpaper();
  });

  function startCanvasWallpaper(sceneName, dim) {
    const stage = document.getElementById("wallpaperStage");
    if (!stage) return;
    const canvas = document.createElement("canvas");
    canvas.id = "wallpaperCanvas";
    canvas.className = "wallpaper-canvas";
    stage.appendChild(canvas);
    stage.classList.add("has-dynamic");
    const ctx = canvas.getContext("2d");
    if (!ctx) return showStaticWallpaperFallback();

    const energySaver = Boolean((navigator.connection && navigator.connection.saveData) || (navigator.deviceMemory && navigator.deviceMemory <= 4));
    const frameInterval = 1000 / (energySaver ? 15 : 30);
    const dpr = energySaver ? 1 : Math.min(window.devicePixelRatio || 1, 1.5);
    let width = 1;
    let height = 1;
    let gradients = {};
    const stars = Array.from({ length: energySaver ? 70 : 150 }, () => ({
      x: Math.random(), y: Math.random(), r: 0.4 + Math.random() * 1.3,
      speed: 0.004 + Math.random() * 0.012, phase: Math.random() * Math.PI * 2
    }));
    const blobs = [
      { cx: 0.25, cy: 0.3, color: "251,191,36", phase: 0 },
      { cx: 0.75, cy: 0.65, color: "249,115,22", phase: 2.1 },
      { cx: 0.55, cy: 0.2, color: "124,45,18", phase: 4.2 }
    ];

    function rebuildGradients() {
      gradients = { bands: [] };
      gradients.glow = ctx.createRadialGradient(width * 0.7, height * 0.25, 0, width * 0.7, height * 0.25, Math.max(width, height) * 0.7);
      gradients.glow.addColorStop(0, "rgba(129,140,248,0.18)");
      gradients.glow.addColorStop(1, "rgba(5,8,20,0)");
      gradients.meshBase = ctx.createLinearGradient(0, 0, width, height);
      gradients.meshBase.addColorStop(0, "#1c1917");
      gradients.meshBase.addColorStop(1, "#0c0a1a");
      gradients.sky = ctx.createLinearGradient(0, 0, 0, height);
      gradients.sky.addColorStop(0, "#060b1a");
      gradients.sky.addColorStop(0.55, "#0b1b33");
      gradients.sky.addColorStop(1, "#0a2f45");
      for (let i = 0; i < 3; i += 1) {
        const band = ctx.createLinearGradient(0, height * (0.2 + i * 0.18), width, height * (0.5 + i * 0.18));
        band.addColorStop(0, "rgba(16,185,129,0)");
        band.addColorStop(0.45, `rgba(56,189,248,${0.12 - i * 0.025})`);
        band.addColorStop(0.7, `rgba(168,85,247,${0.14 - i * 0.025})`);
        band.addColorStop(1, "rgba(16,185,129,0)");
        gradients.bands.push(band);
      }
    }

    const resize = () => {
      width = Math.max(1, stage.clientWidth);
      height = Math.max(1, stage.clientHeight);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = width + "px";
      canvas.style.height = height + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      rebuildGradients();
    };
    resize();
    wallpaperResizeHandler = resize;
    window.addEventListener("resize", resize);
    const started = performance.now();
    wallpaperLastFrame = 0;

    wallpaperDraw = (now) => {
      wallpaperAnimation = null;
      if (document.hidden || prefersReducedMotion()) return;
      if (now - wallpaperLastFrame < frameInterval) {
        wallpaperAnimation = requestAnimationFrame(wallpaperDraw);
        return;
      }
      wallpaperLastFrame = now;
      const t = (now - started) / 1000;
      if (sceneName === "starfield") {
        ctx.fillStyle = "#050814";
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = gradients.glow;
        ctx.fillRect(0, 0, width, height);
        stars.forEach((star) => {
          const y = (star.y + t * star.speed) % 1;
          const alpha = 0.3 + 0.7 * Math.abs(Math.sin(t * 0.5 + star.phase));
          ctx.beginPath();
          ctx.arc(star.x * width, y * height, star.r, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(226,232,240,${alpha * 0.8})`;
          ctx.fill();
        });
      } else if (sceneName === "mesh") {
        ctx.fillStyle = gradients.meshBase;
        ctx.fillRect(0, 0, width, height);
        blobs.forEach((blob) => {
          const x = (blob.cx + Math.sin(t * 0.08 + blob.phase) * 0.08) * width;
          const y = (blob.cy + Math.cos(t * 0.06 + blob.phase) * 0.08) * height;
          const gradient = ctx.createRadialGradient(x, y, 0, x, y, Math.max(width, height) * 0.45);
          gradient.addColorStop(0, `rgba(${blob.color},0.3)`);
          gradient.addColorStop(1, `rgba(${blob.color},0)`);
          ctx.fillStyle = gradient;
          ctx.fillRect(0, 0, width, height);
        });
      } else {
        ctx.fillStyle = gradients.sky;
        ctx.fillRect(0, 0, width, height);
        for (let i = 0; i < 3; i += 1) {
          ctx.fillStyle = gradients.bands[i];
          ctx.beginPath();
          ctx.moveTo(0, height);
          for (let x = 0; x <= width; x += 14) {
            const y = height * (0.5 + i * 0.07) + Math.sin(x * 0.004 + t * (0.16 + i * 0.04)) * (26 + i * 9);
            ctx.lineTo(x, y);
          }
          ctx.lineTo(width, height);
          ctx.closePath();
          ctx.fill();
        }
      }
      if (dim > 0) {
        ctx.fillStyle = `rgba(2,6,20,${dim})`;
        ctx.fillRect(0, 0, width, height);
      }
      wallpaperAnimation = requestAnimationFrame(wallpaperDraw);
    };
    resumeDynamicWallpaper();
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
    video.preload = "metadata";
    if (poster) video.poster = poster;
    video.src = url;
    if (dim > 0) video.style.filter = `brightness(${Math.max(0.4, 1 - dim)})`;
    video.addEventListener("error", showStaticWallpaperFallback, { once: true });
    stage.appendChild(video);
    stage.classList.add("has-dynamic");
    wallpaperVideoEl = video;
    if (!document.hidden) video.play().catch(showStaticWallpaperFallback);
  }

  function applyWallpaper() {
    const stage = document.getElementById("wallpaperStage");
    const photoLayer = document.getElementById("wallpaperPhoto");
    if (!stage || !photoLayer) return;

    stopDynamicWallpaper();
    stage.classList.remove("has-photo");
    photoLayer.style.backgroundImage = "none";

    if (state.profile.customWallpaperUrl) {
      const wallpaperUrl = StudioloCore.normalizeUrl(state.profile.customWallpaperUrl);
      if (wallpaperUrl) {
        stage.dataset.scene = "scene-aurora";
        photoLayer.style.backgroundImage = `linear-gradient(180deg, rgba(8,13,26,0.26), rgba(8,13,26,0.56)), url(${JSON.stringify(wallpaperUrl)})`;
        stage.classList.add("has-photo");
        return;
      }
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

  function clearLogoCaches() {
    logoCacheGeneration += 1;
    logoStatusCache.clear();
    logoProbeCache.clear();
  }

  function probeAppLogo(app) {
    const cached = logoStatusCache.get(app.id);
    if (cached !== undefined) return Promise.resolve(cached);
    if (logoProbeCache.has(app.id)) return logoProbeCache.get(app.id);
    const generation = logoCacheGeneration;
    const candidates = deriveCandidateLogos(app);
    if (!candidates.length) {
      logoStatusCache.set(app.id, false);
      return Promise.resolve(false);
    }
    const promise = new Promise((resolve) => {
      const image = new Image();
      let index = 0;
      function finish(value) {
        if (generation === logoCacheGeneration) logoStatusCache.set(app.id, value);
        resolve(value);
      }
      function tryNext() {
        if (index >= candidates.length) return finish(false);
        image.src = candidates[index++];
      }
      image.onload = () => {
        if (image.naturalWidth >= 12) finish(image.src);
        else tryNext();
      };
      image.onerror = tryNext;
      tryNext();
    });
    logoProbeCache.set(app.id, promise);
    promise.finally(() => {
      if (logoProbeCache.get(app.id) === promise) logoProbeCache.delete(app.id);
    });
    return promise;
  }

  function createAppUnit(app, opts = {}) {
    const a = document.createElement("a");
    a.className = "app-unit" + (recentlyDroppedAppId === app.id ? " just-dropped" : "");
    const safeHref = StudioloCore.normalizeUrl(app.href);
    if (safeHref) a.href = safeHref;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.dataset.appId = app.id;
    a.dataset.itemId = app.id;
    a.dataset.flipKey = `app-${opts.contextKey || "ctx"}-${app.id}`;
    a.draggable = false;

    const bgStyle = StudioloCore.safeColor(
      app.color,
      (window.REX_ICON_LIBRARY[app.icon] && window.REX_ICON_LIBRARY[app.icon].bg) ||
        "linear-gradient(145deg, #2563eb, #0ea5e9)"
    );
    const cachedLogo = logoStatusCache.get(app.id);
    const safeCachedLogo = typeof cachedLogo === "string" ? StudioloCore.normalizeUrl(cachedLogo) : null;
    const hasImmediateLogo = Boolean(safeCachedLogo);

    a.innerHTML = `
      <span class="app-badge-edit" title="点击编辑此应用">✎</span>
      <span class="app-dot"></span>
      <div class="app-squircle">
        <img class="app-real-logo" alt="" />
        <div class="app-svg-wrap">${getIconSvg(app.icon)}</div>
      </div>
      <div class="app-label"></div>
    `;
    a.querySelector(".app-dot").classList.add(["online", "offline", "lan"].includes(app.status) ? app.status : "online");
    const squircle = a.querySelector(".app-squircle");
    squircle.style.background = bgStyle;
    squircle.classList.toggle("has-real-logo", hasImmediateLogo);
    if (safeCachedLogo) a.querySelector(".app-real-logo").src = safeCachedLogo;
    a.querySelector(".app-label").textContent = app.name;

    a.querySelectorAll("img, svg").forEach((ch) => ch.setAttribute("draggable", "false"));

    if (cachedLogo === undefined) {
      probeAppLogo(app).then((logo) => {
        const safeLogo = typeof logo === "string" ? StudioloCore.normalizeUrl(logo) : null;
        if (!safeLogo || !a.isConnected) return;
        a.querySelector(".app-real-logo").src = safeLogo;
        a.querySelector(".app-squircle").classList.add("has-real-logo");
      });
    }

    a.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!safeHref) e.preventDefault();
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
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "app-unit";
    btn.title = `还有 ${hiddenApps.length} 个应用，点击展开全部 ${totalCount} 项`;

    const preview = document.createElement("div");
    preview.className = "more-folder-squircle";
    const previewFour = hiddenApps.slice(0, 4);
    for (let i = 0; i < 4; i += 1) {
      const dot = document.createElement("div");
      dot.className = "mini-preview-dot";
      const item = previewFour[i];
      dot.style.background = item
        ? StudioloCore.safeColor(item.color, "linear-gradient(145deg, #38bdf8, #6366f1)")
        : "rgba(255,255,255,0.18)";
      if (item) dot.innerHTML = getIconSvg(item.icon);
      preview.appendChild(dot);
    }
    const label = document.createElement("div");
    label.className = "app-label";
    label.textContent = `··· (${totalCount})`;
    btn.append(preview, label);

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
    const rect = getLayoutRect(layoutItem);
    applyLayoutElementRect(layoutItem, el);
    el.dataset.itemId = layoutItem.id;
    el.dataset.flipKey = `layout-${layoutItem.id}`;
    el.tabIndex = 0;
    el.setAttribute("role", "group");
    el.setAttribute("aria-label", `${layoutItem.kind === "app" ? "应用" : "组件"}，编辑模式下方向键移动${layoutItem.kind === "widget" ? "，Shift 加方向键缩放" : ""}`);
    el.setAttribute("aria-keyshortcuts", "ArrowUp ArrowDown ArrowLeft ArrowRight Shift+ArrowUp Shift+ArrowDown Shift+ArrowLeft Shift+ArrowRight");

    el.addEventListener("keydown", (event) => {
      if (!editMode || !event.key.startsWith("Arrow")) return;
      if (event.target.closest("input, textarea, select, [contenteditable=true]")) return;
      event.preventDefault();
      event.stopPropagation();
      const current = getLayoutRect(layoutItem);
      const delta = {
        ArrowLeft: { x: -1, y: 0 },
        ArrowRight: { x: 1, y: 0 },
        ArrowUp: { x: 0, y: -1 },
        ArrowDown: { x: 0, y: 1 }
      }[event.key];
      const next = Object.assign({}, current);
      if (event.shiftKey && layoutItem.kind === "widget") {
        next.w = Math.max(2, current.w + (event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0));
        next.h = Math.max(1, Math.min(4, current.h + (event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0)));
      } else {
        next.x += delta.x;
        next.y += delta.y;
      }
      commitLayoutRect(layoutItem.id, next, { structure: event.shiftKey });
    });

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
        w: rect.w,
        h: rect.h,
        title: itemTitle,
        sourceEl: el
      });
    });
  }

  /* =========================================================
   * 9. 可复用组件工具栏 & 防重叠渲染器
   * ========================================================= */
  function buildWidgetEditControls(shellEl, widgetItem) {
    const initialRect = getLayoutRect(widgetItem);
    const bar = document.createElement("div");
    bar.className = "widget-edit-toolbar";
    bar.innerHTML = `
      <span data-size-label style="font-size:10px;color:#fde047;font-weight:700;padding:0 3px">${initialRect.w}×${initialRect.h}</span>
      <button type="button" class="tiny-btn" data-w-delta="-1" title="缩小列宽" aria-label="缩小列宽">W-</button>
      <button type="button" class="tiny-btn" data-w-delta="1" title="增加列宽" aria-label="增加列宽">W+</button>
      <button type="button" class="tiny-btn" data-h-delta="-1" title="缩小行高" aria-label="缩小行高">H-</button>
      <button type="button" class="tiny-btn" data-h-delta="1" title="增加行高" aria-label="增加行高">H+</button>
      <button type="button" class="tiny-btn" data-open-wcfg aria-label="配置组件" style="background:var(--theme-accent);color:#0f172a;font-weight:700">⚙</button>
    `;

    bar.querySelectorAll("[data-w-delta], [data-h-delta]").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        const current = getLayoutRect(widgetItem);
        const columns = isMobileLayout() ? MOBILE_GRID_COLS : GRID_COLS;
        const next = Object.assign({}, current, {
          w: Math.max(2, Math.min(columns, current.w + Number(btn.dataset.wDelta || 0))),
          h: Math.max(1, Math.min(4, current.h + Number(btn.dataset.hDelta || 0)))
        });
        commitLayoutRect(widgetItem.id, next, { structure: true });
      });
    });

    bar.querySelector("[data-open-wcfg]").addEventListener("click", (event) => {
      event.stopPropagation();
      window.openWidgetConfigModal(widgetItem.id);
    });
    shellEl.appendChild(bar);

    const corner = document.createElement("button");
    corner.type = "button";
    corner.className = "widget-resize-corner";
    corner.title = "按住拖拽调整组件长宽；也可用 Shift 加方向键";
    corner.setAttribute("aria-label", "拖拽调整组件长宽");
    corner.textContent = "⤡";

    corner.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      event.preventDefault();
      const startX = event.clientX;
      const startY = event.clientY;
      const startRect = getLayoutRect(widgetItem);
      const baseSnapshot = captureLayoutSnapshot();
      const tracks = measureGridTracks(shellEl.parentElement);
      const colStep = tracks.columnWidth + tracks.columnGap;
      const rowStep = tracks.rowHeight + tracks.rowGap;
      let latest = { clientX: startX, clientY: startY };
      let resizeFrame = null;
      let changed = false;

      function applyResize() {
        resizeFrame = null;
        const next = Object.assign({}, startRect, {
          w: Math.max(2, Math.min(tracks.columns, startRect.w + Math.round((latest.clientX - startX) / colStep))),
          h: Math.max(1, Math.min(4, startRect.h + Math.round((latest.clientY - startY) / rowStep)))
        });
        changed = commitLayoutRect(widgetItem.id, next, { baseSnapshot, persist: false }) || changed;
      }
      function onMove(moveEvent) {
        latest = { clientX: moveEvent.clientX, clientY: moveEvent.clientY };
        if (!resizeFrame) resizeFrame = requestAnimationFrame(applyResize);
      }
      function finish(commit) {
        if (resizeFrame) cancelAnimationFrame(resizeFrame);
        resizeFrame = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        if (commit) {
          applyResize();
          if (changed) saveState();
          scheduleRenderWithFlip();
        } else {
          restoreFromSnapshot(baseSnapshot);
          suppressNextClick = false;
          syncGridCoordsWithFlip();
        }
      }
      function onUp() { finish(true); }
      function onCancel() { finish(false); }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
    });

    shellEl.appendChild(corner);
  }

  function createTrendSvg(points, key, color) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 120 28");
    svg.setAttribute("class", "host-trend-line");
    svg.setAttribute("aria-hidden", "true");
    const values = points.map((point) => Number(point[key])).filter(Number.isFinite).slice(-60);
    if (values.length > 1) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      const d = values.map((value, index) => {
        const x = index * 120 / (values.length - 1);
        const y = 26 - Math.max(0, Math.min(100, value)) * 0.24;
        return `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(" ");
      path.setAttribute("d", d);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", color);
      path.setAttribute("stroke-width", "1.8");
      svg.appendChild(path);
    }
    return svg;
  }

  function paintHostTrend(shell, hostId) {
    const host = shell || document.querySelector(`[data-host-id="${hostId}"]`);
    const container = host && host.querySelector("[data-host-trend]");
    if (!container) return;
    const id = hostId || host.dataset.hostId;
    const entry = hostTrendCache.get(id);
    container.innerHTML = "";
    const status = document.createElement("span");
    status.className = "host-trend-status";
    if (!entry) {
      status.textContent = "正在读取最近 60 点趋势…";
      container.appendChild(status);
      return;
    }
    const points = (entry.points || []).slice(-60);
    status.textContent = entry.error ? `趋势不可用 · ${entry.error}` : `最近 ${points.length} 点采样`;
    container.appendChild(status);
    [["cpu", "CPU", "#38bdf8"], ["mem", "MEM", "#a78bfa"], ["disk", "DISK", "#34d399"]].forEach(([key, label, color]) => {
      const row = document.createElement("div");
      row.className = "host-trend-row";
      const text = document.createElement("span");
      text.textContent = label;
      row.append(text, createTrendSvg(points, key, color));
      container.appendChild(row);
    });
  }

  function demoHostTrend(hostId) {
    if (!hostTrendCache.has(hostId)) {
      const offset = Array.from(hostId).reduce((sum, char) => sum + char.charCodeAt(0), 0);
      const points = Array.from({ length: 60 }, (_, index) => ({
        ts: new Date(Date.now() - (59 - index) * 60000).toISOString(),
        cpu: 25 + Math.sin(index / 7 + offset) * 18 + index % 5,
        mem: 45 + Math.sin(index / 11 + offset) * 12,
        disk: 58 + Math.sin(index / 19 + offset) * 4
      }));
      hostTrendCache.set(hostId, { points, updatedAt: Date.now(), demo: true });
    }
    paintHostTrend(null, hostId);
  }

  async function loadHostTrend(hostId) {
    if (DEMO_MODE) return demoHostTrend(hostId);
    if (!Remote.isReady()) return;
    const previous = hostTrendCache.get(hostId) || {};
    if (previous.loading || (previous.updatedAt && Date.now() - previous.updatedAt < 60000)) return;
    hostTrendCache.set(hostId, Object.assign({}, previous, { loading: true }));
    const { res, body } = await Remote.request(`/api/v1/metrics?host=${encodeURIComponent(hostId)}`);
    const valid = res.ok && body && Array.isArray(body.points);
    hostTrendCache.set(hostId, {
      points: valid ? body.points.slice(-60) : (previous.points || []),
      updatedAt: valid ? Date.now() : undefined,
      error: valid ? null : `HTTP ${res.status || 0}`
    });
    paintHostTrend(null, hostId);
  }

  async function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    const input = document.createElement("textarea");
    input.value = text;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    input.remove();
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
    if (isServer) {
      const copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.className = "tiny-btn";
      copyButton.textContent = "SSH";
      copyButton.title = "复制 SSH 命令";
      copyButton.addEventListener("click", async (event) => {
        event.stopPropagation();
        if (!cfg.ip) return alert("请先配置服务器 IP。");
        const command = `ssh -p ${Number(cfg.sshPort) || 22} ${cfg.sshUser || "root"}@${cfg.ip}`;
        await copyText(command);
        copyButton.textContent = "已复制";
        setTimeout(() => { copyButton.textContent = "SSH"; }, 1500);
      });
      top.querySelector(".widget-actions").prepend(copyButton);
    }

    shell.appendChild(top);

    const slotGrid = document.createElement("div");
    slotGrid.className = "widget-slot-grid";
    slotGrid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;

    if (allApps.length === 0) {
      const emptyBtn = document.createElement("button");
      emptyBtn.type = "button";
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
    if (isServer) {
      const sample = document.createElement("div");
      sample.className = "host-sample";
      sample.dataset.hostSample = "";
      sample.textContent = "暂无最近采样";
      shell.appendChild(sample);
      const details = document.createElement("details");
      details.className = "host-trends";
      const summary = document.createElement("summary");
      summary.textContent = "最近趋势（60 点）";
      const trend = document.createElement("div");
      trend.dataset.hostTrend = "";
      details.append(summary, trend);
      details.addEventListener("toggle", () => paintHostTrend(shell, shell.dataset.hostId));
      shell.appendChild(details);
      paintHostTrend(shell, shell.dataset.hostId);
      loadHostTrend(shell.dataset.hostId);
    }

    shell.addEventListener("click", (e) => {
      if (editMode) return;
      if (e.target.closest("a.app-unit") || e.target.closest("button") || e.target.closest("details")) return;
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
      const definition = item.kind === "widget" && StudioloWidgets.get(item.widgetType);
      if (definition && definition.runtime === "weather" && ((item.config || {}).city === city)) return item.config;
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

  function calendarSourceUrl(item) {
    const config = item.config || {};
    return config.icsUrl || config.caldavUrl || "";
  }

  function paintCalendarEvents(shell, item) {
    const container = shell.querySelector("[data-calendar-events]");
    if (!container) return;
    const hasSource = Boolean(calendarSourceUrl(item));
    container.hidden = !hasSource;
    if (!hasSource) return;
    const entry = calendarEventCache.get(item.id) || { loading: true };
    container.innerHTML = "";
    const status = document.createElement("div");
    status.className = "calendar-sync-status";
    const events = entry.data && Array.isArray(entry.data.events) ? entry.data.events : [];
    if (entry.loading) status.textContent = "正在同步日程…";
    else if (entry.error && !events.length) status.textContent = `同步失败 · ${entry.error}`;
    else {
      const data = entry.data || {};
      const source = (data.sources || [])[0] || {};
      const updated = source.updatedAt || data.serverTime;
      status.textContent = `${entry.error || data.stale ? "陈旧日程" : "日程已同步"}${updated ? ` · ${new Date(updated).toLocaleString("zh-CN", { hour12: false })}` : ""}${entry.error ? ` · ${entry.error}` : ""}`;
    }
    container.appendChild(status);
    const now = Date.now();
    events.filter((event) => {
      const time = Date.parse(event.end || event.start || "");
      return !Number.isFinite(time) || time >= now - 86400000;
    }).slice(0, 4).forEach((event) => {
      const row = document.createElement("div");
      row.className = "calendar-event";
      const title = document.createElement("span");
      title.textContent = event.summary || "（无标题日程）";
      const time = document.createElement("time");
      const start = event.start ? new Date(event.start) : null;
      time.textContent = event.allDay ? `${start ? start.toLocaleDateString("zh-CN") : "近日"} · 全天` : start ? start.toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "时间待定";
      if (start) time.dateTime = start.toISOString();
      row.append(title, time);
      container.appendChild(row);
    });
    if (!events.length && !entry.loading) {
      const empty = document.createElement("div");
      empty.className = "calendar-event-empty";
      empty.textContent = "暂无即将开始的事件";
      container.appendChild(empty);
    }
  }

  async function loadCalendarEvents(item) {
    if (!calendarSourceUrl(item)) return;
    if (DEMO_MODE) {
      if (!calendarEventCache.has(item.id)) {
        calendarEventCache.set(item.id, {
          data: {
            events: [
              { summary: "本地示例 · 产品同步", start: new Date(Date.now() + 3600000).toISOString(), allDay: false },
              { summary: "本地示例 · 全天日程", start: new Date(Date.now() + 86400000).toISOString().slice(0, 10), allDay: true }
            ],
            sources: [{ updatedAt: new Date().toISOString() }],
            stale: false
          }
        });
      }
      const shell = document.querySelector(`[data-item-id="${item.id}"]`);
      if (shell) paintCalendarEvents(shell, item);
      return;
    }
    if (!Remote.isReady()) return;
    const previous = calendarEventCache.get(item.id) || {};
    if (previous.loading || (previous.updatedAt && Date.now() - previous.updatedAt < 60000)) return;
    calendarEventCache.set(item.id, Object.assign({}, previous, { loading: true }));
    const { res, body } = await Remote.request(`/api/v1/calendar/events?id=${encodeURIComponent(item.id)}`);
    const valid = res.ok && body;
    const sourceError = body && Array.isArray(body.sources)
      ? body.sources.map((source) => source.error).filter(Boolean).join("；")
      : "";
    const apiError = valid && body.status !== "ok" ? (sourceError || "日程源同步失败") : null;
    calendarEventCache.set(item.id, {
      data: valid ? body : previous.data,
      updatedAt: valid ? Date.now() : undefined,
      error: valid ? apiError : `HTTP ${res.status || 0}`
    });
    const shell = document.querySelector(`[data-item-id="${item.id}"]`);
    if (shell) paintCalendarEvents(shell, item);
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
    const events = document.createElement("div");
    events.className = "calendar-events";
    events.dataset.calendarEvents = "";
    events.hidden = !calendarSourceUrl(widgetItem);
    shell.appendChild(events);
    paintCalendarEvents(shell, widgetItem);

    const foot = document.createElement("div");
    foot.className = "widget-foot-metrics";
    foot.innerHTML = `<span>本机日历</span><span>${m + 1}月 · 共 ${totalDays} 天</span>`;
    shell.appendChild(foot);
    loadCalendarEvents(widgetItem);
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
    const clockTitle = !cfg.title || cfg.title === "系统脉冲" ? "本机时间" : cfg.title;
    const clockSubtitle = cfg.subtitle || (cfg.badge && cfg.badge !== "本地服务正常" ? cfg.badge : "本地时钟");

    const top = document.createElement("div");
    top.className = "widget-topbar";
    top.innerHTML = `
      <div class="widget-title-area">
        <span class="widget-title">${escapeHtml(clockTitle)}</span>
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
      <div style="font-size:11px;color:var(--text-secondary)">${escapeHtml(clockSubtitle)}</div>
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

  function registerCloudWidgetAdapters() {
    const adapters = {
      "server-node": renderAppContainerWidget,
      "app-folder": renderAppContainerWidget,
      weather: renderWeatherWidget,
      calendar: renderCalendarWidget,
      notes: renderNotesWidget,
      "clock-metric": renderClockMetricWidget
    };
    Object.entries(adapters).forEach(([type, renderer]) => {
      const definition = StudioloWidgets.get(type);
      StudioloWidgets.register(Object.assign({}, definition, {
        render: (ctx) => renderer(ctx.item)
      }), { replace: true });
    });
    const clockAlias = StudioloWidgets.get("clock");
    StudioloWidgets.register(Object.assign({}, clockAlias, {
      render: (ctx) => renderClockMetricWidget(ctx.item)
    }), { replace: true });
  }

  function getPluginDefinition(pluginId) {
    return (state.plugins || []).find((plugin) => plugin.id === pluginId) || null;
  }

  function renderRegisteredWidget(item) {
    if (item.widgetType === "plugin") {
      const definition = getPluginDefinition(item.config && item.config.pluginId);
      if (!definition) return null;
      const shell = StudioloWidgets.renderDeclarative(definition, {
        item,
        save: saveState,
        rerender: scheduleRenderWithFlip
      });
      buildWidgetEditControls(shell, item);
      attachLayoutDragEvents(shell, item);
      return shell;
    }
    if (!StudioloWidgets.has(item.widgetType)) return null;
    return StudioloWidgets.render(item.widgetType, {
      item,
      config: item.config || {},
      save: saveState,
      rerender: scheduleRenderWithFlip
    });
  }

  function configuredWidgetSignature(target) {
    return JSON.stringify([
      target.profile.activeWorkspaceId,
      (target.layout || []).map((item) => {
        const definition = item.kind === "widget" && StudioloWidgets.get(item.widgetType);
        if (!definition || !["server-metrics", "calendar"].includes(definition.runtime)) return null;
        return [item.id, definition.runtime, calendarSourceUrl(item)];
      }).filter(Boolean)
    ]);
  }

  function refreshConfiguredWidgets() {
    if (!Remote.isReady()) return;
    (state.layout || []).forEach((item) => {
      const definition = item.kind === "widget" && StudioloWidgets.get(item.widgetType);
      if (!definition) return;
      if (definition.runtime === "server-metrics") loadHostTrend(String(item.id).replace(/^host-/, ""));
      if (definition.runtime === "calendar") loadCalendarEvents(item);
    });
  }

  function refreshConfiguredWidgetsIfChanged() {
    const signature = configuredWidgetSignature(state);
    if (signature === remoteWidgetSignature) return;
    remoteWidgetSignature = signature;
    hostTrendCache.clear();
    calendarEventCache.clear();
    refreshConfiguredWidgets();
  }

  /* =========================================================
   * 10. 桌面主工作区渲染 (精简 DOM 树，移除 48 个冗余占位节点)
   * ========================================================= */
  function renderWorkspace() {
    applyProfileChrome();
    renderWorkspaceSwitcher();
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
      if (item.kind === "app") el = renderBareAppItem(item);
      else if (item.kind === "widget") el = renderRegisteredWidget(item);
      if (el) grid.appendChild(el);
    });

    ws.appendChild(grid);
    renderDock(dock);
    updateClock();
    refreshConfiguredWidgetsIfChanged();
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
    openModal(backdrop, { onEscape: closeFolderModal, onClose: () => { openedFolderWidgetId = null; } });
    backdrop.classList.add("open");
  }

  function closeFolderModal() {
    const backdrop = document.getElementById("folderBackdrop");
    if (backdrop) closeModal(backdrop);
    openedFolderWidgetId = null;
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
        associateFormLabels(field);
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
      associateFormLabels(field);
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

  function widgetEditorContext(item) {
    if (item.widgetType === "plugin") {
      const definition = getPluginDefinition(item.config && item.config.pluginId);
      if (!definition) throw new Error("插件定义不存在");
      return { definition, blueprint: StudioloWidgets.get(definition.type), values: definition.config };
    }
    return { definition: null, blueprint: StudioloWidgets.get(item.widgetType), values: item.config || {} };
  }

  function toLocalDateTimeInput(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    const pad = (number) => String(number).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function renderSchemaFields(schema, values, container) {
    container.innerHTML = "";
    Object.entries(schema || {}).forEach(([key, field]) => {
      if (key === "title" || key === "badge") return;
      const value = values[key] !== undefined ? values[key] : field.default;
      const wrapper = document.createElement("div");
      wrapper.className = `form-field ${["textarea", "array"].includes(field.type) ? "form-full" : ""}`;
      const label = document.createElement("label");
      label.textContent = field.label || key;
      let control;
      if (field.type === "boolean") {
        control = document.createElement("input");
        control.type = "checkbox";
        control.checked = value !== false;
      } else if (field.type === "select") {
        control = document.createElement("select");
        (field.options || []).forEach((option) => {
          const element = document.createElement("option");
          element.value = String(option);
          element.textContent = String(option);
          control.appendChild(element);
        });
        control.value = String(value);
      } else if (field.type === "textarea" || field.type === "array") {
        control = document.createElement("textarea");
        control.value = field.type === "array" ? JSON.stringify(value || [], null, 2) : String(value || "");
        if (field.type === "array") control.placeholder = "JSON 数组";
      } else {
        control = document.createElement("input");
        control.type = field.type === "number" ? "number" : field.type === "datetime" ? "datetime-local" : "text";
        control.value = field.type === "datetime" && value ? toLocalDateTimeInput(value) : (value === undefined ? "" : String(value));
        if (field.min !== undefined) control.min = String(field.min);
        if (field.max !== undefined) control.max = String(field.max);
      }
      control.dataset.schemaKey = key;
      control.dataset.schemaType = field.type;
      control.required = field.required === true;
      label.htmlFor = control.id = `schema-${editingWidgetId}-${key}`;
      wrapper.append(label, control);
      container.appendChild(wrapper);
    });
    if (container.children.length && container.closest("#wcfgDynamicFields")) {
      const note = document.createElement("div");
      note.className = "settings-note form-full";
      note.textContent = "URL 仅限 http(s)。CalDAV 凭据只在服务端环境变量配置，不会进入前端状态或 YAML。";
      container.appendChild(note);
    }
  }

  function readSchemaFields(schema, container) {
    const result = {};
    container.querySelectorAll("[data-schema-key]").forEach((control) => {
      const key = control.dataset.schemaKey;
      const field = schema[key];
      const type = control.dataset.schemaType;
      let value;
      if (type === "boolean") value = control.checked;
      else if (type === "array") {
        try { value = JSON.parse(control.value || "[]"); }
        catch (_) { throw new Error(`${field.label} 不是有效 JSON`); }
        if (!Array.isArray(value)) throw new Error(`${field.label} 必须是数组`);
      } else if (type === "number") {
        value = Number(control.value);
        if (!Number.isFinite(value) || (field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) {
          throw new Error(`${field.label} 超出有效范围`);
        }
      } else {
        value = control.value.trim();
        if (type === "url" && value) value = StudioloCore.assertUrl(value, field.label, true);
        if (type === "datetime" && value) value = new Date(value).toISOString();
      }
      if (field.required && (value === "" || value === undefined)) throw new Error(`${field.label} 不能为空`);
      if (typeof value === "string" && field.maxLength && value.length > field.maxLength) throw new Error(`${field.label} 过长`);
      result[key] = value;
    });
    return result;
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
      const editor = widgetEditorContext(item);
      const blueprint = editor.blueprint;
      document.getElementById("wcfgModalTitle").textContent = `配置组件 · ${(editor.definition && editor.definition.name) || blueprint.name || item.widgetType}`;
      document.getElementById("wcfgTitleInput").value = editor.definition ? editor.definition.name : (item.config && item.config.title) || "";
      document.getElementById("wcfgBadgeInput").value = editor.definition ? "" : (item.config && item.config.badge) || "";
      document.getElementById("wcfgWidthSelect").value = String(item.w || blueprint.defaultSize.w);
      document.getElementById("wcfgHeightSelect").value = String(item.h || blueprint.defaultSize.h);
      renderSchemaFields(blueprint.configSchema, editor.values, document.getElementById("wcfgDynamicFields"));
      openModal(cfgBackdrop, { initialFocus: document.getElementById("wcfgTitleInput") });
    };

    document.getElementById("closeWcfgModalBtn").addEventListener("click", () => closeModal(cfgBackdrop));
    cfgBackdrop.addEventListener("click", (e) => {
      if (e.target === cfgBackdrop) closeModal(cfgBackdrop);
    });

    document.getElementById("saveWcfgBtn").addEventListener("click", () => {
      const item = state.layout.find((x) => x.id === editingWidgetId);
      if (!item) return;
      try {
        const editor = widgetEditorContext(item);
        const values = readSchemaFields(editor.blueprint.configSchema, document.getElementById("wcfgDynamicFields"));
        const title = document.getElementById("wcfgTitleInput").value.trim() || "未命名组件";
        if (editor.definition) {
          state.plugins = StudioloWidgets.normalizeDefinitions((state.plugins || []).map((definition) =>
            definition.id === editor.definition.id ? Object.assign({}, definition, { name: title, config: values }) : definition
          ));
        } else {
          item.config = item.config || {};
          item.config.title = title;
          item.config.badge = document.getElementById("wcfgBadgeInput").value.trim();
          Object.assign(item.config, values);
          if (item.widgetType === "calendar" && item.config.icsUrl && item.config.caldavUrl) {
            throw new Error("ICS 与 CalDAV 只能选择一种来源");
          }
        }
      } catch (error) {
        alert(`保存组件失败：${error.message}`);
        return;
      }

      const currentRect = getLayoutRect(item);
      commitLayoutRect(item.id, Object.assign({}, currentRect, {
        w: Number(document.getElementById("wcfgWidthSelect").value) || currentRect.w,
        h: Number(document.getElementById("wcfgHeightSelect").value) || currentRect.h
      }), { persist: false });
      saveState();
      renderWithFlip();
      closeModal(cfgBackdrop);
    });

    document.getElementById("deleteWidgetBtn").addEventListener("click", () => {
      if (!editingWidgetId) return;
      const widget = state.layout.find((item) => item.id === editingWidgetId);
      if (!widget || !window.confirm("确定删除此组件吗？删除后可在提示中撤销。")) return;
      const containedApps = state.apps.filter((app) => app.containerId === widget.id);
      const otherContainers = state.layout.filter((item) =>
        item.id !== widget.id && item.kind === "widget" && ["server-node", "app-folder"].includes(item.widgetType)
      );
      let destination = null;
      if (containedApps.length) {
        const choices = otherContainers.map((item) => item.id).join("、") || "（无其他容器）";
        destination = window.prompt(
          `组件内有 ${containedApps.length} 个应用。输入 desktop 移到桌面，输入 cascade 一并删除，或输入其他容器 ID：${choices}`,
          "desktop"
        );
        if (destination === null) return;
        destination = destination.trim();
        if (destination !== "desktop" && destination !== "cascade" && !otherContainers.some((item) => item.id === destination)) {
          alert("目标容器无效，未删除组件。");
          return;
        }
      }
      commitState((draft) => {
        if (destination === "cascade") {
          const removedIds = new Set(containedApps.map((app) => app.id));
          draft.apps = draft.apps.filter((app) => !removedIds.has(app.id));
          draft.layout = draft.layout.filter((item) => !(item.kind === "app" && removedIds.has(item.appId)));
        } else if (destination) {
          containedApps.forEach((app) => {
            const target = draft.apps.find((item) => item.id === app.id);
            if (!target) return;
            target.containerId = destination;
            if (destination === "desktop" && !draft.layout.some((item) => item.kind === "app" && item.appId === app.id)) {
              const spot = findFirstFreeSpot(draft.layout, 1, 1, null, 1, false) || { x: 1, y: 1 };
              draft.layout.push({ id: `bare-${app.id}-${Date.now()}`, kind: "app", appId: app.id, x: spot.x, y: spot.y, w: 1, h: 1 });
            }
          });
        }
        draft.layout = draft.layout.filter((item) => item.id !== widget.id);
      });
      closeModal(cfgBackdrop);
      showToast(destination === "cascade" ? "组件及其中应用已删除" : "组件已删除", true);
    });

    const catalogGrid = document.getElementById("widgetCatalogGrid");
    const catalogTypes = StudioloWidgets.builtInTypes.concat(StudioloWidgets.declarativeTypes);
    catalogTypes.map((type) => StudioloWidgets.get(type)).forEach((meta) => {
      const typeKey = meta.type;
      const card = document.createElement("div");
      card.className = "catalog-card";
      card.innerHTML = `
        <div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <strong style="font-size:14.5px">${escapeHtml(meta.name)}</strong>
            <span class="widget-tag">${escapeHtml(typeKey)} (${meta.defaultSize.w}×${meta.defaultSize.h})</span>
          </div>
          <div style="font-size:12px;color:var(--text-secondary);line-height:1.45">${escapeHtml(meta.description)}</div>
        </div>
        <button type="button" class="glass-btn" style="align-self:flex-start;padding:6px 14px;font-size:12px">+ 添加此组件到桌面</button>
      `;
      card.querySelector("button").addEventListener("click", () => {
        const newId = `widget-${typeKey}-${Date.now()}`;
        const defaultSize = meta.defaultSize;
        const spot = findFirstFreeSpot(state.layout, defaultSize.w, defaultSize.h, null, 1, false) || { x: 1, y: 1 };
        const mobileW = Math.min(MOBILE_GRID_COLS, defaultSize.w);
        const mobileSpot = findFirstFreeSpot(state.layout, mobileW, defaultSize.h, null, 1, true) || { x: 1, y: 1 };
        const declarative = StudioloWidgets.declarativeTypes.includes(typeKey);
        const pluginId = declarative ? `plugin-${typeKey}-${Date.now()}` : null;
        const newWidget = {
          id: newId,
          kind: "widget",
          widgetType: declarative ? "plugin" : typeKey,
          x: spot.x,
          y: spot.y,
          w: defaultSize.w,
          h: defaultSize.h,
          mobile: { x: mobileSpot.x, y: mobileSpot.y, w: mobileW, h: defaultSize.h },
          config: declarative ? { pluginId } : StudioloCore.clone(meta.defaultConfig)
        };
        if (declarative) {
          const initialConfig = StudioloWidgets.getDefaultConfig(typeKey);
          if (typeKey === "text") initialConfig.content = "# 新文本组件";
          if (typeKey === "image") initialConfig.images = [{ url: "https://placehold.co/600x400", alt: "示例图片" }];
          if (typeKey === "countdown") initialConfig.target = new Date(Date.now() + 7 * 86400000).toISOString();
          if (typeKey === "iframe") initialConfig.url = "https://example.com";
          state.plugins.push(StudioloWidgets.normalizeDefinition({
            id: pluginId,
            type: typeKey,
            name: meta.name.trim(),
            defaultSize,
            config: initialConfig
          }));
        }
        state.layout.push(newWidget);
        saveState();
        renderWithFlip();
        closeModal(storeBackdrop);
        window.openWidgetConfigModal(newId);
      });
      catalogGrid.appendChild(card);
    });

    window.openWidgetStoreModal = () => openModal(storeBackdrop, { onEscape: () => closeModal(storeBackdrop) });
    document.getElementById("bannerAddWidgetBtn").addEventListener("click", window.openWidgetStoreModal);
    document.getElementById("closeWidgetStoreBtn").addEventListener("click", () => closeModal(storeBackdrop));
    storeBackdrop.addEventListener("click", (e) => {
      if (e.target === storeBackdrop) closeModal(storeBackdrop);
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

    window.openAppModal = function (appId, defaultContainerId = "desktop") {
      refreshContainerSelectOptions();
      editingAppId = appId;
      const app = state.apps.find((a) => a.id === appId);
      document.getElementById("appModalTitle").textContent = app ? `定制应用 · ${app.name}` : "新增应用或网站图标";
      document.getElementById("appNameInput").value = app ? app.name : "";
      document.getElementById("appDescInput").value = app ? app.desc : "";
      document.getElementById("appHrefInput").value = app ? app.href : "https://";
      document.getElementById("appLogoUrlInput").value = app ? app.logoUrl || "" : "";
      document.getElementById("appUseSiteLogoCheck").checked = app ? app.useSiteLogo !== false : true;
      const containerSelect = document.getElementById("appContainerSelect");
      const requestedContainer = app ? app.containerId || "desktop" : defaultContainerId;
      containerSelect.value = Array.from(containerSelect.options).some((option) => option.value === requestedContainer)
        ? requestedContainer
        : "desktop";
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
      openModal(backdrop, { initialFocus: document.getElementById("appNameInput") });
    };

    document.getElementById("closeAppModalBtn").addEventListener("click", () => closeModal(backdrop));
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeModal(backdrop);
    });

    document.getElementById("saveAppBtn").addEventListener("click", () => {
      const name = document.getElementById("appNameInput").value.trim() || "未命名应用";
      const desc = document.getElementById("appDescInput").value.trim();
      const href = StudioloCore.normalizeUrl(document.getElementById("appHrefInput").value.trim(), false);
      const logoUrl = StudioloCore.normalizeUrl(document.getElementById("appLogoUrlInput").value.trim());
      if (!href || logoUrl === null) {
        alert("应用地址和 Logo 地址仅支持有效的 http(s) URL，Logo 可留空。");
        return;
      }
      const rawColor = colorInput.value.trim();
      const color = StudioloCore.safeColor(rawColor);
      if (!color) {
        alert("图标颜色仅支持安全的 CSS 颜色或渐变。");
        return;
      }
      const useSiteLogo = document.getElementById("appUseSiteLogoCheck").checked;
      const containerSelect = document.getElementById("appContainerSelect");
      const requestedContainer = containerSelect.value;
      const containerId = Array.from(containerSelect.options).some((option) => option.value === requestedContainer)
        ? requestedContainer
        : "desktop";
      const status = document.getElementById("appStatusSelect").value;
      const port = document.getElementById("appPortInput").value.trim();
      const note = document.getElementById("appNoteInput").value.trim();
      const pinned = document.getElementById("appPinnedCheck").checked;
      const wantBareDesktop = document.getElementById("appStandaloneCheck").checked || containerId === "desktop";

      let targetId = editingAppId;
      if (editingAppId) {
        clearLogoCaches();
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
        const spot = findFirstFreeSpot(state.layout, 1, 1, null, 1, false) || { x: 1, y: 1 };
        const mobileSpot = findFirstFreeSpot(state.layout, 1, 1, null, 1, true) || { x: 1, y: 1 };
        state.layout.push({
          id: "bare-" + Date.now(),
          kind: "app",
          appId: targetId,
          x: spot.x,
          y: spot.y,
          w: 1,
          h: 1,
          mobile: { x: mobileSpot.x, y: mobileSpot.y, w: 1, h: 1 }
        });
      } else if (!wantBareDesktop && bareIdx !== -1) {
        state.layout.splice(bareIdx, 1);
      }

      saveState();
      renderWithFlip();
      if (openedFolderWidgetId) renderFolderModalContent(openedFolderWidgetId);
      closeModal(backdrop);
    });

    document.getElementById("deleteAppBtn").addEventListener("click", () => {
      if (!editingAppId || !window.confirm("确定删除此应用吗？删除后可在提示中撤销。")) return;
      state.apps = state.apps.filter((a) => a.id !== editingAppId);
      state.layout = state.layout.filter((x) => !(x.kind === "app" && x.appId === editingAppId));
      saveState();
      renderWithFlip();
      if (openedFolderWidgetId) renderFolderModalContent(openedFolderWidgetId);
      closeModal(backdrop);
      showToast("应用已删除", true);
    });
  }

  /* =========================================================
   * 15. 悬停透视卡片 (Hover Popover) & Omni-Bar 搜索
   * ========================================================= */
  function showPopover(app, anchorEl) {
    const pop = document.getElementById("appPopover");
    if (!pop) return;

    const containerWidget = state.layout.find((x) => x.id === app.containerId);
    const containerTitle = String(containerWidget && containerWidget.config ? containerWidget.config.title : "桌面独立应用");
    const latency = Number.isFinite(Number(app.latency)) ? Math.max(0, Math.round(Number(app.latency))) : 12;
    const statusLabel =
      app.status === "lan"
        ? `仅内网 · ${latency}ms`
        : app.status === "offline"
        ? "离线"
        : `在线 · ${latency}ms`;

    pop.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <strong style="font-size:14.5px">${escapeHtml(app.name)}</strong>
        <span class="widget-tag">${escapeHtml(statusLabel)}</span>
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
    let activeIndex = 0;

    function refreshEngine() {
      const eng = SEARCH_ENGINES[state.profile.searchEngine] || SEARCH_ENGINES.google;
      engineBtn.textContent = `${eng.name} ▾`;
    }
    function setOpen(open) {
      drop.hidden = !open;
      input.setAttribute("aria-expanded", String(open));
      if (!open) input.removeAttribute("aria-activedescendant");
    }
    function setActive(index) {
      const rows = Array.from(drop.querySelectorAll(".omni-row"));
      if (!rows.length) return;
      activeIndex = (index + rows.length) % rows.length;
      rows.forEach((row, rowIndex) => {
        const active = rowIndex === activeIndex;
        row.classList.toggle("active", active);
        row.setAttribute("aria-selected", String(active));
      });
      input.setAttribute("aria-activedescendant", rows[activeIndex].id);
      rows[activeIndex].scrollIntoView({ block: "nearest" });
    }
    function renderResults() {
      const query = input.value.trim();
      const normalized = query.toLowerCase();
      if (!normalized) {
        setOpen(false);
        return;
      }
      const matches = state.apps.filter((app) =>
        `${app.name} ${app.desc} ${app.href} ${app.note || ""}`.toLowerCase().includes(normalized) && StudioloCore.normalizeUrl(app.href)
      ).slice(0, 7);
      const eng = SEARCH_ENGINES[state.profile.searchEngine] || SEARCH_ENGINES.google;
      let html = "";
      matches.forEach((app, index) => {
        const safeBackground = StudioloCore.safeColor(app.color, "#2563eb");
        html += `
          <a id="omni-option-${index}" role="option" aria-selected="false" class="omni-row" href="${escapeHtml(StudioloCore.normalizeUrl(app.href))}" target="_blank" rel="noopener noreferrer">
            <div style="display:flex;align-items:center;gap:10px">
              <div style="width:32px;height:32px;border-radius:10px;background:${safeBackground};display:grid;place-items:center">
                <div style="width:18px;height:18px">${getIconSvg(app.icon)}</div>
              </div>
              <div><div style="font-size:13.5px;font-weight:600">${escapeHtml(app.name)}</div><div style="font-size:11.5px;color:var(--text-secondary)">${escapeHtml(app.desc || app.href)}</div></div>
            </div><span class="widget-tag">打开应用 ↵</span>
          </a>`;
      });
      const webHref = eng.url + encodeURIComponent(query);
      html += `
        <a id="omni-option-${matches.length}" role="option" aria-selected="false" class="omni-row" href="${webHref}" target="_blank" rel="noopener noreferrer">
          <div style="display:flex;align-items:center;gap:10px"><div style="width:32px;height:32px;border-radius:10px;background:rgba(255,255,255,0.18);display:grid;place-items:center"><div style="width:18px;height:18px">${getIconSvg("globe")}</div></div>
          <div><div style="font-size:13.5px;font-weight:600">使用 ${eng.name} 搜索 “${escapeHtml(query)}”</div><div style="font-size:11.5px;color:var(--text-secondary)">跳转到外部网页搜索结果</div></div></div>
          <span class="widget-tag">全网搜索 ↵</span>
        </a>`;
      drop.innerHTML = html;
      setOpen(true);
      setActive(0);
    }

    refreshEngine();
    engineBtn.addEventListener("click", () => {
      const keys = Object.keys(SEARCH_ENGINES);
      state.profile.searchEngine = keys[(keys.indexOf(state.profile.searchEngine) + 1) % keys.length];
      saveState();
      refreshEngine();
      input.focus();
      renderResults();
    });
    input.addEventListener("input", renderResults);
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (drop.hidden) renderResults();
        setActive(activeIndex + (event.key === "ArrowDown" ? 1 : -1));
      } else if (event.key === "Escape") {
        setOpen(false);
      } else if (event.key === "Enter" && !drop.hidden) {
        const active = drop.querySelector(".omni-row.active");
        if (active) {
          event.preventDefault();
          window.open(active.href, "_blank", "noopener,noreferrer");
          setOpen(false);
        }
      }
    });
    drop.addEventListener("mousemove", (event) => {
      const row = event.target.closest(".omni-row");
      if (row) setActive(Array.from(drop.children).indexOf(row));
    });
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".omni-container")) setOpen(false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
        event.preventDefault();
        input.focus();
      }
    });
  }

  /* =========================================================
   * 16. YAML 导出 / 导入中心
   * ========================================================= */
  function stateToYaml(st) {
    return StudioloCore.exportYaml(st);
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
    return StudioloCore.parseYaml(yamlText);
  }

  function initConfigModal() {
    const wpGrid = document.getElementById("wpPickerGrid");
    const customUrlInput = document.getElementById("customWpUrlInput");
    const yamlBox = document.getElementById("yamlTextarea");
    const statusMsg = document.getElementById("yamlStatusMsg");

    function renderSwatches() {
      wpGrid.innerHTML = "";
      window.REX_WALLPAPERS.forEach((wp) => {
        const d = document.createElement("button");
        d.type = "button";
        d.className = `wp-swatch ${state.profile.wallpaper === wp.id && !state.profile.customWallpaperUrl ? "active" : ""}`;
        d.setAttribute("aria-pressed", String(state.profile.wallpaper === wp.id && !state.profile.customWallpaperUrl));
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
      const url = StudioloCore.normalizeUrl(customUrlInput.value.trim());
      if (url === null) {
        statusMsg.style.color = "#fb7185";
        statusMsg.textContent = "壁纸仅支持有效的 http(s) URL";
        return;
      }
      state.profile.customWallpaperUrl = url;
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
      if (!window.confirm("导入将替换当前桌面、主题和壁纸。继续后可使用撤销恢复，是否继续？")) return;
      try {
        const imported = yamlToState(yamlBox.value);
        replaceState(imported);
        yamlBox.value = stateToYaml(state);
        statusMsg.style.color = "#34d399";
        statusMsg.textContent = "配置已成功加载，可通过撤销恢复导入前状态。";
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
        fileInput.value = "";
      };
      r.readAsText(f);
    });

    document.getElementById("resetDefaultBtn").addEventListener("click", () => {
      if (!window.confirm("确定恢复默认桌面与主题吗？当前状态可通过撤销恢复。")) return;
      replaceState(cloneDefault());
      yamlBox.value = stateToYaml(state);
      statusMsg.style.color = "#38bdf8";
      statusMsg.textContent = "已恢复默认桌面与主题配置";
    });
  }

  function versionDiffSummary(snapshotState) {
    const currentWorkspaces = state.workspaces || [];
    const snapshotWorkspaces = snapshotState.workspaces || [{ layout: snapshotState.layout || [], apps: snapshotState.apps || [] }];
    const count = (items, key) => items.reduce((total, item) => total + ((item[key] || []).length), 0);
    const lines = [
      `工作区：${currentWorkspaces.length} → ${snapshotWorkspaces.length}`,
      `布局项：${count(currentWorkspaces, "layout")} → ${count(snapshotWorkspaces, "layout")}`,
      `应用：${count(currentWorkspaces, "apps")} → ${count(snapshotWorkspaces, "apps")}`,
      `插件：${(state.plugins || []).length} → ${(snapshotState.plugins || []).length}`,
      `活动工作区：${state.profile.activeWorkspaceId} → ${(snapshotState.profile || {}).activeWorkspaceId || "默认"}`
    ];
    if (state.profile.themePreset !== (snapshotState.profile || {}).themePreset) {
      lines.push(`主题：${state.profile.themePreset || "自定义"} → ${(snapshotState.profile || {}).themePreset || "自定义"}`);
    }
    return lines.join("\n");
  }

  function initVersionCenter() {
    const list = document.getElementById("versionList");
    const status = document.getElementById("versionStatus");
    const preview = document.getElementById("versionPreview");
    const diff = document.getElementById("versionDiff");
    const restoreButton = document.getElementById("restoreVersionBtn");
    let selected = null;

    async function loadVersions() {
      selected = null;
      restoreButton.disabled = true;
      preview.textContent = "";
      list.innerHTML = "";
      if (DEMO_MODE) {
        status.textContent = "示例模式不提供远端版本中心。";
        diff.textContent = "版本快照在自托管后端可用。";
        return;
      }
      status.textContent = "正在读取版本…";
      const { res, body } = await Remote.request("/api/v1/state/snapshots?limit=30");
      if (!res.ok || !body || !Array.isArray(body.snapshots)) {
        status.textContent = res.status === 401 ? "登录后可查看版本。" : "版本列表暂时不可用。";
        return;
      }
      status.textContent = body.snapshots.length ? `共 ${body.snapshots.length} 个最近版本` : "暂无远端快照";
      body.snapshots.forEach((snapshot) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "version-item";
        button.textContent = `rev ${snapshot.rev} · ${snapshot.createdAt || "未知时间"}`;
        button.addEventListener("click", async () => {
          status.textContent = `正在读取 rev ${snapshot.rev}…`;
          const result = await Remote.request(`/api/v1/state/snapshots/${snapshot.rev}`);
          if (!result.res.ok || !result.body || !result.body.state) {
            status.textContent = "快照读取失败。";
            return;
          }
          selected = result.body;
          preview.textContent = JSON.stringify(selected.state, null, 2).slice(0, 30000);
          diff.textContent = versionDiffSummary(selected.state);
          restoreButton.disabled = false;
          status.textContent = `已选择 rev ${snapshot.rev}，确认前可检查预览和差异。`;
          list.querySelectorAll(".version-item").forEach((item) => item.classList.toggle("active", item === button));
        });
        list.appendChild(button);
      });
    }

    document.getElementById("refreshVersionsBtn").addEventListener("click", loadVersions);
    restoreButton.addEventListener("click", async () => {
      if (!selected || !window.confirm(`确认恢复 rev ${selected.rev} 吗？远端当前版本不会被强制覆盖。`)) return;
      restoreButton.disabled = true;
      status.textContent = "正在同步本地修改并检查版本…";
      await Remote.flush();
      if (Remote.hasPending()) {
        status.textContent = "本地修改尚未同步或存在冲突，未执行恢复。";
        restoreButton.disabled = false;
        return;
      }
      const restoring = selected;
      const expectedRev = Remote.getRevision();
      const expectedGeneration = Remote.getGeneration();
      const { res, body } = await Remote.request(`/api/v1/state/snapshots/${restoring.rev}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRev, force: false })
      });
      if (res.status === 409) {
        status.textContent = `恢复冲突：远端已更新到 rev ${body && body.rev}，未覆盖任何状态。请刷新后重选。`;
      } else if (res.ok && body) {
        const accepted = Remote.acceptRemote(body.rev, expectedGeneration);
        if (!accepted.keptPending) {
          replaceState(restoring.state, { remote: false, clearHistory: true });
        }
        status.textContent = accepted.keptPending
          ? `远端已恢复 rev ${restoring.rev}，较新本地修改正在继续同步。`
          : `已恢复 rev ${restoring.rev}，新版本为 rev ${body.rev}。`;
        selected = null;
        preview.textContent = "";
        diff.textContent = "恢复完成。";
        await loadVersions();
      } else {
        status.textContent = (body && body.error) || `恢复失败（HTTP ${res.status}）。`;
      }
      restoreButton.disabled = !selected;
    });
  }

  function renderWorkspaceSwitcher() {
    const select = document.getElementById("workspaceSelect");
    if (!select) return;
    const signature = JSON.stringify((state.workspaces || []).map((workspace) => [workspace.id, workspace.name]));
    if (select.dataset.signature !== signature) {
      select.innerHTML = "";
      state.workspaces.forEach((workspace) => {
        const option = document.createElement("option");
        option.value = workspace.id;
        option.textContent = workspace.name;
        select.appendChild(option);
      });
      select.dataset.signature = signature;
    }
    select.value = state.profile.activeWorkspaceId;
    const active = state.workspaces.find((workspace) => workspace.id === state.profile.activeWorkspaceId);
    const summary = document.getElementById("workspaceSummary");
    if (summary && active) summary.textContent = `${active.name} · ${active.layout.length} 个布局项 · ${active.apps.length} 个应用，共 ${state.workspaces.length} 个工作区`;
    const deleteButton = document.getElementById("deleteWorkspaceBtn");
    if (deleteButton) deleteButton.disabled = state.workspaces.length <= 1;
  }

  function switchWorkspace(workspaceId) {
    if (workspaceId === state.profile.activeWorkspaceId || !state.workspaces.some((workspace) => workspace.id === workspaceId)) return;
    commitState((draft) => {
      syncActiveWorkspace(draft);
      const target = draft.workspaces.find((workspace) => workspace.id === workspaceId);
      draft.profile.activeWorkspaceId = workspaceId;
      draft.layout = StudioloCore.clone(target.layout);
      draft.apps = StudioloCore.clone(target.apps);
    });
  }

  function initWorkspaceControls() {
    document.getElementById("workspaceSelect").addEventListener("change", (event) => switchWorkspace(event.target.value));
    document.getElementById("newWorkspaceBtn").addEventListener("click", () => {
      const name = window.prompt("新工作区名称", `工作区 ${state.workspaces.length + 1}`);
      if (!name || !name.trim()) return;
      const id = `workspace-${Date.now()}`;
      commitState((draft) => {
        syncActiveWorkspace(draft);
        draft.workspaces.push({ id, name: name.trim(), layout: [], apps: [] });
        draft.profile.activeWorkspaceId = id;
        draft.layout = [];
        draft.apps = [];
      });
    });
    document.getElementById("renameWorkspaceBtn").addEventListener("click", () => {
      const active = state.workspaces.find((workspace) => workspace.id === state.profile.activeWorkspaceId);
      const name = window.prompt("工作区名称", active.name);
      if (!name || !name.trim()) return;
      commitState((draft) => {
        const target = draft.workspaces.find((workspace) => workspace.id === draft.profile.activeWorkspaceId);
        target.name = name.trim();
      });
    });
    document.getElementById("copyWorkspaceLayoutBtn").addEventListener("click", () => {
      const choices = state.workspaces.filter((workspace) => workspace.id !== state.profile.activeWorkspaceId);
      if (!choices.length) return alert("请先新建另一个工作区。");
      const targetId = window.prompt(`将当前布局和应用复制到哪个工作区 ID？${choices.map((workspace) => workspace.id).join("、")}`, choices[0].id);
      if (!targetId || !choices.some((workspace) => workspace.id === targetId)) return;
      if (!window.confirm("目标工作区的现有布局和应用将被替换，是否继续？")) return;
      commitState((draft) => {
        syncActiveWorkspace(draft);
        const target = draft.workspaces.find((workspace) => workspace.id === targetId);
        target.layout = StudioloCore.clone(draft.layout);
        target.apps = StudioloCore.clone(draft.apps);
      });
      showToast("布局和应用已复制", false);
    });
    document.getElementById("deleteWorkspaceBtn").addEventListener("click", () => {
      if (state.workspaces.length <= 1) return;
      const activeId = state.profile.activeWorkspaceId;
      if (!window.confirm("确定删除当前工作区吗？可通过撤销恢复。")) return;
      commitState((draft) => {
        syncActiveWorkspace(draft);
        draft.workspaces = draft.workspaces.filter((workspace) => workspace.id !== activeId);
        const target = draft.workspaces[0];
        draft.profile.activeWorkspaceId = target.id;
        draft.layout = StudioloCore.clone(target.layout);
        draft.apps = StudioloCore.clone(target.apps);
      });
      showToast("工作区已删除", true);
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
    tabs.forEach((btn) => {
      const name = btn.dataset.settingsTab;
      btn.id = `settings-tab-${name}`;
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-controls", `settings-panel-${name}`);
    });
    panels.forEach((panel) => {
      const name = panel.dataset.settingsPanel;
      panel.id = `settings-panel-${name}`;
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", `settings-tab-${name}`);
    });

    const TAB_META = {
      desktop: ["桌面", "名称、Dock 与显示行为"],
      "appearance-theme": ["主题", "选择一套主题包，或导入自己的"],
      "appearance-custom": ["自定义", "逐项调整材质、图标、字体与颜色"],
      "appearance-wallpaper": ["壁纸", "静态、动态与自定义图片"],
      data: ["数据", "YAML 备份、导入与重置"]
    };

    function selectTab(name, moveFocus = false) {
      tabs.forEach((btn) => {
        const selected = btn.dataset.settingsTab === name;
        btn.classList.toggle("active", selected);
        btn.setAttribute("aria-selected", String(selected));
        btn.tabIndex = selected ? 0 : -1;
        if (selected && moveFocus) btn.focus();
      });
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

      document.querySelectorAll(".settings-nav-parent").forEach((el) => {
        el.classList.remove("active-parent");
      });

      if (name.startsWith("appearance")) {
        const parent = document.querySelector(
          '.settings-nav-group[data-nav-group="appearance"] .settings-nav-parent'
        );
        if (parent) {
          parent.classList.add("active-parent");
          parent.setAttribute("aria-expanded", "true");
          const children = parent.parentElement.querySelector(".settings-nav-children");
          if (children) children.hidden = false;
        }
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
      if ((tab || "desktop") === "data") document.getElementById("refreshVersionsBtn").click();
      openModal(backdrop, { initialFocus: document.getElementById("closeSettingsBtn") });
    };

    window.closeSettings = function () {
      closeModal(backdrop);
    };

    document.getElementById("openSettingsBtn").addEventListener("click", () => window.openSettings("desktop"));
    document.getElementById("closeSettingsBtn").addEventListener("click", window.closeSettings);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) window.closeSettings();
    });

    tabs.forEach((btn) => {
      btn.addEventListener("click", () => selectTab(btn.dataset.settingsTab));
      btn.addEventListener("keydown", (event) => {
        const current = tabs.indexOf(btn);
        let next = null;
        if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (current + 1) % tabs.length;
        else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (current - 1 + tabs.length) % tabs.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = tabs.length - 1;
        if (next === null) return;
        event.preventDefault();
        selectTab(tabs[next].dataset.settingsTab, true);
      });
    });

    document.querySelectorAll(".settings-nav-parent").forEach((parent) => {
      parent.addEventListener("click", () => {
        if (!parent.classList.contains("active-parent")) {
          selectTab("appearance-theme");
          return;
        }
        const expanded = parent.getAttribute("aria-expanded") !== "false";
        parent.setAttribute("aria-expanded", String(!expanded));
        const group = parent.closest(".settings-nav-group");
        const children = group && group.querySelector(".settings-nav-children");
        if (children) children.hidden = expanded;
      });
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
    registerCloudWidgetAdapters();
    associateFormLabels(document);
    document.body.classList.toggle("reduced-motion", prefersReducedMotion());
    reducedMotionQuery.addEventListener("change", () => {
      document.body.classList.toggle("reduced-motion", prefersReducedMotion());
      activeFlipAnimations.forEach((animation) => animation.cancel());
      activeFlipAnimations.clear();
      applyWallpaper();
    });
    mobileLayoutQuery.addEventListener("change", () => {
      if (pointerDrag) window.dispatchEvent(new Event("pointercancel"));
      normalizeMobileLayout(state.layout);
      syncGridCoordsWithFlip();
    });
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
      const modifier = e.metaKey || e.ctrlKey;
      const editingText = e.target.closest && e.target.closest("input, textarea, [contenteditable=true]");
      if (modifier && !editingText && (e.key.toLowerCase() === "z" || e.key.toLowerCase() === "y")) {
        e.preventDefault();
        if (e.key.toLowerCase() === "y" || e.shiftKey) redo();
        else undo();
        return;
      }
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
    initWorkspaceControls();
    initVersionCenter();
    initSettingsPanel();
    renderWorkspace();
    Remote.init();
  });
})();
