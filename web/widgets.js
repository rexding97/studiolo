(function (root) {
  "use strict";

  const TYPE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
  const ID_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9_.:-]{0,127}$/;
  const BUILT_IN_TYPES = Object.freeze([
    "server-node",
    "app-folder",
    "weather",
    "calendar",
    "notes",
    "clock-metric"
  ]);
  const DECLARATIVE_TYPES = Object.freeze(["text", "links", "image", "countdown", "iframe"]);
  const IFRAME_SANDBOX = "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox";
  const limits = Object.freeze({
    name: 80,
    description: 300,
    url: 2048,
    text: 20000,
    links: 50,
    images: 20,
    label: 120
  });

  let documentOverride = null;
  const cleanupRecords = new Set();
  let cleanupObserver = null;

  function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function cloneData(value, path, depth, ancestors) {
    const location = path || "data";
    const level = depth || 0;
    if (level > 16) throw new Error(`${location} 嵌套过深`);
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error(`${location} 包含无效数字`);
      return value;
    }
    if (typeof value !== "object") throw new Error(`${location} 必须是可序列化的纯数据`);
    const seen = ancestors || [];
    if (seen.indexOf(value) !== -1) throw new Error(`${location} 包含循环引用`);
    const nextSeen = seen.concat([value]);
    if (Array.isArray(value)) {
      return value.map((entry, index) => cloneData(entry, `${location}[${index}]`, level + 1, nextSeen));
    }
    if (!isPlainObject(value)) throw new Error(`${location} 必须是普通对象`);
    const output = {};
    Object.keys(value).forEach((key) => {
      if (["__proto__", "prototype", "constructor"].includes(key)) {
        throw new Error(`${location} 包含保留字段 ${key}`);
      }
      output[key] = cloneData(value[key], `${location}.${key}`, level + 1, nextSeen);
    });
    return output;
  }

  function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.keys(value).forEach((key) => deepFreeze(value[key]));
    return Object.freeze(value);
  }

  function requiredString(value, label, maxLength, allowEmpty) {
    if (typeof value !== "string") throw new Error(`${label} 必须是字符串`);
    const text = value.trim();
    if (!allowEmpty && !text) throw new Error(`${label} 不能为空`);
    if (value.length > maxLength) throw new Error(`${label} 不能超过 ${maxLength} 个字符`);
    return allowEmpty ? value : text;
  }

  function optionalString(value, fallback, label, maxLength) {
    if (value === undefined || value === null) return fallback;
    return requiredString(value, label, maxLength, true);
  }

  function normalizeInteger(value, fallback, label, min, max) {
    if (value === undefined || value === null || value === "") {
      if (fallback === undefined) throw new Error(`${label} 不能为空`);
      return fallback;
    }
    if (typeof value === "boolean" || (typeof value !== "number" && typeof value !== "string")) {
      throw new Error(`${label} 必须是整数`);
    }
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) {
      throw new Error(`${label} 必须是 ${min} 到 ${max} 之间的整数`);
    }
    return number;
  }

  function normalizeSize(value, fallback) {
    const size = value === undefined ? fallback : value;
    if (!isPlainObject(size)) throw new Error("defaultSize 必须是对象");
    return {
      w: normalizeInteger(size.w, undefined, "defaultSize.w", 1, 12),
      h: normalizeInteger(size.h, undefined, "defaultSize.h", 1, 100)
    };
  }

  function normalizeHttpUrl(value) {
    if (typeof value !== "string") return null;
    const text = value.trim();
    if (!text || text.length > limits.url || /[\u0000-\u0020\u007f]/.test(text)) return null;
    const URLConstructor = root.URL || (typeof URL !== "undefined" ? URL : null);
    if (URLConstructor) {
      try {
        const url = new URLConstructor(text);
        if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return null;
        return url.href;
      } catch (_) {
        return null;
      }
    }
    const match = text.match(/^https?:\/\/([^\/?#]+)(?:[/?#]|$)/i);
    if (!match) return null;
    const authority = match[1];
    if (!/^(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i.test(authority)) return null;
    const port = authority.match(/:(\d{1,5})$/);
    if (port && Number(port[1]) > 65535) return null;
    return text;
  }

  function requireHttpUrl(value, label) {
    const url = normalizeHttpUrl(value);
    if (!url) throw new Error(`${label} 仅支持有效的 http(s) URL`);
    return url;
  }

  function assertKnownKeys(value, allowed, label) {
    Object.keys(value).forEach((key) => {
      if (!allowed.includes(key)) throw new Error(`${label} 包含未知字段 ${key}`);
    });
  }

  function field(type, label, defaultValue, extra) {
    const descriptor = Object.assign({ type, label }, extra || {});
    if (defaultValue !== undefined) descriptor.default = defaultValue;
    return descriptor;
  }

  function schemaFields(schema) {
    const defaults = {};
    Object.keys(schema).forEach((key) => {
      if (schema[key].default !== undefined) defaults[key] = schema[key].default;
    });
    return defaults;
  }

  function metadata(type, name, description, icon, w, h, schema, runtime) {
    return {
      type,
      name,
      description,
      icon,
      defaultSize: { w, h },
      configSchema: schema,
      defaultConfig: schemaFields(schema),
      runtime: runtime || "cloudos-adapter"
    };
  }

  const builtInMetadata = [
    metadata("server-node", "服务器主机", "展示主机状态并承载应用图标", "server", 4, 2, {
      title: field("string", "组件标题", "新服务器节点", { maxLength: 80 }),
      badge: field("string", "状态徽章", "算力节点", { maxLength: 80 }),
      ip: field("string", "公网 IP", "192.168.1.x", { maxLength: 128 }),
      lanIp: field("string", "内网 IP", "192.168.1.x", { maxLength: 128 }),
      role: field("string", "节点描述", "自定义服务器描述", { maxLength: 200 }),
      pingMs: field("number", "延迟（毫秒）", 12, { min: 0 }),
      cpu: field("string", "CPU", "15%", { maxLength: 32 }),
      mem: field("string", "内存", "40%", { maxLength: 32 }),
      disk: field("string", "磁盘", "--", { maxLength: 32 }),
      uptime: field("string", "运行时间", "10d", { maxLength: 64 }),
      sortBy: field("select", "应用排序", "order", { options: ["order", "clicks"] }),
      sshUser: field("string", "SSH 用户名", "root", { maxLength: 64 }),
      sshPort: field("number", "SSH 端口", 22, { min: 1, max: 65535 })
    }, "server-metrics"),
    metadata("app-folder", "应用文件夹", "归纳一组网站或应用", "folder", 4, 2, {
      title: field("string", "组件标题", "精选收藏夹", { maxLength: 80 }),
      badge: field("string", "状态徽章", "书签集合", { maxLength: 80 }),
      subtitle: field("string", "副标题", "可将任意图标拖入或拖出", { maxLength: 200 }),
      sortBy: field("select", "应用排序", "order", { options: ["order", "clicks"] })
    }),
    metadata("weather", "实时天气", "展示城市天气与多日预报", "weather", 3, 2, {
      title: field("string", "组件标题", "实时天气", { maxLength: 80 }),
      city: field("string", "城市", "南京 · 鼓楼", { maxLength: 120 }),
      temp: field("string", "温度", "21°", { maxLength: 32 }),
      condition: field("string", "天气状况", "晴间多云", { maxLength: 80 }),
      range: field("string", "温度范围", "最高 24° · 最低 15°", { maxLength: 80 }),
      humidity: field("string", "湿度", "60%", { maxLength: 32 })
    }, "weather"),
    metadata("calendar", "月历日程", "展示公历与真实 ICS / CalDAV 事件", "calendar", 3, 2, {
      title: field("string", "组件标题", "月历日程", { maxLength: 80 }),
      badge: field("string", "状态徽章", "本机日历", { maxLength: 80 }),
      icsUrl: field("url", "ICS URL（与 CalDAV 二选一）", "", { required: false }),
      caldavUrl: field("url", "CalDAV URL（凭据仅在服务端 env 配置）", "", { required: false })
    }, "calendar"),
    metadata("notes", "随手便签", "持久化保存备忘录文本", "notes", 3, 2, {
      title: field("string", "组件标题", "随手便签", { maxLength: 80 }),
      badge: field("string", "状态徽章", "自动保存", { maxLength: 80 }),
      text: field("textarea", "便签内容", "", { maxLength: 20000 })
    }),
    metadata("clock-metric", "数字时钟", "展示本地时间与状态信息", "clock", 3, 1, {
      title: field("string", "组件标题", "数字时钟", { maxLength: 80 }),
      badge: field("string", "状态徽章", "本地时间", { maxLength: 80 }),
      subtitle: field("string", "副标题", "自动更新", { maxLength: 200 })
    })
  ];

  const declarativeMetadata = [
    metadata("text", " Markdown 文本", "安全渲染文本与 Markdown 子集", "text", 3, 2, {
      content: field("textarea", "文本内容", "", { maxLength: limits.text }),
      markdown: field("boolean", "启用 Markdown", true)
    }, "declarative"),
    metadata("links", "链接集合", "渲染安全的外部链接", "links", 3, 2, {
      links: field("array", "链接", [], { maxItems: limits.links })
    }, "declarative"),
    metadata("image", "图片 / 轮播", "展示单张图片或自动轮播", "image", 4, 2, {
      images: field("array", "图片", [], { maxItems: limits.images }),
      intervalMs: field("number", "轮播间隔（毫秒）", 5000, { min: 1000, max: 60000 }),
      autoplay: field("boolean", "自动轮播", true)
    }, "declarative"),
    metadata("countdown", "倒计时", "展示距离目标时间的剩余时间", "countdown", 3, 1, {
      target: field("datetime", "目标时间", undefined, { required: true }),
      expiredText: field("string", "到期文本", "已到期", { maxLength: limits.label })
    }, "declarative"),
    metadata("iframe", "嵌入页面", "在受限沙箱中嵌入 http(s) 页面", "iframe", 6, 3, {
      url: field("url", "页面 URL", undefined, { required: true })
    }, "declarative")
  ];

  function createRegistry() {
    const plugins = new Map();

    function register(plugin, options) {
      if (!isPlainObject(plugin)) throw new Error("插件定义必须是对象");
      const type = requiredString(plugin.type, "插件 type", 64, false);
      if (!TYPE_PATTERN.test(type)) throw new Error(`插件 type 无效：${type}`);
      if (typeof plugin.render !== "function") throw new Error(`插件 ${type} 必须提供 render(ctx)`);
      if (plugin.update !== undefined && typeof plugin.update !== "function") {
        throw new Error(`插件 ${type} 的 update 必须是函数`);
      }
      if (plugins.has(type) && !(options && options.replace === true)) {
        throw new Error(`插件 ${type} 已注册`);
      }
      const normalized = {
        type,
        name: requiredString(plugin.name, `插件 ${type} 的 name`, limits.name, false),
        description: optionalString(plugin.description, "", `插件 ${type} 的 description`, limits.description),
        icon: requiredString(plugin.icon, `插件 ${type} 的 icon`, 64, false),
        defaultSize: normalizeSize(plugin.defaultSize),
        configSchema: cloneData(plugin.configSchema, `插件 ${type} 的 configSchema`),
        defaultConfig: cloneData(plugin.defaultConfig || {}, `插件 ${type} 的 defaultConfig`),
        runtime: requiredString(plugin.runtime, `插件 ${type} 的 runtime`, 64, false),
        render: plugin.render
      };
      if (!isPlainObject(normalized.configSchema)) throw new Error(`插件 ${type} 的 configSchema 必须是对象`);
      if (!isPlainObject(normalized.defaultConfig)) throw new Error(`插件 ${type} 的 defaultConfig 必须是对象`);
      if (plugin.update) normalized.update = plugin.update;
      const frozen = deepFreeze(normalized);
      plugins.set(type, frozen);
      return frozen;
    }

    function get(type) {
      return plugins.get(type);
    }

    function has(type) {
      return plugins.has(type);
    }

    function list() {
      return Array.from(plugins.values());
    }

    return Object.freeze({ register, get, list, has });
  }

  const registry = createRegistry();

  function getDocument() {
    if (documentOverride) return documentOverride;
    if (root.document) return root.document;
    throw new Error("插件渲染需要 DOM document");
  }

  function element(tagName, className, text) {
    const node = getDocument().createElement(tagName);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function appendText(parent, text) {
    parent.appendChild(getDocument().createTextNode(String(text)));
  }

  function createShell(type, name, item) {
    const size = item && item.w && item.h
      ? { w: item.w, h: item.h }
      : (registry.get(type) || { defaultSize: { w: 3, h: 2 } }).defaultSize;
    const shell = element("section", `widget-shell plugin-widget plugin-${type} w-${size.w} h-${size.h}`);
    shell.dataset.widgetType = type;
    if (item && item.id) shell.dataset.itemId = String(item.id);
    const top = element("div", "widget-topbar");
    const titleArea = element("div", "widget-title-area");
    titleArea.appendChild(element("span", "widget-title", name));
    top.appendChild(titleArea);
    shell.appendChild(top);
    return shell;
  }

  function renderAdapterPlaceholder(ctx) {
    const definition = registry.get(ctx.item.widgetType);
    const shell = createShell(definition.type, ctx.config.title || definition.name, ctx.item);
    shell.className += " plugin-adapter-pending";
    shell.appendChild(element("p", "plugin-adapter-message", "等待 CloudOS 渲染适配"));
    return shell;
  }

  function defaultOpenUrl(url) {
    if (typeof root.open !== "function") return;
    const opened = root.open(url, "_blank", "noopener,noreferrer");
    if (opened) opened.opener = null;
  }

  function createContext(type, context) {
    const source = context || {};
    const item = source.item || {
      id: "",
      kind: "widget",
      widgetType: type,
      config: source.config || {}
    };
    return {
      item,
      config: source.config || item.config || {},
      save: typeof source.save === "function" ? source.save : function () {},
      rerender: typeof source.rerender === "function" ? source.rerender : function () {},
      plugins: source.plugins || api,
      openUrl: typeof source.openUrl === "function" ? source.openUrl : defaultOpenUrl
    };
  }

  function render(type, context) {
    const plugin = registry.get(type);
    if (!plugin) throw new Error(`未注册的插件类型：${type}`);
    const ctx = createContext(type, context);
    const node = plugin.render(ctx);
    if (!node || node.nodeType !== 1) throw new Error(`插件 ${type} 的 render(ctx) 必须返回 DOM 元素`);
    return node;
  }

  function bindSafeLink(anchor, url, ctx) {
    if (anchor.__pluginOpenUrl) anchor.removeEventListener("click", anchor.__pluginOpenUrl);
    anchor.href = url;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.__pluginOpenUrl = function (event) {
      event.preventDefault();
      ctx.openUrl(url, ctx.item);
    };
    anchor.addEventListener("click", anchor.__pluginOpenUrl);
  }

  function appendInlineMarkdown(parent, text, ctx) {
    const pattern = /(\[([^\]\n]{1,500})\]\(([^)\s]+)\)|`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_)/g;
    let cursor = 0;
    let match;
    while ((match = pattern.exec(text))) {
      if (match.index > cursor) appendText(parent, text.slice(cursor, match.index));
      if (match[2] !== undefined) {
        const url = normalizeHttpUrl(match[3]);
        if (url) {
          const anchor = element("a", "plugin-markdown-link");
          anchor.textContent = match[2];
          bindSafeLink(anchor, url, ctx);
          parent.appendChild(anchor);
        } else {
          appendText(parent, match[2]);
        }
      } else if (match[4] !== undefined) {
        parent.appendChild(element("code", "plugin-markdown-code", match[4]));
      } else if (match[5] !== undefined || match[6] !== undefined) {
        parent.appendChild(element("strong", "plugin-markdown-strong", match[5] !== undefined ? match[5] : match[6]));
      } else {
        parent.appendChild(element("em", "plugin-markdown-emphasis", match[7] !== undefined ? match[7] : match[8]));
      }
      cursor = pattern.lastIndex;
    }
    if (cursor < text.length) appendText(parent, text.slice(cursor));
  }

  function renderMarkdown(parent, content, ctx) {
    const lines = content.replace(/\r\n?/g, "\n").split("\n");
    let paragraph = [];
    let list = null;

    function flushParagraph() {
      if (!paragraph.length) return;
      const node = element("p", "plugin-text-paragraph");
      appendInlineMarkdown(node, paragraph.join("\n"), ctx);
      parent.appendChild(node);
      paragraph = [];
    }

    function flushList() {
      if (!list) return;
      parent.appendChild(list.node);
      list = null;
    }

    lines.forEach((line) => {
      if (!line.trim()) {
        flushParagraph();
        flushList();
        return;
      }
      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      const unordered = line.match(/^\s*[-+]\s+(.+)$/) || line.match(/^\s*\*\s+(.+)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      const quote = line.match(/^\s*>\s?(.+)$/);
      if (heading) {
        flushParagraph();
        flushList();
        const node = element(`h${heading[1].length + 2}`, "plugin-text-heading");
        appendInlineMarkdown(node, heading[2], ctx);
        parent.appendChild(node);
      } else if (unordered || ordered) {
        flushParagraph();
        const kind = unordered ? "ul" : "ol";
        if (!list || list.kind !== kind) {
          flushList();
          list = { kind, node: element(kind, "plugin-text-list") };
        }
        const item = element("li", "plugin-text-list-item");
        appendInlineMarkdown(item, (unordered || ordered)[1], ctx);
        list.node.appendChild(item);
      } else if (quote) {
        flushParagraph();
        flushList();
        const node = element("blockquote", "plugin-text-quote");
        appendInlineMarkdown(node, quote[1], ctx);
        parent.appendChild(node);
      } else {
        flushList();
        paragraph.push(line);
      }
    });
    flushParagraph();
    flushList();
  }

  function normalizeText(config) {
    assertKnownKeys(config, ["content", "markdown"], "text.config");
    if (config.markdown !== undefined && typeof config.markdown !== "boolean") {
      throw new Error("text.config.markdown 必须是布尔值");
    }
    return {
      content: optionalString(config.content, "", "text.config.content", limits.text),
      markdown: config.markdown !== false
    };
  }

  function normalizeLinks(config) {
    assertKnownKeys(config, ["links"], "links.config");
    const links = config.links === undefined ? [] : config.links;
    if (!Array.isArray(links) || links.length > limits.links) {
      throw new Error(`links.config.links 必须是最多 ${limits.links} 项的数组`);
    }
    return {
      links: links.map((link, index) => {
        if (!isPlainObject(link)) throw new Error(`links.config.links[${index}] 必须是对象`);
        assertKnownKeys(link, ["label", "url", "description"], `links.config.links[${index}]`);
        return {
          label: requiredString(link.label, `links.config.links[${index}].label`, limits.label, false),
          url: requireHttpUrl(link.url, `links.config.links[${index}].url`),
          description: optionalString(link.description, "", `links.config.links[${index}].description`, limits.description)
        };
      })
    };
  }

  function normalizeImage(config) {
    assertKnownKeys(config, ["url", "alt", "href", "images", "intervalMs", "autoplay"], "image.config");
    if (config.url !== undefined && config.images !== undefined) {
      throw new Error("image.config 不能同时提供 url 和 images");
    }
    const images = config.images !== undefined
      ? config.images
      : (config.url !== undefined ? [{ url: config.url, alt: config.alt, href: config.href }] : []);
    if (!Array.isArray(images) || images.length < 1 || images.length > limits.images) {
      throw new Error(`image.config.images 必须包含 1 到 ${limits.images} 张图片`);
    }
    if (config.autoplay !== undefined && typeof config.autoplay !== "boolean") {
      throw new Error("image.config.autoplay 必须是布尔值");
    }
    return {
      images: images.map((image, index) => {
        const value = typeof image === "string" ? { url: image } : image;
        if (!isPlainObject(value)) throw new Error(`image.config.images[${index}] 必须是 URL 或对象`);
        assertKnownKeys(value, ["url", "alt", "href"], `image.config.images[${index}]`);
        return {
          url: requireHttpUrl(value.url, `image.config.images[${index}].url`),
          alt: optionalString(value.alt, "", `image.config.images[${index}].alt`, limits.description),
          href: value.href ? requireHttpUrl(value.href, `image.config.images[${index}].href`) : ""
        };
      }),
      intervalMs: normalizeInteger(config.intervalMs, 5000, "image.config.intervalMs", 1000, 60000),
      autoplay: config.autoplay !== false
    };
  }

  function normalizeTarget(value) {
    const target = requiredString(value, "countdown.config.target", 64, false);
    const date = new Date(target);
    if (!Number.isFinite(date.getTime())) throw new Error("countdown.config.target 不是有效时间");
    return date.toISOString();
  }

  function normalizeCountdown(config) {
    assertKnownKeys(config, ["target", "expiredText"], "countdown.config");
    return {
      target: normalizeTarget(config.target),
      expiredText: optionalString(config.expiredText, "已到期", "countdown.config.expiredText", limits.label)
    };
  }

  function normalizeIframe(config) {
    assertKnownKeys(config, ["url"], "iframe.config");
    return { url: requireHttpUrl(config.url, "iframe.config.url") };
  }

  function normalizeDefinition(definition) {
    if (!isPlainObject(definition)) throw new Error("声明式插件定义必须是普通对象");
    const type = requiredString(definition.type, "插件 type", 64, false);
    if (!DECLARATIVE_TYPES.includes(type)) throw new Error(`未知声明式插件类型：${type}`);
    const id = requiredString(definition.id, `插件 ${type} 的 id`, 128, false);
    if (!ID_PATTERN.test(id)) throw new Error(`插件 ID 无效：${id}`);
    const defaults = registry.get(type);
    const config = definition.config === undefined ? {} : definition.config;
    if (!isPlainObject(config)) throw new Error(`插件 ${id} 的 config 必须是普通对象`);
    const normalizers = {
      text: normalizeText,
      links: normalizeLinks,
      image: normalizeImage,
      countdown: normalizeCountdown,
      iframe: normalizeIframe
    };
    return {
      id,
      type,
      name: definition.name === undefined
        ? defaults.name.trim()
        : requiredString(definition.name, `插件 ${id} 的 name`, limits.name, false),
      defaultSize: normalizeSize(definition.defaultSize, defaults.defaultSize),
      config: normalizers[type](config)
    };
  }

  function normalizeDefinitions(definitions) {
    if (!Array.isArray(definitions) || definitions.length > 100) {
      throw new Error("state.plugins 必须是最多 100 项的数组");
    }
    const ids = new Set();
    return definitions.map((definition, index) => {
      let normalized;
      try {
        normalized = normalizeDefinition(definition);
      } catch (error) {
        throw new Error(`state.plugins[${index}]：${error.message}`);
      }
      if (ids.has(normalized.id)) throw new Error(`插件 ID 重复：${normalized.id}`);
      ids.add(normalized.id);
      return normalized;
    });
  }

  function registerCleanup(node, cleanup) {
    const record = { node, cleanup, active: true };
    cleanupRecords.add(record);
    node.dispose = function () {
      if (!record.active) return;
      record.active = false;
      cleanupRecords.delete(record);
      cleanup();
    };
    const MutationObserverConstructor = root.MutationObserver;
    const document = getDocument();
    if (MutationObserverConstructor && document.documentElement && !cleanupObserver) {
      cleanupObserver = new MutationObserverConstructor(function (records) {
        records.forEach((mutation) => {
          Array.from(mutation.removedNodes || []).forEach((removed) => {
            cleanupRecords.forEach((entry) => {
              if (entry.active && (removed === entry.node || (removed.contains && removed.contains(entry.node)))) {
                entry.node.dispose();
              }
            });
          });
        });
      });
      cleanupObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
  }

  function schedule(node, callback, intervalMs) {
    const document = getDocument();
    let wasConnected = node.isConnected !== false;
    const tick = function () {
      if (node.isConnected === true) wasConnected = true;
      if (wasConnected && node.isConnected === false) {
        if (node.dispose) node.dispose();
        return;
      }
      if (!document.hidden) callback();
    };
    const setIntervalFunction = root.setInterval || (typeof setInterval !== "undefined" ? setInterval : null);
    const timer = setIntervalFunction ? setIntervalFunction(tick, intervalMs) : null;
    const visibilityHandler = function () {
      if (!document.hidden) tick();
    };
    if (document.addEventListener) document.addEventListener("visibilitychange", visibilityHandler);
    registerCleanup(node, function () {
      if (timer !== null) (root.clearInterval || clearInterval)(timer);
      if (document.removeEventListener) document.removeEventListener("visibilitychange", visibilityHandler);
    });
    return tick;
  }

  function renderText(definition, ctx) {
    const shell = createShell(definition.type, definition.name, ctx.item);
    const content = element("div", "plugin-content plugin-text");
    if (definition.config.markdown) renderMarkdown(content, definition.config.content, ctx);
    else content.appendChild(element("pre", "plugin-text-plain", definition.config.content));
    shell.appendChild(content);
    return shell;
  }

  function renderLinks(definition, ctx) {
    const shell = createShell(definition.type, definition.name, ctx.item);
    const list = element("div", "plugin-content plugin-links widget-slot-grid");
    definition.config.links.forEach((link) => {
      const anchor = element("a", "app-unit plugin-link");
      bindSafeLink(anchor, link.url, ctx);
      anchor.appendChild(element("span", "app-label plugin-link-label", link.label));
      if (link.description) anchor.appendChild(element("span", "plugin-link-description", link.description));
      list.appendChild(anchor);
    });
    shell.appendChild(list);
    return shell;
  }

  function renderImage(definition, ctx) {
    const shell = createShell(definition.type, definition.name, ctx.item);
    const figure = element("figure", "plugin-content plugin-image");
    const frame = element("div", "plugin-image-frame");
    const image = element("img", "plugin-image-media");
    image.alt = definition.config.images[0].alt;
    image.src = definition.config.images[0].url;
    image.loading = "lazy";
    let link = null;
    if (definition.config.images[0].href) {
      link = element("a", "plugin-image-link");
      bindSafeLink(link, definition.config.images[0].href, ctx);
      link.appendChild(image);
      frame.appendChild(link);
    } else {
      frame.appendChild(image);
    }
    figure.appendChild(frame);
    let index = 0;
    let status = null;

    function show(nextIndex) {
      index = (nextIndex + definition.config.images.length) % definition.config.images.length;
      const current = definition.config.images[index];
      image.src = current.url;
      image.alt = current.alt;
      if (link) {
        link.removeEventListener("click", link.__pluginOpenUrl);
      }
      if (current.href) {
        if (!link) {
          link = element("a", "plugin-image-link");
          frame.removeChild(image);
          link.appendChild(image);
          frame.appendChild(link);
        }
        bindSafeLink(link, current.href, ctx);
      } else if (link) {
        frame.removeChild(link);
        link = null;
        frame.appendChild(image);
      }
      if (status) status.textContent = `${index + 1} / ${definition.config.images.length}`;
    }

    if (definition.config.images.length > 1) {
      const controls = element("div", "plugin-image-controls");
      const previous = element("button", "plugin-image-previous", "上一张");
      const next = element("button", "plugin-image-next", "下一张");
      previous.type = "button";
      next.type = "button";
      status = element("span", "plugin-image-status", `1 / ${definition.config.images.length}`);
      status.setAttribute("aria-live", "polite");
      previous.addEventListener("click", function () { show(index - 1); });
      next.addEventListener("click", function () { show(index + 1); });
      controls.appendChild(previous);
      controls.appendChild(status);
      controls.appendChild(next);
      figure.appendChild(controls);
      if (definition.config.autoplay) schedule(shell, function () { show(index + 1); }, definition.config.intervalMs);
    }
    shell.appendChild(figure);
    return shell;
  }

  function formatCountdown(target, now, expiredText) {
    const targetTime = target instanceof Date ? target.getTime() : new Date(target).getTime();
    const nowTime = now instanceof Date ? now.getTime() : (now === undefined ? Date.now() : new Date(now).getTime());
    if (!Number.isFinite(targetTime) || !Number.isFinite(nowTime)) throw new Error("倒计时时间无效");
    const remaining = targetTime - nowTime;
    if (remaining <= 0) return expiredText || "已到期";
    const totalSeconds = Math.floor(remaining / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = String(Math.floor((totalSeconds % 86400) / 3600)).padStart(2, "0");
    const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    const clock = `${hours}:${minutes}:${seconds}`;
    return days > 0 ? `${days}天 ${clock}` : clock;
  }

  function renderCountdown(definition, ctx) {
    const shell = createShell(definition.type, definition.name, ctx.item);
    const time = element("time", "plugin-content plugin-countdown");
    time.dateTime = definition.config.target;
    const update = function () {
      time.textContent = formatCountdown(definition.config.target, undefined, definition.config.expiredText);
    };
    update();
    schedule(shell, update, 1000);
    shell.appendChild(time);
    return shell;
  }

  function renderIframe(definition, ctx) {
    const shell = createShell(definition.type, definition.name, ctx.item);
    const frame = element("iframe", "plugin-content plugin-iframe");
    frame.src = definition.config.url;
    frame.title = definition.name;
    frame.loading = "lazy";
    frame.setAttribute("sandbox", IFRAME_SANDBOX);
    frame.setAttribute("referrerpolicy", "no-referrer");
    shell.appendChild(frame);
    return shell;
  }

  function renderDeclarative(definition, context) {
    const normalized = normalizeDefinition(definition);
    const item = Object.assign({}, (context && context.item) || {}, {
      id: normalized.id,
      kind: "widget",
      widgetType: normalized.type,
      w: normalized.defaultSize.w,
      h: normalized.defaultSize.h,
      config: normalized.config
    });
    const ctx = createContext(normalized.type, Object.assign({}, context || {}, {
      item,
      config: normalized.config
    }));
    const renderers = {
      text: renderText,
      links: renderLinks,
      image: renderImage,
      countdown: renderCountdown,
      iframe: renderIframe
    };
    return renderers[normalized.type](normalized, ctx);
  }

  function renderRegisteredDeclarative(ctx) {
    const item = ctx.item || {};
    const definition = {
      id: item.id,
      type: item.widgetType,
      name: (ctx.config && ctx.config.title) || item.name,
      config: ctx.config
    };
    if (item.w !== undefined && item.h !== undefined) {
      definition.defaultSize = { w: item.w, h: item.h };
    }
    return renderDeclarative(definition, ctx);
  }

  builtInMetadata.concat(declarativeMetadata).forEach((definition) => {
    registry.register(Object.assign({}, definition, {
      render: definition.runtime === "declarative" ? renderRegisteredDeclarative : renderAdapterPlaceholder
    }));
  });
  registry.register(Object.assign({}, registry.get("clock-metric"), { type: "clock" }));

  function getDefaultConfig(type) {
    const plugin = registry.get(type);
    if (!plugin) throw new Error(`未注册的插件类型：${type}`);
    return cloneData(plugin.defaultConfig);
  }

  function createFakeDocument() {
    function FakeNode(nodeType, tagName, text) {
      this.nodeType = nodeType;
      this.tagName = tagName || "";
      this.children = [];
      this.parentNode = null;
      this.attributes = {};
      this.dataset = {};
      this.style = {};
      this.listeners = {};
      this.className = "";
      this._text = text || "";
      this.isConnected = false;
    }
    FakeNode.prototype.appendChild = function (child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.children.push(child);
      return child;
    };
    FakeNode.prototype.removeChild = function (child) {
      const index = this.children.indexOf(child);
      if (index !== -1) this.children.splice(index, 1);
      child.parentNode = null;
      return child;
    };
    FakeNode.prototype.contains = function (candidate) {
      if (candidate === this) return true;
      return this.children.some((child) => child.contains(candidate));
    };
    FakeNode.prototype.setAttribute = function (name, value) {
      this.attributes[name.toLowerCase()] = String(value);
    };
    FakeNode.prototype.getAttribute = function (name) {
      const value = this.attributes[name.toLowerCase()];
      return value === undefined ? null : value;
    };
    FakeNode.prototype.addEventListener = function (name, handler) {
      (this.listeners[name] || (this.listeners[name] = [])).push(handler);
    };
    FakeNode.prototype.removeEventListener = function (name, handler) {
      const handlers = this.listeners[name] || [];
      const index = handlers.indexOf(handler);
      if (index !== -1) handlers.splice(index, 1);
    };
    Object.defineProperty(FakeNode.prototype, "textContent", {
      get: function () {
        return this._text + this.children.map((child) => child.textContent).join("");
      },
      set: function (value) {
        this.children = [];
        this._text = String(value);
      }
    });
    const document = {
      hidden: false,
      documentElement: null,
      listeners: {},
      createElement: (tagName) => new FakeNode(1, tagName.toUpperCase()),
      createTextNode: (text) => new FakeNode(3, "", text),
      addEventListener: function (name, handler) {
        (this.listeners[name] || (this.listeners[name] = [])).push(handler);
      },
      removeEventListener: function (name, handler) {
        const handlers = this.listeners[name] || [];
        const index = handlers.indexOf(handler);
        if (index !== -1) handlers.splice(index, 1);
      }
    };
    document.documentElement = document.createElement("html");
    return document;
  }

  function runTests(options) {
    const opts = options || {};
    const testDocument = opts.document || createFakeDocument();
    const previousDocument = documentOverride;
    documentOverride = testDocument;
    const tests = [];

    function test(name, callback) {
      try {
        callback();
        tests.push({ name, passed: true });
      } catch (error) {
        tests.push({ name, passed: false, error: error.message });
      }
    }

    function assert(condition, message) {
      if (!condition) throw new Error(message || "断言失败");
    }

    function throws(callback, message) {
      let threw = false;
      try { callback(); } catch (_) { threw = true; }
      assert(threw, message || "预期抛出错误");
    }

    function walk(node, callback) {
      callback(node);
      (node.children || []).forEach((child) => walk(child, callback));
    }

    function find(node, predicate) {
      let result = null;
      walk(node, function (candidate) {
        if (!result && predicate(candidate)) result = candidate;
      });
      return result;
    }

    function samplePlugin(type) {
      return {
        type,
        name: "测试插件",
        description: "注册表测试",
        icon: "test",
        defaultSize: { w: 2, h: 2 },
        configSchema: {},
        defaultConfig: {},
        runtime: "test",
        render: (ctx) => element("div", "test-plugin", ctx.config.value || "ok")
      };
    }

    test("Map 注册表 register/get/list/has 与接口校验", function () {
      const isolated = createRegistry();
      const plugin = isolated.register(samplePlugin("self-test"));
      assert(isolated.has("self-test") && isolated.get("self-test") === plugin, "注册后无法读取");
      assert(isolated.list().length === 1, "list 数量错误");
      const rendered = plugin.render(createContext(plugin.type, { config: {} }));
      assert(rendered.textContent === "ok", "render 结果错误");
      throws(() => isolated.register(samplePlugin("self-test")), "重复注册未拒绝");
      throws(() => isolated.register({ type: "bad_type" }), "非法 type 或缺少接口未拒绝");
    });

    test("六种内置元数据和五种声明式类型可用", function () {
      const runtimeByType = { "server-node": "server-metrics", weather: "weather", calendar: "calendar" };
      BUILT_IN_TYPES.forEach((type) => {
        const plugin = registry.get(type);
        assert(plugin && plugin.configSchema && plugin.defaultConfig, `${type} 元数据缺失`);
        assert(plugin.runtime === (runtimeByType[type] || "cloudos-adapter"), `${type} runtime 错误`);
      });
      assert(registry.has("clock") && registry.get("clock").type === "clock", "clock 兼容别名缺失");
      DECLARATIVE_TYPES.forEach((type) => assert(registry.has(type), `${type} 未注册`));
    });

    test("统一 render(type, ctx) 支持内置占位和已注册声明式插件", function () {
      const text = render("text", {
        item: { id: "registered-text", widgetType: "text", config: { content: "**ok**" } }
      });
      assert(find(text, (node) => node.tagName === "STRONG").textContent === "ok", "已注册声明式 render 结果错误");
      const placeholder = render("clock", {
        item: { id: "clock-one", widgetType: "clock", config: {} }
      });
      assert(placeholder.nodeType === 1 && placeholder.className.includes("plugin-adapter-pending"), "内置适配占位错误");
    });

    test("声明式定义规范化可序列化且拒绝未知类型", function () {
      const definition = normalizeDefinition({
        id: "image-one",
        type: "image",
        name: "单图",
        config: { url: "https://example.com/a.png", alt: "A" }
      });
      assert(definition.config.images.length === 1, "单图未规范化");
      assert(definition.defaultSize.w === 4, "默认尺寸缺失");
      assert(JSON.parse(JSON.stringify(definition)).id === "image-one", "定义不可序列化");
      throws(() => normalizeDefinition({ id: "bad", type: "script", config: {} }), "未知原始类型未拒绝");
      throws(() => normalizeDefinitions([definition, definition]), "重复 ID 未拒绝");
    });

    test("XSS 字符串只产生文本，不生成 script 或事件属性", function () {
      const payload = "<script>alert(1)</script><img src=x onerror=alert(1)> **安全** [危险](javascript:alert(1))";
      const node = renderDeclarative({ id: "xss", type: "text", config: { content: payload } });
      assert(node.textContent.includes("<script>"), "原始文本未保留");
      assert(find(node, (child) => child.tagName === "STRONG"), "Markdown 粗体未渲染");
      walk(node, function (child) {
        assert(child.tagName !== "SCRIPT", "生成了 script 元素");
        Object.keys(child.attributes || {}).forEach((name) => assert(!/^on/i.test(name), "生成了事件属性"));
        Object.keys(child).forEach((name) => assert(!/^on/i.test(name) || typeof child[name] !== "string", "生成了事件属性"));
      });
      assert(!find(node, (child) => child.tagName === "A" && String(child.href).includes("javascript")), "危险 Markdown URL 未拒绝");
    });

    test("links/image/iframe 危险 URL 全部拒绝", function () {
      ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "file:///tmp/a"].forEach((url) => {
        throws(() => normalizeDefinition({ id: "bad-link", type: "links", config: { links: [{ label: "bad", url }] } }));
        throws(() => normalizeDefinition({ id: "bad-image", type: "image", config: { url } }));
        throws(() => normalizeDefinition({ id: "bad-frame", type: "iframe", config: { url } }));
      });
    });

    test("倒计时文本、到期状态和 DOM 初始值", function () {
      const target = "2026-01-02T03:04:05.000Z";
      assert(formatCountdown(target, "2026-01-01T00:00:00.000Z") === "1天 03:04:05", "倒计时格式错误");
      assert(formatCountdown(target, target, "完成") === "完成", "到期文本错误");
      const node = renderDeclarative({ id: "count", type: "countdown", config: { target } });
      const time = find(node, (child) => child.tagName === "TIME");
      assert(time && time.textContent.length > 0, "倒计时 DOM 无文本");
      if (node.dispose) node.dispose();
    });

    test("iframe 仅 http(s)，sandbox 不授 allow-same-origin", function () {
      const node = renderDeclarative({
        id: "frame",
        type: "iframe",
        name: "受控嵌入",
        config: { url: "https://example.com/embed" }
      });
      const frame = find(node, (child) => child.tagName === "IFRAME");
      const sandbox = frame.getAttribute("sandbox").split(/\s+/);
      assert(frame.src === "https://example.com/embed", "iframe URL 错误");
      assert(sandbox.includes("allow-scripts"), "iframe sandbox 缺失");
      assert(!sandbox.includes("allow-same-origin"), "iframe 获得 allow-same-origin");
    });

    test("链接使用安全目标属性并调用 openUrl", function () {
      let opened = "";
      const node = renderDeclarative({
        id: "links",
        type: "links",
        config: { links: [{ label: "Example", url: "https://example.com" }] }
      }, { openUrl: (url) => { opened = url; } });
      const anchor = find(node, (child) => child.tagName === "A");
      assert(anchor.target === "_blank" && anchor.rel === "noopener noreferrer", "链接隔离属性错误");
      let prevented = false;
      anchor.listeners.click[0]({ preventDefault: () => { prevented = true; } });
      assert(prevented && opened === normalizeHttpUrl("https://example.com"), "openUrl 未收到安全 URL");
    });

    documentOverride = previousDocument;
    const report = {
      passed: tests.filter((entry) => entry.passed).length,
      failed: tests.filter((entry) => !entry.passed).length,
      tests
    };
    if (report.failed && opts.throwOnFailure) {
      throw new Error(`插件运行时自测失败：${JSON.stringify(report)}`);
    }
    return report;
  }

  const api = Object.freeze({
    register: registry.register,
    get: registry.get,
    list: registry.list,
    has: registry.has,
    registry,
    createRegistry,
    render,
    renderDeclarative,
    normalizeDefinition,
    normalizeDefinitions,
    normalizeUrl: normalizeHttpUrl,
    formatCountdown,
    getDefaultConfig,
    runTests,
    selfTest: runTests,
    builtInTypes: BUILT_IN_TYPES,
    declarativeTypes: DECLARATIVE_TYPES,
    iframeSandbox: IFRAME_SANDBOX,
    limits
  });

  root.StudioloWidgets = api;
})(typeof window !== "undefined" ? window : globalThis);
