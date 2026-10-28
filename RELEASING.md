# 发布流程

每次发版按顺序执行，不要跳步。命令均从仓库根目录运行，不依赖个人机器路径。

## 0. 版本号

语义化版本 `vMAJOR.MINOR.PATCH`：

- `v0.x` 阶段：新功能升 MINOR，修复升 PATCH
- 已发布的 tag 永不移动；需要修正就发下一个版本
- 同步更新 Compose / `.env.example` 的默认镜像标签，不沿用 `latest`

## 1. 发布前检查

```bash
git status
python3 -m compileall -q server
python3 -m unittest discover -s tests -v
sh -n docker-entrypoint.sh

git ls-files -z '*.js' | while IFS= read -r -d '' file; do
  node --check "$file"
done
```

运行 CI 等价的容器检查：

```bash
docker compose config
docker build -t studiolo:test .
docker run --rm -d --name studiolo-test \
  -p 127.0.0.1:13002:3002 \
  -e REXHUB_INIT_PASSWORD=test-only-password \
  studiolo:test
for attempt in $(seq 1 30); do
  curl --fail --silent http://127.0.0.1:13002/api/v1/ready && break
  sleep 1
done
curl --fail http://127.0.0.1:13002/api/v1/ready
curl --fail http://127.0.0.1:13002/ >/dev/null
test "$(docker top studiolo-test -o pid,user,args | awk 'NR > 1 && $3 == "python" && $4 == "/app/server/rexhub.py" {print $2}')" = "10001"
docker rm -f studiolo-test
```

使用 `/api/v1/ready` 验证就绪，并单独启动未初始化实例确认该端点返回非 2xx；`/api/v1/health` 用于存活与诊断，不能代替就绪检查。

如果修改了基础镜像，查询并记录可验证的多架构 digest；网络不可用时可保留明确 patch tag，但必须在发布说明中承认尚未做到 digest 固定，不能填写未经验证的值。

## 2. 更新 CHANGELOG 与文档

在 `CHANGELOG.md` 顶部把对应 Unreleased 内容整理为：

```markdown
## vX.Y.Z — YYYY-MM-DD

### 新增
### 变更
### 修复
```

只写用户能感知的变化。确认 README 的镜像标签、默认 host、依赖、备份恢复和保留策略与代码一致；设计目标不得写成已发布功能。

## 3. 提交并打 tag

```bash
git add -A
git commit -m "release: vX.Y.Z"
git tag -a vX.Y.Z -m "Studiolo vX.Y.Z"
git push origin main
git push origin vX.Y.Z
```

## 4. 更新 Homebrew Formula

计算新 tag 的 tarball 校验值：

```bash
curl -fsSL https://github.com/rexding97/studiolo/archive/refs/tags/vX.Y.Z.tar.gz | shasum -a 256
```

只在新版本中修改 `Formula/studiolo.rb` 的 `url` 与 `sha256`，保留服务显式的 `--host 127.0.0.1`。绝不修改已发布版本的 SHA 来掩盖内容变化。

```bash
brew reinstall --build-from-source rexding97/studiolo/studiolo
studiolo --help
brew services restart studiolo
curl --fail http://127.0.0.1:3002/api/v1/health
```

## 5. 创建 GitHub Release

在 `https://github.com/rexding97/studiolo/releases` 创建对应 tag 的 Release：

- Title：`Studiolo vX.Y.Z`
- 描述：从 CHANGELOG 对应条目复制
- 附上在线示例：`https://rexding97.github.io/studiolo/`
- 只有预览版才勾 pre-release

使用具备仓库 Release 写权限的网页会话或令牌；不要在文档、命令历史或 CI 中记录令牌。

## 6. 部署与验证

### LaunchAgent

先核对实际 Label、plist、Python 路径、项目路径和 `--host` 参数，避免文档与正在运行的服务漂移：

```bash
launchctl print gui/$(id -u)/com.rexding.rexhub
plutil -p "$HOME/Library/LaunchAgents/com.rexding.rexhub.plist"
launchctl kickstart -k gui/$(id -u)/com.rexding.rexhub
curl --fail http://127.0.0.1:3002/api/v1/health
```

若本机 Label 不同，以实际 plist 为准。确认 LaunchAgent、`brew services` 与 Docker 没有同时占用 3002。

### 容器与恢复演练

升级前导出 YAML，并做 SQLite 在线备份。升级后检查：

```bash
docker compose ps
docker compose logs --tail=200 studiolo
curl --fail http://127.0.0.1:3002/api/v1/ready
docker top studiolo -o pid,user,args   # rexhub.py 应为 uid 10001
```

至少做一次不触碰正式数据的恢复演练：用测试卷和测试端口启动候选镜像，执行 README 的一次性强制恢复命令，确认退出码为 0；再重复执行，确认相同备份不会二次覆盖。另用损坏 YAML 和缺失文件验证命令非零退出、服务不误报 ready。登录测试实例核对应用、布局、主题、插件数据及恢复前快照；快照恢复参数只使用最终代码实际提供的命令。

回滚必须使用旧镜像标签和升级前备份，并再次验证登录、数据与健康状态。仅改回镜像不能撤销不兼容的数据迁移。

### 在线示例

```bash
curl -fsSL -o /dev/null -w "%{http_code}\n" https://rexding97.github.io/studiolo/
```

浏览器确认：

- 顶栏同步状态正常
- 主机指标、天气、应用在线状态有数据
- 设置的五个页签均可用：桌面、主题、自定义、壁纸、数据
- 拖拽、文件夹、Dock 正常

## 7. 安全复查

```bash
git ls-files | grep -E '(^|/)(private|server/data)/|\.env$'   # 应为空
git grep -n -I -E 'BEGIN [A-Z ]*PRIVATE KEY|REXHUB_INIT_PASSWORD=[^[:space:]]+'   # 人工检查，示例密码除外
```

同时审查未跟踪文件、Release 附件和容器构建日志，不公开真实密码、私钥、内网地址或访问令牌。

## 8. 发布后

- 构建并推送与 release 一致的版本化镜像；不得只更新 `latest`
- 功能定位变化时更新 GitHub description / topics
- 有截图时更新 README 预览
- 确认 CI 与 Pages workflow 均成功

## 禁止事项

- 不提交运行时数据、私有运维资料或 `.env`
- 不 force push 已发布 tag，不改已发布 tarball 的 Formula SHA
- 不在 3002 上同时运行多个服务管理器
- 不把未落地的 readiness、恢复或远程集成接口写成已验证能力
