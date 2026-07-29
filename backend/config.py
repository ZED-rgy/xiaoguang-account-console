"""运行配置：路径、端口与平台入口地址。"""
import json
import os
from pathlib import Path

from .platforms import CREATOR_URLS


ROOT_DIR = Path(__file__).resolve().parents[1]
APP_ID = "com.local.account-console"
try:
    APP_VERSION = json.loads((ROOT_DIR / "package.json").read_text(encoding="utf-8"))["version"]
except (OSError, KeyError, TypeError, json.JSONDecodeError):
    APP_VERSION = "0.0.0"
# 数据目录可用环境变量重定向（打包版由 Electron 指到 exe 旁的 data，与源码目录解耦）
_DATA_OVERRIDE = os.environ.get("ACCOUNT_CONSOLE_DATA", "").strip()
DATA_DIR = Path(_DATA_OVERRIDE) if _DATA_OVERRIDE else ROOT_DIR / "data"
STATIC_DIR = ROOT_DIR / "frontend"
DB_PATH = DATA_DIR / "account_console.sqlite3"
BACKUP_DIR = DATA_DIR / "backups"
AVATAR_DIR = DATA_DIR / "avatars"

PORT = int(os.environ.get("ACCOUNT_CONSOLE_PORT", "8826"))
HOST = "127.0.0.1"

PROFILE_ROOT = DATA_DIR / "browser_profiles"
