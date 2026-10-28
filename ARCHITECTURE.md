# 架构设计

本文以当前代码为准。前端按 core / remote / widgets 划分职责，后端仍以 Python 模块提供状态、采集与远程适配；这些名称描述现有边界，不代表另有独立服务。

## 1. 总体结构

- `web/core.js`：状态规范化、旧配置兼容、YAML/JSON 导入导出、多工作区与活动镜像。
- `web/remote.js`：认证后的服务端同步、乐观锁冲突处理、重试与快照请求。
- `web/widgets.js`：内置组件注册表、声明式插件校验与安全渲染。
- `web/cloudos.js`：把这些边界接入工作区交互、组件适配、版本中心和设置界面。
- `server/`：HTTP 路由、认证、SQLite 持久化、指标采集、远程日历与静态文件托管。
- `docker-entrypoint.sh`：权限、初始化与严格导入；实际服务降权到 uid `10001`。

前端保持零构建步骤。完整模式以服务端状态为准，浏览器 localStorage 只承担纯静态演示等客户端职责。

## 2. Core：状态与多工作区

状态包含全局 `profile`、`plugins` 和 `workspaces`，并保留顶层 `layout` / `apps` 作为当前活动工作区镜像：

- 每个工作区有唯一 `id`、`name` 以及自己的 `layout`、`apps`。
- `profile.activeWorkspaceId` 指向活动工作区。
- 规范化后，顶层 `layout` / `apps` 与活动工作区一致；切换工作区时先保存旧活动镜像，再载入目标工作区。
- 后端采集器与日历来源读取顶层活动镜像，因此兼容现有运行时数据路径。
- 插件定义是全局的，各工作区通过 `widgetType: "plugin"` 和 `config.pluginId` 引用；不允许引用不存在的插件。

YAML 使用 `workspacesJson` 保存工作区 JSON 数组，使用 `pluginsJson` 保存插件 JSON 数组。导入时校验数组结构、引用、URL、坐标和未知插件类型；旧状态缺少工作区时生成默认工作区。

状态写入使用 `rev` 乐观锁。SQLite 保存账号、会话、状态、最近 20 份快照、点击与指标；版本中心通过快照列表、单份读取和恢复 API 展示差异并恢复。快照不是异地备份。

## 3. Widgets：注册表与纯数据插件

内置服务器、文件夹、天气、日历、便签和时钟通过统一注册接口提供元数据、配置 schema、默认尺寸及渲染函数。`render` / `update` 属于随版本发布的受信任代码，不是用户插件入口。

当前声明式插件类型：

- `text`：文本与 Markdown 子集。
- `links`：`config.links` JSON 数组，每项使用 `label`、`url` 和可选 `description`。
- `image`：`config.images` JSON 数组，支持 URL 字符串或含 `url`、`alt`、`href` 的对象，并有轮播配置。
- `countdown`：目标时间与到期文本。
- `iframe`：单个 HTTP(S) URL。

用户插件只有数据表达能力：

- `state.plugins` 是最多 100 项的数组，插件 ID 必须唯一，布局通过 `pluginId` 引用。
- 只接受上述已知类型，按 schema 校验字段、URL 和尺寸；不能加载或执行用户 JavaScript。
- 链接和图片 URL 限制为 HTTP(S)，`iframe` 使用 sandbox，且不授予 `allow-same-origin`。
- 插件定义随 `pluginsJson` 备份；账号、会话、SSH 私钥和远程服务凭据不随插件导出。

## 4. Remote：同步、指标与日历

`remote.js` 负责服务端同步及请求生命周期，不拥有桌面事实数据。本机/SSH 指标和应用探测由后端采集器提供；主机组件读取 `/api/v1/metrics` 的最近 60 点历史，SSH 按钮只复制命令，不在浏览器中建立 SSH 连接。

`server/schedule.py` 从活动布局的日历组件读取 ICS 或 CalDAV URL，并通过 `/api/v1/calendar/events` 返回只读事件：

- ICS 使用 HTTP(S) GET；CalDAV 使用 `Depth: 1` 的 `REPORT` calendar-query。
- CalDAV 可选 HTTP Basic 凭据只从服务端环境变量读取，键名由组件 ID 派生。
- 当前只解析基础 VEVENT 的开始、结束、标题和全天标记，不展开重复规则。
- 不提供事件创建、修改、删除、日历发现、OAuth 或完整 CalDAV 同步。
- 请求有超时、响应大小、来源数量与事件数量限制；失败可短期返回缓存的旧数据。
- 重定向只允许原主机，外部失败不能绕过状态校验或修改桌面文档。

CI 使用本地替身，不依赖真实日历、SSH 私钥或私人服务。

## 5. 健康、恢复与部署

`/api/v1/health` 提供存活与诊断，`/api/v1/ready` 仅在初始化、数据库和采集器检查通过后返回成功；容器健康检查使用后者。`/api/v1/readiness` 是同一就绪检查的别名。

导入或恢复失败不会被入口脚本吞掉。普通导入遇到已有状态可明确跳过；Docker 强制恢复只有成功后才写内容摘要标记，避免每次重启覆盖。恢复快照通过独立 API 校验版本冲突并生成新的状态版本。

应用自身提供 HTTP，默认只监听/发布到 `127.0.0.1:3002`，公网访问由 HTTPS 反向代理终止 TLS。Docker 镜像固定 Python patch tag 与 psutil 版本；基础镜像 digest 尚需在网络可用时核实固定。

## 6. 主题边界

主题包由稳定 ID、名称、基准预设和 token 值组成。主题包不执行代码，只有内置 token 定义可以把数据映射到 CSS 变量或受限 `dataset`；未知 token 不应生成任意 CSS。

## 7. 后续演进约束

后续扩展应保持旧 YAML 可导入、顶层活动镜像一致、用户插件不可执行以及远程凭据不进入状态。新能力先落地代码与本地测试，再更新 API 和恢复文档；不得用架构目标代替已实现行为。
