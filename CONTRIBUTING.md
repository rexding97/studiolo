# Contributing

## 约定

- 前端保持零依赖、无构建步骤
- 后端只使用 Python 标准库，新增依赖需要说明理由
- 不提交 `server/data/`、`private/`、`.env`
- 修改后至少确认：
  - `python3 -m py_compile server/*.py`
  - 浏览器能正常加载 `web/`

## 提交

- 提交信息使用 `feat:`、`fix:`、`docs:`、`chore:` 前缀
- 较大的改动请先开 issue 说明动机与范围

## 本地开发

完整模式：

```bash
cd server
REXHUB_INIT_PASSWORD='your-password' python3 rexhub.py --set-password
python3 rexhub.py --port 3002
```

纯静态模式：

```bash
python3 -m http.server 3002 --directory web
```

带示例数据：

```
http://127.0.0.1:3002/?demo=1
```
