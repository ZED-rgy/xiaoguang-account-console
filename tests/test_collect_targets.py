# -*- coding: utf-8 -*-
"""采集目标与账号资产分离后的接口行为测试。"""
import json
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from backend import db
from backend.main import app


class CollectTargetsTest(unittest.TestCase):
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

    def create_account(self, name: str, platform: str = "抖音") -> int:
        response = self.client.post(
            "/api/accounts",
            json={
                "account_name": name,
                "platform": platform,
                "homepage_url": f"https://example.com/{name}",
            },
        )
        self.assertEqual(response.status_code, 200)
        return int(response.json()["account"]["id"])

    def test_existing_accounts_can_be_selected_without_login(self):
        first = self.create_account("已有账号一")
        second = self.create_account("已有账号二", "快手")
        self.assertEqual(self.client.get("/api/collect/targets").json()["data"], [])

        response = self.client.post(
            "/api/collect/targets",
            json={"account_ids": [first, second, first]},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["account_ids"], [first, second])
        targets = self.client.get("/api/collect/targets").json()["data"]
        self.assertEqual([row["id"] for row in targets], [first, second])
        douyin = self.client.get("/api/collect/targets?platform=抖音").json()["data"]
        self.assertEqual([row["id"] for row in douyin], [first])

    def test_removing_target_keeps_account_asset(self):
        account_id = self.create_account("保留账号")
        self.client.post("/api/collect/targets", json={"account_ids": [account_id]})

        response = self.client.delete(f"/api/collect/targets/{account_id}")

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["removed"])
        self.assertEqual(self.client.get("/api/collect/targets").json()["data"], [])
        self.assertEqual(self.client.get(f"/api/accounts/{account_id}").status_code, 200)

    def test_collect_login_promotes_account_and_adds_target(self):
        session = self.client.post(
            "/api/account-login-sessions", json={"platform": "抖音"}
        ).json()

        response = self.client.post(
            f"/api/account-login-sessions/{session['account_id']}/complete",
            json={
                "profile_nickname": "新登录账号",
                "avatar_url": "/avatar.png",
                "platform_account_id": "new-collect-account",
                "homepage_url": "https://www.douyin.com/user/new-collect-account",
                "add_to_collect_targets": True,
            },
        )

        self.assertEqual(response.status_code, 200)
        account_id = response.json()["account_id"]
        targets = self.client.get("/api/collect/targets").json()["data"]
        self.assertEqual([row["id"] for row in targets], [account_id])

    def test_first_upgrade_preserves_implicit_existing_targets(self):
        self.create_account("未启用平台账号")
        account_id = self.create_account("升级前账号", "快手")
        with db.connect() as conn:
            conn.execute("DROP TABLE collect_targets")
            conn.execute("DELETE FROM app_settings WHERE key='collect_targets_initialized'")
            conn.execute(
                "INSERT OR REPLACE INTO app_settings(key, value) VALUES ('collect_config', ?)",
                (json.dumps({"platforms": ["快手"]}, ensure_ascii=False),),
            )

        db.init_db()

        targets = self.client.get("/api/collect/targets").json()["data"]
        self.assertEqual([row["id"] for row in targets], [account_id])


if __name__ == "__main__":
    unittest.main()
