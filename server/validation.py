"""Shared validation for persisted desktop state and API input."""

import ipaddress
import json
import math
import re
import urllib.parse

MAX_ID = 128
MAX_STRING = 65536
MAX_ITEMS = 2000
MAX_DEPTH = 12
_ID = re.compile(r"^[^\x00-\x1f\x7f]+$")
_SSH_USER = re.compile(r"^[A-Za-z_][A-Za-z0-9_.-]{0,63}$")


class ValidationError(ValueError):
    pass


def require_dict(value, name="value"):
    if not isinstance(value, dict):
        raise ValidationError(f"{name} 必须是对象")
    return value


def require_list(value, name="value"):
    if not isinstance(value, list):
        raise ValidationError(f"{name} 必须是数组")
    return value


def validate_id(value, name="id"):
    if not isinstance(value, str) or not value or len(value) > MAX_ID or not _ID.fullmatch(value):
        raise ValidationError(f"{name} 必须是 1-{MAX_ID} 字符的非空字符串")
    return value


def validate_port(value, name="port", allow_empty=False):
    if allow_empty and (value is None or value == ""):
        return None
    if isinstance(value, bool):
        raise ValidationError(f"{name} 必须是 1-65535 的端口")
    try:
        port = int(value)
    except (TypeError, ValueError):
        raise ValidationError(f"{name} 必须是 1-65535 的端口") from None
    if str(value).strip() != str(port) or not 1 <= port <= 65535:
        raise ValidationError(f"{name} 必须是 1-65535 的端口")
    return port


def validate_url(value, name="url", allow_empty=False):
    if allow_empty and (value is None or value == ""):
        return ""
    if not isinstance(value, str) or not value or len(value) > 2048 or any(ord(c) < 32 for c in value):
        raise ValidationError(f"{name} 必须是有效的 http(s) URL")
    try:
        parsed = urllib.parse.urlparse(value)
        port = parsed.port
    except ValueError:
        raise ValidationError(f"{name} 必须是有效的 http(s) URL") from None
    if parsed.scheme.lower() not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
        raise ValidationError(f"{name} 必须是有效的 http(s) URL")
    if port is not None:
        validate_port(port, name)
    return value


def validate_ssh_user(value):
    if not isinstance(value, str) or not _SSH_USER.fullmatch(value):
        raise ValidationError("sshUser 格式无效")
    return value


def validate_ip(value):
    if not isinstance(value, str):
        raise ValidationError("ip 必须是 IP 地址字符串")
    try:
        return str(ipaddress.ip_address(value.strip()))
    except ValueError:
        raise ValidationError("ip 必须是有效的 IPv4 或 IPv6 地址") from None


def _check_json(value, path, depth=0):
    if depth > MAX_DEPTH:
        raise ValidationError(f"{path} 嵌套过深")
    if value is None or isinstance(value, (bool, int)):
        if isinstance(value, int) and not isinstance(value, bool) and abs(value) > 2**53:
            raise ValidationError(f"{path} 整数超出安全范围")
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValidationError(f"{path} 数值必须有限")
        return
    if isinstance(value, str):
        if len(value) > MAX_STRING or "\x00" in value:
            raise ValidationError(f"{path} 字符串过长或含空字符")
        return
    if isinstance(value, list):
        if len(value) > MAX_ITEMS:
            raise ValidationError(f"{path} 项数超过 {MAX_ITEMS}")
        for index, item in enumerate(value):
            _check_json(item, f"{path}[{index}]", depth + 1)
        return
    if isinstance(value, dict):
        if len(value) > 512:
            raise ValidationError(f"{path} 字段过多")
        for key, item in value.items():
            if not isinstance(key, str) or not key or len(key) > 128:
                raise ValidationError(f"{path} 包含无效字段名")
            _check_json(item, f"{path}.{key}", depth + 1)
        return
    raise ValidationError(f"{path} 包含不支持的类型")


def _coordinate(item, key, minimum, maximum, required=True):
    if key not in item and not required:
        return
    value = item.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValidationError(f"layout {item.get('id')} 的 {key} 必须是 {minimum}-{maximum} 的整数")


def validate_state(state):
    require_dict(state, "state")
    _check_json(state, "state")
    layout = require_list(state.get("layout"), "state.layout")
    apps = require_list(state.get("apps"), "state.apps")
    if len(layout) > MAX_ITEMS or len(apps) > MAX_ITEMS:
        raise ValidationError(f"layout/apps 最多各 {MAX_ITEMS} 项")
    if "profile" in state:
        require_dict(state["profile"], "state.profile")
    for key in ("plugins", "workspaces"):
        if key in state and not isinstance(state[key], (dict, list)):
            raise ValidationError(f"state.{key} 必须是对象或数组")

    layout_ids = set()
    for item in layout:
        require_dict(item, "layout 项")
        item_id = validate_id(item.get("id"), "layout.id")
        if item_id in layout_ids:
            raise ValidationError(f"layout.id 重复: {item_id}")
        layout_ids.add(item_id)
        if "kind" in item and (not isinstance(item["kind"], str) or not item["kind"]):
            raise ValidationError(f"layout {item_id} 的 kind 无效")
        _coordinate(item, "x", 0, 10000)
        _coordinate(item, "y", 0, 10000)
        _coordinate(item, "w", 1, 1000)
        _coordinate(item, "h", 1, 1000)
        config = item.get("config", {})
        require_dict(config, f"layout {item_id}.config")
        if item.get("widgetType") == "server-node":
            if config.get("ip") not in (None, ""):
                validate_ip(config["ip"])
            validate_port(config.get("sshPort", 22), "sshPort")
            validate_ssh_user(config.get("sshUser", "root"))
        if item.get("widgetType") in ("calendar", "schedule", "calendar-events"):
            for key in ("icsUrl", "caldavUrl"):
                if config.get(key) not in (None, ""):
                    validate_url(config[key], key)
            forbidden = {"password", "token", "secret", "authorization"}
            if any(key.lower() in forbidden for key in config):
                raise ValidationError("日程凭据必须使用服务端环境变量，不能写入 state")

    app_ids = set()
    for app in apps:
        require_dict(app, "apps 项")
        app_id = validate_id(app.get("id"), "apps.id")
        if app_id in app_ids:
            raise ValidationError(f"apps.id 重复: {app_id}")
        app_ids.add(app_id)
        for key in ("href", "logoUrl"):
            if key in app:
                validate_url(app[key], key, allow_empty=True)
        if "port" in app:
            validate_port(app["port"], "port", allow_empty=True)
        container = app.get("containerId")
        if container not in (None, ""):
            validate_id(container, "containerId")
            if container not in layout_ids:
                raise ValidationError(f"应用 {app_id} 引用了不存在的容器 {container}")
        if "clicks" in app:
            clicks = app["clicks"]
            if isinstance(clicks, bool) or not isinstance(clicks, int) or not 0 <= clicks <= 1000000:
                raise ValidationError(f"应用 {app_id} 的 clicks 无效")

    for item in layout:
        if item.get("kind") == "app" and item.get("appId") not in (None, ""):
            if item["appId"] not in app_ids:
                raise ValidationError(f"布局 {item['id']} 引用了不存在的应用 {item['appId']}")
    size = len(json.dumps(state, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8"))
    if size > 2 * 1024 * 1024:
        raise ValidationError("state 超过 2MB")
    return state


def validate_login(body):
    require_dict(body, "请求体")
    username = body.get("username", "admin")
    password = body.get("password", "")
    if not isinstance(username, str) or not 1 <= len(username) <= 128:
        raise ValidationError("用户名必须是 1-128 字符的字符串")
    if not isinstance(password, str) or not 1 <= len(password) <= 1024:
        raise ValidationError("密码必须是 1-1024 字符的字符串")
    return username, password
