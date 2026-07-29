import unittest

from fastapi.testclient import TestClient

from backend.main import app


class RuntimeContractTest(unittest.TestCase):
    def test_health_identifies_the_app_version_and_data_directory(self):
        with TestClient(app) as client:
            response = client.get("/api/health")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["app_id"], "com.local.account-console")
        self.assertRegex(payload["version"], r"^\d+\.\d+\.\d+$")
        self.assertTrue(payload["data_dir"])

    def test_dormant_dashboard_and_publish_surfaces_are_not_exposed(self):
        with TestClient(app) as client:
            responses = [
                client.get("/api/dashboard"),
                client.get("/api/analytics/account-cards"),
                client.get("/api/publish-tasks"),
                client.post("/api/publish-tasks", json={"title": "unused"}),
            ]

        self.assertTrue(all(response.status_code == 404 for response in responses))


if __name__ == "__main__":
    unittest.main()
