# Windows 辅助脚本

这里保存开发、构建、启动和计划任务脚本。所有脚本都以仓库根目录为工作目录。

| 文件 | 用途 |
| --- | --- |
| `start-desktop.bat` | 启动 Electron 开发版 |
| `start-server.bat` | 只启动本地 FastAPI |
| `start-installed.ps1` | 查找并启动已构建或已放置在磁盘根目录下的成品 |
| `restart-local.ps1` | 仅停止属于本项目的 8826 端口后端，再重新启动 |
| `build-backend.ps1` | 使用 PyInstaller 构建内置后端 |
| `build-desktop.bat` | 生成 Windows portable 成品 |
| `collect-works.bat` | 从源码无界面执行一次采集 |
| `setup-collect-schedule.bat` | 为源码 checkout 注册每日采集计划任务 |

根目录的 `启动小光账号.bat` 会调用 `start-installed.ps1`。可通过 `ACCOUNT_CONSOLE_EXE` 指定完整可执行文件路径，或通过 `ACCOUNT_CONSOLE_INSTALL_DIR` 指定成品目录；没有找到成品时会回退到开发版。

`setup-collect-schedule.bat` 依赖当前源码目录、Node.js 和已安装的 npm 依赖。公开分发成品的系统级调度方式应在 release 流程中单独设计。
