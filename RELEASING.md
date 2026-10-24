# 发布流程

每次发版按顺序执行，不要跳步。

## 0. 版本号

语义化版本 `vMAJOR.MINOR.PATCH`：

- `v0.x` 阶段：新功能升 MINOR，修复升 PATCH
- **已发布的 tag 永不移动**；需要修正就发下一个版本

## 1. 发布前检查

```bash
cd ~/SystemDoc/rexding-net

git status                     # 必须是 clean
python3 -m py_compile server/*.py
```

前端语法：

```bash
osascript -l JavaScript -e '
ObjC.import("Foundation");
var s = $.NSString.stringWithContentsOfFileEncodingError("/Users/rexding/SystemDoc/rexding-net/web/cloudos.js", $.NSUTF8StringEncoding, null).js;
new Function(s);
'
```

或打开 `http://127.0.0.1:3002/?demo=1`，确认控制台没有报错。

如果改了后端依赖或 Dockerfile：

```bash
docker build -t studiolo:test .
docker run --rm -d --name studiolo-test -p 13002:3002 \
  -e REXHUB_INIT_PASSWORD=test studiolo:test
sleep 5
curl -s http://127.0.0.1:13002/api/v1/health
docker rm -f studiolo-test
```

## 2. 更新 CHANGELOG

在 `CHANGELOG.md` 顶部新增条目：

```markdown
## vX.Y.Z — YYYY-MM-DD

### 新增
### 变更
### 修复
```

只写用户能感知的变化，不写内部重构细节。

## 3. 提交并打 tag

```bash
git add -A
git commit -m "release: vX.Y.Z"
git tag -a vX.Y.Z -m "Studiolo vX.Y.Z"
git push origin main
git push origin vX.Y.Z
```

## 4. 更新 Homebrew formula

计算新 tag 的 tarball 校验值：

```bash
curl -sL https://github.com/rexding97/studiolo/archive/refs/tags/vX.Y.Z.tar.gz | shasum -a 256
```

修改 `Formula/studiolo.rb`：

```ruby
url "https://github.com/rexding97/studiolo/archive/refs/tags/vX.Y.Z.tar.gz"
sha256 "<上一步结果>"
```

提交并推送：

```bash
git add Formula/studiolo.rb
git commit -m "chore: bump formula to vX.Y.Z"
git push origin main
```

本地验证：

```bash
cd /opt/homebrew/Library/Taps/rexding97/homebrew-studiolo
git pull --ff-only
brew upgrade rexding97/studiolo/studiolo
studiolo --help
```

## 5. 创建 GitHub Release

打开：

```
https://github.com/rexding97/studiolo/releases/new?tag=vX.Y.Z
```

- Title：`Studiolo vX.Y.Z`
- 描述：从 CHANGELOG 对应条目复制
- 附上在线示例：`https://rexding97.github.io/studiolo/`
- 只有预览版才勾 pre-release

> 注意：GitHub CLI 的 device flow 签发的是细粒度 token，无法创建 release。用网页，或 classic PAT（勾 `repo`）。

## 6. 部署与验证

正式环境（LaunchAgent）：

```bash
launchctl kickstart -k gui/$(id -u)/com.rexding.rexhub
curl -s http://127.0.0.1:3002/api/v1/health
```

在线示例（push 后自动部署）：

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://rexding97.github.io/studiolo/
```

浏览器确认：

- 顶栏同步状态正常
- 主机指标、天气、应用在线状态有数据
- 设置面板四个页签可用
- 拖拽、文件夹、Dock 正常

## 7. 安全复查

```bash
git ls-files | grep -E "private/|server/data/|\.env$"   # 应为空
git log -p --all | grep -nE "ding8591|4Paurlj|8L97hWhm|PfsId6|FOuSjQ|LTAI|BEGIN .*PRIVATE"  # 应为空
```

## 8. 发布后

- Docker 镜像按需另行构建推送；本机 Docker Hub 直连不可用，需要镜像加速或代理
- 功能定位有变化时，更新 GitHub 的 description / topics
- 有截图时更新 README 顶部预览图

## 禁止事项

- 不提交 `server/data/`、`private/`、`.env`
- 不把密钥、内网 IP、规则 Key 写进公开文件
- 不 force push 已发布的 tag
- 不在 3002 上同时运行 LaunchAgent 和 `brew services`
