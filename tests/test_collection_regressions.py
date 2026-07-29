# -*- coding: utf-8 -*-
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from backend import db
from backend.main import app


class CollectionRegressionTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.old_data_dir = db.DATA_DIR
        self.old_db_path = db.DB_PATH
        self.old_backup_dir = db.BACKUP_DIR
        root = Path(self.temp_dir.name)
        db.DATA_DIR = root
        db.DB_PATH = root / "account_console.sqlite3"
        db.BACKUP_DIR = root / "backups"
        db.init_db()
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        db.DATA_DIR = self.old_data_dir
        db.DB_PATH = self.old_db_path
        db.BACKUP_DIR = self.old_backup_dir
        self.temp_dir.cleanup()

    def _account(self, name="同名账号", platform="B站"):
        return self.client.post(
            "/api/accounts", json={"account_name": name, "platform": platform}
        ).json()["account"]["id"]

    def test_partial_public_metrics_preserve_last_known_values(self):
        account_id = self._account(platform="小红书")
        initial = {
            "account_id": account_id,
            "platform": "小红书",
            "works": [{
                "platform_work_id": "6a57322100000000170298e7",
                "title": "公开作品",
                "likes": 10,
                "comments": 3,
                "favorites": 4,
                "shares": 5,
                "plays": 6,
            }],
        }
        self.client.post("/api/collect/report", json=initial).raise_for_status()

        partial = {
            "account_id": account_id,
            "platform": "小红书",
            "works": [{
                "platform_work_id": "6a57322100000000170298e7",
                "likes": 20,
            }],
        }
        self.client.post("/api/collect/report", json=partial).raise_for_status()

        with db.connect() as conn:
            row = conn.execute(
                """
                SELECT likes, comments, favorites, shares, plays
                FROM works WHERE platform='小红书' AND platform_work_id=?
                """,
                ("6a57322100000000170298e7",),
            ).fetchone()
        self.assertEqual(tuple(row), (20, 3, 4, 5, 6))

    def test_non_xiaohongshu_reports_keep_null_replacement_semantics(self):
        account_id = self._account(platform="B站")
        initial = {
            "account_id": account_id,
            "platform": "B站",
            "works": [{
                "platform_work_id": "BV1partial",
                "likes": 10,
                "comments": 3,
                "favorites": 4,
                "shares": 5,
                "plays": 6,
            }],
        }
        self.client.post("/api/collect/report", json=initial).raise_for_status()
        partial = {
            "account_id": account_id,
            "platform": "B站",
            "works": [{
                "platform_work_id": "BV1partial",
                "comments": 8,
            }],
        }
        self.client.post("/api/collect/report", json=partial).raise_for_status()

        with db.connect() as conn:
            row = conn.execute(
                """
                SELECT likes, comments, favorites, shares, plays
                FROM works WHERE platform='B站' AND platform_work_id='BV1partial'
                """
            ).fetchone()
        self.assertEqual(tuple(row), (None, 8, None, None, 6))

    def test_xiaohongshu_object_ids_are_backfilled_on_startup(self):
        account_id = self._account(platform="小红书")
        with db.connect() as conn:
            conn.execute(
                """
                INSERT INTO works(source_record_id, platform, platform_work_id, account_id, account_name, title)
                VALUES ('xhs-old', '小红书', '65f0abc123def456789012ab', ?, '同名账号', '旧笔记')
                """,
                (account_id,),
            )

        db.init_db()

        works = self.client.get("/api/works?platform=小红书").json()["data"]
        self.assertRegex(works[0]["published_at"], r"^\d{4}-\d{2}-\d{2} ")

    def test_xiaohongshu_dirty_object_id_is_not_backfilled(self):
        account_id = self._account(platform="小红书")
        with db.connect() as conn:
            conn.execute(
                """
                INSERT INTO works(source_record_id, platform, platform_work_id, account_id, account_name, title)
                VALUES ('xhs-dirty', '小红书', '65f0abc1xxxxxxxxxxxxxxxx', ?, '同名账号', '脏数据')
                """,
                (account_id,),
            )
        db.init_db()
        works = self.client.get("/api/works?platform=小红书").json()["data"]
        self.assertIsNone(works[0]["published_at"])

    def test_analytics_exposes_plays_for_platform_and_account_charts(self):
        account_id = self._account(platform="B站")
        with db.connect() as conn:
            conn.execute(
                """
                INSERT INTO works(source_record_id, platform, platform_work_id, account_id, account_name,
                                  title, published_at, comments, plays)
                VALUES ('b-one', 'B站', 'BV1test', ?, '同名账号', '视频', datetime('now'), 2, 171)
                """,
                (account_id,),
            )

        analytics = self.client.get("/api/analytics?days=7").json()
        self.assertEqual(analytics["by_account"][0]["plays"], 171)
        platform = next(row for row in analytics["by_platform"] if row["platform"] == "B站")
        self.assertEqual(platform["plays"], 171)

    def test_platform_chart_keeps_historical_platforms_but_omits_never_collected_ones(self):
        historical_id = self._account(name="历史账号", platform="小红书")
        self._account(name="未采集账号", platform="咸鱼")
        with db.connect() as conn:
            conn.execute(
                """
                INSERT INTO works(source_record_id, platform, platform_work_id, account_id, account_name,
                                  title, published_at, likes)
                VALUES ('historical-xhs', '小红书', 'old-note', ?, '历史账号',
                        '范围外旧作品', '2026-01-01 12:00:00', 50)
                """,
                (historical_id,),
            )

        platforms = {
            row["platform"]: row
            for row in self.client.get("/api/analytics?days=7").json()["by_platform"]
        }

        self.assertIn("小红书", platforms)
        self.assertEqual(platforms["小红书"]["works"], 0)
        self.assertNotIn("咸鱼", platforms)

    def test_account_chart_keeps_historical_accounts_but_omits_never_collected_ones(self):
        historical_id = self._account(name="历史账号", platform="小红书")
        self._account(name="未采集账号", platform="咸鱼")
        with db.connect() as conn:
            conn.execute(
                """
                INSERT INTO works(source_record_id, platform, platform_work_id, account_id, account_name,
                                  title, published_at, likes)
                VALUES ('historical-account-xhs', '小红书', 'old-account-note', ?, '历史账号',
                        '范围外旧作品', '2026-01-01 12:00:00', 50)
                """,
                (historical_id,),
            )

        accounts = {
            row["account_name"]: row
            for row in self.client.get("/api/analytics?days=7").json()["by_account"]
        }

        self.assertIn("历史账号", accounts)
        self.assertEqual(accounts["历史账号"]["platform"], "小红书")
        self.assertEqual(accounts["历史账号"]["works"], 0)
        self.assertNotIn("未采集账号", accounts)

    def test_account_detail_uses_account_id_when_names_match(self):
        first = self._account(platform="B站")
        second = self._account(platform="小红书")
        with db.connect() as conn:
            for account_id, platform, work_id in (
                (first, "B站", "BV1same"),
                (second, "小红书", "65f0abc123def456789012ab"),
            ):
                conn.execute(
                    """
                    INSERT INTO works(source_record_id, platform, platform_work_id, account_id, account_name, title)
                    VALUES (?, ?, ?, ?, '同名账号', ?)
                    """,
                    (f"src-{work_id}", platform, work_id, account_id, platform),
                )

        detail = self.client.get(f"/api/accounts/{first}").json()
        self.assertEqual(len(detail["works"]), 1)
        self.assertEqual(detail["works"][0]["platform"], "B站")

    def test_works_default_to_recent_collection_and_can_sort_by_publish_time(self):
        account_id = self._account(platform="小红书")
        with db.connect() as conn:
            conn.execute(
                """
                INSERT INTO works(source_record_id, platform, platform_work_id, account_id, account_name,
                                  title, published_at, collected_at)
                VALUES ('older-collection', '小红书', 'older-published-newer', ?, '同名账号',
                        '较早采集但发布较新', '2026-07-01 12:00:00', '2026-07-15T08:30:00+08:00')
                """,
                (account_id,),
            )
            conn.execute(
                """
                INSERT INTO works(source_record_id, platform, platform_work_id, account_id, account_name,
                                  title, published_at, collected_at)
                VALUES ('recent-collection', '小红书', 'recent-published-older', ?, '同名账号',
                        '刚采集但发布较早', '2026-03-01 12:00:00', '2026-07-15T04:10:00+00:00')
                """,
                (account_id,),
            )

        recent = self.client.get("/api/works?platform=小红书").json()["data"]
        published = self.client.get("/api/works?platform=小红书&sort=published").json()["data"]

        self.assertEqual(recent[0]["source_record_id"], "recent-collection")
        self.assertEqual(published[0]["source_record_id"], "older-collection")

    def test_works_collection_sort_is_stable_within_the_same_batch(self):
        account_id = self._account(platform="小红书")
        with db.connect() as conn:
            for source_id in ("same-batch-first", "same-batch-second"):
                conn.execute(
                    """
                    INSERT INTO works(source_record_id, platform, platform_work_id, account_id, account_name,
                                      title, published_at, collected_at)
                    VALUES (?, '小红书', ?, ?, '同名账号', ?, NULL, '2026-07-15T04:10:00+00:00')
                    """,
                    (source_id, source_id, account_id, source_id),
                )

        works = self.client.get("/api/works?platform=小红书").json()["data"]
        self.assertEqual(
            [row["source_record_id"] for row in works],
            ["same-batch-second", "same-batch-first"],
        )


if __name__ == "__main__":
    unittest.main()
