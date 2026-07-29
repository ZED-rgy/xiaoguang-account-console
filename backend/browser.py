import os
import re
import shutil
import subprocess
from pathlib import Path

from .config import CREATOR_URLS, PROFILE_ROOT
from .db import connect, utc_now


def _slug(value: str | None) -> str:
    text = value or "account"
    text = re.sub(r"[\\/:*?\"<>|\\s]+", "_", text.strip())
    return text.strip("_") or "account"


def find_browser() -> str | None:
    candidates = [
        shutil.which("chrome"),
        shutil.which("chrome.exe"),
        shutil.which("msedge"),
        shutil.which("msedge.exe"),
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return str(candidate)
    return None


def target_url(platform: str | None, target: str, homepage_url: str | None = None) -> str:
    if target == "home" and homepage_url:
        return homepage_url
    platform_urls = CREATOR_URLS.get(platform or "", {})
    return platform_urls.get(target) or platform_urls.get("home") or homepage_url or "about:blank"


def open_account_workspace(account_id: int, target: str = "home") -> dict:
    with connect() as conn:
        row = conn.execute("SELECT * FROM accounts WHERE id=?", (account_id,)).fetchone()
        if not row:
            raise ValueError("account not found")
        platform = row["platform"] or "unknown"
        account_name = row["account_name"] or f"account_{account_id}"
        profile_path = row["profile_path"]
        if not profile_path:
            profile_path = str(PROFILE_ROOT / _slug(platform) / f"{account_id}_{_slug(account_name)}")
        Path(profile_path).mkdir(parents=True, exist_ok=True)
        url = target_url(platform, target, row["homepage_url"])
        browser = find_browser()
        if not browser:
            raise RuntimeError("未找到 Chrome 或 Edge 浏览器")
        subprocess.Popen(
            [
                browser,
                f"--user-data-dir={profile_path}",
                "--new-window",
                url,
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
        )
        now = utc_now()
        conn.execute(
            "UPDATE accounts SET profile_path=?, last_opened_at=? WHERE id=?",
            (profile_path, now, account_id),
        )
    return {
        "ok": True,
        "account_id": account_id,
        "platform": platform,
        "profile_path": profile_path,
        "url": url,
    }
