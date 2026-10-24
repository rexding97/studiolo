# 架构设计：主题与插件

本文档定义 Studiolo 的两个扩展点：主题系统与组件插件系统。

## 1. 主题系统

### 1.1 目标

- 主题由 **design tokens** 驱动，而不是硬编码字段
- 新增一个视觉参数时，只改 token 定义和 CSS，不改编辑器代码
- 用户可以保存、导出、导入自己的主题
- 主题包是纯数据，可分享，不执行代码

### 1.2 Token 定义

Token 定义放在 `web/data.js` 的 `REX_THEME_TOKENS`：

```js
window.REX_THEME_TOKENS = [
  {
    group: "surface",
    key: "cardBgOpacity",
    label: "卡片表面不透明度",
    type: "range",
    min: 0.04, max: 0.65, step: 0.02,
    default: 0.14,
    apply: (v) => ({
      "--theme-card-bg": `linear-gradient(145deg, rgba(255,255,255,${v}) 0%, rgba(15,23,42,${Math.min(0.85, v * 1.2)}) 100%)`
    })
  },
  {
    group: "icon",
    key: "iconShape",
    label: "图标几何形状",
    type: "select",
    options: [
      { value: "squircle", label: "iOS 超椭圆" },
      { value: "circle", label: "正圆" },
      { value: "rounded", label: "圆角" },
      { value: "sharp", label: "锐角" }
    ],
    default: "squircle",
    apply: (v) => ({ "--theme-icon-radius": shapeMap[v] })
  }
];
```

`apply(value)` 返回一组 CSS 变量，`applyTheme()` 统一遍历执行。

特殊 token 可以直接写入 `document.body.dataset`（例如 `iconSurface`、`logoMode`），通过 `dataset` 字段声明：

```js
{ key: "logoMode", type: "select", dataset: "logoMode", ... }
```

### 1.3 主题包格式

```yaml
id: my-theme
name: 我的主题
basedOn: vision-glass
tokens:
  cardBgOpacity: 0.12
  cardBlur: 30
  cardRadius: 24
  accentColor: "#7dd3fc"
  iconShape: squircle
  logoMode: bleed-cover
```

- 存储位置：`state.profile.themeCustom` 保持兼容，值为 `tokens` 的扁平对象
- `state.profile.themePreset` 为预设 id 或 `custom`
- 导出主题时生成上面的 YAML，导入时校验未知 token 并忽略

### 1.4 编辑器

- 由 `REX_THEME_TOKENS` 自动生成控件，按 `group` 分区
- 支持 `range` / `color` / `select` / `toggle` / `text`
- 每个控件实时调用 `applyTheme()`，无需"保存"
- 提供三个动作：保存为自定义主题、导出 YAML、导入 YAML

## 2. 插件系统

### 2.1 目标

- 现有 6 个组件（服务器、文件夹、天气、日历、便签、时钟）用同一套接口
- 新增组件只需注册，不改 `renderWorkspace`
- 用户可以不写代码，用声明式配置创建插件
- 用户插件随 YAML 备份与恢复

### 2.2 插件接口

```js
{
  type: "weather",
  name: "实时天气",
  description: "按城市展示实时天气与预报",
  icon: "cloud",
  defaultSize: { w: 3, h: 2 },

  configSchema: [
    { key: "title", label: "标题", type: "text", default: "实时天气" },
    { key: "city", label: "城市", type: "text", default: "上海" }
  ],

  render(ctx) {
    // ctx: { item, config, save(), rerender() }
    const el = document.createElement("section");
    el.className = "widget-shell";
    // ...
    return el;
  },

  // 可选：声明订阅的运行时数据
  runtime: "weather"
}
```

### 2.3 注册表

```js
window.StudioloWidgets = new Map();

function registerWidget(plugin) {
  StudioloWidgets.set(plugin.type, plugin);
}
```

- 内置插件在 `web/plugins/builtin.js` 注册
- `renderWorkspace` 改为查表调用
- 组件商店按注册表渲染
- 配置弹窗按 `configSchema` 动态生成字段

### 2.4 用户声明式插件

第一版支持 5 种原始类型，不执行任意 JS：

| 类型 | 用途 | 主要配置 |
|---|---|---|
| `text` | 文本 / Markdown | `text` |
| `links` | 导航链接组 | `items[]` |
| `image` | 单图或轮播 | `urls[]`, `interval` |
| `iframe` | 嵌入页面 | `url`, `height` |
| `countdown` | 倒计时 | `target`, `label` |

示例：

```yaml
plugins:
  - id: my-links
    type: links
    name: 我的导航
    size: { w: 3, h: 2 }
    config:
      title: 常用
      items:
        - { label: GitHub, href: "https://github.com", icon: github }
        - { label: 邮箱, href: "https://mail.google.com", icon: label }
```

存储：`state.plugins`，随 YAML 导出与导入。

### 2.5 安全边界

- 用户插件是纯数据，不执行任意 JavaScript
- `iframe` 使用 `sandbox`，默认不授予 `allow-same-origin`
- 外部数据源（RSS、JSON API）走服务端代理，域名白名单，类似 favicon
- 导入插件时校验 `type` 必须在已知原始类型内

### 2.6 数据源

插件可以声明运行时数据需求：

```js
runtime: "weather"   // 从 /runtime.weather 取值
runtime: "hosts"     // 从 /runtime.hosts 取值
```

`applyRuntime` 不再硬编码天气和主机的更新逻辑，而是遍历已挂载插件的 `runtime` 声明，调用插件的 `update(data)`。

## 3. 实施顺序

| 阶段 | 内容 | 风险 |
|---|---|---|
| P1 | 设置面板固定高度、内部滚动 | 已完成 |
| P2 | 主题 token 化 + 动态编辑器 + 主题导入导出 | 中 |
| P3 | 组件注册表，现有 6 个组件迁移为内置插件 | 中高 |
| P4 | 声明式用户插件 + 插件管理界面 | 中 |
| P5 | 插件数据源与服务端代理 | 中 |

每个阶段都保持旧 YAML 可导入，新增字段按默认值补齐。
