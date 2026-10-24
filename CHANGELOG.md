# Changelog

## v0.1.3 — 2026-10-24

### 新增

- `--import-yaml`：清空数据后可用一份 YAML 恢复布局、应用、主题、壁纸与近 7 天热度
- Docker 环境变量 `REXHUB_IMPORT_YAML` / `REXHUB_IMPORT_FORCE` 自动导入
- 导入时写入快照，已有状态默认跳过

## v0.1.2 — 2026-10-24

### 新增

- 仓库内 Homebrew formula，支持 `brew services` 托管
- 数据目录固定在 `$(brew --prefix)/var/studiolo`

### 变更

- 后端启动描述统一为 Studiolo Hub

## v0.1.1 — 2026-10-24

### 新增

- `Dockerfile`、`docker-compose.yml`、首次启动密码初始化
- `CHANGELOG.md`、`CONTRIBUTING.md`
- README 增加环境变量与 HTTP API 参考

### 变更

- 容器内可通过 `PSUTIL_PROCFS_PATH` 采集宿主机指标

## v0.1.0 — 2026-10-24

首个公开预览版。

### 新增

- 2D 原子网格桌面，自由拖放，空位保留，不自动补全
- 可复用组件：服务器节点、应用文件夹、天气、日历、便签、时钟
- 本机 psutil 与远程 SSH 指标采集（CPU / 内存 / 磁盘 / 延迟）
- 应用 TCP + HTTP 探测，30 秒刷新
- 近 7 天点击热度排序
- 主题工坊、壁纸切换、可选底部 Dock
- YAML 导入导出，附带 `web/default-state.yaml` 示例
- 零依赖 Python 标准库后端，SQLite 持久化
- 单用户密码登录，PBKDF2-HMAC-SHA256 哈希
- Docker / Compose 部署
- GitHub Pages 示例模式（`?demo=1` 或 `*.github.io`）

### 安全

- favicon 代理要求登录，并校验目标域名来自当前应用列表
- 运行时数据目录与私有运维资料不进入版本库
