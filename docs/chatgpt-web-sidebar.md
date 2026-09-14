# ChatGPT 网页侧边对话

> `side-chat` / `web-chat` 是历史设计，相关源码和 `smoke:web-chat` 入口已不在当前仓库中。当前原生模式只增强 Codex Desktop 自带的 Quick chat，提供“添加到会话”上下文桥。

## 官方实现参考

2026-09-09 核对 `openai/codex` main（`9ba1d9eb5bbbd87ba2fc528d91ad239eea975ee9`）的完整目录树、README、`codex-rs/chatgpt` 与桌面启动器后，未发现截图中 Quick chat 面板的前端与聊天历史同步实现。

- [官方 ChatGPT 使用文档](https://learn.chatgpt.com/docs/use-chatgpt)明确说明：Codex 的 Quick chat 可以访问网页和手机端的 ChatGPT 聊天。
- [公开组件列表](https://learn.chatgpt.com/docs/open-source)列出 CLI、SDK、App Server 等；没有提供该面板的源码入口。
- [`codex-rs/chatgpt/src/get_task.rs`](https://github.com/openai/codex/blob/9ba1d9eb5bbbd87ba2fc528d91ad239eea975ee9/codex-rs/chatgpt/src/get_task.rs)读取 `/wham/tasks/{task_id}` 编码任务，不是网页聊天列表。
- [`codex-rs/cli/src/desktop_app/windows.rs`](https://github.com/openai/codex/blob/9ba1d9eb5bbbd87ba2fc528d91ad239eea975ee9/codex-rs/cli/src/desktop_app/windows.rs)负责启动或安装桌面应用，不包含 Quick chat UI。

因此这里实现的是直接内嵌 ChatGPT 官方网页的替代接入，不声称复制了官方 Quick chat 的内部实现。最近聊天与模型菜单使用网页自身的界面，不伪造官方内部会话接口。

点击“新建对话”旁的聊天按钮或 Alt+S，打开内嵌的 https://chatgpt.com/。
首次使用在网页中登录。网页使用独立的持久浏览器会话，关闭面板后重新打开保留页面；应用重启后可通过网页历史记录继续聊天。

侧边聊天直接使用 ChatGPT 网页，不调用 Codex app-server，不占用 Codex 编码额度。ChatGPT 网页自身的模型与使用限制仍适用。将内容添加到主输入框后，再发送给编码 Harness，会按该 Harness 正常计费或消耗额度。

“添加到当前 Harness”优先导入网页选中文字；未选择时读取当前页面已加载的用户与助手消息文本，附带页面标题和来源链接。只填入草稿，由用户点击发送。图片附件不会自动下载或导入；网页未加载的历史消息也不会导入。网页结构变化导致读取失败时会显示提示，可选中文字重试。

当前实现位于 `src/native-ui/renderer-extension/src/renderer-chatgpt-context.ts`。Quick chat 标题栏的“添加到会话”优先使用面板内选中文字，否则读取当前已打开聊天中明确标记为 user/assistant 的已加载消息；内容经脱敏、最多 12 条/24000 字符截断后，作为“不可信历史资料”写入当前主 Composer 草稿。只写草稿，不自动发送，同一草稿只允许一条引用。

- 添加到其他 Harness：发送时由当前 Harness 创建/继续它自己的原生 Session，使用该 Harness 的模型、工具、权限和账号额度；不继承 ChatGPT 的会话 ID、系统提示或工具状态。
- 添加到 Codex：发送时由当前 Composer 绑定的 Codex 账号处理并消耗该账号额度；同样只是上下文引用，不把 ChatGPT conversation 恢复成 Codex Thread。新任务使用 Composer 当前选择的账号，旧任务保持原账号。
- 两种目标共用原生 Composer 和同一份上下文包。发送前可用现有 Harness/账号选择器确认目标，Quick chat 不增加第二套会话 UI。

登录和模型选择使用网站原生界面。浏览器会话由 Electron 管理；应用不读取、导出或代理 Cookie、Token。远程页面启用 sandbox、contextIsolation，关闭 nodeIntegration，不注入本地 IPC preload。登录弹窗使用相同浏览器会话。

实现：`src/main/side-chat/web.js`、`src/renderer/web-chat.js`、`src/renderer/web-chat.css`。原 app-server 侧边模块保留在源码中，但生产入口和 preload 已停止接入它。

历史版本曾使用 `smoke:web-chat` 验证隔离网页夹具；当前版本没有该命令。若未来恢复此能力，必须同时恢复隔离、安全边界测试以及真实登录后的人工验收。
