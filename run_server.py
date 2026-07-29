import urllib.request

from backend.config import HOST, PORT
from backend.main import run


if __name__ == "__main__":
    url = f"http://{HOST}:{PORT}"
    try:
        urllib.request.urlopen(f"{url}/api/health", timeout=1)
        print(f"账号管理台已在运行：{url}")
    except Exception:
        run()
