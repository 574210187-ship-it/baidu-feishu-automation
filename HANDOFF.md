# 录屏03 交接说明：百度网盘 → 文稿 → 飞书多维表

本文是给接手机器（通用 Linux，例如另一台云电脑）和接手 AI 的完整说明。按这里的步骤部署，不要再去拷贝旧机器上的 Chrome 配置、Cookie、token 或日志。

时间一律按**北京时间**（Asia/Shanghai，UTC+8）理解和配置。

---

## 给接手 AI 的一句话指令

请在这台一直保持开机、不会休眠的 Linux 云电脑上部署「录屏03」百度网盘→文稿→飞书多维表自动化。先完整阅读本仓库的 HANDOFF.md 并严格按其中步骤执行：把程序放到合适目录（例如 `/workspace/baidu-feishu-automation`），数据目录单独放（例如 `/workspace/baidu-feishu-data`），不要使用或拷贝任何旧的 chrome-profile、cookie、token 或日志；安装 Node.js 20+、Google Chrome（或 Chromium，并改 `CHROME_PATH`）、lark-cli 1.0.100（`npx @larksuite/cli@1.0.100 install`，写入一律走 `lark-cli --as user`）和 supercronic（`bin/install-supercronic.sh`）；在仓库根目录执行 `npm install`；按本机路径修改 `config/runtime.json`（以及如有必要的 `config/automation.json`）；先完成百度网盘专用 Chrome profile 扫码登录和 lark-cli 用户授权，登录完成前不要启用 crontab。启用调度前必须确认：录屏边上那台 Windows 电脑的计划任务 `BaiduFeishuTranscriptBatch` 已禁用，且原 Grok Bot 云电脑上的批次和调度已全部停掉——同一时间只能有一边在跑，否则会重复写入飞书三张多维表（姜律师 / 意晨 / zed）。默认调度是北京时间每天 0、4、8、12、16、20 点，启动前先和用户确认是否改时间。登录完成后可用 `BAIDU_FEISHU_SCHEDULED_RUN=1 ./run-batch.sh` 手动验证一轮，再执行 `bin/enable-cron.sh`。这台机器必须一直开着，进程才能跑完一轮（大约 1.5 小时）；机器休眠时盒内定时器不会触发，错过的点也不会补跑。不要把 cookie、token 或密钥写入仓库，也不要发给任何人。

---

## 这套程序做什么

把百度网盘源目录里的录屏 mp4，通过百度网盘网页版自带的「文稿 / AI 草稿」功能转成文稿，再把分享链接、提取码和文稿附件写入三张飞书多维表，最后把已完成或作废的文件在网盘里移到对应子目录。

它**不是**本地语音识别。出稿发生在百度服务器上。本程序用 Node 脚本，通过 CDP（默认端口 9333）驱动一台**专用的 headless Chrome**（独立 profile，不要用桌面浏览器那份），再用 `lark-cli`（建议 1.0.100）以 `--as user` 写飞书。

一轮的大致顺序：

1. 检查百度登录和飞书 CLI 是否可用。
2. 扫描三张表对应的网盘目录，计算本轮目标。
3. 先把上一轮留下的半成品做完（分享文稿、下载上传附件、移动完成/作废文件），这一步不必再等文稿生成。
4. 对需要点「文稿」的视频统一执行 stage1（点文稿 + 分享视频）。
5. **整轮只全局等待一次**（默认 10 分钟），让百度生成文稿。
6. 再统一跑 stage2 → 3 → 3b → 4 → 5 → 6。
7. 本批新产生的返工行立刻检查是否已有文稿，不再二次等待；没就绪的保持「下一轮重新执行」。

真实生产写入必须带环境变量 `BAIDU_FEISHU_SCHEDULED_RUN=1`。包装脚本 `run-batch.sh` 会设置它。直接跑 `scripts/run-baidu-feishu-batch.mjs` 且没有这个变量时，会被拒绝（`MANUAL_PRODUCTION_RUN_BLOCKED`，退出码 3）。`--validate-only` 只读校验不受这个限制。

同一时间只允许一轮：`run-batch.sh` 用 `flock` 锁 `$BAIDU_FEISHU_DATA_DIR/state/batch.lock`，脚本内部还有仓库内的 `state/run.lock`。

---

## 重要约束（先读再开）

### 1. 同一时间只能有一边在跑

下面这些入口写的是**同一套**飞书表和同一套百度目录，并行会重复写行、重复上传「直播稿doc」附件：

- 录屏边上那台 Windows 的计划任务 **`BaiduFeishuTranscriptBatch`**
- 原 Grok Bot 云电脑上的本仓库调度（`bin/enable-cron.sh` / supercronic）
- 现在这台接手机器上的调度

启用本机调度之前，必须确认另外两边都已停掉。截止交接时（2026-11-11，北京时间）：原 Grok Bot 云电脑上的 supercronic / 批次 / 巡检已停；Windows 计划任务此前已被禁用，但用户曾计划改时间后重新打开，且那台机器一度离线，交接时请再核一次任务是否仍为 Disabled。

### 2. 目标机器不能休眠

批次一轮大约 1.5 小时。如果机器空闲就整台暂停（Grok Bot 云电脑就是这样：没有 bot 在干活时，盒内脚本和定时器一起冻住），则：

- 盒内 `supercronic` / cron 在暂停期间不会触发，会漏跑；
- 已经启动的批次也会中途冻住，醒过来只会从中断处接着跑几分钟。

因此目标机器必须一直开着，或者有办法让这个进程在一轮结束前持续运行。不要把这套方案再放到会自动休眠的 Grok Bot 云电脑上靠盒内 crontab 跑。

---

## 目录结构

交接包只包含程序，不含登录态和运行数据。

```
baidu-feishu-automation/          # 程序仓库
  HANDOFF.md                      # 本文
  README.md
  INTEGRATION.md                  # 旧版 Windows 跨 AI 说明，部分过时
  LINUX.md                        # 上一台云电脑的短说明，部分过时
  package.json
  package-lock.json
  pnpm-lock.yaml
  crontab                         # supercronic 读取；默认生产行是注释的
  run-batch.sh                    # 调度入口：flock + 日志 + 设置 SCHEDULED_RUN
  bin/
    enable-cron.sh
    disable-cron.sh
    start-scheduler.sh
    install-supercronic.sh        # 下载 supercronic v0.2.51，不随包附带二进制
  config/
    tables.json                   # 三表注册中心（表 ID、网盘目录、字段差异）
    runtime.json                  # 本机路径（Chrome、lark-cli、数据目录等）
    automation.json               # 与表无关的共享项（探测目录、锁 TTL 等）
  scripts/                        # 批次与各 stage
    run-baidu-feishu-batch.mjs    # 唯一生产入口
    ensure-baidu-cdp.mjs          # 拉起专用 Chrome，检查登录，必要时截二维码
    lark-cli-utils.mjs            # lark-cli 唯一出口，含网络/超时重试
    ...
  tests/
```

运行时数据必须放在仓库外面，例如 `/workspace/baidu-feishu-data`（可用环境变量 `BAIDU_FEISHU_DATA_DIR` 改）：

```
baidu-feishu-data/
  chrome-profile/                 # 专用 Chrome，内含百度登录 Cookie，禁止打包上传
  state/
    last-run.json                 # 最近一轮摘要
    baidu-login-qr.png            # 需要扫码时由脚本生成
    batch.lock
    supercronic.pid
    sweep.lock
  logs/
    batch-YYYYMMDD-HHMMSS.log
    latest.log                    # 指向最近一次批次日志
    supercronic.log
    wrapper.log
  姜律师文稿/ 意晨文稿/ zed文稿/   # 文稿本地下载目录（见 tables.json）
```

仓库内的 `state/` 在运行中也会写入 `run.lock`、`runs/<runId>.json`、以及 `state/<jiang|yichen|zed>/` 下的阶段报告。这些都不要提交到 git。

百度网盘源目录（在网盘里，不是本地磁盘）：

- `/8月新录屏/姜律师已压缩`，子目录 `已完成`、`作废`
- `/8月新录屏/意晨已压缩`，子目录 `已完成`、`作废`
- `/8月新录屏/zed已压缩`，子目录 `已完成`、`作废`

---

## 每个 stage 的作用

| 阶段 | 脚本 | 作用 |
|---|---|---|
| 准备 | `ensure-baidu-cdp.mjs` | 启动专用 headless Chrome（CDP 9333），打开百度网盘，判断登录态。未登录则截二维码到 `state/baidu-login-qr.png` 并中止本轮，不写网盘。 |
| 扫描 | `api-scan-baidu-videos.mjs` 等 | 扫描各表源目录，结合飞书已有行，计算本轮目标。 |
| stage1 | `stage1-click-wengao-all.mjs` | 在视频页点击「文稿」，并分享视频，把视频链接和提取码写入飞书。 |
| 全局等待 | `lib/global-wait-gate.mjs` | 三表 stage1 全部结束后，只等一次 `transcriptWaitMinutes`（默认 10 分钟）。 |
| stage2 | `stage2-export-ready-transcripts.mjs` | 对已生成的文稿执行导出（.doc）。 |
| stage3 | `stage3-share-exported-docs-api.mjs` | 分享已导出的文稿，把文稿链接和提取码写入飞书。 |
| stage3b | `stage3b-download-shared-docs-local.mjs` | 下载文稿，上传到飞书「直播稿doc」附件列。同一单元格应只有一份附件，不要重复追加。 |
| stage4 | `stage4-move-completed-files.mjs` | 把已完成的 mp4 和 doc 移到网盘「已完成」目录，更新飞书状态。 |
| stage5 | `stage5-move-void-files.mjs` | 把作废文件移到「作废」目录。 |
| stage6 | `stage6-clean-source-residue.mjs` | 收尾审计源目录残留；恢复期策略偏保守，缺少证据时不擅自移动文件。 |

飞书状态常用值（见 `config/tables.json` 的 `statusOptions`）：`已移动完成`、`已作废`、`下一轮重新执行`。终态完成文案三表略有差异：姜律师是「已完成」，意晨和 zed 是「完成」。

单条失败不中断整批。整轮状态可能是 `complete` 或 `complete-with-errors`。

---

## 依赖

| 依赖 | 说明 |
|---|---|
| Linux | 通用 x86_64 或 arm64。需要 `flock`（通常来自 util-linux）、`bash`、`curl` 或 `wget`。 |
| Node.js | 20 或更高。原生产环境用过 Node v24。仓库是 `"type": "module"` 的 ESM。 |
| Google Chrome | 原环境为 Google Chrome 156。也可用 Chromium，但要把 `config/runtime.json` 的 `chromePath` 或环境变量 `CHROME_PATH` 改成实际路径。默认 `/usr/bin/google-chrome`。 |
| npm 依赖 | 在仓库根目录执行 `npm install`。生产路径实际用 `chrome-remote-interface` 驱动 CDP；`playwright` 写在 package.json 里，安装时会一并装上，但业务脚本并未 import 它。 |
| lark-cli | **1.0.100**。安装：`npx @larksuite/cli@1.0.100 install`。所有飞书写入使用 `--as user`，需要先完成用户授权。把可执行文件放到 `/usr/local/bin/lark-cli`，或改 `runtime.json` 的 `larkCliPath` / 环境变量 `LARK_CLI_PATH`。 |
| supercronic | v0.2.51。盒内往往没有 systemd / 系统 cron。运行 `bin/install-supercronic.sh` 下载到 `bin/supercronic`。如果目标机有可用的系统 cron 且机器不会休眠，也可以直接把 `crontab` 里的生产行装进系统 crontab，但路径要改对。 |

飞书应用需要有这三张多维表的读写权限（base / 记录读写、附件上传等）。授权时至少覆盖 `base`、`drive` 相关范围；也可用 `lark-cli auth login --recommend` 再按提示补齐。

---

## 安装步骤

1. 确认目标机器一直开机、不会休眠，并确认 Windows 计划任务和原云电脑调度都已停止（见上文互斥约束）。
2. 把本仓库放到目标路径，推荐仍用 `/workspace/baidu-feishu-automation`，可减少改配置。若用别的路径，`bin/*.sh` 会按脚本位置自动改 crontab 里的 `run-batch.sh` 路径，但 `config/runtime.json` 和默认数据目录仍要你改。
3. 创建数据目录：

   ```bash
   mkdir -p /workspace/baidu-feishu-data/{state,logs,chrome-profile}
   ```

   路径不同就把上面的目录和 `config/runtime.json` 一起改掉，并导出 `BAIDU_FEISHU_DATA_DIR`。

4. 安装 Node.js 20+、Google Chrome、lark-cli 1.0.100。
5. 在仓库根目录：

   ```bash
   cd /workspace/baidu-feishu-automation
   npm install
   ./bin/install-supercronic.sh
   ```

6. 编辑 `config/runtime.json`，至少核对：

   - `larkCliPath`
   - `chromePath`
   - `baiduProfileDir`、`dataDir`、`loginQrPath`、`lastRunPath`、`sweepLockPath`
   - `schedulerRoot`

   `run-batch.sh` 里的默认值也是这些路径，可用环境变量覆盖：`BAIDU_FEISHU_REPO`、`BAIDU_FEISHU_DATA_DIR`、`CDP_PORT`、`LARK_CLI_PATH`。

7. **先登录，再启用调度。** 交接包里的 `crontab` 生产行默认是注释的。

---

## 首次登录

### 百度网盘（专用 Chrome profile）

不要复用桌面浏览器的 profile，也不要拷贝旧机器的 `chrome-profile`。

1. 确保 `runtime.json` 里的 `baiduProfileDir` 指向空的（或新的）目录，例如 `/workspace/baidu-feishu-data/chrome-profile`。
2. 在仓库根目录执行：

   ```bash
   export BAIDU_FEISHU_SCHEDULED_RUN=1
   node scripts/ensure-baidu-cdp.mjs
   ```

   也可以直接 `BAIDU_FEISHU_SCHEDULED_RUN=1 ./run-batch.sh`，未登录时会在写网盘之前停住。

3. 若判定未登录，脚本会尽量点出扫码框，并把二维码截到：

   - `$BAIDU_FEISHU_DATA_DIR/state/baidu-login-qr.png`
   - 以及仓库内 `state/baidu-login-qr.png`

   把这张图发给需要扫码的人。若截到的不是二维码（高分屏裁剪不准时发生过），再打开专用 profile 的页面人工看二维码，不要把整桌面或其他窗口误截上去。

4. 扫码完成后再跑一次 `ensure-baidu-cdp.mjs`，确认已登录（不要把接口临时失败误判成掉登录：脚本会区分「真的要扫码」和「百度接口暂时拒绝」）。

登录态保存在专用 profile 里，会过期，过期后按同样方式重新扫码。下一自然批次会自动接着做，不必强制手动补跑，除非你想马上验证。

### 飞书 lark-cli（用户授权）

1. 如尚未配置应用，按官方流程执行 `lark-cli config init`（接手 AI 可用 `lark-cli config init --new`，把授权链接发给用户）。
2. 用户登录：

   ```bash
   lark-cli auth login --recommend
   ```

   若当前环境不能一直等浏览器，使用 `lark-cli auth login --recommend --no-wait --json`，把验证 URL 或二维码发给用户，用户确认后再用返回的 device code 完成。不要在日志或聊天里打印 token。

3. 检查：

   ```bash
   lark-cli --version          # 应为 1.0.100 或与之兼容的版本
   lark-cli whoami             # 确认是用户身份，不要把输出里的凭证贴出去
   lark-cli auth status
   ```

4. 只读验证三张表是否可达（不写业务数据）：

   ```bash
   node scripts/run-baidu-feishu-batch.mjs --validate-only
   ```

飞书 refresh token 会过期，`lark-cli` 通常会自动续期；若批次报告 `needsFeishuLogin=true` 或出现未登录类错误，重新执行 `lark-cli auth login`。

---

## 配置文件说明

### `config/tables.json`

三表唯一注册中心。新增或调整表只改这里。字段名三表基本一致（各 61 列），差异主要是 `videoLinkField` 和目录 / 表 ID。

| 表 | key | baseToken | tableId | 网盘目录 | 视频链接字段 | 完成态文案 |
|---|---|---|---|---|---|---|
| 姜律师 | jiang | `EASybXafOaOiXPsgL5LcNrxJnDb` | `tbl7lxRkJkKvA4XN` | `/8月新录屏/姜律师已压缩` | 视频网盘链接 | 已完成 |
| 意晨 | yichen | `YVDlbBcSCaJOYos30qPcOpADnMf` | `tblx1ESrJvK3g4UQ` | `/8月新录屏/意晨已压缩` | 视频网盘链接 | 完成 |
| zed | zed | `MLKnbkdBCaQMWmssbvkcz80EnEd` | `tblSWinblefT5efH` | `/8月新录屏/zed已压缩` | 视频链接 | 完成 |

这里的 `baseToken` / `tableId` 是多维表标识，不是用户登录 token。运行需要它们，交接包保留原值。不要把 lark-cli 的用户 access/refresh token 写进这个文件。

其他项：`batchIntervalHours`（4）、`transcriptWaitMinutes`（10）、`statusOptions`、`requiredFields`。

### `config/runtime.json`

本机路径。可用同名环境变量覆盖，见 `scripts/runtime-config.mjs`。文件本身不应包含密钥。

### `config/automation.json`

与具体表无关的共享项，例如保活探测目录、共享下载目录、锁 TTL。`activeBaiduDir` / `activeBaiduUrl` 只给登录探测用，取值等于 zed 的新目录。批次节奏以 `tables.json` 为准。

### `crontab`

```
TZ=Asia/Shanghai
CRON_TZ=Asia/Shanghai
# baidu-feishu-batch: 0 0,4,8,12,16,20 * * * <仓库>/run-batch.sh
```

默认整行注释。`enable-cron.sh` 会去掉注释，并把路径改成当前仓库位置。改时间时，请同时改 crontab 行和 `bin/disable-cron.sh` 里匹配 `0 0,4,8,12,16,20` 的那一行，否则停用脚本可能认不出生产行。

---

## 启动和停止调度

登录和 `--validate-only` 都通过之后：

```bash
# 建议先手动跑一轮（会真正写飞书和网盘）
BAIDU_FEISHU_SCHEDULED_RUN=1 /workspace/baidu-feishu-automation/run-batch.sh

# 启用每 4 小时调度（机器重启后需要再执行一次 start 或 enable）
/workspace/baidu-feishu-automation/bin/enable-cron.sh

# 只启动调度器、不打开生产行
/workspace/baidu-feishu-automation/bin/start-scheduler.sh

# 停用生产行并重启调度器
/workspace/baidu-feishu-automation/bin/disable-cron.sh
```

`start-scheduler.sh` 把 pid 写在 `$BAIDU_FEISHU_DATA_DIR/state/supercronic.pid`。机器若重启，supercronic 不会自动回来，需要再次执行 `start-scheduler.sh` 或 `enable-cron.sh`。

排查时可只跑一张表（仍需 `BAIDU_FEISHU_SCHEDULED_RUN=1`）：

```bash
BAIDU_FEISHU_SCHEDULED_RUN=1 node scripts/run-baidu-feishu-batch.mjs --table=jiang
```

维护性全量补跑：`--all-existing`。不要在已有另一边生产批次在跑时使用。

只读检查：`npm run inspect`、`npm run validate`，或 `node scripts/baidu-feishu-control.mjs inspect --json`。

---

## 日志和状态怎么看

- 包装日志：`$BAIDU_FEISHU_DATA_DIR/logs/batch-*.log`，软链接 `latest.log`。
- 调度日志：`$BAIDU_FEISHU_DATA_DIR/logs/supercronic.log`；锁冲突时看 `wrapper.log`。
- 最近一轮摘要：`$BAIDU_FEISHU_DATA_DIR/state/last-run.json`，字段包括：

  `runId`、`start`、`end`、`exitCode`、`status`、`needsBaiduLogin`、`needsFeishuLogin`、`errorSummary`

  `needsBaiduLogin` / `needsFeishuLogin` 为 true 时需要重新扫码或重新授权，不要把文件里可能出现的路径之外的敏感内容对外粘贴。

- 详细运行报告：仓库内 `state/runs/<runId>.json`（各表 processed / completed / 错误、`globalWait` 等）。
- 分表阶段报告：`state/<jiang|yichen|zed>/stage1-report.json` 等。
- 业务是否完成，不能只看脚本退出码 0。要以运行报告、百度远端文件位置、飞书行回读（链接、提取码、「直播稿doc」附件数量）三者同时成立为准。退出码 0 且 `status=complete-with-errors` 表示整轮跑完但有失败项。

---

## 常见故障

| 现象 | 处理 |
|---|---|
| 漏跑整点批次，或一轮只往前走了几分钟 | 机器在休眠。本方案要求目标机一直开着。Grok Bot 云电脑空闲会暂停，盒内 cron 不可靠。 |
| `needsBaiduLogin=true`，或出现 `baidu-login-qr.png` | 把二维码发给用户扫码。截错图时重新打开专用 profile 页面再截。扫完等下一轮或手动再跑。 |
| 页面其实已登录，但本轮没写网盘，提示接口临时拒绝 | 不要立刻当掉登录处理。属百度 API 抖动，下一轮会再试。 |
| `needsFeishuLogin=true`，或 lark-cli 报未登录 / 99991663 | 重新 `lark-cli auth login --recommend`。不要复制旧 Windows 机器里 DPAPI 加密的 token，Linux 用不了。 |
| 飞书调用 `type=network` / `subtype=timeout` | 已在 `scripts/lark-cli-utils.mjs` 里视为可重试（最多 5 次，退避约 2/5/10/20 秒）。若仍失败，看当时网络，不要改成关闭重试。可用 `node tests/lark-cli-timeout-retry.test.mjs` 回归。 |
| `MANUAL_PRODUCTION_RUN_BLOCKED` 退出码 3 | 忘记设 `BAIDU_FEISHU_SCHEDULED_RUN=1`。用 `run-batch.sh` 或先 export 再跑。 |
| 另一轮正在跑，wrapper 立刻退出 0 | `batch.lock` 被占用，这是正常互斥。不要同时再开 Windows 任务。 |
| 飞书「直播稿doc」出现多个附件 | 多半是两边同时跑，或旧链路双写。先停掉重复入口，再人工清理重复附件。本入口按表隔离，避免历史 sweep 与本批次双写。 |
| 行长期停在「下一轮重新执行」，备注类似 `no_wengao_tab_or_no_doc` | 历史问题：部分视频点不出文稿页或没有可导出文稿，不是迁移本身引入的。不要为了清状态强行改飞书。需要的话人工抽查这些行。 |
| supercronic 找不到或机器重启后不再调度 | 运行 `bin/install-supercronic.sh`，再执行 `bin/start-scheduler.sh` 或 `enable-cron.sh`。盒内调度不会随系统开机自启，除非你另外做了启动项。 |
| Chrome / CDP 连不上 9333 | 确认 `chromePath` 正确、profile 目录可写、9333 没被别的进程占用。本批次不要去碰桌面浏览器的调试端口。 |
| 高分屏二维码截图不准 | 已知问题：截图缩放不是 1:1 时裁剪可能偏移。改用人工打开专用页面扫码。 |
| 机器重启后 crontab 生产行还在，但没人启动 supercronic | 不会跑。把 supercronic 加入该机器自己的开机方式，或每次唤醒后执行 `bin/start-scheduler.sh`。 |

---

## 已修复的问题（不要改回去）

`scripts/lark-cli-utils.mjs` 会把 lark-cli 结构化错误 `{type:"network", subtype:"timeout"}`（以及截断后的同类 JSON）当成可重试。更早的版本把它判成不可重试，一次超时就会让整段 stage 失败。相关测试：`tests/lark-cli-timeout-retry.test.mjs`。

---

## 脱敏说明

交接包已排除：`node_modules/`、`state/`、日志、`bin/supercronic` 二进制、二维码图片、Chrome profile，以及数据目录 `/workspace/baidu-feishu-data`。

对源码里命中 `token` / `cookie` / `secret` / `password` 等关键词的文件做了检查：命中的都是代码里的字段名、变量名或注释（例如飞书 `baseToken`、页面 cookie 检测、lark-cli 重试逻辑），**没有发现需要替换成占位符的真实密钥、Cookie 或密码**。`config/tables.json` 中的 `baseToken` / `tableId` 是表标识，已原样保留。

---

## 当前运行现状（交接时）

截至 2026-11-11 北京时间：

- 原 Grok Bot 云电脑上的调度、补跑和巡检已停止，不要再在那台会休眠的机器上启用盒内 cron 来跑生产。
- Windows 任务 `BaiduFeishuTranscriptBatch` 此前已禁用；若用户后来改时间重新打开，接手方启用前必须再确认它是关的。
- 不要从任何旧机器拷贝 chrome-profile 或 lark-cli token 文件到新机器。

部署完成后，把仓库路径、数据目录路径、调度时间、以及第一次成功批次的 `runId` / `last-run.json` 摘要告知用户。
