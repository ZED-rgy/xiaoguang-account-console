"""SQLite 连接、建表迁移、索引、备份与 account_id 回填。"""
import json
import re
import sqlite3
import shutil
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import BACKUP_DIR, DATA_DIR, DB_PATH

BACKUP_KEEP = 14


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def ensure_data_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def xiaohongshu_published_at(platform_work_id: str) -> str | None:
    value = str(platform_work_id or "")
    if not re.fullmatch(r"[a-fA-F0-9]{24}", value):
        return None
    try:
        seconds = int(value[:8], 16)
    except ValueError:
        return None
    now_seconds = int(datetime.now().timestamp())
    if seconds < 1262304000 or seconds > now_seconds + 86400:
        return None
    return datetime.fromtimestamp(seconds).strftime("%Y-%m-%d %H:%M:%S")


@contextmanager
def connect():
    ensure_data_dir()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_record_id TEXT UNIQUE,
                account_name TEXT,
                platform TEXT,
                status TEXT,
                account_type TEXT,
                traffic_level TEXT,
                followers INTEGER,
                homepage_url TEXT,
                avatar_url TEXT,
                profile_nickname TEXT,
                notes TEXT,
                phone_record_ids TEXT,
                device_record_ids TEXT,
                profile_path TEXT,
                login_status TEXT,
                profile_synced_at TEXT,
                last_profile_check_at TEXT,
                source_origin TEXT,
                source_deleted_at TEXT,
                local_updated_at TEXT,
                last_opened_at TEXT,
                last_synced_at TEXT
            );

            CREATE TABLE IF NOT EXISTS works (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_record_id TEXT UNIQUE,
                work_no TEXT,
                platform TEXT,
                platform_work_id TEXT,
                account_name TEXT,
                title TEXT,
                work_url TEXT,
                video_url TEXT,
                account_homepage TEXT,
                publish_date TEXT,
                published_at TEXT,
                collected_at TEXT,
                collect_status TEXT,
                collect_error TEXT,
                time_range TEXT,
                likes INTEGER,
                comments INTEGER,
                favorites INTEGER,
                shares INTEGER,
                last_synced_at TEXT
            );

            CREATE TABLE IF NOT EXISTS publish_tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                account_id INTEGER,
                platform TEXT,
                material_path TEXT,
                cover_path TEXT,
                caption TEXT,
                tags TEXT,
                planned_at TEXT,
                status TEXT NOT NULL DEFAULT '待发布',
                stage TEXT,
                priority TEXT,
                result_work_url TEXT,
                notes TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS sync_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                started_at TEXT NOT NULL,
                finished_at TEXT,
                status TEXT NOT NULL,
                accounts_count INTEGER DEFAULT 0,
                works_count INTEGER DEFAULT 0,
                error_message TEXT
            );

            CREATE TABLE IF NOT EXISTS work_metrics_daily (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                work_id INTEGER NOT NULL,
                date TEXT NOT NULL,
                likes INTEGER,
                comments INTEGER,
                favorites INTEGER,
                shares INTEGER,
                plays INTEGER,
                collected_at TEXT,
                UNIQUE(work_id, date),
                FOREIGN KEY(work_id) REFERENCES works(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS collect_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                started_at TEXT NOT NULL,
                finished_at TEXT,
                platform TEXT,
                account_id INTEGER,
                trigger_source TEXT,
                status TEXT NOT NULL,
                works_found INTEGER DEFAULT 0,
                works_updated INTEGER DEFAULT 0,
                error_message TEXT
            );

            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT
            );

            CREATE TABLE IF NOT EXISTS account_login_sessions (
                id INTEGER PRIMARY KEY,
                platform TEXT NOT NULL,
                partition TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS collect_targets (
                account_id INTEGER PRIMARY KEY,
                created_at TEXT NOT NULL,
                FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
            );
            """
        )
        # 旧版本把所有账号隐式视为采集目标。首次升级时保留这一结果；
        # 新安装及后续新增账号则由用户在采集中心明确选择。
        collect_targets_initialized = conn.execute(
            "SELECT value FROM app_settings WHERE key='collect_targets_initialized'"
        ).fetchone()
        if not collect_targets_initialized:
            collect_config_row = conn.execute(
                "SELECT value FROM app_settings WHERE key='collect_config'"
            ).fetchone()
            try:
                collect_config = json.loads(collect_config_row["value"]) if collect_config_row else {}
                legacy_platforms = collect_config.get("platforms") or ["抖音"]
            except (TypeError, ValueError, json.JSONDecodeError):
                legacy_platforms = ["抖音"]
            legacy_platforms = [str(platform) for platform in legacy_platforms if str(platform).strip()]
            placeholders = ",".join("?" for _ in legacy_platforms)
            conn.execute(
                f"""
                INSERT OR IGNORE INTO collect_targets(account_id, created_at)
                SELECT id, ? FROM accounts
                WHERE platform IN ({placeholders})
                """,
                (utc_now(), *legacy_platforms),
            )
            conn.execute(
                "INSERT INTO app_settings(key, value) VALUES ('collect_targets_initialized', ?)",
                (utc_now(),),
            )
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(accounts)").fetchall()}
        migrations = {
            "avatar_url": "ALTER TABLE accounts ADD COLUMN avatar_url TEXT",
            "profile_nickname": "ALTER TABLE accounts ADD COLUMN profile_nickname TEXT",
            "profile_synced_at": "ALTER TABLE accounts ADD COLUMN profile_synced_at TEXT",
            "login_status": "ALTER TABLE accounts ADD COLUMN login_status TEXT",
            "last_profile_check_at": "ALTER TABLE accounts ADD COLUMN last_profile_check_at TEXT",
            "source_origin": "ALTER TABLE accounts ADD COLUMN source_origin TEXT",
            "source_deleted_at": "ALTER TABLE accounts ADD COLUMN source_deleted_at TEXT",
            "local_updated_at": "ALTER TABLE accounts ADD COLUMN local_updated_at TEXT",
            "sort_order": "ALTER TABLE accounts ADD COLUMN sort_order INTEGER",
            "custom_fields": "ALTER TABLE accounts ADD COLUMN custom_fields TEXT",
            "platform_account_id": "ALTER TABLE accounts ADD COLUMN platform_account_id TEXT",
            "browser_partition": "ALTER TABLE accounts ADD COLUMN browser_partition TEXT",
        }
        for column, sql in migrations.items():
            if column not in columns:
                conn.execute(sql)
        # New installations enforce stable platform identity uniqueness at the
        # storage layer. Legacy databases with pre-existing duplicates keep
        # running; write endpoints still serialize and reject new conflicts.
        try:
            conn.execute(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_platform_identity
                ON accounts(platform, platform_account_id)
                WHERE platform_account_id IS NOT NULL AND TRIM(platform_account_id)<>''
                """
            )
        except sqlite3.IntegrityError:
            pass
        task_columns = {row["name"] for row in conn.execute("PRAGMA table_info(publish_tasks)").fetchall()}
        task_migrations = {
            "stage": "ALTER TABLE publish_tasks ADD COLUMN stage TEXT",
            "priority": "ALTER TABLE publish_tasks ADD COLUMN priority TEXT",
        }
        for column, sql in task_migrations.items():
            if column not in task_columns:
                conn.execute(sql)
        work_columns = {row["name"] for row in conn.execute("PRAGMA table_info(works)").fetchall()}
        if "account_id" not in work_columns:
            conn.execute("ALTER TABLE works ADD COLUMN account_id INTEGER")
        if "plays" not in work_columns:
            conn.execute("ALTER TABLE works ADD COLUMN plays INTEGER")
        backfill_work_account_ids(conn)
        # 旧版小红书采集器没有保存发布时间，导致成功采集的作品沉到列表底部。
        # 笔记 id 的前 8 位是稳定的秒级发布时间，启动迁移时一次性补齐。
        xhs_rows = conn.execute(
            """
            SELECT id, platform_work_id FROM works
            WHERE platform='小红书' AND published_at IS NULL
            """
        ).fetchall()
        for row in xhs_rows:
            published_at = xiaohongshu_published_at(row["platform_work_id"])
            if published_at:
                conn.execute(
                    "UPDATE works SET published_at=? WHERE id=?",
                    (published_at, row["id"]),
                )
        # 清理历史脏数据：互动数里混入的时间戳等异常大值（>= 1 亿）
        for table in ("works", "work_metrics_daily"):
            for col in ("likes", "comments", "favorites", "shares", "plays"):
                conn.execute(
                    f"UPDATE {table} SET {col}=NULL WHERE {col} IS NOT NULL AND ({col} < 0 OR {col} >= 100000000)"
                )
        conn.executescript(
            """
            CREATE INDEX IF NOT EXISTS idx_works_account_name ON works(account_name);
            CREATE INDEX IF NOT EXISTS idx_works_account_id ON works(account_id);
            CREATE INDEX IF NOT EXISTS idx_works_published ON works(published_at);
            CREATE INDEX IF NOT EXISTS idx_works_publish_date ON works(publish_date);
            CREATE INDEX IF NOT EXISTS idx_accounts_platform_status ON accounts(platform, status);
            CREATE INDEX IF NOT EXISTS idx_accounts_platform_identity ON accounts(platform, platform_account_id);
            CREATE INDEX IF NOT EXISTS idx_tasks_status ON publish_tasks(status);
            CREATE INDEX IF NOT EXISTS idx_metrics_work_date ON work_metrics_daily(work_id, date);
            CREATE INDEX IF NOT EXISTS idx_metrics_date ON work_metrics_daily(date);
            CREATE INDEX IF NOT EXISTS idx_collect_targets_created ON collect_targets(created_at);
            """
        )


def cleanup_abandoned_login_sessions(conn: sqlite3.Connection) -> int:
    """清除未完成且未被正式账号采用的登录分区，然后删除临时会话。"""
    rows = conn.execute("SELECT partition FROM account_login_sessions").fetchall()
    partitions_root = (DATA_DIR / "electron-profile" / "Partitions").resolve()
    removed = 0
    for row in rows:
        partition = str(row["partition"] or "")
        if not partition.startswith("persist:account-login-"):
            continue
        adopted = conn.execute(
            "SELECT 1 FROM accounts WHERE browser_partition=? LIMIT 1", (partition,)
        ).fetchone()
        if adopted:
            continue
        folder = (partitions_root / partition.removeprefix("persist:")).resolve()
        if folder.parent == partitions_root and folder.name.startswith("account-login-"):
            shutil.rmtree(folder, ignore_errors=True)
            removed += 1
    conn.execute("DELETE FROM account_login_sessions")
    return removed


def backfill_work_account_ids(conn: sqlite3.Connection) -> int:
    """按账号名精确匹配，把作品绑定到账号（仅当账号名唯一时）。"""
    cur = conn.execute(
        """
        UPDATE works
        SET account_id = (
            SELECT a.id FROM accounts a
            WHERE a.account_name = works.account_name
        )
        WHERE account_id IS NULL
          AND account_name IS NOT NULL
          AND account_name != ''
          AND (
            SELECT COUNT(*) FROM accounts a
            WHERE a.account_name = works.account_name
          ) = 1
        """
    )
    return cur.rowcount


def backup_db(reason: str = "manual") -> Path | None:
    """把数据库备份到 data/backups，保留最近 BACKUP_KEEP 份。"""
    if not DB_PATH.exists():
        return None
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    target = BACKUP_DIR / f"account_console_{stamp}_{reason}.sqlite3"
    with sqlite3.connect(DB_PATH) as src, sqlite3.connect(target) as dst:
        src.backup(dst)
    backups = sorted(BACKUP_DIR.glob("account_console_*.sqlite3"))
    for old in backups[:-BACKUP_KEEP]:
        old.unlink(missing_ok=True)
    return target


def daily_backup_if_needed() -> Path | None:
    """每天第一次启动时自动备份一次数据库。"""
    today = datetime.now().strftime("%Y-%m-%d")
    with connect() as conn:
        row = conn.execute(
            "SELECT value FROM app_settings WHERE key='last_daily_backup_date'"
        ).fetchone()
        if row and row["value"] == today:
            return None
        conn.execute(
            "INSERT INTO app_settings(key, value) VALUES('last_daily_backup_date', ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (today,),
        )
    return backup_db(reason="daily")


def row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    data = dict(row)
    for key in ("phone_record_ids", "device_record_ids"):
        if key in data:
            try:
                data[key] = json.loads(data[key] or "[]")
            except json.JSONDecodeError:
                data[key] = []
    if "custom_fields" in data:
        try:
            data["custom_fields"] = json.loads(data["custom_fields"] or "{}")
        except (json.JSONDecodeError, TypeError):
            data["custom_fields"] = {}
    return data


def rows_to_dicts(rows) -> list[dict[str, Any]]:
    return [row_to_dict(row) for row in rows]


