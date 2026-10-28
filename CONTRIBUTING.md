# Contributing

## 约定

- 前端保持零构建步骤、零运行时包依赖
- 后端使用 Python 标准库与 psutil；新增依赖需要说明理由并同步容器、Formula 和文档
- 不提交 `server/data/`、`private/`、`.env`、备份或凭据
- 新接口先实现再写命令示例；目标架构与当前实现必须明确区分
- 保持默认回环地址绑定，测试不依赖真实外网、私钥或私人服务

## 本地开发

准备 Python 3.12 虚拟环境：

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install psutil==6.1.0
REXHUB_INIT_PASSWORD='your-password' python server/rexhub.py --set-password
python server/rexhub.py --host 127.0.0.1 --port 3002
```

纯静态模式：

```bash
python3 -m http.server 3002 --bind 127.0.0.1 --directory web
```

带示例数据打开 `http://127.0.0.1:3002/?demo=1`。

## 测试与检查

提交前在仓库根目录运行：

```bash
python -m compileall -q server
python -m unittest discover -s tests -v
sh -n docker-entrypoint.sh

git ls-files -z '*.js' | while IFS= read -r -d '' file; do
  node --check "$file"
done

docker compose config
docker build -t studiolo:test .
```

`read -d` 示例需要 Bash。所有跟踪的 JavaScript 文件都应通过 `node --check`，不能只检查入口文件。修改容器后，还要在本地启动测试容器并请求 `/api/v1/health`、`/api/v1/ready` 和首页，确认进程以 uid `10001` 运行。涉及初始化/readiness 的改动必须额外验证“未初始化不就绪”，且不要把存活响应当成就绪证明。

CI 在 PR 和 main 上执行相同类别的检查。不得用跳过失败、屏蔽错误或访问真实外部服务来让测试变绿。

## 提交

- 提交信息使用 `feat:`、`fix:`、`docs:`、`chore:` 前缀
- 较大的改动先开 issue 说明动机、数据兼容和回滚范围
- 不移动已发布 tag，不在发布 Formula 时保留旧版本 SHA

## 发布

版本发布步骤见 [`RELEASING.md`](RELEASING.md)，按顺序执行。
