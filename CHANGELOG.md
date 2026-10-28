# Changelog

## Unreleased

### 新增

- PR 与 main CI：Python 编译/unittest、全部 JavaScript 语法检查、Docker build、Compose config 和真实 HTTP 冒烟
- Docker 一次性强制恢复模式及按备份内容记录的成功标记，避免重启反复覆盖

### 变更

- Compose 默认仅绑定 `127.0.0.1`，支持通过环境变量显式修改；镜像标签默认固定为 `0.1.3`
- Docker 基础镜像固定到 Python 3.12.12 slim trixie patch tag，并显式使用 SIGTERM 停止
- Homebrew 服务显式绑定 `127.0.0.1`
- README 明确前端零构建、后端标准库与 psutil 的依赖边界，并补充备份恢复、升级回滚、诊断和保留策略
- 架构文档区分当前实现与 core / remote / widgets 目标，限定用户插件为纯数据

### 修复

- Docker YAML 文件缺失、解析和 I/O 失败不再被吞掉；已有状态的普通导入可明确跳过并成功
- 容器启动不再递归 `chown` 整棵数据树，仅在必要时调整数据根目录权限
- 发布文档移除个人绝对路径，校准设置页签、LaunchAgent 与容器恢复检查

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
- Python 标准库与 psutil 后端，SQLite 持久化
- 单用户密码登录，PBKDF2-HMAC-SHA256 哈希
- Docker / Compose 部署
- GitHub Pages 示例模式（`?demo=1` 或 `*.github.io`）

### 安全

- favicon 代理要求登录，并校验目标域名来自当前应用列表
- 运行时数据目录与私有运维资料不进入版本库
