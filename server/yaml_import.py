"""Parse and validate Studiolo YAML/JSON exports without side effects."""

import json
import os
import re

import validation


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
            except json.JSONDecodeError as exc:
                raise ImportError(f"字符串引号无效: {exc.msg}") from None
        return text[1:-1].replace("''", "'")
    if text == "true":
        return True
    if text == "false":
        return False
    if re.fullmatch(r"-?\d+", text):
        return int(text)
    if re.fullmatch(r"-?(?:\d+\.\d*|\d*\.\d+)", text):
        return float(text)
    return text


def parse(text):
    if not isinstance(text, str):
        raise ImportError("导入内容必须是文本")
    if len(text.encode("utf-8")) > 2 * 1024 * 1024:
        raise ImportError("导入文件超过 2MB")
    try:
        stripped = text.lstrip()
        if stripped.startswith("{"):
            state = json.loads(stripped)
        else:
            state = _parse_yaml(text)
        return _normalize(state)
    except (validation.ValidationError, ValueError, TypeError) as exc:
        if isinstance(exc, ImportError):
            raise
        raise ImportError(f"配置无效: {exc}") from None


def _parse_yaml(text):
    state = {"version": "4.0", "profile": {}, "layout": [], "apps": []}
    section = None
    current = None
    for line_number, raw in enumerate(text.splitlines(), 1):
        line = raw.rstrip()
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if "\t" in raw[:len(raw) - len(raw.lstrip())]:
            raise ImportError(f"第 {line_number} 行不能使用 Tab 缩进")
        if re.match(r"^version\s*:", line):
            state["version"] = str(_scalar(line.split(":", 1)[1]))
            continue
        matched_section = re.match(r"^(profile|layout|apps)\s*:\s*(\[\])?\s*$", line)
        if matched_section:
            section = matched_section.group(1)
            current = None
            continue
        if section == "profile":
            match = re.match(r"^\s+([A-Za-z0-9_]+)\s*:\s*(.*)$", line)
            if not match:
                raise ImportError(f"第 {line_number} 行 profile 格式无效")
            key = match.group(1)
            try:
                value = _scalar(match.group(2))
            except ImportError:
                if key == "themeWallpaperJson":
                    raise ImportError(f"第 {line_number} 行 themeWallpaperJson 损坏") from None
                raise
            if key == "themeCustomJson":
                try:
                    state["profile"]["themeCustom"] = json.loads(value) if value else None
                except (TypeError, json.JSONDecodeError):
                    raise ImportError(f"第 {line_number} 行 themeCustomJson 无效") from None
            elif key == "themeWallpaperJson":
                try:
                    state["profile"]["themeWallpaper"] = json.loads(value)
                except (TypeError, json.JSONDecodeError):
                    raise ImportError(f"第 {line_number} 行 themeWallpaperJson 损坏") from None
                if state["profile"]["themeWallpaper"] is not None and not isinstance(
                        state["profile"]["themeWallpaper"], dict):
                    raise ImportError(f"第 {line_number} 行 themeWallpaperJson 必须是对象或 null")
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
                key = field.group(1)
                value = _scalar(field.group(2))
                if key == "mobileJson":
                    try:
                        current["mobile"] = json.loads(value)
                    except (TypeError, json.JSONDecodeError):
                        raise ImportError(f"第 {line_number} 行 mobileJson 损坏") from None
                    if not isinstance(current["mobile"], dict):
                        raise ImportError(f"第 {line_number} 行 mobileJson 必须是对象")
                else:
                    current[key] = value
                continue
        root_field = re.match(r"^([A-Za-z0-9_]+)\s*:\s*(.*)$", line)
        if root_field:
            key, raw_value = root_field.group(1), root_field.group(2)
            if key == "savedThemesJson":
                try:
                    state["profile"]["savedThemes"] = json.loads(_scalar(raw_value))
                except (ImportError, TypeError, json.JSONDecodeError):
                    raise ImportError(f"第 {line_number} 行 savedThemesJson 损坏") from None
                themes = state["profile"]["savedThemes"]
                if not isinstance(themes, list) or any(not isinstance(theme, dict) for theme in themes):
                    raise ImportError(f"第 {line_number} 行 savedThemesJson 必须是主题对象数组")
            elif key in ("pluginsJson", "workspacesJson"):
                target = key[:-4]
                try:
                    state[target] = json.loads(_scalar(raw_value))
                except (ImportError, TypeError, json.JSONDecodeError):
                    raise ImportError(f"第 {line_number} 行 {key} 损坏") from None
                if not isinstance(state[target], list):
                    raise ImportError(f"第 {line_number} 行 {key} 必须是数组")
            elif key in ("plugins", "workspaces"):
                try:
                    state[key] = json.loads(raw_value) if raw_value else {}
                except json.JSONDecodeError:
                    raise ImportError(f"第 {line_number} 行 {key} 必须使用内联 JSON 对象或数组") from None
            else:
                state[key] = _scalar(raw_value)
            section = None
            current = None
            continue
        if line.strip():
            raise ImportError(f"第 {line_number} 行格式无效或字段不受支持")
    return state


def _normalize(state):
    validation.require_dict(state, "YAML 根节点")
    validation.require_list(state.get("layout"), "YAML layout")
    validation.require_list(state.get("apps"), "YAML apps")
    for item in state["layout"]:
        validation.require_dict(item, "layout 项")
        raw = item.pop("configJson", None)
        if raw is not None:
            try:
                item["config"] = json.loads(raw) if isinstance(raw, str) and raw else ({} if raw == "" else raw)
            except json.JSONDecodeError as exc:
                raise ImportError(f"layout {item.get('id')} 的 configJson 无效: {exc.msg}") from None
        item.setdefault("kind", "widget")
        try:
            item["w"] = 1 if item.get("kind") == "app" else int(item.get("w") or 4)
            item["h"] = 1 if item.get("kind") == "app" else int(item.get("h") or 2)
            item["x"] = int(item.get("x", 0))
            item["y"] = int(item.get("y", 0))
        except (TypeError, ValueError):
            raise ImportError(f"layout {item.get('id')} 的坐标或尺寸无效") from None
    for app in state["apps"]:
        validation.require_dict(app, "apps 项")
        app.setdefault("status", "online")
        app.setdefault("useSiteLogo", True)
        try:
            app["clicks"] = int(app.get("clicks") or 0)
        except (TypeError, ValueError):
            raise ImportError(f"应用 {app.get('id')} 的 clicks 无效") from None
    profile = state.setdefault("profile", {})
    validation.require_dict(profile, "profile")
    profile.setdefault("title", "Studiolo")
    profile.setdefault("layoutMode", "bento")
    profile.setdefault("dockEnabled", True)
    profile.setdefault("wallpaper", "aurora-peaks")
    profile.setdefault("searchEngine", "google")
    profile.setdefault("themePreset", "vision-glass")
    validation.validate_state(state)
    return state


def load(path):
    normalized = os.path.realpath(os.path.abspath(os.path.expanduser(os.fspath(path))))
    with open(normalized, "r", encoding="utf-8") as fh:
        return parse(fh.read(2 * 1024 * 1024 + 1))
