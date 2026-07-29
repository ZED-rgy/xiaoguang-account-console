import json
import re
import time
import urllib.request
import uuid
from datetime import date
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .analytics import router as analytics_router
from .browser import open_account_workspace
from .browser import target_url as account_target_url
from .config import APP_ID, APP_VERSION, AVATAR_DIR, BACKUP_DIR, CREATOR_URLS, DATA_DIR, PROFILE_ROOT
from .config import HOST, PORT, STATIC_DIR
from .db import (
    backup_db,
    cleanup_abandoned_login_sessions,
    connect,
    daily_backup_if_needed,
    init_db,
    row_to_dict,
    rows_to_dicts,
    utc_now,
)
from .platforms import (
    COLLECT_SUPPORTED_PLATFORMS,
    DEFAULT_PLATFORMS,
    normalize_homepage_url,
    public_capabilities,
)


app = FastAPI(title="小光账号")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        f"http://127.0.0.1:{PORT}",
        f"http://localhost:{PORT}",
    ],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(analytics_router)


class OpenWorkspacePayload(BaseModel):
    target: str = "home"


class AccountLoginSessionPayload(BaseModel):
    platform: str


class CompleteAccountLoginPayload(BaseModel):
    profile_nickname: Optional[str] = None
    avatar_url: Optional[str] = None
    homepage_url: Optional[str] = None
    platform_account_id: Optional[str] = None
    add_to_collect_targets: bool = False


class AccountPayload(BaseModel):
    account_name: str
    platform: Optional[str] = None
    status: Optional[str] = "正常"
    account_type: Optional[str] = "可用"
    traffic_level: Optional[str] = None
    followers: Optional[int] = None
    homepage_url: Optional[str] = None
    avatar_url: Optional[str] = None
    profile_nickname: Optional[str] = None
    notes: Optional[str] = None
    custom_fields: Optional[dict] = None


class AccountPatch(BaseModel):
    account_name: Optional[str] = None
    platform: Optional[str] = None
    status: Optional[str] = None
    account_type: Optional[str] = None
    traffic_level: Optional[str] = None
    followers: Optional[int] = None
    homepage_url: Optional[str] = None
    avatar_url: Optional[str] = None
    profile_nickname: Optional[str] = None
    login_status: Optional[str] = None
    notes: Optional[str] = None
    custom_fields: Optional[dict] = None



class AccountProfilePayload(BaseModel):
    avatar_url: Optional[str] = None
    profile_nickname: Optional[str] = None
    homepage_url: Optional[str] = None
    platform_account_id: Optional[str] = None


class DiscoveredAccountIdentityPayload(BaseModel):
    homepage_url: str
    platform_account_id: str


class CollectWorkItem(BaseModel):
    platform_work_id: str
    title: Optional[str] = None
    work_url: Optional[str] = None
    published_at: Optional[str] = None
    likes: Optional[int] = None
    comments: Optional[int] = None
    favorites: Optional[int] = None
    shares: Optional[int] = None
    plays: Optional[int] = None


class CollectAuthorInfo(BaseModel):
    nickname: Optional[str] = None
    avatar_url: Optional[str] = None


class CollectReportPayload(BaseModel):
    account_id: int
    platform: str
    trigger_source: str = "manual"
    status: str = "success"
    error_message: Optional[str] = None
    started_at: Optional[str] = None
    works: list[CollectWorkItem] = []
    author: Optional[CollectAuthorInfo] = None


class CollectTargetsPayload(BaseModel):
    account_ids: list[int]


# 头像本地缓存：平台 CDN 头像链接带签名会过期，下载存 data/avatars 后改走本地地址
def cache_avatar(account_id: int, url: str) -> Optional[str]:
    if not url or not str(url).startswith("http"):
        return None
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                          "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        })
        with urllib.request.urlopen(req, timeout=10) as resp:
            content_type = (resp.headers.get("Content-Type") or "").split(";")[0].strip()
            data = resp.read(5 * 1024 * 1024)
        if not data or not content_type.startswith("image/"):
            return None
        ext = {"image/png": ".png", "image/webp": ".webp", "image/gif": ".gif"}.get(content_type, ".jpg")
        AVATAR_DIR.mkdir(parents=True, exist_ok=True)
        for old in AVATAR_DIR.glob(f"{account_id}.*"):
            old.unlink(missing_ok=True)
        (AVATAR_DIR / f"{account_id}{ext}").write_bytes(data)
        return f"/api/avatars/{account_id}?v={int(time.time())}"
    except Exception:
        return None


@app.on_event("startup")
def startup() -> None:
    init_db()
    daily_backup_if_needed()
    # 存量数据修复：把分享口令文本清洗成可加载的 URL
    with connect() as conn:
        # 登录会话只在当前桌面进程内有效；异常退出留下的会话下次启动自动清理。
        cleanup_abandoned_login_sessions(conn)
        # 兼容开发期曾写入 accounts 的临时占位。
        conn.execute("DELETE FROM accounts WHERE source_origin='login_pending'")
        rows = conn.execute(
            "SELECT id, homepage_url FROM accounts WHERE homepage_url IS NOT NULL AND homepage_url != ''"
        ).fetchall()
        for row in rows:
            cleaned = normalize_homepage_url(row["homepage_url"])
            if cleaned and cleaned != row["homepage_url"]:
                conn.execute("UPDATE accounts SET homepage_url=? WHERE id=?", (cleaned, row["id"]))


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "app_id": APP_ID,
        "version": APP_VERSION,
        "data_dir": str(DATA_DIR.resolve()),
        "time": utc_now(),
    }


@app.post("/api/account-login-sessions")
def create_account_login_session(payload: AccountLoginSessionPayload):
    platform = payload.platform.strip()
    if platform not in CREATOR_URLS:
        raise HTTPException(400, "unsupported platform")
    now = utc_now()
    with connect() as conn:
        # 使用负数临时 id，避免和正式账号 BrowserView 键冲突；会话不进入账号资产表。
        account_id = -(uuid.uuid4().int % 1_000_000_000_000 + 1)
        partition = f"persist:account-login-{abs(account_id)}"
        conn.execute(
            "INSERT INTO account_login_sessions(id, platform, partition, created_at) VALUES (?, ?, ?, ?)",
            (account_id, platform, partition, now),
        )
    return {
        "ok": True,
        "account_id": account_id,
        "platform": platform,
        "partition": partition,
        "url": account_target_url(platform, "publish", None),
        "status": "waiting",
    }


@app.post("/api/account-login-sessions/{account_id}/complete")
def complete_account_login_session(account_id: int, payload: CompleteAccountLoginPayload):
    now = utc_now()
    with connect() as conn:
        pending = conn.execute(
            "SELECT * FROM account_login_sessions WHERE id=?",
            (account_id,),
        ).fetchone()
        if not pending:
            raise HTTPException(404, "login session not found")
        nickname = (payload.profile_nickname or "").strip()
        account_name = nickname or f"{pending['platform']}账号"
        homepage_url = normalize_homepage_url(payload.homepage_url, pending["platform"])
        platform_account_id = (payload.platform_account_id or "").strip() or None
        avatar_url = (payload.avatar_url or "").strip() or None
        if not nickname or not avatar_url:
            raise HTTPException(400, "nickname and avatar required")
        if not platform_account_id and not homepage_url:
            raise HTTPException(400, "stable platform identity required")
        existing = None
        if platform_account_id:
            existing = conn.execute(
                """
                SELECT * FROM accounts
                WHERE platform=? AND platform_account_id=?
                  AND COALESCE(source_origin, '') != 'login_pending'
                ORDER BY id LIMIT 1
                """,
                (pending["platform"], platform_account_id),
            ).fetchone()
        elif homepage_url:
            existing = conn.execute(
                """
                SELECT * FROM accounts
                WHERE platform=? AND homepage_url=?
                  AND COALESCE(source_origin, '') != 'login_pending'
                ORDER BY id LIMIT 1
                """,
                (pending["platform"], homepage_url),
            ).fetchone()
        target_id = int(existing["id"]) if existing else None
        if target_id and avatar_url and avatar_url.startswith("http"):
            avatar_url = cache_avatar(target_id, avatar_url) or avatar_url
        if existing:
            account_name = nickname or existing["account_name"] or account_name
            conn.execute(
                """
                UPDATE accounts
                SET account_name=?,
                    profile_nickname=COALESCE(?, profile_nickname),
                    avatar_url=COALESCE(?, avatar_url),
                    homepage_url=COALESCE(?, homepage_url),
                    platform_account_id=COALESCE(?, platform_account_id),
                    browser_partition=?, login_status='已登录', source_origin='login',
                    profile_synced_at=?, last_profile_check_at=?, local_updated_at=?, last_synced_at=?
                WHERE id=?
                """,
                (
                    account_name,
                    nickname or None,
                    avatar_url,
                    homepage_url,
                    platform_account_id,
                    pending["partition"],
                    now,
                    now,
                    now,
                    now,
                    target_id,
                ),
            )
            if payload.add_to_collect_targets:
                conn.execute(
                    "INSERT OR IGNORE INTO collect_targets(account_id, created_at) VALUES (?, ?)",
                    (target_id, now),
                )
            conn.execute("DELETE FROM account_login_sessions WHERE id=?", (account_id,))
            account = conn.execute("SELECT * FROM accounts WHERE id=?", (target_id,)).fetchone()
            return {"ok": True, "account_id": target_id, "merged": True, "account": row_to_dict(account)}
        cur = conn.execute(
            """
            INSERT INTO accounts(
                source_record_id, account_name, platform, status, account_type,
                profile_nickname, avatar_url, homepage_url, platform_account_id,
                browser_partition, login_status, source_origin, profile_synced_at,
                last_profile_check_at, local_updated_at, last_synced_at
            ) VALUES (?, ?, ?, '正常', '可用', ?, ?, ?, ?, ?, '已登录', 'login', ?, ?, ?, ?)
            """,
            (
                f"login-{uuid.uuid4().hex}",
                account_name,
                pending["platform"],
                nickname or None,
                avatar_url,
                homepage_url,
                platform_account_id,
                pending["partition"],
                now,
                now,
                now,
                now,
            ),
        )
        target_id = int(cur.lastrowid)
        if avatar_url and avatar_url.startswith("http"):
            avatar_url = cache_avatar(target_id, avatar_url) or avatar_url
            conn.execute("UPDATE accounts SET avatar_url=? WHERE id=?", (avatar_url, target_id))
        if payload.add_to_collect_targets:
            conn.execute(
                "INSERT OR IGNORE INTO collect_targets(account_id, created_at) VALUES (?, ?)",
                (target_id, now),
            )
        conn.execute("DELETE FROM account_login_sessions WHERE id=?", (account_id,))
        account = conn.execute("SELECT * FROM accounts WHERE id=?", (target_id,)).fetchone()
    return {"ok": True, "account_id": target_id, "merged": False, "account": row_to_dict(account)}


@app.delete("/api/account-login-sessions/{account_id}")
def cancel_account_login_session(account_id: int):
    with connect() as conn:
        pending = conn.execute(
            "SELECT id FROM account_login_sessions WHERE id=?",
            (account_id,),
        ).fetchone()
        if not pending:
            raise HTTPException(404, "login session not found")
        conn.execute("DELETE FROM account_login_sessions WHERE id=?", (account_id,))
    return {"ok": True, "account_id": account_id}


@app.get("/api/accounts")
def accounts(
    search: str = "",
    platform: str = "",
    status: str = "",
    limit: int = Query(200, ge=1, le=500),
):
    clauses = ["COALESCE(source_origin, '') != 'login_pending'"]
    params = []
    if search:
        clauses.append("(account_name LIKE ? OR notes LIKE ?)")
        params.extend([f"%{search}%", f"%{search}%"])
    if platform:
        clauses.append("platform = ?")
        params.append(platform)
    if status:
        clauses.append("status = ?")
        params.append(status)
    where = "WHERE " + " AND ".join(clauses) if clauses else ""
    with connect() as conn:
        rows = conn.execute(
            f"""
            SELECT *,
              (SELECT COUNT(*) FROM works WHERE works.account_id = accounts.id) AS works_count
            FROM accounts
            {where}
            ORDER BY CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END, sort_order, platform, account_name
            LIMIT ?
            """,
            (*params, limit),
        ).fetchall()
    return {"data": rows_to_dicts(rows)}


class ReorderPayload(BaseModel):
    ids: list[int]


@app.post("/api/accounts/reorder")
def reorder_accounts(payload: ReorderPayload):
    if not payload.ids:
        raise HTTPException(400, "empty ids")
    now = utc_now()
    with connect() as conn:
        for index, account_id in enumerate(payload.ids):
            conn.execute(
                "UPDATE accounts SET sort_order=?, local_updated_at=? WHERE id=?",
                (index, now, account_id),
            )
    return {"ok": True, "count": len(payload.ids)}


@app.get("/api/accounts/{account_id}")
def account_detail(account_id: int):
    with connect() as conn:
        account = row_to_dict(conn.execute("SELECT * FROM accounts WHERE id=?", (account_id,)).fetchone())
        if not account:
            raise HTTPException(404, "account not found")
        works = rows_to_dicts(
            conn.execute(
                "SELECT * FROM works WHERE account_id=? ORDER BY COALESCE(published_at, publish_date) DESC LIMIT 30",
                (account_id,),
            ).fetchall()
        )
        tasks = rows_to_dicts(
            conn.execute(
                """
                SELECT *
                FROM publish_tasks
                WHERE account_id=?
                ORDER BY COALESCE(planned_at, created_at) DESC
                LIMIT 20
                """,
                (account_id,),
            ).fetchall()
        )
    return {"account": account, "works": works, "tasks": tasks}


@app.post("/api/accounts")
def create_account(payload: AccountPayload):
    now = utc_now()
    payload.homepage_url = normalize_homepage_url(payload.homepage_url)
    with connect() as conn:
        cur = conn.execute(
            """
            INSERT INTO accounts(
                source_record_id, account_name, platform, status, account_type,
                traffic_level, followers, homepage_url, avatar_url, profile_nickname,
                notes, custom_fields, phone_record_ids, device_record_ids, login_status,
                source_origin, local_updated_at, last_synced_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                f"local-{uuid.uuid4().hex}",
                payload.account_name,
                payload.platform,
                payload.status,
                payload.account_type,
                payload.traffic_level,
                payload.followers,
                payload.homepage_url,
                payload.avatar_url,
                payload.profile_nickname,
                payload.notes,
                json.dumps(payload.custom_fields or {}, ensure_ascii=False),
                "[]",
                "[]",
                "未登录",
                "local",
                now,
                now,
            ),
        )
        row = conn.execute("SELECT * FROM accounts WHERE id=?", (cur.lastrowid,)).fetchone()
    return {"ok": True, "account": row_to_dict(row)}


@app.patch("/api/accounts/{account_id}")
def update_account(account_id: int, payload: AccountPatch):
    data = payload.model_dump(exclude_unset=True)
    if not data:
        raise HTTPException(400, "empty patch")
    allowed = {
        "account_name", "platform", "status", "account_type", "traffic_level",
        "followers", "homepage_url", "avatar_url", "profile_nickname",
        "login_status", "notes", "custom_fields",
    }
    data = {key: value for key, value in data.items() if key in allowed}
    if "homepage_url" in data:
        data["homepage_url"] = normalize_homepage_url(data["homepage_url"])
    if "custom_fields" in data:
        data["custom_fields"] = json.dumps(data["custom_fields"] or {}, ensure_ascii=False)
    data["local_updated_at"] = utc_now()
    fields = ", ".join(f"{key}=?" for key in data)
    with connect() as conn:
        conn.execute(f"UPDATE accounts SET {fields} WHERE id=?", (*data.values(), account_id))
        row = conn.execute("SELECT * FROM accounts WHERE id=?", (account_id,)).fetchone()
        if not row:
            raise HTTPException(404, "account not found")
    return {"ok": True, "account": row_to_dict(row)}


@app.get("/api/avatars/{account_id}")
def get_avatar(account_id: int):
    for path in AVATAR_DIR.glob(f"{account_id}.*"):
        return FileResponse(path)
    raise HTTPException(404, "no avatar")


@app.post("/api/accounts/{account_id}/profile")
def update_account_profile(account_id: int, payload: AccountProfilePayload):
    data = payload.model_dump(exclude_unset=True)
    data = {key: value for key, value in data.items() if value}
    if not data:
        raise HTTPException(400, "empty profile")
    if "homepage_url" in data:
        data["homepage_url"] = normalize_homepage_url(data["homepage_url"])
    if "platform_account_id" in data:
        data["platform_account_id"] = str(data["platform_account_id"]).strip()
    # 远程头像先落本地缓存；下载失败保留原链接（前端有裂图兜底）
    if data.get("avatar_url", "").startswith("http"):
        cached = cache_avatar(account_id, data["avatar_url"])
        if cached:
            data["avatar_url"] = cached
    data["profile_synced_at"] = utc_now()
    data["last_profile_check_at"] = data["profile_synced_at"]
    data["local_updated_at"] = data["profile_synced_at"]
    fields = ", ".join(f"{key}=?" for key in data)
    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        current = conn.execute("SELECT * FROM accounts WHERE id=?", (account_id,)).fetchone()
        if not current:
            raise HTTPException(404, "account not found")
        discovered_identity = str(data.get("platform_account_id") or "").strip()
        if discovered_identity:
            current_identity = str(current["platform_account_id"] or "").strip()
            if current_identity and current_identity != discovered_identity:
                raise HTTPException(409, "account login identity changed")
            conflict = conn.execute(
                """
                SELECT id FROM accounts
                WHERE id<>? AND platform=? AND platform_account_id=?
                LIMIT 1
                """,
                (account_id, current["platform"], discovered_identity),
            ).fetchone()
            if conflict:
                raise HTTPException(409, "platform identity already belongs to another account")
        conn.execute(f"UPDATE accounts SET {fields} WHERE id=?", (*data.values(), account_id))
        row = conn.execute("SELECT * FROM accounts WHERE id=?", (account_id,)).fetchone()
    return {"ok": True, "account": row_to_dict(row)}


@app.post("/api/accounts/{account_id}/discovered-identity")
def save_discovered_account_identity(account_id: int, payload: DiscoveredAccountIdentityPayload):
    """Persist an automatically discovered identity without overwriting user data."""
    homepage_url = normalize_homepage_url(payload.homepage_url)
    platform_account_id = str(payload.platform_account_id or "").strip()
    if not homepage_url or not platform_account_id:
        raise HTTPException(400, "incomplete discovered identity")
    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT * FROM accounts WHERE id=?", (account_id,)).fetchone()
        if not row:
            raise HTTPException(404, "account not found")
        current_homepage = str(row["homepage_url"] or "").strip()
        current_identity = str(row["platform_account_id"] or "").strip()
        repair_kuaishou_numeric = (
            row["platform"] == "快手"
            and current_identity.isdigit()
            and f"/profile/{current_identity}" in current_homepage
        )
        if current_homepage and not repair_kuaishou_numeric:
            return {"ok": True, "skipped": True, "account": row_to_dict(row)}
        if current_identity and current_identity != platform_account_id and not repair_kuaishou_numeric:
            raise HTTPException(409, "account login identity changed")
        conflict = conn.execute(
            """
            SELECT id FROM accounts
            WHERE id<>? AND platform=? AND platform_account_id=?
            LIMIT 1
            """,
            (account_id, row["platform"], platform_account_id),
        ).fetchone()
        if conflict:
            raise HTTPException(409, "platform identity already belongs to another account")
        now = utc_now()
        conn.execute(
            """
            UPDATE accounts
            SET homepage_url=?, platform_account_id=?, profile_synced_at=?,
                last_profile_check_at=?, local_updated_at=?
            WHERE id=?
            """,
            (homepage_url, platform_account_id, now, now, now, account_id),
        )
        row = conn.execute("SELECT * FROM accounts WHERE id=?", (account_id,)).fetchone()
    return {"ok": True, "skipped": False, "account": row_to_dict(row)}


@app.delete("/api/accounts/{account_id}")
def delete_account(account_id: int):
    with connect() as conn:
        row = conn.execute("SELECT * FROM accounts WHERE id=?", (account_id,)).fetchone()
        if not row:
            raise HTTPException(404, "account not found")
        conn.execute("DELETE FROM accounts WHERE id=?", (account_id,))
    return {"ok": True}


@app.post("/api/accounts/{account_id}/open")
def open_workspace(account_id: int, payload: OpenWorkspacePayload):
    try:
        return open_account_workspace(account_id, payload.target)
    except ValueError as exc:
        raise HTTPException(404, str(exc))
    except Exception as exc:
        raise HTTPException(500, str(exc))


@app.post("/api/accounts/{account_id}/workspace-info")
def workspace_info(account_id: int, payload: OpenWorkspacePayload):
    with connect() as conn:
        row = conn.execute("SELECT * FROM accounts WHERE id=?", (account_id,)).fetchone()
        if not row:
            raise HTTPException(404, "account not found")
        platform = row["platform"] or "unknown"
        account_name = row["account_name"] or f"account_{account_id}"
        profile_path = row["profile_path"]
        partition = row["browser_partition"] or f"persist:account-{account_id}"
        if not profile_path:
            safe_platform = "".join(ch if ch.isalnum() else "_" for ch in platform) or "unknown"
            safe_account = "".join(ch if ch.isalnum() else "_" for ch in account_name) or "account"
            profile_path = str(PROFILE_ROOT / safe_platform / f"{account_id}_{safe_account}")
        url = account_target_url(platform, payload.target, row["homepage_url"])
        now = utc_now()
        conn.execute(
            """
            UPDATE accounts
            SET profile_path=?, browser_partition=?, last_opened_at=?,
                login_status=CASE
                  WHEN login_status IS NULL OR login_status='' THEN '待登录'
                  ELSE login_status
                END
            WHERE id=?
            """,
            (profile_path, partition, now, account_id),
        )
    return {
        "ok": True,
        "account_id": account_id,
        "account_name": account_name,
        "platform": platform,
        "target": payload.target,
        "url": url,
        "profile_path": profile_path,
        "partition": partition,
    }


@app.get("/api/accounts/{account_id}/profile-source")
def profile_source(account_id: int):
    """Return the authenticated creator page used for silent profile discovery."""
    with connect() as conn:
        row = conn.execute("SELECT * FROM accounts WHERE id=?", (account_id,)).fetchone()
        if not row:
            raise HTTPException(404, "account not found")
        platform = row["platform"] or "unknown"
        partition = row["browser_partition"] or f"persist:account-{account_id}"
    return {
        "ok": True,
        "account_id": account_id,
        "platform": platform,
        "url": account_target_url(platform, "home", None),
        "partition": partition,
    }


@app.get("/api/works")
def works(
    search: str = "",
    account: str = "",
    platform: str = "",
    sort: Literal["collected", "published"] = "collected",
    limit: int = Query(200, ge=1, le=500),
):
    clauses = []
    params = []
    if search:
        clauses.append("(title LIKE ? OR account_name LIKE ?)")
        params.extend([f"%{search}%", f"%{search}%"])
    if account:
        clauses.append("account_name = ?")
        params.append(account)
    if platform:
        clauses.append("platform = ?")
        params.append(platform)
    where = "WHERE " + " AND ".join(clauses) if clauses else ""
    if sort == "published":
        order_by = (
            "COALESCE(julianday(published_at), julianday(publish_date), "
            "julianday(collected_at), julianday(last_synced_at)) DESC, "
            "COALESCE(julianday(collected_at), julianday(last_synced_at)) DESC, id DESC"
        )
    else:
        order_by = (
            "COALESCE(julianday(collected_at), julianday(last_synced_at), "
            "julianday(published_at), julianday(publish_date)) DESC, "
            "COALESCE(julianday(published_at), julianday(publish_date)) DESC, id DESC"
        )
    with connect() as conn:
        rows = conn.execute(
            f"SELECT * FROM works {where} ORDER BY {order_by} LIMIT ?",
            (*params, limit),
        ).fetchall()
    return {"data": rows_to_dicts(rows)}



@app.get("/api/collect/targets")
def collect_targets(platform: str = ""):
    with connect() as conn:
        where = "WHERE accounts.platform = ?" if platform else ""
        params = (platform,) if platform else ()
        rows = conn.execute(
            f"""
            SELECT accounts.id, accounts.account_name, accounts.platform,
                   accounts.homepage_url, accounts.status
            FROM collect_targets
            JOIN accounts ON accounts.id = collect_targets.account_id
            {where}
            ORDER BY collect_targets.created_at, accounts.id
            """,
            params,
        ).fetchall()
    return {"data": rows_to_dicts(rows)}


@app.post("/api/collect/targets")
def add_collect_targets(payload: CollectTargetsPayload):
    account_ids = list(dict.fromkeys(int(account_id) for account_id in payload.account_ids))
    if not account_ids:
        raise HTTPException(400, "empty account ids")
    placeholders = ",".join("?" for _ in account_ids)
    now = utc_now()
    with connect() as conn:
        rows = conn.execute(
            f"SELECT id FROM accounts WHERE id IN ({placeholders})",
            account_ids,
        ).fetchall()
        found = {int(row["id"]) for row in rows}
        missing = [account_id for account_id in account_ids if account_id not in found]
        if missing:
            raise HTTPException(404, f"accounts not found: {missing}")
        conn.executemany(
            "INSERT OR IGNORE INTO collect_targets(account_id, created_at) VALUES (?, ?)",
            [(account_id, now) for account_id in account_ids],
        )
    return {"ok": True, "account_ids": account_ids, "count": len(account_ids)}


@app.delete("/api/collect/targets/{account_id}")
def remove_collect_target(account_id: int):
    with connect() as conn:
        account = conn.execute("SELECT id FROM accounts WHERE id=?", (account_id,)).fetchone()
        if not account:
            raise HTTPException(404, "account not found")
        cur = conn.execute("DELETE FROM collect_targets WHERE account_id=?", (account_id,))
    return {"ok": True, "account_id": account_id, "removed": cur.rowcount > 0}


@app.get("/api/collect/runs")
def collect_runs(limit: int = Query(20, ge=1, le=100)):
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT collect_runs.*, accounts.account_name
            FROM collect_runs
            LEFT JOIN accounts ON accounts.id = collect_runs.account_id
            ORDER BY collect_runs.id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return {"data": rows_to_dicts(rows)}


@app.post("/api/collect/report")
def collect_report(payload: CollectReportPayload):
    now = utc_now()
    today = date.today().isoformat()
    inserted = 0
    updated = 0
    # 作者资料来自作品接口响应，比页面猜图可靠；头像下载放在事务外
    author_updates: dict = {}
    if payload.author:
        nickname = (payload.author.nickname or "").strip()
        if nickname:
            author_updates["profile_nickname"] = nickname[:80]
        if payload.author.avatar_url:
            cached = cache_avatar(payload.account_id, payload.author.avatar_url)
            if cached:
                author_updates["avatar_url"] = cached
    with connect() as conn:
        account = conn.execute(
            "SELECT * FROM accounts WHERE id=?", (payload.account_id,)
        ).fetchone()
        if not account:
            raise HTTPException(404, "account not found")
        account_name = account["account_name"]
        if author_updates:
            author_updates["local_updated_at"] = now
            fields = ", ".join(f"{key}=?" for key in author_updates)
            conn.execute(
                f"UPDATE accounts SET {fields} WHERE id=?",
                (*author_updates.values(), payload.account_id),
            )
        work_ids: list[int] = []
        metric_updates = (
            "likes=COALESCE(?, likes), comments=COALESCE(?, comments), "
            "favorites=COALESCE(?, favorites), shares=COALESCE(?, shares)"
            if payload.platform == "小红书"
            else "likes=?, comments=?, favorites=?, shares=?"
        )
        for item in payload.works:
            if not item.platform_work_id:
                continue
            cur = conn.execute(
                f"""
                UPDATE works
                SET account_id=?, account_name=COALESCE(account_name, ?),
                    title=COALESCE(?, title), work_url=COALESCE(?, work_url),
                    published_at=COALESCE(?, published_at),
                    {metric_updates},
                    plays=COALESCE(?, plays),
                    collected_at=?, collect_status='成功', collect_error=NULL
                WHERE platform=? AND platform_work_id=?
                """,
                (
                    payload.account_id, account_name,
                    item.title, item.work_url, item.published_at,
                    item.likes, item.comments, item.favorites, item.shares,
                    item.plays, now, payload.platform, item.platform_work_id,
                ),
            )
            if cur.rowcount:
                updated += cur.rowcount
                row = conn.execute(
                    "SELECT id FROM works WHERE platform=? AND platform_work_id=?",
                    (payload.platform, item.platform_work_id),
                ).fetchone()
            else:
                cur = conn.execute(
                    """
                    INSERT INTO works(
                        source_record_id, platform, platform_work_id, account_id, account_name,
                        title, work_url, published_at, likes, comments, favorites, shares, plays,
                        collected_at, collect_status, last_synced_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '成功', ?)
                    """,
                    (
                        f"collect-{payload.platform}-{item.platform_work_id}",
                        payload.platform, item.platform_work_id,
                        payload.account_id, account_name,
                        item.title, item.work_url, item.published_at,
                        item.likes, item.comments, item.favorites, item.shares, item.plays,
                        now, now,
                    ),
                )
                inserted += 1
                row = {"id": cur.lastrowid}
            if row:
                work_ids.append(row["id"])
        for work_id in work_ids:
            conn.execute(
                """
                INSERT INTO work_metrics_daily(work_id, date, likes, comments, favorites, shares, plays, collected_at)
                SELECT id, ?, likes, comments, favorites, shares, plays, ?
                FROM works WHERE id=?
                ON CONFLICT(work_id, date) DO UPDATE SET
                    likes=excluded.likes, comments=excluded.comments,
                    favorites=excluded.favorites, shares=excluded.shares,
                    plays=excluded.plays, collected_at=excluded.collected_at
                """,
                (today, now, work_id),
            )
        conn.execute(
            """
            INSERT INTO collect_runs(
                started_at, finished_at, platform, account_id, trigger_source,
                status, works_found, works_updated, error_message
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload.started_at or now, now, payload.platform, payload.account_id,
                payload.trigger_source, payload.status,
                len(payload.works), inserted + updated, payload.error_message,
            ),
        )
    return {"ok": True, "inserted": inserted, "updated": updated, "snapshot_date": today}


DEFAULT_COLLECT_CONFIG = {
    "auto_enabled": False,
    "frequency": "daily",   # daily | weekly
    "weekday": 1,           # 0=周日 1=周一 ...（仅 weekly 生效）
    "hour": 6,
    "minute": 0,
    "scan_limit": 20,       # 每账号扫描上限
    "show_browser": True,   # 手动采集时显示浏览器窗口（定时采集始终隐藏）
    "platforms": ["抖音"],
    "last_auto_date": None,  # 最近一次自动采集的本地日期（YYYY-MM-DD），重启后去重
}


class CollectConfigPayload(BaseModel):
    auto_enabled: Optional[bool] = None
    frequency: Optional[str] = None
    weekday: Optional[int] = None
    hour: Optional[int] = None
    minute: Optional[int] = None
    scan_limit: Optional[int] = None
    show_browser: Optional[bool] = None
    platforms: Optional[list[str]] = None
    last_auto_date: Optional[str] = None


def _load_collect_config() -> dict:
    import json
    with connect() as conn:
        row = conn.execute("SELECT value FROM app_settings WHERE key='collect_config'").fetchone()
    config = dict(DEFAULT_COLLECT_CONFIG)
    if row and row["value"]:
        try:
            config.update(json.loads(row["value"]))
        except (json.JSONDecodeError, TypeError):
            pass
    return config


@app.get("/api/collect/config")
def get_collect_config():
    return _load_collect_config()


@app.post("/api/collect/config")
def set_collect_config(payload: CollectConfigPayload):
    import json
    config = _load_collect_config()
    for key, value in payload.model_dump(exclude_unset=True).items():
        if value is not None:
            config[key] = value
    config["hour"] = max(0, min(23, int(config.get("hour", 6))))
    config["minute"] = max(0, min(59, int(config.get("minute", 0))))
    config["weekday"] = max(0, min(6, int(config.get("weekday", 1))))
    config["scan_limit"] = max(5, min(100, int(config.get("scan_limit", 20))))
    if config.get("frequency") not in ("daily", "weekly"):
        config["frequency"] = "daily"
    with connect() as conn:
        conn.execute(
            "INSERT INTO app_settings(key, value) VALUES ('collect_config', ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (json.dumps(config, ensure_ascii=False),),
        )
    return config


# ---------- UI 设置（导航顺序等） ----------
class UiSettingsPayload(BaseModel):
    nav_order: Optional[list[str]] = None


def _load_ui_settings() -> dict:
    import json
    with connect() as conn:
        row = conn.execute("SELECT value FROM app_settings WHERE key='ui_settings'").fetchone()
    settings: dict = {"nav_order": None}
    if row and row["value"]:
        try:
            settings.update(json.loads(row["value"]))
        except (json.JSONDecodeError, TypeError):
            pass
    return settings


@app.get("/api/ui-settings")
def get_ui_settings():
    return _load_ui_settings()


@app.post("/api/ui-settings")
def set_ui_settings(payload: UiSettingsPayload):
    import json
    settings = _load_ui_settings()
    for key, value in payload.model_dump(exclude_unset=True).items():
        settings[key] = value
    with connect() as conn:
        conn.execute(
            "INSERT INTO app_settings(key, value) VALUES ('ui_settings', ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (json.dumps(settings, ensure_ascii=False),),
        )
    return settings


# ---------- 常规设置 / 备份 / 关于 ----------
class GeneralSettingsPayload(BaseModel):
    close_to_tray: Optional[bool] = None
    notify_on_collect: Optional[bool] = None
    autostart_hidden: Optional[bool] = None


_GENERAL_DEFAULTS = {"close_to_tray": True, "notify_on_collect": True, "autostart_hidden": True}


def _load_general_settings() -> dict:
    settings = dict(_GENERAL_DEFAULTS)
    with connect() as conn:
        row = conn.execute("SELECT value FROM app_settings WHERE key='general_settings'").fetchone()
    if row:
        try:
            settings.update(json.loads(row["value"]))
        except (json.JSONDecodeError, TypeError):
            pass
    return settings


@app.get("/api/general-settings")
def get_general_settings():
    return _load_general_settings()


@app.post("/api/general-settings")
def set_general_settings(payload: GeneralSettingsPayload):
    settings = _load_general_settings()
    for key, value in payload.model_dump(exclude_unset=True).items():
        if value is not None:
            settings[key] = value
    with connect() as conn:
        conn.execute(
            "INSERT INTO app_settings(key, value) VALUES ('general_settings', ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (json.dumps(settings, ensure_ascii=False),),
        )
    return settings


@app.post("/api/backup")
def manual_backup():
    target = backup_db(reason="manual")
    if not target:
        raise HTTPException(500, "数据库不存在，无法备份")
    return {"ok": True, "file": target.name}


def _last_backup_at() -> Optional[str]:
    try:
        backups = sorted(BACKUP_DIR.glob("account_console_*.sqlite3"))
        if not backups:
            return None
        from datetime import datetime as _dt
        return _dt.fromtimestamp(backups[-1].stat().st_mtime).strftime("%Y-%m-%d %H:%M")
    except OSError:
        return None


@app.get("/api/about")
def about():
    return {
        "version": APP_VERSION,
        "data_dir": str(DATA_DIR),
        "last_backup_at": _last_backup_at(),
    }


# ---------- 账号字段配置与平台管理 ----------
# 受保护字段（账号名字/主页链接）必填不可删；其余内置字段可删（值保留在库里，可恢复）；
# 自定义字段存 accounts.custom_fields JSON。
PROTECTED_FIELD_KEYS = {"account_name", "homepage_url"}
DEFAULT_ACCOUNT_FIELDS = [
    {"key": "account_name", "label": "账号名字", "type": "text", "builtin": True, "required": True},
    {"key": "platform", "label": "平台", "type": "platform", "builtin": True},
    {"key": "status", "label": "状态", "type": "select", "builtin": True,
     "options": ["正常", "养号", "限流", "处罚/封号"]},
    {"key": "account_type", "label": "类型", "type": "select", "builtin": True,
     "options": ["可用", "不可用"]},
    {"key": "traffic_level", "label": "流量层级", "type": "text", "builtin": True},
    {"key": "followers", "label": "粉丝量", "type": "number", "builtin": True},
    {"key": "homepage_url", "label": "主页链接", "type": "url", "builtin": True},
    {"key": "notes", "label": "备注", "type": "textarea", "builtin": True},
]
FIELD_TYPES = {"text", "number", "select", "url", "textarea"}
_FIELD_KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,39}$")


class FieldItem(BaseModel):
    key: str
    label: str
    type: str = "text"
    options: Optional[list[str]] = None
    builtin: bool = False
    required: bool = False


class FieldConfigPayload(BaseModel):
    fields: list[FieldItem]


class PlatformsPayload(BaseModel):
    platforms: list[str]


def _load_setting_json(key: str, default):
    with connect() as conn:
        row = conn.execute("SELECT value FROM app_settings WHERE key=?", (key,)).fetchone()
    if row and row["value"]:
        try:
            return json.loads(row["value"])
        except (json.JSONDecodeError, TypeError):
            pass
    return default


def _save_setting_json(key: str, value) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT INTO app_settings(key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, json.dumps(value, ensure_ascii=False)),
        )


def _merged_account_fields() -> list[dict]:
    """存量配置为准（内置字段可被删除）；仅受保护字段强制存在。"""
    stored = _load_setting_json("account_fields", None)
    if not isinstance(stored, list):
        return [dict(f) for f in DEFAULT_ACCOUNT_FIELDS]
    merged = []
    seen = set()
    for item in stored:
        if not isinstance(item, dict) or not item.get("key") or item["key"] in seen:
            continue
        seen.add(item["key"])
        merged.append(item)
    for default in DEFAULT_ACCOUNT_FIELDS:
        if default["key"] in PROTECTED_FIELD_KEYS and default["key"] not in seen:
            merged.append(dict(default))
    return merged


@app.get("/api/account-fields")
def get_account_fields():
    return {"fields": _merged_account_fields(), "protected": sorted(PROTECTED_FIELD_KEYS)}


@app.post("/api/account-fields")
def set_account_fields(payload: FieldConfigPayload):
    builtin_keys = {f["key"] for f in DEFAULT_ACCOUNT_FIELDS}
    builtin_defaults = {f["key"]: f for f in DEFAULT_ACCOUNT_FIELDS}
    result = []
    seen = set()
    for item in payload.fields:
        field = item.model_dump()
        key = field["key"].strip()
        if not key or key in seen:
            continue
        if key in builtin_keys:
            base = dict(builtin_defaults[key])
            base["label"] = (field.get("label") or base["label"]).strip()[:20] or base["label"]
            if base["type"] == "select" and isinstance(field.get("options"), list):
                options = [str(o).strip()[:30] for o in field["options"] if str(o).strip()]
                if options:
                    base["options"] = options
            result.append(base)
        else:
            if not _FIELD_KEY_RE.match(key):
                raise HTTPException(400, f"自定义字段 key 不合法：{key}（小写字母开头，仅字母数字下划线）")
            ftype = field.get("type") if field.get("type") in FIELD_TYPES else "text"
            entry = {
                "key": key,
                "label": (field.get("label") or key).strip()[:20],
                "type": ftype,
                "builtin": False,
            }
            if ftype == "select":
                entry["options"] = [str(o).strip()[:30] for o in (field.get("options") or []) if str(o).strip()]
            result.append(entry)
        seen.add(key)
    # 仅受保护字段强制补回；其余内置字段允许删除
    for default in DEFAULT_ACCOUNT_FIELDS:
        if default["key"] in PROTECTED_FIELD_KEYS and default["key"] not in seen:
            result.append(dict(default))
    _save_setting_json("account_fields", result)
    return {"fields": result}


@app.post("/api/account-fields/restore-defaults")
def restore_default_fields():
    """把缺失的内置字段补回（保留现有自定义字段和内置字段的改动）。"""
    current = _merged_account_fields()
    seen = {f["key"] for f in current}
    restored = list(current)
    for default in DEFAULT_ACCOUNT_FIELDS:
        if default["key"] not in seen:
            restored.append(dict(default))
    _save_setting_json("account_fields", restored)
    return {"fields": restored}


@app.get("/api/platforms")
def get_platforms():
    platforms = _load_setting_json("platforms", None)
    if not isinstance(platforms, list) or not platforms:
        platforms = list(DEFAULT_PLATFORMS)
    return {
        "platforms": platforms,
        "collect_supported": COLLECT_SUPPORTED_PLATFORMS,
        "capabilities": public_capabilities(),
    }


@app.post("/api/platforms")
def set_platforms(payload: PlatformsPayload):
    cleaned = []
    for name in payload.platforms:
        name = str(name).strip()[:20]
        if name and name not in cleaned:
            cleaned.append(name)
    for required in COLLECT_SUPPORTED_PLATFORMS:
        if required not in cleaned:
            raise HTTPException(400, f"已支持采集的平台不能删除：{required}")
    if not cleaned:
        raise HTTPException(400, "平台列表不能为空")
    _save_setting_json("platforms", cleaned)
    return {
        "platforms": cleaned,
        "collect_supported": COLLECT_SUPPORTED_PLATFORMS,
        "capabilities": public_capabilities(),
    }


if STATIC_DIR.exists():
    app.mount("/assets", StaticFiles(directory=str(STATIC_DIR)), name="assets")


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


def run() -> None:
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT)
