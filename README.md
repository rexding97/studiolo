# Studiolo

> 一个自托管的个人云桌面。

把散落在多台机器上的服务、网站和书签，收进一间只属于你的房间。

Studiolo 源自文艺复兴时期的私人书房——不待客，只属于主人，墙上陈列着他真正在意的东西。

## 特性

- **2D 原子网格**：自由拖放，空位保留，不自动补全；组件可任意改宽高
- **可复用组件**：服务器节点、应用文件夹、天气、日历、便签、时钟
- **多主机指标**：本机 psutil，远程 SSH，CPU / 内存 / 磁盘 / 延迟 / 在线状态
- **应用探测**：TCP + HTTP 探测，在线状态每 30 秒刷新
- **近 7 天热度**：点击事件按周聚合，常用应用自动靠前
- **主题工坊**：材质、圆角、模糊、图标形状、Logo 处理管线
- **可选 Dock**：置顶优先，否则按热度取前 8
- **YAML 配置**：整份桌面可导出、导入、版本化
- **零依赖**：前端纯静态，后端只用 Python 标准库
- **单用户认证**：密码以 PBKDF2 哈希存储，会话 7 天

## 快速开始

### 只看界面

```bash
python3 -m http.server 3002 --directory web
```

打开 `http://127.0.0.1:3002`。此时没有后端，状态只存在浏览器 localStorage。

### 完整模式

```bash
cd server

# 首次设置密码（只保存哈希）
REXHUB_INIT_PASSWORD='your-password' python3 rexhub.py --set-password

# 启动，同时托管 ../web
python3 rexhub.py --port 3002
```

打开 `http://127.0.0.1:3002`，用刚才的密码登录。

### 常驻运行（macOS）

参考 LaunchAgent：

```xml
<key>Label</key><string>com.studiolo.rexhub</string>
<key>ProgramArguments</key>
<array>
  <string>/usr/bin/python3</string>
  <string>/path/to/server/rexhub.py</string>
  <string>--port</string><string>3002</string>
</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
```

### Docker

```bash
cp .env.example .env
# 编辑 .env，至少设置 REXHUB_INIT_PASSWORD

docker compose up -d --build
```

打开 `http://127.0.0.1:3002`。

- 数据保存在 `./server/data`，首次启动会按 `.env` 里的密码初始化，已有用户不会被覆盖
- 国内构建可在 `.env` 里设置 `PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple`
- 远程主机指标：把 SSH 密钥挂进容器，并在主机组件里填写 `sshUser` / `sshPort`
- 想采集宿主机而不是容器指标：启用 compose 里的 `pid: host`、挂载 `/proc:/host/proc:ro`，并设置 `PSUTIL_PROCFS_PATH=/host/proc`

镜像基于 `python:3.12-slim`，容器内以非 root 用户运行，健康检查请求 `/api/v1/health`。

## 默认配置

`web/default-state.yaml` 是一份可直接导入的示例：

- 3 台主机（Mac / Home Lab / NAS，均为 `192.168.1.x` 占位）
- 4 个组件：常用收藏、天气、便签、系统脉冲
- 16 个常用网站：GitHub、ChatGPT、Claude、Kimi、Vercel、Cloudflare、Notion、Linear、Figma、YouTube、哔哩哔哩、知乎、豆瓣、Gmail、Drive、Calendar

在「设置 → 数据」里粘贴或导入即可。

## 多主机指标

本机（组件 id 以 `host-mac` 开头）直接用 psutil 采集。

其他主机通过 SSH 读取 `/proc` 指标，需要事先配置免密：

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_rexhub -N ""
ssh-copy-id -i ~/.ssh/id_ed25519_rexhub.pub user@your-host
```

然后在主机组件的配置里填写 `ip`、`sshPort`（默认 22）、`sshUser`（默认 `root`）。

没有 SSH 的主机会显示为离线，不影响桌面其他部分。

## 配置字段

```yaml
profile:
  title: Studiolo          # 顶栏与标签页标题
  dockEnabled: true        # 底部 Dock
  wallpaper: aurora-peaks  # 壁纸 id 或 customWallpaperUrl
layout:
  - id: host-mac
    kind: widget           # widget | app
    x: 1
    y: 1
    w: 4
    h: 2
    widgetType: server-node
    configJson: '{"title":"Mac · 主入口","ip":"192.168.1.10"}'
apps:
  - id: github
    name: GitHub
    href: https://github.com
    containerId: host-mac
```

## 目录

```
web/                 前端（无构建步骤）
  index.html
  cloudos.css
  cloudos.js         布局、拖拽、主题、同步
  data.js            默认状态、图标库、主题预设
  default-state.yaml 示例配置
server/              后端（Python 标准库）
  rexhub.py          入口、HTTP、路由
  api.py             认证、状态、运行时、favicon、天气
  collectors.py      本机 / SSH 指标与探针
  db.py              SQLite 持久层
  data/              运行时数据（不入库）
```

## 安全

- `server/data/` 已加入 `.gitignore`，不会提交 SQLite 与缓存
- 密码只保存 PBKDF2-HMAC-SHA256 哈希
- favicon 代理要求登录，且目标域名必须出现在当前应用的 `href` 或 `logoUrl` 中
- 公网部署请在反向代理层启用 HTTPS

## License

MIT
