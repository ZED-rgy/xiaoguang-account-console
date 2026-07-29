# -*- coding: utf-8 -*-
"""账号登录接入流程的 HTTP 行为测试。"""
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from backend import db
from backend.main import app


class AccountOnboardingTest(unittest.TestCase):
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

    def test_login_session_is_hidden_until_login_succeeds(self):
        response = self.client.post("/api/account-login-sessions", json={"platform": "抖音"})

        self.assertEqual(response.status_code, 200)
        session = response.json()
        self.assertEqual(session["platform"], "抖音")
        self.assertLess(session["account_id"], 0)
        self.assertTrue(session["partition"].startswith("persist:account-"))
        self.assertIn("creator.douyin.com", session["url"])
        self.assertEqual(self.client.get("/api/accounts?limit=500").json()["data"], [])
        self.assertEqual(self.client.get("/api/analytics").json()["kpi"]["account_total"], 0)

    def test_successful_login_promotes_session_to_visible_account(self):
        session = self.client.post(
            "/api/account-login-sessions", json={"platform": "抖音"}
        ).json()

        response = self.client.post(
            f"/api/account-login-sessions/{session['account_id']}/complete",
            json={
                "profile_nickname": "小光英语",
                "avatar_url": "/test-avatar.png",
                "homepage_url": "https://www.douyin.com/user/MS4wLjABAAAA-demo",
                "platform_account_id": "MS4wLjABAAAA-demo",
            },
        )

        self.assertEqual(response.status_code, 200)
        completed = response.json()
        self.assertNotEqual(completed["account_id"], session["account_id"])
        self.assertGreater(completed["account_id"], 0)
        self.assertFalse(completed["merged"])
        accounts = self.client.get("/api/accounts?limit=500").json()["data"]
        self.assertEqual(len(accounts), 1)
        self.assertEqual(accounts[0]["account_name"], "小光英语")
        self.assertEqual(accounts[0]["login_status"], "已登录")
        self.assertEqual(accounts[0]["platform_account_id"], "MS4wLjABAAAA-demo")
        self.assertEqual(accounts[0]["browser_partition"], session["partition"])

    def test_profile_source_returns_creator_home_without_mutating_account(self):
        session = self.client.post(
            "/api/account-login-sessions", json={"platform": "小红书"}
        ).json()
        completed = self.client.post(
            f"/api/account-login-sessions/{session['account_id']}/complete",
            json={
                "profile_nickname": "小光在成长ing",
                "avatar_url": "/avatar.png",
                "platform_account_id": "6810b3340000000006011f98",
            },
        ).json()
        account_id = completed["account_id"]

        response = self.client.get(f"/api/accounts/{account_id}/profile-source")

        self.assertEqual(response.status_code, 200)
        source = response.json()
        self.assertIn("creator.xiaohongshu.com", source["url"])
        self.assertEqual(source["partition"], session["partition"])
        with db.connect() as conn:
            last_opened_at = conn.execute(
                "SELECT last_opened_at FROM accounts WHERE id=?", (account_id,)
            ).fetchone()["last_opened_at"]
        self.assertIsNone(last_opened_at)

    def test_discovered_identity_does_not_overwrite_manually_added_homepage(self):
        session = self.client.post(
            "/api/account-login-sessions", json={"platform": "小红书"}
        ).json()
        account_id = self.client.post(
            f"/api/account-login-sessions/{session['account_id']}/complete",
            json={
                "profile_nickname": "小光在成长ing",
                "avatar_url": "/avatar.png",
                "platform_account_id": "6810b3340000000006011f98",
            },
        ).json()["account_id"]
        manual_homepage = "https://www.xiaohongshu.com/user/profile/manual-user"
        self.client.patch(
            f"/api/accounts/{account_id}", json={"homepage_url": manual_homepage}
        )

        response = self.client.post(
            f"/api/accounts/{account_id}/discovered-identity",
            json={
                "homepage_url": "https://www.xiaohongshu.com/user/profile/6810b3340000000006011f98",
                "platform_account_id": "6810b3340000000006011f98",
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["skipped"])
        account = self.client.get(f"/api/accounts/{account_id}").json()["account"]
        self.assertEqual(account["homepage_url"], manual_homepage)

    def test_discovered_identity_rejects_identity_owned_by_another_account(self):
        session = self.client.post(
            "/api/account-login-sessions", json={"platform": "B站"}
        ).json()
        first_id = self.client.post(
            f"/api/account-login-sessions/{session['account_id']}/complete",
            json={
                "profile_nickname": "第一个账号",
                "avatar_url": "/first.png",
                "platform_account_id": "123456789",
            },
        ).json()["account_id"]
        second_id = self.client.post(
            "/api/accounts", json={"account_name": "第二个账号", "platform": "B站"}
        ).json()["account"]["id"]

        response = self.client.post(
            f"/api/accounts/{second_id}/discovered-identity",
            json={
                "homepage_url": "https://space.bilibili.com/123456789",
                "platform_account_id": "123456789",
            },
        )

        self.assertEqual(response.status_code, 409)
        first = self.client.get(f"/api/accounts/{first_id}").json()["account"]
        second = self.client.get(f"/api/accounts/{second_id}").json()["account"]
        self.assertEqual(first["platform_account_id"], "123456789")
        self.assertIsNone(second["platform_account_id"])
        self.assertIsNone(second["homepage_url"])

    def test_same_platform_identity_refreshes_existing_account_instead_of_duplicating(self):
        first_session = self.client.post(
            "/api/account-login-sessions", json={"platform": "抖音"}
        ).json()
        first = self.client.post(
            f"/api/account-login-sessions/{first_session['account_id']}/complete",
            json={"profile_nickname": "旧昵称", "avatar_url": "/old.png", "platform_account_id": "douyin-user-1"},
        ).json()
        second_session = self.client.post(
            "/api/account-login-sessions", json={"platform": "抖音"}
        ).json()

        response = self.client.post(
            f"/api/account-login-sessions/{second_session['account_id']}/complete",
            json={"profile_nickname": "新昵称", "avatar_url": "/new.png", "platform_account_id": "douyin-user-1"},
        )

        self.assertEqual(response.status_code, 200)
        completed = response.json()
        self.assertTrue(completed["merged"])
        self.assertEqual(completed["account_id"], first["account_id"])
        accounts = self.client.get("/api/accounts?limit=500").json()["data"]
        self.assertEqual(len(accounts), 1)
        self.assertEqual(accounts[0]["account_name"], "新昵称")
        self.assertEqual(accounts[0]["browser_partition"], second_session["partition"])
        self.assertEqual(
            self.client.get(f"/api/accounts/{second_session['account_id']}").status_code,
            404,
        )

    def test_cancelled_login_session_leaves_no_account_record(self):
        session = self.client.post(
            "/api/account-login-sessions", json={"platform": "小红书"}
        ).json()

        response = self.client.delete(
            f"/api/account-login-sessions/{session['account_id']}"
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.get("/api/accounts?limit=500").json()["data"], [])
        self.assertEqual(
            self.client.get(f"/api/accounts/{session['account_id']}").status_code,
            404,
        )

    def test_startup_cleanup_removes_abandoned_login_partition(self):
        session = self.client.post(
            "/api/account-login-sessions", json={"platform": "B站"}
        ).json()
        partition_name = session["partition"].removeprefix("persist:")
        partition_dir = (
            Path(self.temp_dir.name) / "electron-profile" / "Partitions" / partition_name
        )
        partition_dir.mkdir(parents=True)
        (partition_dir / "Cookies").write_text("temporary", encoding="utf-8")

        with db.connect() as conn:
            removed = db.cleanup_abandoned_login_sessions(conn)

        self.assertEqual(removed, 1)
        self.assertFalse(partition_dir.exists())
        self.assertEqual(
            self.client.delete(f"/api/account-login-sessions/{session['account_id']}").status_code,
            404,
        )

    def test_same_platform_nickname_does_not_merge_different_identities(self):
        first_session = self.client.post(
            "/api/account-login-sessions", json={"platform": "快手"}
        ).json()
        first = self.client.post(
            f"/api/account-login-sessions/{first_session['account_id']}/complete",
            json={"profile_nickname": "同名账号", "avatar_url": "/first.png", "platform_account_id": "ks-user-1"},
        ).json()
        second_session = self.client.post(
            "/api/account-login-sessions", json={"platform": "快手"}
        ).json()

        completed = self.client.post(
            f"/api/account-login-sessions/{second_session['account_id']}/complete",
            json={"profile_nickname": "同名账号", "avatar_url": "/second.png", "platform_account_id": "ks-user-2"},
        ).json()

        self.assertFalse(completed["merged"])
        self.assertNotEqual(completed["account_id"], first["account_id"])
        self.assertEqual(len(self.client.get("/api/accounts?limit=500").json()["data"]), 2)

    def test_exact_platform_homepage_is_duplicate_fallback(self):
        first_session = self.client.post(
            "/api/account-login-sessions", json={"platform": "小红书"}
        ).json()
        first = self.client.post(
            f"/api/account-login-sessions/{first_session['account_id']}/complete",
            json={
                "profile_nickname": "旧昵称",
                "avatar_url": "/old.png",
                "homepage_url": "https://www.xiaohongshu.com/user/profile/user-a",
            },
        ).json()
        second_session = self.client.post(
            "/api/account-login-sessions", json={"platform": "小红书"}
        ).json()

        completed = self.client.post(
            f"/api/account-login-sessions/{second_session['account_id']}/complete",
            json={
                "profile_nickname": "新昵称",
                "avatar_url": "/new.png",
                "homepage_url": "https://www.xiaohongshu.com/user/profile/user-a?source=web",
            },
        ).json()

        self.assertTrue(completed["merged"])
        self.assertEqual(completed["account_id"], first["account_id"])
        self.assertEqual(len(self.client.get("/api/accounts?limit=500").json()["data"]), 1)

    def test_empty_profile_cannot_promote_login_session(self):
        session = self.client.post(
            "/api/account-login-sessions", json={"platform": "咸鱼"}
        ).json()

        response = self.client.post(
            f"/api/account-login-sessions/{session['account_id']}/complete",
            json={"platform_account_id": "identity-without-profile"},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.client.get("/api/accounts?limit=500").json()["data"], [])
        self.assertEqual(
            self.client.delete(f"/api/account-login-sessions/{session['account_id']}").status_code,
            200,
        )

    def test_nickname_and_avatar_without_stable_identity_cannot_promote(self):
        session = self.client.post(
            "/api/account-login-sessions", json={"platform": "抖音"}
        ).json()

        response = self.client.post(
            f"/api/account-login-sessions/{session['account_id']}/complete",
            json={"profile_nickname": "同名风险账号", "avatar_url": "/avatar.png"},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.client.get("/api/accounts?limit=500").json()["data"], [])

    def test_other_site_url_cannot_promote_as_platform_homepage_identity(self):
        session = self.client.post(
            "/api/account-login-sessions", json={"platform": "抖音"}
        ).json()

        response = self.client.post(
            f"/api/account-login-sessions/{session['account_id']}/complete",
            json={
                "profile_nickname": "错误主页账号",
                "avatar_url": "/avatar.png",
                "homepage_url": "https://example.com/not-a-douyin-homepage",
            },
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.client.get("/api/accounts?limit=500").json()["data"], [])


if __name__ == "__main__":
    unittest.main()
