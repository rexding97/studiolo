(function (root) {
  "use strict";

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function createSync(options) {
    const opts = options || {};
    if (typeof opts.request !== "function") throw new Error("createSync 需要 request 适配器");
    const storage = opts.storage || null;
    const storageKey = opts.storageKey || "studiolo_remote_outbox_v1";
    const baseDelay = Number(opts.debounceMs) || 500;
    const retryBase = Number(opts.retryBaseMs) || 1000;
    const retryMax = Number(opts.retryMaxMs) || 60000;

    let revision = 0;
    let generation = 0;
    let pending = null;
    let pushTimer = null;
    let retryTimer = null;
    let retryAttempt = 0;
    let flight = null;
    let pullFlight = null;
    let authenticated = false;
    let conflictOpen = false;
    let destroyed = false;

    function status(value, detail) {
      if (typeof opts.onStatus === "function") opts.onStatus(value, detail);
    }

    async function request(url, options) {
      try {
        return await opts.request(url, options);
      } catch (networkError) {
        return { res: { ok: false, status: 0 }, body: null, networkError };
      }
    }

    function readOutbox() {
      if (!storage) return null;
      try {
        const raw = storage.getItem(storageKey);
        if (!raw) return null;
        const data = JSON.parse(raw);
        if (!data || !Number.isSafeInteger(data.generation) || data.generation < 1 || !data.state) return null;
        return { generation: data.generation, state: data.state };
      } catch (_) {
        return null;
      }
    }

    function persist() {
      if (!storage) return;
      try {
        if (pending) storage.setItem(storageKey, JSON.stringify(pending));
        else storage.removeItem(storageKey);
      } catch (_) {}
    }

    function clearRetry() {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
    }

    function scheduleRetry() {
      if (destroyed || retryTimer || !authenticated || !pending || conflictOpen) return;
      const ceiling = Math.min(retryMax, retryBase * Math.pow(2, retryAttempt));
      retryAttempt += 1;
      const delay = Math.round(ceiling * (0.8 + Math.random() * 0.4));
      status("offline", `离线，${Math.ceil(delay / 1000)} 秒后重试`);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        flush();
      }, delay);
    }

    function enqueue(snapshot, delay) {
      if (destroyed) return generation;
      generation += 1;
      pending = { generation, state: clone(snapshot) };
      persist();
      status("saving", "等待同步");
      if (pushTimer) clearTimeout(pushTimer);
      clearRetry();
      if (authenticated) {
        pushTimer = setTimeout(() => {
          pushTimer = null;
          flush();
        }, typeof delay === "number" ? delay : baseDelay);
      }
      return generation;
    }

    async function resolveConflict(context) {
      if (typeof opts.onConflict !== "function") {
        status("offline", "同步冲突，等待处理");
        return "defer";
      }
      conflictOpen = true;
      try {
        return await opts.onConflict(context);
      } finally {
        conflictOpen = false;
      }
    }

    async function send(entry, force) {
      const sentGeneration = entry.generation;
      const sentRevision = revision;
      status("saving", "保存中");
      const result = await request("/api/v1/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(force ? { state: entry.state } : { rev: sentRevision, state: entry.state }),
        keepalive: Boolean(force && opts.keepalive)
      });
      const res = result.res || { ok: false, status: 0 };
      const body = result.body;

      if (res.status === 401) {
        authenticated = false;
        status("auth", "需登录");
        if (typeof opts.onAuthRequired === "function") opts.onAuthRequired();
        return { stopped: true };
      }
      if (res.status === 409) {
        const remoteRevision = body && Number(body.rev) >= 0 ? Number(body.rev) : revision;
        const action = await resolveConflict({
          localState: clone(entry.state),
          latestLocalState: pending ? clone(pending.state) : clone(entry.state),
          remoteState: body && body.state ? clone(body.state) : null,
          rev: remoteRevision,
          generation: sentGeneration
        });
        if (action === "local") {
          revision = remoteRevision;
          const latest = pending || entry;
          pending = latest;
          persist();
          return send(latest, true);
        }
        if (action === "remote") {
          revision = remoteRevision;
          pending = null;
          persist();
          if (body && body.state && typeof opts.onApplyRemote === "function") {
            await opts.onApplyRemote(clone(body.state), { rev: revision, reason: "conflict" });
          }
          retryAttempt = 0;
          status("ok", "已载入远端版本");
          return { applied: true };
        }
        status("offline", "同步冲突，等待处理");
        return { conflict: true };
      }
      if (!res.ok || !body) {
        if (res.status === 0 || res.status >= 500) scheduleRetry();
        else status("offline", `保存失败（HTTP ${res.status}）`);
        return { failed: true };
      }

      revision = Number(body.rev) >= 0 ? Number(body.rev) : revision;
      retryAttempt = 0;
      clearRetry();
      if (pending && pending.generation === sentGeneration) {
        pending = null;
        persist();
      }
      if (pending) {
        status("saving", "继续同步较新修改");
        return { more: true };
      }
      status("ok", "已同步");
      if (sentRevision === 0 && typeof opts.onFirstSync === "function") opts.onFirstSync();
      return { acknowledged: true };
    }

    function flush() {
      if (destroyed || !authenticated || !pending || conflictOpen) return Promise.resolve({ skipped: true });
      if (flight) return flight;
      if (pushTimer) clearTimeout(pushTimer);
      pushTimer = null;
      clearRetry();
      flight = (async () => {
        let result;
        while (pending && authenticated && !destroyed) {
          const entry = pending;
          result = await send(entry, false);
          if (!result.more) break;
        }
        return result || { skipped: true };
      })().finally(() => {
        flight = null;
      });
      return flight;
    }

    async function pull() {
      if (destroyed || !authenticated || pullFlight || conflictOpen) return { skipped: true };
      const flushed = await flush();
      if (pending || (flushed && flushed.conflict)) return { pending: true };
      pullFlight = (async () => {
        const result = await request("/api/v1/state");
        const res = result.res || { ok: false, status: 0 };
        const body = result.body;
        if (res.status === 401) {
          authenticated = false;
          status("auth", "需登录");
          if (typeof opts.onAuthRequired === "function") opts.onAuthRequired();
          return { auth: true };
        }
        if (!res.ok || !body) {
          status("offline", "暂时无法读取远端状态");
          return { failed: true };
        }
        revision = Number(body.rev) >= 0 ? Number(body.rev) : 0;
        if (body.state && typeof opts.onApplyRemote === "function") {
          await opts.onApplyRemote(clone(body.state), { rev: revision, reason: "pull" });
        } else if (!body.state) {
          const snapshot = typeof opts.getState === "function" ? opts.getState() : null;
          if (snapshot) enqueue(snapshot, 0);
        }
        if (!pending) status("ok", "已同步");
        return { ok: true, empty: !body.state };
      })().finally(() => {
        pullFlight = null;
      });
      return pullFlight;
    }

    async function reconnect() {
      const result = await flush();
      if (!pending && !(result && result.conflict)) await pull();
    }

    function setAuthenticated(value) {
      authenticated = Boolean(value);
      if (authenticated && pending) flush();
      return authenticated;
    }

    function canPull() {
      return authenticated && !pending && !flight && !pullFlight && !conflictOpen;
    }

    function getRevision() {
      return revision;
    }

    function hasPending() {
      return Boolean(pending);
    }

    function destroy() {
      destroyed = true;
      if (pushTimer) clearTimeout(pushTimer);
      clearRetry();
    }

    const restored = readOutbox();
    if (restored) {
      pending = restored;
      generation = restored.generation;
      status("saving", "已恢复待同步修改");
    }

    return {
      enqueue,
      schedulePush: enqueue,
      flush,
      pull,
      reconnect,
      setAuthenticated,
      canPull,
      getRevision,
      hasPending,
      destroy
    };
  }

  root.StudioloRemote = Object.freeze({ createSync });
})(typeof window !== "undefined" ? window : globalThis);
