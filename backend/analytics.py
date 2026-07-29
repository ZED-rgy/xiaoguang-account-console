"""分析聚合（只读查询）：总览仪表盘、运营分析、账号下钻。"""
from datetime import date, timedelta

from fastapi import APIRouter, HTTPException, Query

from .db import connect, row_to_dict, rows_to_dicts

router = APIRouter()



def _pub_expr() -> str:
    return "substr(COALESCE(published_at, publish_date), 1, 10)"


RANK_EXPRS = {
    "interactions": "COALESCE(likes,0)+COALESCE(comments,0)+COALESCE(favorites,0)+COALESCE(shares,0)",
    "comments": "COALESCE(comments,0)",
    "likes": "COALESCE(likes,0)",
    "favorites": "COALESCE(favorites,0)",
}


@router.get("/api/analytics")
def analytics(days: int = Query(7, ge=7, le=180), rank: str = Query("comments")):
    """核心口径：近 N 天发布的作品及其累计互动（对齐运营习惯）；
    快照趋势提供日增视角（采集积累后丰富）。"""
    since = (date.today() - timedelta(days=days - 1)).isoformat()
    pub = _pub_expr()
    interactions = RANK_EXPRS["interactions"]
    rank_expr = RANK_EXPRS.get(rank, RANK_EXPRS["comments"])
    w_interactions = "COALESCE(w.likes,0)+COALESCE(w.comments,0)+COALESCE(w.favorites,0)+COALESCE(w.shares,0)"
    with connect() as conn:
        works_total = conn.execute("SELECT COUNT(*) c FROM works").fetchone()["c"]
        account_total = conn.execute("SELECT COUNT(*) c FROM accounts").fetchone()["c"]
        collectable = conn.execute(
            "SELECT COUNT(*) c FROM accounts WHERE homepage_url IS NOT NULL AND homepage_url!=''"
        ).fetchone()["c"]

        # 近 N 天发布作品的互动结构（飞书口径）
        mix = conn.execute(
            f"""
            SELECT COALESCE(SUM(likes),0) likes, COALESCE(SUM(comments),0) comments,
                   COALESCE(SUM(favorites),0) favorites, COALESCE(SUM(shares),0) shares,
                   COALESCE(SUM(plays),0) plays, COUNT(*) works
            FROM works WHERE {pub} >= ?
            """,
            (since,),
        ).fetchone()
        mix_all = conn.execute(
            """
            SELECT COALESCE(SUM(likes),0) likes, COALESCE(SUM(comments),0) comments,
                   COALESCE(SUM(favorites),0) favorites, COALESCE(SUM(shares),0) shares,
                   COALESCE(SUM(plays),0) plays
            FROM works
            """
        ).fetchone()

        # 发布趋势：按发布日聚合（历史作品即有数据）
        publish_trend = rows_to_dicts(conn.execute(
            f"""
            SELECT {pub} AS date, COUNT(*) AS works,
                   COALESCE(SUM({interactions}),0) AS interactions,
                   COALESCE(SUM(likes),0) AS likes
            FROM works
            WHERE {pub} >= ?
            GROUP BY {pub}
            ORDER BY date
            """,
            (since,),
        ).fetchall())

        # 快照趋势：按采集日聚合（用于日增视角，采集积累后丰富）
        snapshot_trend = rows_to_dicts(conn.execute(
            """
            SELECT date,
                   COALESCE(SUM(COALESCE(likes,0)+COALESCE(comments,0)+COALESCE(favorites,0)+COALESCE(shares,0)),0) AS interactions,
                   COUNT(DISTINCT work_id) AS works
            FROM work_metrics_daily
            WHERE date >= ?
            GROUP BY date
            ORDER BY date
            """,
            (since,),
        ).fetchall())

        # 账号维度对比：近 N 天发布作品的互动拆分（堆叠图数据）
        by_account = rows_to_dicts(conn.execute(
            f"""
            SELECT a.id, COALESCE(a.account_name, '未命名') AS account_name, a.platform,
                   COUNT(w.id) AS works,
                   COALESCE(SUM(w.likes),0) AS likes,
                   COALESCE(SUM(w.comments),0) AS comments,
                   COALESCE(SUM(w.favorites),0) AS favorites,
                   COALESCE(SUM(w.shares),0) AS shares,
                   COALESCE(SUM(w.plays),0) AS plays,
                   COALESCE(SUM({w_interactions}),0) AS interactions
            FROM accounts a
            LEFT JOIN works w ON w.account_id = a.id
              AND substr(COALESCE(w.published_at, w.publish_date), 1, 10) >= ?
            WHERE EXISTS (
              SELECT 1
              FROM works history
              WHERE history.account_id = a.id
            )
            GROUP BY a.id
            ORDER BY interactions DESC, a.sort_order ASC, a.id ASC
            LIMIT 12
            """,
            (since,),
        ).fetchall())

        by_platform = rows_to_dicts(conn.execute(
            f"""
            SELECT COALESCE(a.platform,'未填写') AS platform,
                   COUNT(DISTINCT a.id) AS accounts,
                   COUNT(w.id) AS works,
                   COALESCE(SUM(w.plays),0) AS plays,
                   COALESCE(SUM({w_interactions}),0) AS interactions
            FROM accounts a
            LEFT JOIN works w ON w.account_id = a.id
              AND substr(COALESCE(w.published_at, w.publish_date), 1, 10) >= ?
            WHERE EXISTS (
              SELECT 1
              FROM works history
              WHERE COALESCE(history.platform,'未填写') = COALESCE(a.platform,'未填写')
            )
            GROUP BY COALESCE(a.platform,'未填写')
            ORDER BY interactions DESC
            """,
            (since,),
        ).fetchall())

        # 账号资产排行：全量累计（资产视角，和上面的近 N 天对比互补）
        top_accounts = rows_to_dicts(conn.execute(
            f"""
            SELECT a.id, a.account_name, a.platform, a.followers,
                   COUNT(w.id) AS works,
                   COALESCE(SUM({w_interactions}),0) AS interactions,
                   MAX(COALESCE(w.published_at, w.publish_date)) AS last_publish
            FROM accounts a
            LEFT JOIN works w ON w.account_id = a.id
            GROUP BY a.id
            HAVING works > 0
            ORDER BY interactions DESC
            LIMIT 10
            """
        ).fetchall())

        # 作品排行：近 N 天发布，按可切换指标排序
        top_works = rows_to_dicts(conn.execute(
            f"""
            SELECT id, account_name, title, work_url, platform,
                   COALESCE(published_at, publish_date) AS published_at,
                   likes, comments, favorites, shares, plays,
                   {interactions} AS interactions
            FROM works
            WHERE {pub} >= ?
            ORDER BY {rank_expr} DESC, interactions DESC
            LIMIT 10
            """,
            (since,),
        ).fetchall())

        last_collect = row_to_dict(conn.execute(
            "SELECT * FROM collect_runs ORDER BY id DESC LIMIT 1"
        ).fetchone())

    interactions_in_range = int(mix["likes"] + mix["comments"] + mix["favorites"] + mix["shares"])
    interactions_all = int(mix_all["likes"] + mix_all["comments"] + mix_all["favorites"] + mix_all["shares"])
    return {
        "days": days,
        "rank": rank if rank in RANK_EXPRS else "comments",
        "kpi": {
            "works_total": works_total,
            "account_total": account_total,
            "collectable": collectable,
            "works_in_range": int(mix["works"]),
            "likes_in_range": int(mix["likes"]),
            "comments_in_range": int(mix["comments"]),
            "favorites_in_range": int(mix["favorites"]),
            "shares_in_range": int(mix["shares"]),
            "plays_in_range": int(mix["plays"]),
            "interactions_in_range": interactions_in_range,
            "interactions_all": interactions_all,
            "plays_all": int(mix_all["plays"]),
        },
        "interaction_mix": {
            "likes": int(mix["likes"]), "comments": int(mix["comments"]),
            "favorites": int(mix["favorites"]), "shares": int(mix["shares"]),
        },
        "publish_trend": publish_trend,
        "snapshot_trend": snapshot_trend,
        "by_account": by_account,
        "by_platform": by_platform,
        "top_accounts": top_accounts,
        "top_works": top_works,
        "last_collect": last_collect,
    }


@router.get("/api/analytics/account/{account_id}")
def account_analytics(account_id: int, days: int = Query(30, ge=7, le=180)):
    since = (date.today() - timedelta(days=days - 1)).isoformat()
    pub = _pub_expr()
    interactions = RANK_EXPRS["interactions"]
    with connect() as conn:
        account = row_to_dict(conn.execute(
            """
            SELECT *,
              (SELECT COUNT(*) FROM works WHERE works.account_id = accounts.id) AS works_count
            FROM accounts WHERE id=?
            """,
            (account_id,),
        ).fetchone())
        if not account:
            raise HTTPException(404, "account not found")

        totals = conn.execute(
            f"""
            SELECT COUNT(*) works, COALESCE(SUM(likes),0) likes, COALESCE(SUM(comments),0) comments,
                   COALESCE(SUM(favorites),0) favorites, COALESCE(SUM(shares),0) shares,
                   COALESCE(SUM(plays),0) plays
            FROM works WHERE account_id=?
            """,
            (account_id,),
        ).fetchone()

        publish_trend = rows_to_dicts(conn.execute(
            f"""
            SELECT {pub} AS date, COUNT(*) AS works,
                   COALESCE(SUM({interactions}),0) AS interactions
            FROM works
            WHERE account_id=? AND {pub} >= ?
            GROUP BY {pub}
            ORDER BY date
            """,
            (account_id, since),
        ).fetchall())

        snapshot_trend = rows_to_dicts(conn.execute(
            """
            SELECT m.date,
                   COALESCE(SUM(COALESCE(m.likes,0)+COALESCE(m.comments,0)+COALESCE(m.favorites,0)+COALESCE(m.shares,0)),0) AS interactions
            FROM work_metrics_daily m
            JOIN works w ON w.id = m.work_id
            WHERE w.account_id=? AND m.date >= ?
            GROUP BY m.date
            ORDER BY m.date
            """,
            (account_id, since),
        ).fetchall())

        works = rows_to_dicts(conn.execute(
            f"""
            SELECT id, title, work_url, platform,
                   COALESCE(published_at, publish_date) AS published_at,
                   likes, comments, favorites, shares, plays,
                   {interactions} AS interactions
            FROM works
            WHERE account_id=?
            ORDER BY COALESCE(published_at, publish_date) DESC
            LIMIT 50
            """,
            (account_id,),
        ).fetchall())

        runs = rows_to_dicts(conn.execute(
            "SELECT * FROM collect_runs WHERE account_id=? ORDER BY id DESC LIMIT 5",
            (account_id,),
        ).fetchall())

    return {
        "days": days,
        "account": account,
        "totals": dict(totals),
        "publish_trend": publish_trend,
        "snapshot_trend": snapshot_trend,
        "works": works,
        "runs": runs,
    }
