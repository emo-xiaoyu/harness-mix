# Harness 管理

入口：右上角「Harness 管理」、左下角设置，或 `Ctrl+,`。

## 连接

分别检查 Codex、Claude Code、Pi、DeepSeek Harness 的本机安装状态，显示原生接口、诊断信息和检查耗时。检测不会发送用户消息。程序可用不等于账号已登录。

## 账号

| Harness | 读取状态 | 管理方式 |
| --- | --- | --- |
| Codex | 原生 `account/read` | 原生 `account/login/start` 打开浏览器；支持取消、完成通知与退出登录 |
| Claude Code | 原生 `claude auth status --json` | 打开原生认证窗口执行 `claude auth login/logout`，完成后刷新 |
| Pi | 原生 RPC 模型目录中的供应商 | 打开 Pi 原生交互终端，使用 `/login` 与 `/logout` |
| DeepSeek Harness | 原生 Web Remote 模型目录中的供应商 | 在独立、安全隔离的应用窗口中打开 DSH 原生管理页面，进入设置管理供应商 |

Pi / DSH 显示「已配置」而非「已登录」，目录存在不能证明凭据通过在线验证。登录与配置仍使用原生程序自己的账号存储，Harness Mix 不复制账号密钥。当前使用各原生程序的本机账号环境，不提供独立多账号池。

修改登录前会检查该 Harness 是否有运行中的任务。Codex 登录连接保留至完成、取消或五分钟超时；关闭设置不会取消浏览器登录，应用退出会取消待完成的登录。

## 模型

- 按 Harness 读取原生模型目录，支持按名称和供应商筛选。
- 「保存为新对话默认」写入 Harness Mix 的本地非敏感偏好，刷新与重启后保留，不改写原生模型配置。
- 同名模型按供应商区分。默认选择只允许来自该 Harness 实际返回的目录。
- 「应用到当前对话」通过现有原生 `setModel` 链路执行；任务运行中不能切换。
- 选择「跟随原生默认」可清除 Harness Mix 的默认模型覆盖。
- 配置或登录完成后刷新状态和目录，使新的供应商与模型可见。

## 验证

```powershell
npm run test:management
npm run smoke:management
npm run e2e:management
```

`test:management` 检查账号字段白名单、模型供应商身份、并发默认值保存和登录连接生命周期。`smoke:management` 使用真实 Electron / IPC 和模拟原生响应，检查页面切换、延迟响应、登录路由、筛选、重启恢复与小窗口布局。

`e2e:management` 是只读真实验收：读取四家原生账号状态与模型目录，打开并重新打开认证后的 DSH 原生页面。不会执行登录/退出、修改凭据、调用模型；需要本机安装对应 Harness。测试报告和截图保存在 `output/playwright/`。
