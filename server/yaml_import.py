"""导入 Studiolo 导出的 YAML，用于首次部署或灾难恢复。"""

import json
import re


class ImportError(Exception):
    pass


def _scalar(raw):
    text = raw.strip()
    if not text:
        return ""
    if len(text) >= 2 and text[0] == text[-1] and text[0] in ('"', "'"):
        if text[0] == '"':
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                return text[1:-1]
        return text[1:-1]
    if text == "true":
        return True
    if text == "false":
        return False
    if re.fullmatch(r"-?\d+", text):
        return int(text)
    if re.fullmatch(r"-?\d+\.\d+", text):
        return float(text)
    return text


def parse(text):
    stripped = text.lstrip()
    if stripped.startswith("{"):
        return _normalize(json.loads(stripped))

    state = {"version": "4.0", "profile": {}, "layout": [], "apps": []}
    section = None
    current = None

    for raw in text.splitlines():
        line = raw.rstrip()
        if not line.strip() or line.lstrip().startswith("#"):
            continue

        if re.match(r"^version\s*:", line):
            state["version"] = str(_scalar(line.split(":", 1)[1]))
            continue
        if re.match(r"^profile\s*:\s*$", line):
            section, current = "profile", None
            continue
        if re.match(r"^layout\s*:\s*$", line):
            section, current = "layout", None
            continue
        if re.match(r"^apps\s*:\s*$", line):
            section, current = "apps", None
            continue

        if section == "profile":
            match = re.match(r"^\s+([A-Za-z0-9_]+)\s*:\s*(.*)$", line)
            if not match:
                continue
            key, value = match.group(1), _scalar(match.group(2))
            if key == "themeCustomJson":
                try:
                    state["profile"]["themeCustom"] = json.loads(value)
                except (TypeError, json.JSONDecodeError):
                    pass
            else:
                state["profile"][key] = value
            continue

        if section in ("layout", "apps"):
            item = re.match(r"^\s*-\s+([A-Za-z0-9_]+)\s*:\s*(.*)$", line)
            if item:
                current = {item.group(1): _scalar(item.group(2))}
                state[section].append(current)
                continue
            field = re.match(r"^\s+([A-Za-z0-9_]+)\s*:\s*(.*)$", line)
            if field and current is not None:
                current[field.group(1)] = _scalar(field.group(2))

    return _normalize(state)


def _normalize(state):
    if not isinstance(state, dict):
        raise ImportError("YAML 根节点必须是对象")
    if not isinstance(state.get("layout"), list):
        raise ImportError("YAML 缺少 layout 列表")
    if not isinstance(state.get("apps"), list) or not state["apps"]:
        raise ImportError("YAML 缺少有效的 apps 列表")

    for item in state["layout"]:
        if not isinstance(item, dict):
            raise ImportError("layout 项必须是对象")
        raw = item.pop("configJson", None)
        if raw is not None:
            try:
                item["config"] = json.loads(raw) if isinstance(raw, str) else raw
            except json.JSONDecodeError as exc:
                raise ImportError(f"layout {item.get('id')} 的 configJson 无效: {exc}")
        item.setdefault("kind", "widget")
        item["w"] = 1 if item.get("kind") == "app" else int(item.get("w") or 4)
        item["h"] = 1 if item.get("kind") == "app" else int(item.get("h") or 2)

    for app in state["apps"]:
        if not isinstance(app, dict):
            raise ImportError("apps 项必须是对象")
        app.setdefault("status", "online")
        app.setdefault("useSiteLogo", True)
        app["clicks"] = int(app.get("clicks") or 0)

    profile = state.setdefault("profile", {})
    profile.setdefault("title", "Studiolo")
    profile.setdefault("layoutMode", "bento")
    profile.setdefault("dockEnabled", True)
    profile.setdefault("wallpaper", "aurora-peaks")
    profile.setdefault("searchEngine", "google")
    profile.setdefault("themePreset", "vision-glass")
    return state


def load(path):
    with open(path, "r", encoding="utf-8") as fh:
        return parse(fh.read())
