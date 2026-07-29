# 开发指南

## 运行组成

小光账号由四部分组成：

1. Electron 负责桌面窗口、托盘、隔离浏览器分区和平台采集。
2. FastAPI 只监听 `127.0.0.1`，提供账号、作品、分析和设置接口。
3. SQLite 是唯一业务主库。
4. 原生 HTML、CSS 和 JavaScript 构成管理界面。

Electron 启动时会校验后端的应用标识、版本和数据目录，避免误连另一个本地实例。

## 环境要求

- Windows 10/11
- Node.js `>= 22.12.0`
- Python `>= 3.10`

```powershell
npm install
python -m pip install -r requirements.txt
```

PyInstaller 只在打包时需要，`npm run pack` 会根据 `requirements-build.txt` 安装。

## 数据隔离

开发环境默认使用仓库下的 `data/`。正式包默认使用可执行文件旁的 `data/`，portable 模式也会优先使用原始 portable 文件所在目录。

为测试或排障创建独立数据目录：

```powershell
$env:ACCOUNT_CONSOLE_DATA = "D:\account-console-test-data"
$env:ACCOUNT_CONSOLE_PORT = "8827"
npm run start
```

不要把真实数据目录用于自动化测试，也不要把以下内容提交到 Git：

- `*.sqlite3` 及其 WAL/SHM 文件
- `electron-profile/` 和 `browser_profiles/`
- `logs/`、`backups/`、Cookie、令牌或平台响应原文

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run start` | 启动 Electron 开发版 |
| `npm run server` | 只启动 FastAPI |
| `npm run collect` | 无界面执行一次采集 |
| `npm run test` | 运行 Node 与 Python 测试 |
| `npm run check` | 语法检查和完整回归 |
| `npm run pack` | 构建解压版 |
| `npm run dist` | 构建 portable 成品 |

Windows 辅助脚本见 [scripts/README.md](../scripts/README.md)。

## 验证顺序

普通改动至少运行：

```powershell
npm run check
git diff --check
```

涉及打包或运行时监督时，还应运行 `npm run pack`，从 `dist/win-unpacked` 启动成品，并读取 `/api/health` 验证应用标识、版本和数据目录。

涉及真实平台页面时，自动化测试只能验证编排与解析契约；仍需使用专用测试账号人工抽测登录、重启后登录态、公开主页采集和失败恢复。

## 模块导航

- `backend/main.py`：HTTP 路由和应用入口。
- `backend/db.py`：数据库结构、迁移、备份和行转换。
- `backend/analytics.py`：分析查询。
- `electron/main.js`：Electron 生命周期与 IPC 入口。
- `electron/account-lifecycle.js`：登录会话到正式账号的生命周期。
- `electron/collection-coordinator.js`：采集请求编排。
- `electron/collector.js`：平台 adapter 执行。
- `electron/runtime-supervisor.js`：后端发现、启动、就绪与关闭。
- `frontend/app.js`：页面状态与交互入口。
- `shared/platforms.json`：跨运行时的平台能力声明。

这些入口文件仍然较大，但关键业务决策已经位于可独立测试的模块中。后续应在真实业务修改中按能力迁移，避免为了缩短文件而做一次性拆分。
