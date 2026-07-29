from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class BuildContractTest(unittest.TestCase):
    def test_backend_build_installs_runtime_and_build_dependencies(self):
        script = (ROOT / "scripts" / "build-backend.ps1").read_text(encoding="utf-8")

        self.assertIn("-r requirements.txt", script)
        self.assertIn("-r requirements-build.txt", script)


if __name__ == "__main__":
    unittest.main()
