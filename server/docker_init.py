"""容器首次启动时按环境变量初始化密码，不覆盖已有用户。"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import db

path = os.environ.get("REXHUB_DB", "/app/server/data/rexhub.db")
db.configure(path)
db.init()

if db.has_user():
    print("[init] user exists, password unchanged", flush=True)
else:
    password = os.environ.get("REXHUB_INIT_PASSWORD", "")
    if not password:
        print("[init] REXHUB_INIT_PASSWORD is empty, skip", flush=True)
    else:
        db.set_password(os.environ.get("REXHUB_USER", "admin"), password)
        print("[init] password initialized", flush=True)
