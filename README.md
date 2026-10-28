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
- **可选 Dock**：置顶优先，否则按热度取前 10
- **YAML 配置**：整份桌面可导出、导入、版本化
- **轻量运行**：前端零构建、零运行时包依赖；后端使用 Python 标准库与 psutil
- **单用户认证**：密码以 PBKDF2 哈希存储，会话 7 天

工作区、声明式插件、ICS/CalDAV 和更严格的快照恢复是本迭代的后端/架构目标，具体接口与可用范围以最终代码和 `--help` 为准；本文不将这些目标视为已发布能力。

## 快速开始

### 只看界面

```bash
python3 -m http.server 3002 --bind 127.0.0.1 --directory web
```

打开 `http://127.0.0.1:3002`。此时没有后端，状态只存在浏览器 localStorage。

### 从源码运行

需要 Python 3.12。推荐使用虚拟环境：

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install psutil==6.1.0

# 首次设置密码（只保存哈希）
REXHUB_INIT_PASSWORD='your-password' python server/rexhub.py --set-password

# 启动，同时托管 web/
python server/rexhub.py --host 127.0.0.1 --port 3002
```

打开 `http://127.0.0.1:3002`，用刚才的密码登录。服务默认只监听回环地址；旧版本若默认值不同，显式传入上面的 `--host 127.0.0.1`。

### 常驻运行（macOS）

Homebrew 服务显式绑定 `127.0.0.1`。自建 LaunchAgent 时应使用当前虚拟环境的 Python 绝对路径，并显式传入：

```xml
<key>ProgramArguments</key>
<array>
  <string>/absolute/path/to/.venv/bin/python</string>
  <string>/absolute/path/to/server/rexhub.py</string>
  <string>--host</string><string>127.0.0.1</string>
  <string>--port</string><string>3002</string>
</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
```

不要同时让 LaunchAgent、`brew services` 和 Docker 占用同一端口。

### Docker / Compose

```bash
cp .env.example .env
# 编辑 .env，至少设置 REXHUB_INIT_PASSWORD

docker compose up -d --build
docker compose ps
```

打开 `http://127.0.0.1:3002`。

- 数据保存在 `./server/data`；已有用户不会因重启而重置密码
- 默认发布地址是 `127.0.0.1:3002`；确需局域网访问时才在 `.env` 中修改 `REXHUB_BIND_HOST`
- 公网访问必须放在启用 HTTPS 的反向代理之后，不要把内置 HTTP 服务直接暴露到公网
- `STUDIOLO_IMAGE_TAG` 固定镜像标签，默认 `0.1.3`，避免无意滚动到 `latest`
- 国内构建可设置 `PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple`
- 远程主机指标需要把 SSH 密钥只读挂载到容器，并确保 uid `10001` 可读
- 采集宿主机而非容器指标时，按 Compose 注释启用 `pid: host`、`/proc:/host/proc:ro` 与 `PSUTIL_PROCFS_PATH`

容器入口仅在必要时调整数据根目录属主，实际服务以 uid `10001` 运行。Docker/Compose 健康检查请求 `/api/v1/ready`；初始化未完成、数据库不可用或采集器不健康时不会报告 ready。`/api/v1/health` 仍用于存活与诊断。

镜像使用明确的 `python:3.12.12-slim-trixie` patch tag，并固定 `psutil==6.1.0`。当前未取得可验证的基础镜像 digest，因此基础镜像尚未做到内容级固定；发布流程要求在网络可用时补查并更新 digest。

### Homebrew（macOS）

```bash
brew tap rexding97/studiolo https://github.com/rexding97/studiolo
brew install rexding97/studiolo/studiolo

studiolo --set-password
brew services start studiolo
```

- 数据目录：`$(brew --prefix)/var/studiolo`
- 前台运行：`studiolo --host 127.0.0.1 --port 3002`
- 服务日志：`$(brew --prefix)/var/log/studiolo.log`
- Formula 位于 `Formula/studiolo.rb`

## 默认配置

`web/default-state.yaml` 是一份可直接导入的示例，包含占位主机、组件和常用网站。在「设置 → 数据」里粘贴或导入即可；占位 IP 不代表你的实际网络。

## 备份与恢复

### 备份

常规备份使用「设置 → 数据 → 导出 .yaml」。YAML 包含桌面布局、应用、主题、壁纸和热度等可移植状态，不包含密码、会话或主机运行时指标。

需要完整 SQLite 备份时，使用 SQLite 在线备份而不是只复制可能仍有 WAL 的数据库文件：

```bash
docker compose exec --user 10001 -T studiolo python -c \
  "import sqlite3; s=sqlite3.connect('/app/server/data/rexhub.db'); d=sqlite3.connect('/app/server/data/rexhub-backup.db'); s.backup(d); d.close(); s.close()"
cp server/data/rexhub-backup.db /safe/backup/location/rexhub-backup.db
```

把备份放在数据目录之外，并限制访问权限。恢复前再保留一份当前备份。

### 普通 YAML 导入

```bash
studiolo --import-yaml ~/studiolo-backup.yaml
# 或源码模式
python server/rexhub.py --import-yaml ~/studiolo-backup.yaml
```

已有桌面状态时，普通导入应明确跳过，不覆盖状态；解析、文件读取和写入失败均会非零退出。需要覆盖时，源码/Homebrew 可显式使用 `--force-import`。

### Docker 一次性强制恢复

```bash
docker compose run --rm --no-deps \
  -v "$PWD/studiolo-backup.yaml:/backup.yaml:ro" \
  -e REXHUB_IMPORT_YAML=/backup.yaml \
  -e REXHUB_IMPORT_FORCE=1 \
  -e REXHUB_IMPORT_ONLY=1 \
  studiolo
```

该命令导入后退出，不启动第二个长期服务。只有导入成功才会在数据目录写入 `.rexhub-import-force.sha256`；标记记录备份内容的 SHA-256：

- 同一份备份已成功强制导入后，即使环境中残留 `REXHUB_IMPORT_FORCE=1`，重启也不会再次覆盖
- 新内容的备份会获得新摘要，可以再次显式恢复
- 确需用完全相同的文件再次覆盖时，先停止服务并删除该标记，再执行上面的一次性命令
- 文件不存在、解析失败或写入失败都会使命令失败；不会忽略错误，也不会写成功标记

不建议把 `REXHUB_IMPORT_FORCE=1` 长期写进 Compose。当前 API 提供快照列表、单份快照读取和恢复；恢复会校验快照并写入新的状态版本。具体请求以最终路由实现为准，操作前仍应保留独立备份。

## 升级与回滚

1. 导出 YAML；重要数据同时做 SQLite 在线备份。
2. 记录当前镜像标签：`docker compose images`。
3. 更新代码，在 `.env` 中设置目标 `STUDIOLO_IMAGE_TAG`，执行 `docker compose up -d --build`。
4. 检查 `docker compose ps`、健康接口、登录和桌面数据。

回滚到上一镜像时，把 `STUDIOLO_IMAGE_TAG` 改回已验证的旧标签并重新 `up -d --build`。如果新版本做过不兼容的数据迁移，仅回滚镜像并不足够：先停止服务，再用升级前的备份恢复；恢复后验证登录、数据版本和健康状态。不要在没有备份时尝试跨版本降级。

## 日志与诊断

```bash
docker compose ps
docker compose logs --tail=200 studiolo
docker inspect --format '{{json .State.Health}}' studiolo
curl --fail http://127.0.0.1:3002/api/v1/health
```

Homebrew 使用 `brew services list` 和上述服务日志；LaunchAgent 使用 `launchctl print gui/$(id -u)/com.rexding.rexhub`（Label 以本机 plist 为准）。排查时依次确认端口占用、数据目录权限、密码是否初始化、健康/就绪状态和最近导入错误。日志可能包含路径或网络信息，公开分享前先脱敏。

## 保留策略

当前本地保留策略：桌面快照最多 20 份；点击原始事件保留 30 天，排序只统计近 7 天；主机指标保留 2 天；会话有效期 7 天。探针只保留最近状态。快照不是异地备份，清理策略也不能替代定期 YAML/SQLite 导出。

## 多主机指标

本机组件直接用 psutil 采集。其他主机通过 SSH 读取指标，需要事先配置免密登录，并在主机组件中填写 `ip`、`sshPort`（默认 22）和 `sshUser`。没有 SSH 的主机会显示为离线，不影响桌面其他部分。不要把私钥提交到仓库；CI 不依赖任何 SSH 私钥或真实外部主机。

## 配置字段

```yaml
profile:
  title: Studiolo
  dockEnabled: true
  wallpaper: aurora-peaks
layout:
  - id: host-mac
    kind: widget
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

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `REXHUB_INIT_PASSWORD` | 空 | 首次初始化密码，已有用户不会覆盖 |
| `REXHUB_USER` | `admin` | 登录用户名；服务端只校验密码 |
| `REXHUB_BIND_HOST` | `127.0.0.1` | Compose 发布到宿主机的地址 |
| `REXHUB_PORT` | `3002` | Compose 发布的宿主机端口 |
| `STUDIOLO_IMAGE_TAG` | `0.1.3` | Compose 镜像标签 |
| `REXHUB_DATA_DIR` | `/app/server/data` | 容器数据目录 |
| `REXHUB_DB` | `<data>/rexhub.db` | SQLite 文件路径 |
| `REXHUB_IMPORT_YAML` | 空 | 启动时导入的 YAML 路径 |
| `REXHUB_IMPORT_FORCE` | `0` | 强制覆盖；成功标记防止重复覆盖 |
| `REXHUB_IMPORT_ONLY` | `0` | 设为 `1` 时初始化/导入后退出，用于一次性恢复 |
| `PSUTIL_PROCFS_PATH` | 空 | 采集宿主机指标时指向 `/host/proc` |
| `PIP_INDEX_URL` | `https://pypi.org/simple` | 构建时的 pip 源 |

## HTTP API

当前主要端点：

| 方法 | 路径 | 认证 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/v1/auth/login` | - | 密码登录，写 HttpOnly Cookie |
| POST | `/api/v1/auth/logout` | ✓ | 注销 |
| GET | `/api/v1/auth/me` | - | 当前会话 |
| GET | `/api/v1/state` | ✓ | 读取桌面状态与版本号 |
| PUT | `/api/v1/state` | ✓ | 写入状态，带 `rev` 乐观锁，冲突返回 409 |
| GET | `/api/v1/state/meta` | ✓ | 轻量版本号，用于多端检测 |
| GET | `/api/v1/state/snapshots` | ✓ | 快照元数据列表 |
| GET | `/api/v1/state/snapshots/{rev}` | ✓ | 读取单份快照 |
| POST | `/api/v1/state/snapshots/{rev}/restore` | ✓ | 校验并恢复快照 |
| GET | `/api/v1/runtime` | ✓ | 主机指标、探针、天气、点击热度 |
| GET | `/api/v1/metrics?host=` | ✓ | 单主机历史采样 |
| POST | `/api/v1/click` | ✓ | 记录一次点击 |
| GET | `/api/v1/favicon?u=` | ✓ | favicon 抓取与缓存 |
| GET | `/api/v1/weather?city=` | ✓ | Open-Meteo 代理 |
| GET | `/api/v1/health` | - | 存活与诊断 |
| GET | `/api/v1/ready` | - | 初始化、数据库和采集器就绪检查 |

其他新远程集成端点不在此预先展开；以最终路由和 API 文档为准。

## 目录

```
web/                 前端（无构建步骤）
server/              Python 后端与 SQLite 持久层
server/data/         运行时数据（不入库）
Dockerfile           固定 patch 基础镜像与 psutil 版本
docker-entrypoint.sh 初始化、严格导入与非 root 启动
.github/workflows/   CI 与 Pages 部署
```

## 安全

- `server/data/`、`private/`、`.env` 不进入版本库或 Docker 构建上下文
- 密码只保存 PBKDF2-HMAC-SHA256 哈希
- favicon 代理要求登录，并限制目标来源
- 默认仅回环地址可访问；公网部署必须在反向代理层启用 HTTPS，并配置访问控制与安全更新

## License

MIT
