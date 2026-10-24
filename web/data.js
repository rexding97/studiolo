/*
 * REX · Cloud OS v4.0 数据、2D 绝对坐标棋盘模型与可自定义主题引擎 (Theme Engine)
 * 核心升级：
 * 1. 【真正的 2D 绝对坐标网格 (x, y, w, h)】：
 *    - 桌面是一张 12 列 × N 行的绝对坐标棋盘（x: 1~12, y: 1~N）。
 *    - 移走元素后，原位置保持空白，绝不自动往前挤（不会自动补全）！
 *    - 两个 1×1 的独立应用可以自由地上下垂直叠放（如一个在 x=5, y=1，另一个在 x=5, y=2）！
 * 2. 【深度可定制主题引擎 (Theme Studio)】：
 *    - 涵盖 UI 材质（卡片背景、毛玻璃模糊度、高光强度、卡片圆角、边框样式、阴影深度）
 *    - 涵盖 图标外观与处理管线（图标形状：iOS超椭圆 / 正圆形 / 硬朗微圆角 / 琉璃透明；网页原生 Logo 处理方式：自适应圆角垫片 / 满幅填充 / 纯净免底 / 智能反色滤镜；图标尺寸与顶部高光开关）
 *    - 提供 4 套风格迥异的大师级预设主题，并支持用户逐项 DIY 并随 YAML 导出/导入！
 */

window.REX_ICON_LIBRARY = {
  fnos: {
    label: "飞牛 fnOS",
    bg: "linear-gradient(145deg, #1d4ed8 0%, #0ea5e9 55%, #38bdf8 100%)",
    svg: `<svg viewBox="0 0 32 32" fill="none"><rect x="4" y="6" width="24" height="8.5" rx="3.2" fill="white" fill-opacity="0.95"/><rect x="4" y="17.5" width="24" height="8.5" rx="3.2" fill="white" fill-opacity="0.78"/><circle cx="9.5" cy="10.25" r="1.6" fill="#0284c7"/><circle cx="9.5" cy="21.75" r="1.6" fill="#0284c7"/><rect x="14" y="9.2" width="10" height="2.1" rx="1.05" fill="#0284c7" fill-opacity="0.55"/><rect x="14" y="20.7" width="7" height="2.1" rx="1.05" fill="#0284c7" fill-opacity="0.55"/></svg>`
  },
  vscode: {
    label: "VS Code",
    bg: "linear-gradient(145deg, #0066b8 0%, #0098ff 100%)",
    svg: `<svg viewBox="0 0 32 32" fill="none"><path d="M22.8 4.2L11.2 15.1L6.6 11.4L4.2 12.6V19.4L6.6 20.6L11.2 16.9L22.8 27.8L27.8 25.4V6.6L22.8 4.2ZM22.8 11.1V20.9L15.1 16L22.8 11.1Z" fill="white"/></svg>`
  },
  opencode: {
    label: "OpenCode",
    bg: "linear-gradient(145deg, #4f46e5 0%, #9333ea 55%, #ec4899 100%)",
    svg: `<svg viewBox="0 0 32 32" fill="none"><path d="M11.5 10L5.5 16L11.5 22" stroke="white" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M20.5 10L26.5 16L20.5 22" stroke="white" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 7.5L14 24.5" stroke="white" stroke-opacity="0.85" stroke-width="2.4" stroke-linecap="round"/></svg>`
  },
  newapi: {
    label: "New API",
    bg: "linear-gradient(145deg, #059669 0%, #10b981 55%, #6ee7b7 100%)",
    svg: `<svg viewBox="0 0 32 32" fill="none"><circle cx="16" cy="16" r="5" fill="white"/><path d="M16 4V8M16 24V28M4 16H8M24 16H28M7.5 7.5L10.3 10.3M21.7 21.7L24.5 24.5M24.5 7.5L21.7 10.3M10.3 21.7L7.5 24.5" stroke="white" stroke-width="2.5" stroke-linecap="round"/></svg>`
  },
  kimi: {
    label: "Kimi AI",
    bg: "linear-gradient(145deg, #0f172a 0%, #312e81 50%, #6366f1 100%)",
    svg: `<svg viewBox="0 0 32 32" fill="none"><path d="M17.5 6.2C11.8 6.8 7.5 11.6 7.5 17.5C7.5 23.6 12.4 28.5 18.5 28.5C23.5 28.5 27.7 25.1 29 20.5C23.2 21.2 18.2 16.4 17.5 6.2Z" fill="white"/><path d="M24 5V11M21 8H27" stroke="#a5b4fc" stroke-width="2.3" stroke-linecap="round"/></svg>`
  },
  gitea: {
    label: "Gitea",
    bg: "linear-gradient(145deg, #15803d 0%, #22c55e 60%, #86efac 100%)",
    svg: `<svg viewBox="0 0 32 32" fill="none"><circle cx="10" cy="9" r="3" fill="white"/><circle cx="22" cy="9" r="3" fill="white"/><circle cx="10" cy="23" r="3" fill="white"/><path d="M10 12V20M22 12C22 16.5 18 18 10 18" stroke="white" stroke-width="2.5" stroke-linecap="round"/></svg>`
  },
  sync: {
    label: "Verysync",
    bg: "linear-gradient(145deg, #0f766e 0%, #14b8a6 55%, #5eead4 100%)",
    svg: `<svg viewBox="0 0 32 32" fill="none"><path d="M25 14A9.5 9.5 0 0 0 8.5 9.5L6 12M6 7V12H11" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 18A9.5 9.5 0 0 0 23.5 22.5L26 20M26 25V20H21" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`
  },
  label: {
    label: "LabelWeb",
    bg: "linear-gradient(145deg, #ea580c 0%, #f97316 55%, #fdba74 100%)",
    svg: `<svg viewBox="0 0 32 32" fill="none"><path d="M15.8 5H6V14.8L17.4 26.2C18.6 27.4 20.5 27.4 21.7 26.2L26.2 21.7C27.4 20.5 27.4 18.6 26.2 17.4L15.8 5Z" fill="white" fill-opacity="0.92"/><circle cx="10.8" cy="10.8" r="2" fill="#ea580c"/></svg>`
  },
  image: {
    label: "ImageTools",
    bg: "linear-gradient(145deg, #be185d 0%, #ec4899 55%, #fda4af 100%)",
    svg: `<svg viewBox="0 0 32 32" fill="none"><rect x="5" y="5" width="22" height="22" rx="5" stroke="white" stroke-width="2.4"/><circle cx="11.5" cy="11.5" r="2.3" fill="white"/><path d="M6.5 24L13.5 17L18 21.5L21.5 18L26 23" stroke="white" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`
  },
  defect: {
    label: "GQSM 质检",
    bg: "linear-gradient(145deg, #b45309 0%, #f59e0b 55%, #fde047 100%)",
    svg: `<svg viewBox="0 0 32 32" fill="none"><circle cx="14.5" cy="14.5" r="8.5" stroke="white" stroke-width="2.5"/><path d="M21 21L27 27" stroke="white" stroke-width="2.8" stroke-linecap="round"/><path d="M14.5 10.5V18.5M10.5 14.5H18.5" stroke="white" stroke-width="2.3" stroke-linecap="round"/></svg>`
  },
  bichon: {
    label: "Bichon",
    bg: "linear-gradient(145deg, #6d28d9 0%, #a855f7 55%, #f472b6 100%)",
    svg: `<svg viewBox="0 0 32 32" fill="none"><path d="M16 6C9.9 6 5 10.2 5 15.5C5 18.6 6.7 21.3 9.4 23L8.5 27L13.2 24.8C14.1 25 15 25 16 25C22.1 25 27 20.8 27 15.5C27 10.2 22.1 6 16 6Z" fill="white" fill-opacity="0.93"/><circle cx="12.5" cy="15" r="1.6" fill="#6d28d9"/><circle cx="19.5" cy="15" r="1.6" fill="#6d28d9"/></svg>`
  },
  bench: {
    label: "ClawBench",
    bg: "linear-gradient(145deg, #be123c 0%, #f43f5e 55%, #fda4af 100%)",
    svg: `<svg viewBox="0 0 32 32" fill="none"><path d="M6 23A11 11 0 1 1 26 23" stroke="white" stroke-width="2.6" stroke-linecap="round"/><path d="M16 17L21.5 10.5" stroke="white" stroke-width="2.6" stroke-linecap="round"/><circle cx="16" cy="17" r="2.4" fill="white"/></svg>`
  },
  docker: {
    label: "Portainer",
    bg: "linear-gradient(145deg, #0369a1 0%, #06b6d4 55%, #67e8f9 100%)",
    svg: `<svg viewBox="0 0 32 32" fill="none"><rect x="7" y="12" width="3.5" height="3.5" rx="0.7" fill="white"/><rect x="11.5" y="12" width="3.5" height="3.5" rx="0.7" fill="white"/><rect x="16" y="12" width="3.5" height="3.5" rx="0.7" fill="white"/><rect x="11.5" y="7.5" width="3.5" height="3.5" rx="0.7" fill="white"/><rect x="16" y="7.5" width="3.5" height="3.5" rx="0.7" fill="white"/><path d="M4 17.2H24.5C25.8 17.2 27.2 16.5 28 15.2C26.5 14.7 25.6 15.1 24.8 15.8C24.4 14 23 13 21.5 12.6C20.7 13.7 20.6 15.3 21.2 16.5H4C4 21.8 7.5 25 13.5 25C20.5 25 25 21.2 26.2 16.5" fill="white" fill-opacity="0.92"/></svg>`
  },
  lucky: {
    label: "Lucky 网关",
    bg: "linear-gradient(145deg, #d97706 0%, #f59e0b 55%, #fde047 100%)",
    svg: `<svg viewBox="0 0 32 32" fill="none"><path d="M16 4L6 8.5V16.2C6 22.8 10.3 27.5 16 29C21.7 27.5 26 22.8 26 16.2V8.5L16 4Z" fill="white" fill-opacity="0.92"/><path d="M12 16.5L15 19.5L20.5 13.5" stroke="#d97706" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`
  },
  github: {
    label: "GitHub",
    bg: "linear-gradient(145deg, #18181b 0%, #3f3f46 100%)",
    svg: `<svg viewBox="0 0 32 32" fill="none"><path fill-rule="evenodd" clip-rule="evenodd" d="M16 4C9.37 4 4 9.37 4 16C4 21.3 7.44 25.8 12.2 27.39C12.8 27.5 13.02 27.13 13.02 26.81C13.02 26.53 13.01 25.77 13 24.77C9.66 25.5 8.96 23.16 8.96 23.16C8.41 21.77 7.63 21.4 7.63 21.4C6.54 20.66 7.71 20.67 7.71 20.67C8.92 20.76 9.55 21.91 9.55 21.91C10.62 23.75 12.36 23.22 13.05 22.91C13.16 22.13 13.47 21.6 13.81 21.3C11.15 21 8.35 19.97 8.35 15.37C8.35 14.06 8.82 12.99 9.59 12.15C9.46 11.85 9.05 10.63 9.7 8.98C9.7 8.98 10.71 8.66 13 10.21C13.96 9.94 14.98 9.81 16 9.8C17.02 9.81 18.04 9.94 19 10.21C21.29 8.66 22.3 8.98 22.3 8.98C22.95 10.63 22.54 11.85 22.41 12.15C23.18 12.99 23.65 14.06 23.65 15.37C23.65 19.98 20.84 20.99 18.17 21.29C18.6 21.66 18.98 22.39 18.98 23.51C18.98 25.11 18.97 26.4 18.97 26.81C18.97 27.13 19.19 27.51 19.8 27.39C24.56 25.8 28 21.3 28 16C28 9.37 22.63 4 16 4Z" fill="white"/></svg>`
  },
  globe: {
    label: "网页与书签",
    bg: "linear-gradient(145deg, #2563eb 0%, #38bdf8 100%)",
    svg: `<svg viewBox="0 0 32 32" fill="none"><circle cx="16" cy="16" r="11" stroke="white" stroke-width="2.3"/><ellipse cx="16" cy="16" rx="5" ry="11" stroke="white" stroke-width="2.1"/><path d="M5.5 16H26.5" stroke="white" stroke-width="2.1"/></svg>`
  },
  star: {
    label: "灵感与精选",
    bg: "linear-gradient(145deg, #f59e0b 0%, #ec4899 55%, #8b5cf6 100%)",
    svg: `<svg viewBox="0 0 32 32" fill="none"><path d="M16 4.5L19.4 11.5L27 12.6L21.5 18L22.8 25.6L16 22L9.2 25.6L10.5 18L5 12.6L12.6 11.5L16 4.5Z" fill="white"/></svg>`
  }
};

/*
 * 4 套大师级预设主题 (Theme Presets)
 * 用户不仅能一键切换预设，还能在「🎨 主题工坊」里微调每一个参数（UI 毛玻璃、边框、图标形状、Logo 渲染策略等）
 */
window.REX_THEME_PRESETS = {
  "vision-glass": {
    id: "vision-glass",
    name: "Apple visionOS · 空间流光玻璃",
    desc: "高饱和度磨砂折射 + 镜面高光唇边 + iOS 超椭圆立体图标",
    badge: "默认推荐",
    config: {
      cardBgOpacity: 0.14,
      cardBlur: 32,
      cardRadius: 28,
      cardBorderOpacity: 0.28,
      cardShadowStrength: 0.45,
      accentColor: "#38bdf8",
      textPrimary: "#ffffff",
      // 图标与 Logo 处理管线
      iconShape: "squircle", // squircle (超椭圆 28%) | circle (正圆 50%) | rounded (硬朗方角 16%) | sharp (极简微角 8%)
      iconSurface: "gradient", // gradient (彩色渐变底座) | frosted (通透毛玻璃底座) | dark-matte (暗夜哑光底座) | neon-ring (赛博霓虹描边)
      logoMode: "badge-pad", // badge-pad (圆角白瓷垫片衬托原生Logo) | bleed-cover (原生Logo满幅铺满) | raw-clean (无衬底直接悬浮) | mono-white (智能纯白符号化滤镜)
      iconScale: 1.0,
      iconGloss: true,
      gridGap: 18
    }
  },
  "nordic-frost": {
    id: "nordic-frost",
    name: "Nordic Frost · 极简冰川磨砂",
    desc: "统一的通透毛玻璃图标底座 + 纯净原生 Logo 悬浮，克制而高级",
    badge: "极简纯粹",
    config: {
      cardBgOpacity: 0.1,
      cardBlur: 40,
      cardRadius: 24,
      cardBorderOpacity: 0.2,
      cardShadowStrength: 0.3,
      accentColor: "#a5b4fc",
      textPrimary: "#f8fafc",
      iconShape: "squircle",
      iconSurface: "frosted",
      logoMode: "raw-clean",
      iconScale: 0.96,
      iconGloss: false,
      gridGap: 20
    }
  },
  "cyber-neon": {
    id: "cyber-neon",
    name: "Cyber Neon · 赛博黑曜霓虹",
    desc: "深邃暗夜哑光卡片 + 霓虹发光边框 + 正圆形暗黑发光图标",
    badge: "极客暗夜",
    config: {
      cardBgOpacity: 0.48,
      cardBlur: 24,
      cardRadius: 18,
      cardBorderOpacity: 0.42,
      cardShadowStrength: 0.68,
      accentColor: "#22d3ee",
      textPrimary: "#ecfeff",
      iconShape: "circle",
      iconSurface: "neon-ring",
      logoMode: "raw-clean",
      iconScale: 1.02,
      iconGloss: true,
      gridGap: 16
    }
  },
  "ceramic-soft": {
    id: "ceramic-soft",
    name: "Ceramic Pop · 温润陶瓷浮雕",
    desc: "大圆角饱满卡片 + 白瓷衬垫真实网页 Logo，像实体按键一样温润",
    badge: "温润拟物",
    config: {
      cardBgOpacity: 0.22,
      cardBlur: 36,
      cardRadius: 34,
      cardBorderOpacity: 0.38,
      cardShadowStrength: 0.38,
      accentColor: "#fbbf24",
      textPrimary: "#ffffff",
      iconShape: "rounded",
      iconSurface: "gradient",
      logoMode: "badge-pad",
      iconScale: 1.05,
      iconGloss: true,
      gridGap: 20
    }
  }
};

window.REX_THEME_TOKENS = [
  {
    group: "surface",
    key: "cardBgOpacity",
    label: "卡片表面不透明度",
    type: "range",
    min: 0.04,
    max: 0.65,
    step: 0.02,
    default: 0.14,
    apply: (v) => ({
      "--theme-card-bg": `linear-gradient(145deg, rgba(255,255,255,${v}) 0%, rgba(15,23,42,${Math.min(0.85, Number(v) * 1.2)}) 100%)`
    })
  },
  {
    group: "surface",
    key: "cardBlur",
    label: "毛玻璃模糊度 (px)",
    type: "range",
    min: 0,
    max: 60,
    step: 2,
    default: 32,
    apply: (v) => ({ "--theme-card-blur": `${v}px` })
  },
  {
    group: "surface",
    key: "cardRadius",
    label: "卡片圆角 (px)",
    type: "range",
    min: 8,
    max: 42,
    step: 2,
    default: 28,
    apply: (v) => ({ "--theme-card-radius": `${v}px` })
  },
  {
    group: "surface",
    key: "cardBorderOpacity",
    label: "高光边框强度",
    type: "range",
    min: 0.08,
    max: 0.6,
    step: 0.02,
    default: 0.28,
    apply: (v) => ({ "--theme-card-border": `rgba(255,255,255,${v})` })
  },
  {
    group: "surface",
    key: "cardShadowStrength",
    label: "投影强度",
    type: "range",
    min: 0.1,
    max: 0.8,
    step: 0.02,
    default: 0.45,
    apply: (v, all) => ({
      "--theme-card-shadow": `0 20px 42px -12px rgba(0,0,0,${v}), inset 0 1.5px 1px 0 rgba(255,255,255,${Math.min(0.6, Number(all.cardBorderOpacity ?? 0.28) * 1.3)})`
    })
  },
  {
    group: "surface",
    key: "gridGap",
    label: "网格间距 (px)",
    type: "range",
    min: 8,
    max: 32,
    step: 2,
    default: 18,
    apply: (v) => ({ "--theme-grid-gap": `${v}px` })
  },
  {
    group: "icon",
    key: "iconShape",
    label: "图标几何形状",
    type: "select",
    options: [
      { value: "squircle", label: "iOS 超椭圆" },
      { value: "circle", label: "正圆形" },
      { value: "rounded", label: "圆角方形" },
      { value: "sharp", label: "微锐角" }
    ],
    default: "squircle",
    apply: (v) => ({
      "--theme-icon-radius": { squircle: "18px", circle: "50%", rounded: "11px", sharp: "5px" }[v] || "18px"
    })
  },
  {
    group: "icon",
    key: "iconSurface",
    label: "图标底座材质",
    type: "select",
    options: [
      { value: "gradient", label: "品牌渐变" },
      { value: "frosted", label: "冰川毛玻璃" },
      { value: "dark-matte", label: "曜石哑光" },
      { value: "neon-ring", label: "霓虹描边" }
    ],
    default: "gradient",
    dataset: "iconSurface"
  },
  {
    group: "icon",
    key: "logoMode",
    label: "网站 Logo 处理",
    type: "select",
    options: [
      { value: "badge-pad", label: "白瓷衬垫" },
      { value: "bleed-cover", label: "满幅出血" },
      { value: "raw-clean", label: "纯净直出" },
      { value: "mono-white", label: "纯白符号化" }
    ],
    default: "badge-pad",
    dataset: "logoMode"
  },
  {
    group: "icon",
    key: "iconScale",
    label: "图标缩放",
    type: "range",
    min: 0.82,
    max: 1.15,
    step: 0.02,
    default: 1,
    apply: (v) => ({ "--theme-icon-scale": String(v) })
  },
  {
    group: "icon",
    key: "iconGloss",
    label: "顶部弧面光泽",
    type: "toggle",
    default: true,
    dataset: "iconGloss"
  },
  {
    group: "color",
    key: "accentColor",
    label: "全局强调色",
    type: "color",
    default: "#38bdf8",
    apply: (v) => ({ "--theme-accent": v })
  },
  {
    group: "color",
    key: "textPrimary",
    label: "主文字颜色",
    type: "color",
    default: "#ffffff",
    apply: (v) => ({ "--theme-text": v })
  },
  {
    group: "type",
    key: "fontFamily",
    label: "字体",
    type: "select",
    options: [
      { value: "system", label: "系统无衬线" },
      { value: "rounded", label: "圆体" },
      { value: "serif", label: "衬线" },
      { value: "mono", label: "等宽" }
    ],
    default: "system",
    apply: (v) => ({
      "--app-font": {
        system: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", "Hiragino Sans GB", sans-serif',
        rounded: '"SF Pro Rounded", "Hiragino Maru Gothic ProN", "PingFang SC", -apple-system, sans-serif',
        serif: 'Georgia, "Songti SC", "Noto Serif SC", serif',
        mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace'
      }[v] || '-apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif'
    })
  },
  {
    group: "type",
    key: "baseFontSize",
    label: "基础字号 (px)",
    type: "range",
    min: 14,
    max: 20,
    step: 1,
    default: 16,
    apply: (v) => ({ "--app-font-size": `${v}px` })
  },
  {
    group: "type",
    key: "headingWeight",
    label: "标题字重",
    type: "select",
    options: [
      { value: "500", label: "中等 500" },
      { value: "600", label: "半粗 600" },
      { value: "700", label: "粗体 700" }
    ],
    default: "600",
    apply: (v) => ({ "--app-heading-weight": v })
  },
  {
    group: "type",
    key: "lineHeight",
    label: "行高",
    type: "range",
    min: 1.2,
    max: 1.8,
    step: 0.05,
    default: 1.5,
    apply: (v) => ({ "--app-line-height": String(v) })
  }
];

window.REX_THEME_PACKS = [
  {
    id: "aurora-night",
    name: "极光夜航",
    author: "Studiolo",
    desc: "深蓝夜空与缓慢流动的极光带，适合长时间使用",
    badge: "动态壁纸",
    tokens: {
      cardBgOpacity: 0.12,
      cardBlur: 34,
      cardRadius: 26,
      cardBorderOpacity: 0.24,
      cardShadowStrength: 0.5,
      accentColor: "#7dd3fc",
      textPrimary: "#f0f9ff",
      iconShape: "squircle",
      iconSurface: "frosted",
      logoMode: "raw-clean",
      iconScale: 1,
      iconGloss: true,
      gridGap: 18
    },
    wallpaper: {
      type: "canvas",
      scene: "aurora",
      dim: 0.28,
      fallback: "linear-gradient(135deg, #0b1026 0%, #12304a 45%, #1b5e6b 100%)"
    }
  },
  {
    id: "deep-space",
    name: "深空星野",
    author: "Studiolo",
    desc: "缓慢漂移的星点与深空底色，安静、克制",
    badge: "动态壁纸",
    tokens: {
      cardBgOpacity: 0.16,
      cardBlur: 30,
      cardRadius: 24,
      cardBorderOpacity: 0.22,
      cardShadowStrength: 0.55,
      accentColor: "#a78bfa",
      textPrimary: "#f5f3ff",
      iconShape: "squircle",
      iconSurface: "dark-matte",
      logoMode: "mono-white",
      iconScale: 1,
      iconGloss: false,
      gridGap: 20
    },
    wallpaper: {
      type: "canvas",
      scene: "starfield",
      dim: 0.35,
      fallback: "linear-gradient(180deg, #050814 0%, #0b1226 60%, #111a33 100%)"
    }
  },
  {
    id: "solar-mesh",
    name: "暖光网格",
    author: "Studiolo",
    desc: "缓慢呼吸的暖色光斑，适合夜间与阅读",
    badge: "动态壁纸",
    tokens: {
      cardBgOpacity: 0.18,
      cardBlur: 32,
      cardRadius: 28,
      cardBorderOpacity: 0.3,
      cardShadowStrength: 0.42,
      accentColor: "#fbbf24",
      textPrimary: "#fffbeb",
      iconShape: "rounded",
      iconSurface: "gradient",
      logoMode: "badge-pad",
      iconScale: 1.02,
      iconGloss: true,
      gridGap: 18
    },
    wallpaper: {
      type: "canvas",
      scene: "mesh",
      dim: 0.22,
      fallback: "linear-gradient(135deg, #f59e0b 0%, #7c2d12 55%, #1e1b4b 100%)"
    }
  },
  {
    id: "slate-glass",
    name: "墨石玻璃",
    author: "Studiolo",
    desc: "静态深灰渐变，低功耗，适合常开桌面",
    badge: "静态",
    tokens: {
      cardBgOpacity: 0.2,
      cardBlur: 28,
      cardRadius: 24,
      cardBorderOpacity: 0.26,
      cardShadowStrength: 0.48,
      accentColor: "#94a3b8",
      textPrimary: "#f8fafc",
      iconShape: "squircle",
      iconSurface: "dark-matte",
      logoMode: "raw-clean",
      iconScale: 1,
      iconGloss: false,
      gridGap: 18
    },
    wallpaper: {
      type: "gradient",
      value: "radial-gradient(1200px 800px at 20% 10%, #1e293b 0%, #0b1120 55%, #020617 100%)",
      dim: 0
    }
  }
];

window.REX_WIDGET_CATALOG = {
  "server-node": {
    name: "服务器主机组件",
    desc: "展示主机状态指标（IP/延迟/CPU/内存）并承载该机器上的应用图标，超出格子自动折叠为 ···",
    badge: "核心可复用",
    defaultW: 4,
    defaultH: 2,
    defaultConfig: {
      title: "新服务器节点",
      badge: "算力节点",
      ip: "192.168.1.x",
      lanIp: "192.168.1.x",
      role: "自定义服务器描述",
      pingMs: 12,
      cpu: "15%",
      mem: "40%",
      uptime: "10d",
      sortBy: "order"
    }
  },
  "app-folder": {
    name: "应用/书签文件夹组件",
    desc: "像手机文件夹一样归纳任意一组网站或应用，超出长宽容量时最后一格自动变为九宫格 ···",
    badge: "应用容器",
    defaultW: 4,
    defaultH: 2,
    defaultConfig: {
      title: "精选收藏夹",
      badge: "书签集合",
      subtitle: "可将任意图标拖入或拖出",
      sortBy: "order"
    }
  },
  weather: {
    name: "实时天气组件",
    desc: "可配置任意城市、气温与多日预报的毛玻璃天气卡片，可同时添加多个关注不同城市",
    badge: "生活组件",
    defaultW: 3,
    defaultH: 2,
    defaultConfig: {
      title: "实时天气",
      city: "南京 · 鼓楼",
      temp: "21°",
      condition: "晴间多云",
      range: "最高 24° · 最低 15°",
      humidity: "60%"
    }
  },
  calendar: {
    name: "月历日程组件",
    desc: "当月日历网格与今日高亮，支持自由缩放长宽",
    badge: "时间组件",
    defaultW: 3,
    defaultH: 2,
    defaultConfig: {
      title: "月历日程",
      badge: "自动同步"
    }
  },
  notes: {
    name: "随手便签组件",
    desc: "可创建多个不同主题的毛玻璃备忘录卡片（如端口备忘、待办清单），实时持久化到 YAML",
    badge: "效率组件",
    defaultW: 3,
    defaultH: 2,
    defaultConfig: {
      title: "随手便签",
      badge: "自动保存",
      text: "• 中间第 5 列的 2 个独立应用现在上下垂直叠放 (x=5,y=1 与 x=5,y=2)\n• 移走任何图标后原位置保留为空位，绝不自动往前挤！\n• 点击右上角「🎨 主题工坊」可自定义全站 UI 与图标处理方式"
    }
  },
  "clock-metric": {
    name: "数字时钟 / 脉冲组件",
    desc: "展示大号精工数字时间、节点在线率或纪念日目标",
    badge: "状态组件",
    defaultW: 3,
    defaultH: 1,
    defaultConfig: {
      title: "系统脉冲",
      badge: "8443 网关正常",
      subtitle: "IPv6 DDNS 稳定锁定"
    }
  }
};

window.REX_WALLPAPERS = [
  {
    id: "aurora-peaks",
    name: "极光流彩山峦 (推荐)",
    preview: "linear-gradient(135deg, #0ea5e9 0%, #6366f1 45%, #ec4899 100%)",
    type: "scene-aurora"
  },
  {
    id: "macos-sequoia",
    name: "红杉暮光幻境",
    preview: "linear-gradient(135deg, #f97316 0%, #db2777 48%, #312e81 100%)",
    type: "scene-sunset"
  },
  {
    id: "emerald-fjord",
    name: "翡翠峡湾星夜",
    preview: "linear-gradient(135deg, #10b981 0%, #0284c7 50%, #0f172a 100%)",
    type: "scene-emerald"
  },
  {
    id: "cyber-nebula",
    name: "深空霓虹星云",
    preview: "linear-gradient(135deg, #8b5cf6 0%, #06b6d4 52%, #090d16 100%)",
    type: "scene-nebula"
  },
  {
    id: "unsplash-alps",
    name: "阿尔卑斯雪峰 (摄影)",
    preview: "linear-gradient(135deg, #38bdf8 0%, #1e293b 100%)",
    type: "photo",
    url: "https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=2000&q=80"
  }
];

window.REX_DEFAULT_STATE = {
  version: "4.0",
  profile: {
    title: "Studiolo",
    owner: "your-name",
    layoutMode: "bento",
    dockEnabled: true,
    wallpaper: "aurora-peaks",
    customWallpaperUrl: "",
    searchEngine: "google",
    themePreset: "vision-glass",
    themeCustom: JSON.parse(JSON.stringify(window.REX_THEME_PRESETS["vision-glass"].config))
  },
  layout: [
    {
        "id": "host-mac",
        "kind": "widget",
        "widgetType": "server-node",
        "x": 1,
        "y": 1,
        "w": 4,
        "h": 2,
        "config": {
            "title": "Mac · 主入口",
            "badge": "公网入口",
            "ip": "192.168.1.10",
            "lanIp": "192.168.1.10",
            "role": "TLS 终结 · 本机服务",
            "pingMs": 1,
            "cpu": "--",
            "mem": "--",
            "disk": "--",
            "uptime": "--",
            "sortBy": "order"
        }
    },
    {
        "id": "host-office",
        "kind": "widget",
        "widgetType": "server-node",
        "x": 5,
        "y": 1,
        "w": 4,
        "h": 2,
        "config": {
            "title": "Home Lab · 应用服务器",
            "badge": "自托管应用",
            "ip": "192.168.1.20",
            "lanIp": "192.168.1.20",
            "role": "容器与内部服务",
            "pingMs": 2,
            "cpu": "--",
            "mem": "--",
            "disk": "--",
            "uptime": "--",
            "sortBy": "order"
        }
    },
    {
        "id": "host-fnas",
        "kind": "widget",
        "widgetType": "server-node",
        "x": 9,
        "y": 1,
        "w": 4,
        "h": 2,
        "config": {
            "title": "NAS · 存储节点",
            "badge": "文件与备份",
            "ip": "192.168.1.30",
            "lanIp": "192.168.1.30",
            "role": "家庭存储",
            "pingMs": 3,
            "cpu": "--",
            "mem": "--",
            "disk": "--",
            "uptime": "--",
            "sortBy": "order"
        }
    },
    {
        "id": "folder-favorites",
        "kind": "widget",
        "widgetType": "app-folder",
        "x": 1,
        "y": 3,
        "w": 3,
        "h": 2,
        "config": {
            "title": "常用收藏",
            "badge": "书签集合",
            "subtitle": "把常去的网站拖进来",
            "sortBy": "order"
        }
    },
    {
        "id": "widget-weather",
        "kind": "widget",
        "widgetType": "weather",
        "x": 4,
        "y": 3,
        "w": 3,
        "h": 2,
        "config": {
            "title": "实时天气",
            "city": "上海",
            "temp": "--",
            "condition": "——",
            "range": "-- / --",
            "humidity": "--"
        }
    },
    {
        "id": "widget-notes",
        "kind": "widget",
        "widgetType": "notes",
        "x": 7,
        "y": 3,
        "w": 3,
        "h": 2,
        "config": {
            "title": "随手便签",
            "badge": "自动保存",
            "text": "欢迎使用 Studiolo。\n\n• 拖动图标可重新排布\n• 编辑模式下可新增组件\n• 设置里可切换主题、壁纸与 Dock"
        }
    },
    {
        "id": "widget-clock",
        "kind": "widget",
        "widgetType": "clock-metric",
        "x": 10,
        "y": 3,
        "w": 2,
        "h": 1,
        "config": {
            "title": "系统脉冲",
            "badge": "本地服务正常",
            "subtitle": "状态每 12 秒刷新"
        }
    }
],
  apps: [
    {
        "id": "github",
        "name": "GitHub",
        "desc": "代码托管与协作",
        "href": "https://github.com",
        "containerId": "host-mac",
        "icon": "github",
        "logoUrl": "",
        "useSiteLogo": true,
        "color": "linear-gradient(145deg, #161b22 0%, #30363d 100%)",
        "status": "online",
        "latency": 0,
        "port": "",
        "note": "示例：可替换成你自己的仓库地址",
        "pinned": true,
        "clicks": 0
    },
    {
        "id": "chatgpt",
        "name": "ChatGPT",
        "desc": "通用 AI 助手",
        "href": "https://chatgpt.com",
        "containerId": "host-mac",
        "icon": "globe",
        "logoUrl": "",
        "useSiteLogo": true,
        "color": "linear-gradient(145deg, #10a37f 0%, #0d8a6a 100%)",
        "status": "online",
        "latency": 0,
        "port": "",
        "note": "",
        "pinned": false,
        "clicks": 0
    },
    {
        "id": "claude",
        "name": "Claude",
        "desc": "长文本与代码助手",
        "href": "https://claude.ai",
        "containerId": "host-mac",
        "icon": "star",
        "logoUrl": "",
        "useSiteLogo": true,
        "color": "linear-gradient(145deg, #d97757 0%, #b45309 100%)",
        "status": "online",
        "latency": 0,
        "port": "",
        "note": "",
        "pinned": false,
        "clicks": 0
    },
    {
        "id": "kimi",
        "name": "Kimi",
        "desc": "中文长上下文助手",
        "href": "https://kimi.moonshot.cn",
        "containerId": "host-mac",
        "icon": "kimi",
        "logoUrl": "",
        "useSiteLogo": true,
        "color": "linear-gradient(145deg, #0f172a 0%, #312e81 50%, #6366f1 100%)",
        "status": "online",
        "latency": 0,
        "port": "",
        "note": "",
        "pinned": false,
        "clicks": 0
    },
    {
        "id": "vercel",
        "name": "Vercel",
        "desc": "前端部署与预览",
        "href": "https://vercel.com",
        "containerId": "host-office",
        "icon": "globe",
        "logoUrl": "",
        "useSiteLogo": true,
        "color": "linear-gradient(145deg, #111827 0%, #374151 100%)",
        "status": "online",
        "latency": 0,
        "port": "",
        "note": "",
        "pinned": false,
        "clicks": 0
    },
    {
        "id": "cloudflare",
        "name": "Cloudflare",
        "desc": "DNS 与边缘网络",
        "href": "https://dash.cloudflare.com",
        "containerId": "host-office",
        "icon": "globe",
        "logoUrl": "",
        "useSiteLogo": true,
        "color": "linear-gradient(145deg, #f59e0b 0%, #ea580c 100%)",
        "status": "online",
        "latency": 0,
        "port": "",
        "note": "",
        "pinned": false,
        "clicks": 0
    },
    {
        "id": "notion",
        "name": "Notion",
        "desc": "文档与知识库",
        "href": "https://www.notion.so",
        "containerId": "host-office",
        "icon": "label",
        "logoUrl": "",
        "useSiteLogo": true,
        "color": "linear-gradient(145deg, #f3f4f6 0%, #d1d5db 100%)",
        "status": "online",
        "latency": 0,
        "port": "",
        "note": "浅色底座示例",
        "pinned": true,
        "clicks": 0
    },
    {
        "id": "linear",
        "name": "Linear",
        "desc": "项目管理与 Issue",
        "href": "https://linear.app",
        "containerId": "host-office",
        "icon": "sync",
        "logoUrl": "",
        "useSiteLogo": true,
        "color": "linear-gradient(145deg, #5e6ad2 0%, #4338ca 100%)",
        "status": "online",
        "latency": 0,
        "port": "",
        "note": "",
        "pinned": false,
        "clicks": 0
    },
    {
        "id": "figma",
        "name": "Figma",
        "desc": "界面设计与原型",
        "href": "https://www.figma.com",
        "containerId": "host-office",
        "icon": "image",
        "logoUrl": "",
        "useSiteLogo": true,
        "color": "linear-gradient(145deg, #f24e1e 0%, #a259ff 55%, #1abcfe 100%)",
        "status": "online",
        "latency": 0,
        "port": "",
        "note": "",
        "pinned": false,
        "clicks": 0
    },
    {
        "id": "youtube",
        "name": "YouTube",
        "desc": "视频与订阅",
        "href": "https://www.youtube.com",
        "containerId": "host-fnas",
        "icon": "globe",
        "logoUrl": "",
        "useSiteLogo": true,
        "color": "linear-gradient(145deg, #ff0000 0%, #991b1b 100%)",
        "status": "online",
        "latency": 0,
        "port": "",
        "note": "",
        "pinned": false,
        "clicks": 0
    },
    {
        "id": "bilibili",
        "name": "哔哩哔哩",
        "desc": "中文视频社区",
        "href": "https://www.bilibili.com",
        "containerId": "host-fnas",
        "icon": "globe",
        "logoUrl": "",
        "useSiteLogo": true,
        "color": "linear-gradient(145deg, #fb7299 0%, #f43f5e 100%)",
        "status": "online",
        "latency": 0,
        "port": "",
        "note": "",
        "pinned": true,
        "clicks": 0
    },
    {
        "id": "zhihu",
        "name": "知乎",
        "desc": "问答与专栏",
        "href": "https://www.zhihu.com",
        "containerId": "host-fnas",
        "icon": "globe",
        "logoUrl": "",
        "useSiteLogo": true,
        "color": "linear-gradient(145deg, #0084ff 0%, #1d4ed8 100%)",
        "status": "online",
        "latency": 0,
        "port": "",
        "note": "",
        "pinned": false,
        "clicks": 0
    },
    {
        "id": "douban",
        "name": "豆瓣",
        "desc": "书影音记录",
        "href": "https://www.douban.com",
        "containerId": "host-fnas",
        "icon": "star",
        "logoUrl": "",
        "useSiteLogo": true,
        "color": "linear-gradient(145deg, #2e963d 0%, #166534 100%)",
        "status": "online",
        "latency": 0,
        "port": "",
        "note": "",
        "pinned": false,
        "clicks": 0
    },
    {
        "id": "gmail",
        "name": "Gmail",
        "desc": "邮件",
        "href": "https://mail.google.com",
        "containerId": "folder-favorites",
        "icon": "label",
        "logoUrl": "",
        "useSiteLogo": true,
        "color": "linear-gradient(145deg, #ea4335 0%, #b91c1c 100%)",
        "status": "online",
        "latency": 0,
        "port": "",
        "note": "",
        "pinned": false,
        "clicks": 0
    },
    {
        "id": "drive",
        "name": "Google Drive",
        "desc": "云端文件",
        "href": "https://drive.google.com",
        "containerId": "folder-favorites",
        "icon": "sync",
        "logoUrl": "",
        "useSiteLogo": true,
        "color": "linear-gradient(145deg, #34a853 0%, #166534 100%)",
        "status": "online",
        "latency": 0,
        "port": "",
        "note": "",
        "pinned": false,
        "clicks": 0
    },
    {
        "id": "calendar",
        "name": "Google Calendar",
        "desc": "日程",
        "href": "https://calendar.google.com",
        "containerId": "folder-favorites",
        "icon": "label",
        "logoUrl": "",
        "useSiteLogo": true,
        "color": "linear-gradient(145deg, #4285f4 0%, #1e40af 100%)",
        "status": "online",
        "latency": 0,
        "port": "",
        "note": "",
        "pinned": false,
        "clicks": 0
    }
]
};
