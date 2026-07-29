# 参与开发

感谢你关注小光账号。提交改动前，请先理解 [CONTEXT.md](CONTEXT.md) 中的领域词汇、不变量和关键 seam。

## 本地准备

项目面向 Windows，需要 Node.js 22.12 或更高版本、Python 3.10 或更高版本。

```powershell
npm install
python -m pip install -r requirements.txt
npm run check
```

开发数据默认写入 `data/`。建议通过 `ACCOUNT_CONSOLE_DATA` 为实验或测试使用独立目录，不要复制真实账号数据到仓库。

## 改动原则

- 登录会话成功前不得进入正式账号列表和统计。
- 账号合并只依据平台账号 ID 或归一化公开主页，不依据昵称。
- 手动、托盘、定时和系统任务复用同一个采集运行语义。
- 发布保持人工完成，不新增绕过验证码、风控或平台限制的实现。
- 平台差异放在平台能力声明或对应 adapter 中，不复制到多个调用者。
- 测试通过模块 interface 验证可观察行为，不依赖内部实现细节。

## 提交前检查

```powershell
npm run check
git diff --check
```

同时确认：

- 没有提交 `data/`、日志、浏览器 profile、Cookie、令牌或真实账号标识。
- 新增平台同时更新 `shared/platforms.json`、运行时 adapter 和回归测试。
- 修改登录或采集流程时，保留失败清理和数据目录隔离行为。
- 修改打包流程时，确认升级不会覆盖已有 `data/`。

## 问题报告

问题描述应包含版本、复现步骤、预期结果和实际结果。日志和截图在公开前必须删除账号昵称、主页链接、Cookie、令牌和本地绝对路径等隐私信息。
