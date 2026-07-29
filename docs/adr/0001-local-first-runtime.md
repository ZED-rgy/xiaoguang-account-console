# ADR-0001：本地优先运行时与 SQLite 主库

- 状态：已接受
- 日期：2026-07-15

## 决策

小光账号继续采用 Electron + FastAPI + SQLite 的本地优先形态。SQLite 是运行时唯一主库，正式数据位于安装目录的 `data/`，开发数据位于仓库 `data/` 或 `ACCOUNT_CONSOLE_DATA` 指定目录。

## 原因

账号隔离登录态、本地浏览器、采集日志和素材入口都依赖本机资源。当前数据规模不需要 PostgreSQL，也没有远程多用户并发需求。

## 后果

- 正式打包必须保护 `data/`，程序升级不能覆盖它。
- Electron 必须确认连接的是匹配应用身份和数据目录的 FastAPI 实例。
- 不为只有 SQLite 一个实现的存储代码引入假想 adapter seam。

