# 百度网盘→飞书三表自动化：跨 AI 接入说明

## 结论

这不是一个安装后可复制到任意电脑的独立桌面应用，而是一个本机独立生产仓库：

- 核心逻辑在本仓库 scripts/；
- 运行时由 Windows 计划任务 BaiduFeishuTranscriptBatch 的 PowerShell wrapper 启动；
- 百度网页复用本机已经登录的 Chrome/CDP 会话；
- 飞书写入通过本机 lark-cli.exe 和已有 reporter 完成；
- 状态、锁、运行报告都落在本仓库 state/。

因此，其他 AI 工具可以安排检查、调试、读取结果和提交待处理请求，但不能直接伪造计划任务身份或另起一套浏览器来做生产。

## 给其他 AI 的唯一入口

在任意工作目录，用固定 Node 运行：

~~~powershell
node "C:\Users\Administrator\Documents\Codex\2026-08-24\new-chat\work\baidu-feishu-automation\scripts\baidu-feishu-control.mjs" inspect --json
~~~

只读列出当前已经存在的百度页面（不会新建、导航或关闭页面）：

~~~powershell
node "C:\Users\Administrator\Documents\Codex\2026-08-24\new-chat\work\baidu-feishu-automation\scripts\baidu-feishu-control.mjs" inspect --cdp --json
~~~

运行已有只读校验：

~~~powershell
node "C:\Users\Administrator\Documents\Codex\2026-08-24\new-chat\work\baidu-feishu-automation\scripts\baidu-feishu-control.mjs" validate --json
~~~

提交一个调试或人工复核请求。此命令只落盘请求，不启动生产：

~~~powershell
node "C:\Users\Administrator\Documents\Codex\2026-08-24\new-chat\work\baidu-feishu-automation\scripts\baidu-feishu-control.mjs" request-run --requester=workbuddy --mode=validate-only --reason="检查最近自然批次" --json
~~~

允许的 mode 只有：

- validate-only：只读字段和环境校验；
- human-review：等待人工决定；
- scheduled-observation：观察下一次自然计划批次。

没有“直接生产启动”模式。真实生产只由 Windows 计划任务 wrapper 启动。

## 生产边界

1. 不得直接运行 run-baidu-feishu-batch.mjs 进行生产。
2. 不得伪造 BAIDU_FEISHU_SCHEDULED_RUN=1。
3. 不得执行 --only、--force、--waitmin 等旁路生产参数。
4. 不得新建 Chrome、Profile 或第二套 CDP 页面。
5. 批次运行时不连接 9223 做额外探测。
6. validate 的输出只能证明校验结果，不能当成业务完成。
7. 业务完成必须以运行报告、百度远端文件和飞书行回读三者同时成立为准。

## 外部 AI 如何安排调试

外部 AI 的标准顺序是：

1. inspect --json：确认仓库、配置、两把锁和最近批次；
2. 若没有生产锁，再运行 inspect --cdp --json：只查看已经存在的页面；
3. validate --json：只读校验表字段和运行环境；
4. request-run：记录需要人工或下一自然批次处理的请求；
5. 等 Windows 计划任务自然完成后，重新读取 state/runs/*.json、日志和三张业务表；
6. 只有百度文件、文稿链接、直播稿doc 附件数量均回读正确，才可以汇报完成。

WorkBuddy、Codex 或其他 AI 都使用同一组文件和同一套锁，不应各自安装一套接收器、浏览器或 Profile。

## 当前仍是本机依赖的部分

以下资源仍必须在本机可用：

- 固定 Node；
- lark-cli.exe；
- 已登录的百度 Chrome Profile；
- CDP 9223；
- D:\winlp_reporter；
- Windows 计划任务。

这些路径集中在 config/runtime.json，也可由同名环境变量覆盖。文件不包含密钥；不要把 config/tables.json 中的敏感凭据复制给其他 AI。

## 调试回执

每次外部 AI 调试都应保留：

- 调用命令；
- requestId（如调用 request-run）；
- 最近 runId；
- state/runs/<runId>.json；
- 业务表回读结果；
- 若失败，准确错误码和下一步。

“脚本能读到消息”“页面在线”“只读校验通过”都不能写成“转文稿完成”。
