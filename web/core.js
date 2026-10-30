(function (root) {
  "use strict";

  const GRID_COLS = 12;
  const ID_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9_.:-]{0,127}$/;
  const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  const FUNCTION_COLOR = /^(?:rgb|rgba|hsl|hsla)\(\s*[0-9.%+\-\s,]+\)$/i;
  const NAMED_COLORS = /^(?:transparent|black|white|red|green|blue|yellow|orange|purple|pink|gray|grey)$/i;

  function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function normalizeUrl(value, allowEmpty) {
    if (value === null || value === undefined || String(value).trim() === "") {
      return allowEmpty === false ? null : "";
    }
    try {
      const url = new URL(String(value).trim());
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      return url.href;
    } catch (_) {
      return null;
    }
  }

  function assertUrl(value, label, allowEmpty) {
    const normalized = normalizeUrl(value, allowEmpty);
    if (normalized === null) throw new Error(`${label || "URL"} 仅支持有效的 http(s) 地址`);
    return normalized;
  }

  function splitArgs(value) {
    const parts = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < value.length; i += 1) {
      const ch = value[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") depth -= 1;
      else if (ch === "," && depth === 0) {
        parts.push(value.slice(start, i).trim());
        start = i + 1;
      }
      if (depth < 0) return [];
    }
    if (depth !== 0) return [];
    parts.push(value.slice(start).trim());
    return parts;
  }

  function isSafeColor(value) {
    const color = String(value === null || value === undefined ? "" : value).trim();
    return Boolean(color) && (HEX_COLOR.test(color) || FUNCTION_COLOR.test(color) || NAMED_COLORS.test(color));
  }

  function isSafeGradient(value) {
    const input = String(value === null || value === undefined ? "" : value).trim();
    const match = input.match(/^(linear|radial|conic)-gradient\((.*)\)$/i);
    if (!match || /[;<>{}\\"'@]|url\s*\(|expression\s*\(|var\s*\(/i.test(input)) return false;
    const args = splitArgs(match[2]);
    if (args.length < 2) return false;
    return args.every((part) => {
      if (!part) return false;
      const tokens = part.split(/\s+/);
      let colors = 0;
      let cursor = 0;
      while (cursor < tokens.length) {
        const token = tokens[cursor];
        if (/^(?:rgb|rgba|hsl|hsla)\(/i.test(token)) {
          const color = tokens.slice(cursor).join(" ");
          const stop = color.match(/^(.*?)(\s+[+-]?(?:\d+(?:\.\d+)?%?|\.\d+%?)(?:\s+[+-]?(?:\d+(?:\.\d+)?%?|\.\d+%?))?)$/);
          if (stop && isSafeColor(stop[1])) {
            colors += 1;
            return true;
          }
          return isSafeColor(color) ? (colors += 1) > 0 : false;
        }
        if (isSafeColor(token)) {
          colors += 1;
          cursor += 1;
          continue;
        }
        if (!/^(?:to|at|from|in|closest-side|closest-corner|farthest-side|farthest-corner|circle|ellipse|center|top|right|bottom|left|longer|shorter|decreasing|increasing|oklab|oklch|srgb|srgb-linear|display-p3|a98-rgb|prophoto-rgb|rec2020|lab|lch|hsl|hwb|xyz|xyz-d50|xyz-d65|[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:deg|grad|rad|turn|%)?)$/i.test(token)) {
          return false;
        }
        cursor += 1;
      }
      return colors > 0 || args.indexOf(part) === 0;
    });
  }

  function safeColor(value, fallback) {
    const input = String(value === null || value === undefined ? "" : value).trim();
    if (isSafeColor(input) || isSafeGradient(input)) return input;
    return fallback === undefined ? "" : fallback;
  }

  function normalizeId(value, label) {
    const id = String(value === null || value === undefined ? "" : value).trim();
    if (!ID_PATTERN.test(id)) throw new Error(`${label || "项目"} ID 无效：${id || "(空)"}`);
    return id;
  }

  function finiteInteger(value, fallback, min, max) {
    const number = Number(value);
    const integer = Number.isFinite(number) ? Math.round(number) : fallback;
    return Math.max(min, Math.min(max, integer));
  }

  function rectsOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function placeItem(item, placed) {
    item.x = finiteInteger(item.x, 1, 1, GRID_COLS - item.w + 1);
    item.y = finiteInteger(item.y, 1, 1, 10000);
    const collides = (x, y) => placed.some((other) => rectsOverlap({ x, y, w: item.w, h: item.h }, other));
    if (!collides(item.x, item.y)) return;
    for (let y = 1; y <= 10000; y += 1) {
      for (let x = 1; x <= GRID_COLS - item.w + 1; x += 1) {
        if (!collides(x, y)) {
          item.x = x;
          item.y = y;
          return;
        }
      }
    }
    throw new Error("布局空间不足");
  }

  function normalizeCoordinates(layout) {
    const placed = [];
    layout.forEach((item) => {
      placeItem(item, placed);
      placed.push(item);
    });
    return layout;
  }

  function normalizeMobileRect(value, fallbackW, fallbackH) {
    if (!isObject(value)) return undefined;
    return {
      x: finiteInteger(value.x, 1, 1, 4),
      y: finiteInteger(value.y, 1, 1, 10000),
      w: finiteInteger(value.w, fallbackW, 1, 4),
      h: finiteInteger(value.h, fallbackH, 1, 100)
    };
  }

  function normalizeState(input, options) {
    const opts = options || {};
    if (!isObject(input)) throw new Error("配置根节点必须是对象");
    if (input.layout !== undefined && !Array.isArray(input.layout)) throw new Error("layout 必须是数组");
    if (input.apps !== undefined && !Array.isArray(input.apps)) throw new Error("apps 必须是数组");
    if (input.profile !== undefined && !isObject(input.profile)) throw new Error("profile 必须是对象");

    let source;
    try {
      source = clone(input);
    } catch (_) {
      throw new Error("配置包含无法序列化的数据");
    }
    const next = {
      version: String(source.version || "5.0"),
      profile: isObject(source.profile) ? source.profile : {},
      layout: Array.isArray(source.layout) ? source.layout : [],
      apps: Array.isArray(source.apps) ? source.apps : []
    };

    const appIds = new Set();
    next.apps = next.apps.map((raw, index) => {
      if (!isObject(raw)) throw new Error(`apps[${index}] 必须是对象`);
      const app = raw;
      app.id = normalizeId(app.id, `apps[${index}]`);
      if (appIds.has(app.id)) throw new Error(`应用 ID 重复：${app.id}`);
      appIds.add(app.id);
      app.name = String(app.name || "未命名应用");
      app.desc = String(app.desc || "");
      app.href = opts.repair ? normalizeUrl(app.href) || "" : assertUrl(app.href, `应用 ${app.id} 的 URL`, true);
      app.logoUrl = opts.repair ? normalizeUrl(app.logoUrl) || "" : assertUrl(app.logoUrl, `应用 ${app.id} 的 Logo URL`, true);
      app.containerId = String(app.containerId || "desktop").trim() || "desktop";
      app.icon = String(app.icon || "globe");
      app.color = safeColor(app.color);
      app.status = ["online", "offline", "lan"].includes(app.status) ? app.status : "online";
      app.note = String(app.note || "");
      app.port = String(app.port || "");
      app.useSiteLogo = app.useSiteLogo !== false;
      app.pinned = Boolean(app.pinned);
      app.clicks = finiteInteger(app.clicks, 0, 0, Number.MAX_SAFE_INTEGER);
      return app;
    });

    const layoutIds = new Set();
    const containerIds = new Set();
    next.layout.forEach((raw, index) => {
      if (!isObject(raw)) throw new Error(`layout[${index}] 必须是对象`);
      raw.id = normalizeId(raw.id, `layout[${index}]`);
      if (layoutIds.has(raw.id)) throw new Error(`布局 ID 重复：${raw.id}`);
      layoutIds.add(raw.id);
      if (raw.kind === "widget" && ["server-node", "app-folder"].includes(raw.widgetType)) containerIds.add(raw.id);
    });

    next.layout = next.layout.filter((item, index) => {
      if (item.kind === "app") {
        if (!appIds.has(String(item.appId || ""))) {
          if (opts.repair) return false;
          throw new Error(`layout[${index}] 引用了不存在的应用`);
        }
        item.appId = String(item.appId);
        item.w = 1;
        item.h = 1;
        item.mobile = normalizeMobileRect(item.mobile, 1, 1);
        return true;
      }
      if (item.kind !== "widget") {
        if (opts.repair) return false;
        throw new Error(`layout[${index}] kind 无效`);
      }
      item.widgetType = String(item.widgetType || "");
      item.config = item.config === undefined ? {} : item.config;
      if (!isObject(item.config)) throw new Error(`组件 ${item.id} 的 config 必须是对象`);
      item.w = finiteInteger(item.w, 4, 1, GRID_COLS);
      item.h = finiteInteger(item.h, 2, 1, 100);
      item.mobile = normalizeMobileRect(item.mobile, Math.min(4, item.w), item.h);
      if (item.widgetType === "calendar") {
        ["icsUrl", "caldavUrl"].forEach((key) => {
          if (!item.config[key]) item.config[key] = "";
          else item.config[key] = opts.repair
            ? normalizeUrl(item.config[key]) || ""
            : assertUrl(item.config[key], `日历 ${item.id} 的 ${key}`, true);
        });
        if (item.config.icsUrl && item.config.caldavUrl) throw new Error(`日历 ${item.id} 只能选择一种日程来源`);
        Object.keys(item.config).forEach((key) => {
          if (["password", "token", "secret", "authorization"].includes(key.toLowerCase())) {
            throw new Error("CalDAV 凭据只能配置在服务端环境变量");
          }
        });
      }
      return true;
    });

    next.apps.forEach((app) => {
      if (app.containerId !== "desktop" && !containerIds.has(app.containerId)) {
        if (!opts.repair) throw new Error(`应用 ${app.id} 引用了不存在的容器 ${app.containerId}`);
        app.containerId = "desktop";
      }
      if (app.containerId === "desktop" && !next.layout.some((item) => item.kind === "app" && item.appId === app.id)) {
        let layoutId = `bare-${app.id}`;
        let suffix = 2;
        while (layoutIds.has(layoutId)) layoutId = `bare-${app.id}-${suffix++}`;
        layoutIds.add(layoutId);
        next.layout.push({ id: layoutId, kind: "app", appId: app.id, x: 1, y: 1, w: 1, h: 1 });
      }
    });

    normalizeCoordinates(next.layout);
    if (next.profile.customWallpaperUrl) {
      next.profile.customWallpaperUrl = opts.repair
        ? normalizeUrl(next.profile.customWallpaperUrl) || ""
        : assertUrl(next.profile.customWallpaperUrl, "自定义壁纸 URL", true);
    } else {
      next.profile.customWallpaperUrl = "";
    }

    if (source.plugins !== undefined && !Array.isArray(source.plugins)) throw new Error("plugins 必须是数组");
    const pluginDefinitions = Array.isArray(source.plugins) ? source.plugins : [];
    if (pluginDefinitions.length) {
      if (!root.StudioloWidgets || typeof root.StudioloWidgets.normalizeDefinitions !== "function") {
        throw new Error("插件运行时未加载，无法校验 plugins");
      }
      next.plugins = root.StudioloWidgets.normalizeDefinitions(pluginDefinitions);
    } else {
      next.plugins = [];
    }
    if (opts._skipWorkspaces) return next;

    if (source.workspaces !== undefined && !Array.isArray(source.workspaces)) throw new Error("workspaces 必须是数组");
    const workspaces = Array.isArray(source.workspaces) ? source.workspaces : [];
    const workspaceIds = new Set();
    next.workspaces = workspaces.map((workspace, index) => {
      if (!isObject(workspace)) throw new Error(`workspaces[${index}] 必须是对象`);
      const id = normalizeId(workspace.id, `workspaces[${index}]`);
      if (workspaceIds.has(id)) throw new Error(`工作区 ID 重复：${id}`);
      workspaceIds.add(id);
      if (!Array.isArray(workspace.layout) || !Array.isArray(workspace.apps)) {
        throw new Error(`工作区 ${id} 的 layout/apps 必须是数组`);
      }
      const normalized = normalizeState({
        version: next.version,
        profile: {},
        layout: workspace.layout,
        apps: workspace.apps,
        plugins: []
      }, { repair: opts.repair, _skipWorkspaces: true });
      return {
        id,
        name: String(workspace.name || `工作区 ${index + 1}`).trim() || `工作区 ${index + 1}`,
        layout: normalized.layout,
        apps: normalized.apps
      };
    });
    if (!next.workspaces.length) {
      const id = normalizeId(next.profile.activeWorkspaceId || "workspace-default", "默认工作区");
      next.workspaces = [{ id, name: "主桌面", layout: next.layout, apps: next.apps }];
      workspaceIds.add(id);
    }
    const requestedActive = String(next.profile.activeWorkspaceId || next.workspaces[0].id);
    if (!workspaceIds.has(requestedActive) && !opts.repair) throw new Error(`活动工作区不存在：${requestedActive}`);
    const activeId = workspaceIds.has(requestedActive) ? requestedActive : next.workspaces[0].id;
    next.profile.activeWorkspaceId = activeId;
    const active = next.workspaces.find((workspace) => workspace.id === activeId);
    next.layout = active.layout;
    next.apps = active.apps;

    const pluginIds = new Set(next.plugins.map((plugin) => plugin.id));
    next.workspaces.forEach((workspace) => {
      workspace.layout.forEach((item) => {
        if (item.kind !== "widget" || item.widgetType !== "plugin") return;
        const pluginId = item.config && item.config.pluginId;
        if (!pluginIds.has(pluginId)) throw new Error(`布局 ${item.id} 引用了不存在的插件 ${pluginId || "(空)"}`);
      });
    });
    return next;
  }

  function yamlScalar(value) {
    if (value === null || value === undefined) return '""';
    if (typeof value === "boolean" || typeof value === "number") return String(value);
    return JSON.stringify(String(value));
  }

  function exportYaml(state) {
    const st = normalizeState(state, { repair: true });
    const lines = ["# Studiolo 桌面 2D 坐标与主题配置文件", `version: ${yamlScalar(st.version)}`, "profile:"];
    Object.keys(st.profile).forEach((key) => {
      if (!/^[A-Za-z0-9_]+$/.test(key)) return;
      if (key === "themeCustom") lines.push(`  themeCustomJson: ${yamlScalar(JSON.stringify(st.profile[key] || {}))}`);
      else if (key === "themeWallpaper") lines.push(`  themeWallpaperJson: ${yamlScalar(JSON.stringify(st.profile[key] || null))}`);
      else lines.push(`  ${key}: ${yamlScalar(st.profile[key])}`);
    });
    lines.push("layout:");
    st.layout.forEach((item) => {
      lines.push(`  - id: ${yamlScalar(item.id)}`);
      lines.push(`    kind: ${yamlScalar(item.kind)}`);
      lines.push(`    x: ${item.x}`, `    y: ${item.y}`, `    w: ${item.w}`, `    h: ${item.h}`);
      if (item.mobile) lines.push(`    mobileJson: ${yamlScalar(JSON.stringify(item.mobile))}`);
      if (item.kind === "app") lines.push(`    appId: ${yamlScalar(item.appId)}`);
      else {
        lines.push(`    widgetType: ${yamlScalar(item.widgetType)}`);
        lines.push(`    configJson: ${yamlScalar(JSON.stringify(item.config || {}))}`);
      }
    });
    lines.push("apps:");
    st.apps.forEach((app) => {
      [
        "id", "name", "desc", "href", "containerId", "icon", "logoUrl",
        "color", "status", "port", "note"
      ].forEach((key, index) => {
        lines.push(`  ${index === 0 ? "-" : " "} ${key}: ${yamlScalar(app[key] || (key === "containerId" ? "desktop" : ""))}`);
      });
      lines.push(`    useSiteLogo: ${app.useSiteLogo !== false}`);
      lines.push(`    pinned: ${Boolean(app.pinned)}`);
      lines.push(`    clicks: ${finiteInteger(app.clicks, 0, 0, Number.MAX_SAFE_INTEGER)}`);
    });
    lines.push(`pluginsJson: ${yamlScalar(JSON.stringify(st.plugins || []))}`);
    lines.push(`workspacesJson: ${yamlScalar(JSON.stringify(st.workspaces || []))}`);
    return lines.join("\n") + "\n";
  }

  function parseScalar(raw) {
    const text = String(raw || "").trim();
    if (!text) return "";
    if (text[0] === '"') {
      try {
        const value = JSON.parse(text);
        if (typeof value !== "string") throw new Error("字符串标量无效");
        return value;
      } catch (_) {
        throw new Error(`YAML 字符串引号或转义无效：${text}`);
      }
    }
    if (text[0] === "'") {
      if (!text.endsWith("'")) throw new Error("YAML 单引号字符串未闭合");
      return text.slice(1, -1).replace(/''/g, "'");
    }
    if (text === "true") return true;
    if (text === "false") return false;
    if (text === "null") return null;
    if (text === "[]") return [];
    if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
    if (/[:#\n{}\[\],&*!|>%@`]/.test(text)) throw new Error(`YAML 标量需要加引号：${text}`);
    return text;
  }

  function parseYaml(text) {
    const yamlText = String(text || "");
    const trimmed = yamlText.trim();
    if (!trimmed) throw new Error("配置内容为空");
    if (trimmed[0] === "{") {
      const parsed = JSON.parse(trimmed);
      return normalizeState(parsed);
    }

    const next = { version: "5.0", profile: {}, layout: [], apps: [] };
    let section = null;
    let current = null;
    yamlText.split(/\r?\n/).forEach((rawLine, lineIndex) => {
      const line = rawLine.replace(/\s+$/, "");
      if (!line.trim() || line.trim()[0] === "#") return;
      const jsonSection = line.match(/^(pluginsJson|workspacesJson)\s*:\s*(.*)$/);
      if (jsonSection) {
        const key = jsonSection[1] === "pluginsJson" ? "plugins" : "workspaces";
        try {
          next[key] = JSON.parse(String(parseScalar(jsonSection[2])));
        } catch (_) {
          throw new Error(`第 ${lineIndex + 1} 行 ${jsonSection[1]} 损坏`);
        }
        if (!Array.isArray(next[key])) throw new Error(`${jsonSection[1]} 必须是数组`);
        section = null;
        current = null;
        return;
      }
      const sectionMatch = line.match(/^(version|profile|layout|apps)\s*:\s*(.*)$/);
      if (sectionMatch) {
        const key = sectionMatch[1];
        if (key === "version") next.version = String(parseScalar(sectionMatch[2]));
        else {
          section = key;
          current = null;
          if (sectionMatch[2] && parseScalar(sectionMatch[2]).length !== 0) {
            throw new Error(`第 ${lineIndex + 1} 行的 ${key} 仅支持空数组 []`);
          }
        }
        return;
      }
      if (!section) throw new Error(`第 ${lineIndex + 1} 行不属于有效配置段`);
      if (section === "profile") {
        const match = line.match(/^\s+([A-Za-z0-9_]+)\s*:\s*(.*)$/);
        if (!match) throw new Error(`第 ${lineIndex + 1} 行 profile 格式无效`);
        if (match[1] === "themeCustomJson" || match[1] === "themeWallpaperJson") {
          const key = match[1] === "themeCustomJson" ? "themeCustom" : "themeWallpaper";
          const json = String(parseScalar(match[2]));
          try {
            next.profile[key] = json.trim() ? JSON.parse(json) : (key === "themeCustom" ? {} : null);
          } catch (_) {
            throw new Error(`第 ${lineIndex + 1} 行 ${match[1]} 损坏`);
          }
          if (key === "themeCustom" && !isObject(next.profile[key])) throw new Error("themeCustomJson 必须是对象");
          if (key === "themeWallpaper" && next.profile[key] !== null && !isObject(next.profile[key])) {
            throw new Error("themeWallpaperJson 必须是对象或 null");
          }
        } else next.profile[match[1]] = parseScalar(match[2]);
        return;
      }
      const itemStart = line.match(/^\s*-\s+([A-Za-z0-9_]+)\s*:\s*(.*)$/);
      if (itemStart) {
        current = {};
        current[itemStart[1]] = parseScalar(itemStart[2]);
        next[section].push(current);
        return;
      }
      const property = line.match(/^\s+([A-Za-z0-9_]+)\s*:\s*(.*)$/);
      if (!property || !current) throw new Error(`第 ${lineIndex + 1} 行列表属性格式无效`);
      const key = property[1];
      const value = parseScalar(property[2]);
      if (key === "configJson" || key === "mobileJson") {
        const json = String(value);
        const targetKey = key === "configJson" ? "config" : "mobile";
        try {
          current[targetKey] = JSON.parse(json);
        } catch (_) {
          throw new Error(`第 ${lineIndex + 1} 行 ${key} 损坏`);
        }
        if (!isObject(current[targetKey])) throw new Error(`第 ${lineIndex + 1} 行 ${key} 必须是对象`);
      } else current[key] = value;
    });
    return normalizeState(next);
  }

  root.StudioloCore = Object.freeze({
    clone,
    normalizeUrl,
    assertUrl,
    isSafeColor,
    isSafeGradient,
    safeColor,
    normalizeId,
    normalizeCoordinates,
    normalizeState,
    exportYaml,
    stateToYaml: exportYaml,
    parseYaml,
    importState: parseYaml
  });
})(typeof window !== "undefined" ? window : globalThis);
