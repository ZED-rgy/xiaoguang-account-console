"""共享平台能力声明及主页链接规则。"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Optional


_MANIFEST_PATH = Path(__file__).resolve().parents[1] / "shared" / "platforms.json"
PLATFORM_CAPABILITIES = json.loads(_MANIFEST_PATH.read_text(encoding="utf-8"))
PLATFORM_BY_NAME = {item["name"]: item for item in PLATFORM_CAPABILITIES}
CREATOR_URLS = {item["name"]: item["creator_urls"] for item in PLATFORM_CAPABILITIES}
DEFAULT_PLATFORMS = [item["name"] for item in PLATFORM_CAPABILITIES]
COLLECT_SUPPORTED_PLATFORMS = [
    item["name"] for item in PLATFORM_CAPABILITIES if item.get("collect_supported")
]

_GENERIC_URL_PATTERN = re.compile(r"https?://[^\s一-鿿，。、]+")


def _rule_value(rule: dict, match: re.Match) -> str:
    principal_group = rule.get("principal_group")
    if rule.get("canonical_prefix") and principal_group:
        return f"{rule['canonical_prefix']}{match.group(int(principal_group))}"
    return match.group(0)


def normalize_homepage_url(url: Optional[str], platform: Optional[str] = None) -> Optional[str]:
    if not url:
        return url
    text = str(url).strip()
    candidates = [PLATFORM_BY_NAME.get(platform)] if platform else PLATFORM_CAPABILITIES
    for capability in (item for item in candidates if item):
        for rule in capability.get("homepage_patterns", []):
            match = re.search(rule["pattern"], text, re.IGNORECASE)
            if not match:
                continue
            value = _rule_value(rule, match)
            if rule.get("ensure_trailing_slash") and not value.endswith("/"):
                value += "/"
            return value
    if platform:
        return None
    generic = _GENERIC_URL_PATTERN.search(text)
    if generic:
        return generic.group(0).rstrip("/,;)")
    return text or None


def is_platform_homepage(platform: str, url: Optional[str]) -> bool:
    return bool(normalize_homepage_url(url, platform))


def public_capabilities() -> list[dict]:
    keys = ("key", "name", "icon", "collect_supported", "creator_urls")
    return [{key: item.get(key) for key in keys} for item in PLATFORM_CAPABILITIES]
