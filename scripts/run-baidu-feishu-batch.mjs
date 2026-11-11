// run-baidu-feishu-batch.mjs — 百度网盘→飞书 三表统一入口（唯一调度入口）
//
// 背景（2026-09-10 重构）：此前本脚本只处理 zed（config/feishu-fields.json 只绑定 zed
// 一张表），姜律师与意晨被迫留在旧的 sweep_waiting 链路。两条链路各自往「直播稿doc」
// 附件列追加一次 —— 附件字段是数组、上传是追加语义 —— 这正是"一个单元格多个 doc"
// 复发的结构性根源。现在：
//   · 三表全部由本入口处理，表定义集中在 config/tables.json；
//   · state/<key>/ 按表隔离，三表同轮互不覆盖；
//   · zed 不再被 sweep_waiting 处理（sweep 已硬封口），双写被结构性消除。
//
// 2026-09-11 修复（第一目标：最快拿到直播稿doc 并写入多维表）：
//   Bug1 第一阶段不再按"当前 4 小时窗口"排除未入表视频 —— 源目录内所有 mp4，只要飞书
//        没有同名记录且未被 processedFsIds 跳过，就进第一阶段。时间窗口只用于写批次号/
//        批次阶段与统计。旧逻辑会让"上一轮开始后上传、下一轮跨出窗口"的视频永远不入表。
//   Bug2 等待不再被"表 × 阶段"串行放大：旧编排每个阶段的 stage1 后都 sleep 10 分钟，
//        三表最多 15 个阶段 = 最坏空等 150 分钟。新编排见下方 §编排。
//   Bug7 运行报告的每张表条目统一带 key/status，不再出现 undefined:complete。
//   Bug8 启动时把"status=running 但进程/锁都已消失"的历史中断报告收敛成 aborted。
//
// 用法：
//   node scripts/run-baidu-feishu-batch.mjs                      # 三表全跑，4 小时批次
//   node scripts/run-baidu-feishu-batch.mjs --validate-only      # 只读：校验三表字段/表可达，不写任何业务数据
//   node scripts/run-baidu-feishu-batch.mjs --table=jiang        # 只跑指定表（排查用）
//   node scripts/run-baidu-feishu-batch.mjs --all-existing       # 全量现有补跑（维护用）
//
// §唯一入口凭据（2026-09-17 加固）：
//   真实业务写入必须在环境变量 BAIDU_FEISHU_SCHEDULED_RUN=1 下运行。
//   计划任务 wrapper（D:\百度网盘文稿下载\scheduler\run-baidu-feishu-batch-task.ps1）
//   启动本脚本前会自动设置它；其他任何程序/窗口直拉都会被拒绝，输出
//   MANUAL_PRODUCTION_RUN_BLOCKED 并 exit(3)。--validate-only 只读模式不受限。
//   维护用显式跑法：$env:BAIDU_FEISHU_SCHEDULED_RUN='1'; node scripts/run-baidu-feishu-batch.mjs --all-existing
//
// §编排（2026-09-11 起）：
//   ① 三表全部 api-scan，并一次性算好各阶段目标集合
//   ② 先跑「前置阶段-半成品收敛」的下游（stage3→3b→4→5，不需要等待文稿）
//   ③ 三表所有"需要点文稿"的阶段（下一轮重新执行 / 本批新批次 / 上一批返工）stage1 全跑完
//   ④ 全局只等一次 transcriptWaitMinutes（默认 10 分钟）
//   ⑤ 再统一跑这些阶段的下游 stage2→3→3b→4→5
//   ⑥ 最后单独做「第三阶段-本批返工」（依赖 ③ 新建的行）——**立即检查已就绪文稿，不再等待**
//   即：整轮等待次数恒为 1 次（2026-10-11 起）；此前是"最多 2 次"，第二等白等 10 分钟。
//   · 正常批次 run.json 必须满足 globalWait.rounds === 1（闸门 scripts/lib/global-wait-gate.mjs
//     把等待权收敛成一次性令牌；违反会写 stageErrors 并改判 complete-with-errors）。
//   · 第三阶段未就绪的返工行保持「下一轮重新执行」，由下一自然批次的「第二阶段-上一批返工」继续。
//
// 单条失败不中断整批；单阶段崩溃只跳过该阶段下游，外层继续下一阶段/下一张表。

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { cleanupBaiduTargets } from './baidu-cdp-utils.mjs';
import { listAllRecords } from './feishu-list-all.mjs';
import { resolveAllTables, resolveTable, parseTableArg, LARK_CLI, readTablesConfig } from './table-context.mjs';
import { REPO_ROOT, REPORT_EVENT_PATH, REPORTER_ROOT, SWEEP_LOCK_PATH } from './runtime-config.mjs';
import { writeLastRun } from './last-run-status.mjs';
import { pushStageError, summarizeStageErrors, decideRunStatus, ensureStageErrors } from './stage-error-store.mjs';
import { evaluateEmptyScanWarnings, loadRecentBatchHistory, loadTempDirScan } from './empty-scan-warning.mjs';
import { createGlobalWaitGate } from './lib/global-wait-gate.mjs';

const root = REPO_ROOT;
// 所有相对 state/config 路径统一锚定仓库；外部 AI 可从任意 cwd 调用只读入口。
process.chdir(root);
const cli = LARK_CLI;
const tablesConfig = readTablesConfig();
const batchIntervalHours = tablesConfig.batchIntervalHours;
const transcriptWaitMinutes = tablesConfig.transcriptWaitMinutes;

// 本机汇报负责人接入：只提交事件到 D:\winlp_reporter\outbox，
// 不直接改汇报表或发送机器人；dispatcher 负责后续发送与回读。
const REPORT_EVENT = REPORT_EVENT_PATH;
const REVIEW_SCRIPT = path.join(root, 'scripts', 'review-03-run.mjs');
const FALLBACK_REPORT_ROWS = {
  jiang: 'reczz28TF1Q6EeON',
  yichen: 'reczz28TF4Sut2q4',
  zed: 'reczz28TF4SuwgaA'
};
const REPORT_ROWS = (() => {
  try {
    const reporterConfig = JSON.parse(fsSync.readFileSync(path.join(REPORTER_ROOT, 'config.json'), 'utf8'));
    const ids = reporterConfig.unified_alerting?.projects?.baidu_transcript_03?.row_ids;
    if (Array.isArray(ids) && ids.length >= 3 && ids.slice(0, 3).every((id) => typeof id === 'string' && id)) {
      return { jiang: ids[0], yichen: ids[1], zed: ids[2] };
    }
    console.error(JSON.stringify({ event: 'report_row_config_fallback', reason: '当前配置缺少 baidu_transcript_03.row_ids' }));
  } catch (error) {
    console.error(JSON.stringify({ event: 'report_row_config_fallback', reason: String(error?.message || error).slice(0, 300) }));
  }
  return FALLBACK_REPORT_ROWS;
})();

function submitLocalReportEvent({ report, tableKey, eventType, level, summary, detail }) {
  const row = REPORT_ROWS[tableKey];
  if (!row || validateOnly || report.trigger === 'validate-only' || report.mode === 'validate-only') {
    return { skipped: true, reason: 'not-production-or-validate-only' };
  }
  // Linux 迁移后不再调用 winlp_reporter；告警改写 last-run.json。脚本缺失时直接跳过。
  if (!REPORT_EVENT || !fsSync.existsSync(REPORT_EVENT)) {
    return { skipped: true, reason: 'reporter-disabled' };
  }
  // 来源真实性（总控 2026-10-09 裁定·方案 B）：03 的真实执行主体＝计划任务 wrapper
  // （trigger=scheduled-wrapper-env，自报 baidu_batch_script）。
  const reportSource = 'baidu_batch_script';
  // 详情一律走文件（2026-10-10 修复 ENAMETOOLONG）：
  // 产物清单 + 阶段摘要会让 --detail 的内联 JSON 超过 Windows 命令行上限，
  // spawn 直接报 ENAMETOOLONG，事件根本落不了盘。改为写临时文件 + --detail-file。
  let detailFile = null;
  try {
    const detailDir = path.join('state', 'report-detail');
    fsSync.mkdirSync(detailDir, { recursive: true });
    detailFile = path.join(detailDir, `detail-${tableKey}-${Date.now()}-${process.pid}.json`);
    fsSync.writeFileSync(detailFile, JSON.stringify(detail), 'utf8');
  } catch (error) {
    console.error(JSON.stringify({ event: 'local_report_event_failed', row, tableKey, stage: 'write_detail_file', error: String(error?.message || error).slice(0, 500) }));
    return { ok: false, row, tableKey, error: String(error?.message || error).slice(0, 500) };
  }
  try {
    const r = spawnSync(process.execPath, [
      REPORT_EVENT,
      '--row', row,
      '--source', reportSource,
      '--type', eventType,
      '--level', level,
      '--module', '百度网盘→飞书三表自动化',
      '--summary', summary,
      '--detail-file', detailFile
    ], { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
    if (r.error || r.status !== 0) {
      console.error(JSON.stringify({ event: 'local_report_event_failed', row, tableKey, error: String(r.error?.message || r.stderr || `exit=${r.status}`).slice(0, 500) }));
      return { ok: false, row, tableKey, error: String(r.error?.message || r.stderr || `exit=${r.status}`).slice(0, 500) };
    }
    const parsed = JSON.parse(String(r.stdout || '{}'));
    console.log(JSON.stringify({ event: 'local_report_event_submitted', row, tableKey, event_id: parsed.event_id, outbox: parsed['落盘位置'] || null, detail: parsed.详情 || null }));
    return { ok: true, row, tableKey, event_id: parsed.event_id, outbox: parsed['落盘位置'] || null };
  } catch (error) {
    console.error(JSON.stringify({ event: 'local_report_event_failed', row, tableKey, error: String(error?.message || error).slice(0, 500) }));
    return { ok: false, row, tableKey, error: String(error?.message || error).slice(0, 500) };
  } finally {
    if (detailFile) {
      try { fsSync.unlinkSync(detailFile); } catch { /* 详情文件清理失败不影响上报结果 */ }
    }
  }
}

const reportCellText = (value) => {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(reportCellText).filter(Boolean).join(' ').trim();
  if (typeof value === 'object') return String(value.text ?? value.name ?? value.url ?? value.link ?? '').trim();
  return String(value).trim();
};
const reportDocCount = (value) => Array.isArray(value) ? value.length : (value ? 1 : 0);

// 汇报出口必须用业务终态回读计数，不能把“点过文稿”或“stage1 已处理”冒充成完成。
const readBatchBusinessResult = (tableKey, phases) => {
  const names = [...new Set(phases.flatMap((phase) => Array.isArray(phase.targetNames) ? phase.targetNames : []).filter(Boolean))];
  const table = resolveTable(tableKey);
  const raw = listAllRecords({
    cli,
    baseToken: table.baseToken,
    tableId: table.tableId,
    fieldIds: ['录屏名称', '状态', '文稿链接', '直播稿doc'],
    identity: 'user'
  });
  const fields = raw.data?.fields || [];
  const index = Object.fromEntries(fields.map((field, i) => [typeof field === 'string' ? field : field.name, i]));
  const ids = raw.data?.record_id_list || [];
  const rows = raw.data?.data || [];
  const byName = new Map();
  for (let i = 0; i < rows.length; i += 1) {
    const values = rows[i];
    const name = reportCellText(values[index['录屏名称']]);
    if (!name || byName.has(name)) continue;
    const status = reportCellText(values[index['状态']]);
    const link = reportCellText(values[index['文稿链接']]);
    const docs = reportDocCount(values[index['直播稿doc']]);
    byName.set(name, { recordId: ids[i] || null, name, status, link, docs });
  }
  const matched = names.map((name) => byName.get(name) || { name, recordId: null, status: '', link: '', docs: 0, missing: true });
  const completed = matched.filter((row) => row.status === '已移动完成' && Boolean(row.link) && row.docs === 1);
  const voided = matched.filter((row) => row.status === '已作废');
  return {
    tableKey,
    readbackOk: true,
    targetCount: names.length,
    successCount: completed.length,
    failedCount: voided.length,
    remainingCount: Math.max(0, names.length - completed.length - voided.length),
    targetNames: names,
    completedNames: completed.map((row) => row.name),
    voidedNames: voided.map((row) => row.name),
    remainingNames: matched.filter((row) => !completed.includes(row) && !voided.includes(row)).map((row) => row.name),
    missingFromTable: matched.filter((row) => row.missing).map((row) => row.name),
    matched
  };
};

// 选中的表：默认全部（按 config.tableOrder 顺序）；--table=<key> 可只跑一张。
const requestedKey = parseTableArg();
const selectedTables = requestedKey ? [resolveTable(requestedKey)] : resolveAllTables();

const lockPath = path.join(root, 'state', 'run.lock');
const runsDir = path.join(root, 'state', 'runs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pad = (n) => String(n).padStart(2, '0');
const cnDate = (date = new Date()) => {
  const d = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
const cnStampForFile = (date = new Date()) => {
  const d = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
};
const cnStamp = (date = new Date()) => {
  const d = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};
const parseCnStamp = (value) => {
  if (!value || typeof value !== 'string') return null;
  const match = value.match(/^(20\d\d)-(\d\d)-(\d\d)\s+(\d\d):(\d\d)$/);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]) - 8, Number(match[5])));
};
const batchWindow = (() => {
  const nowCn = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const slot = Math.floor(nowCn.getUTCHours() / batchIntervalHours) * batchIntervalHours;
  const start = new Date(Date.UTC(nowCn.getUTCFullYear(), nowCn.getUTCMonth(), nowCn.getUTCDate(), slot - 8, 0, 0));
  const end = new Date(start.getTime() + batchIntervalHours * 60 * 60 * 1000);
  const previousStart = new Date(start.getTime() - batchIntervalHours * 60 * 60 * 1000);
  const previousSlotCn = new Date(previousStart.getTime() + 8 * 60 * 60 * 1000);
  return {
    start,
    end,
    previousStart,
    label: `${cnDate(start)}-${pad(slot)}时批次`,
    previousLabel: `${previousSlotCn.getUTCFullYear()}-${pad(previousSlotCn.getUTCMonth() + 1)}-${pad(previousSlotCn.getUTCDate())}-${pad(previousSlotCn.getUTCHours())}时批次`
  };
})();
const batchNo = batchWindow.label;
const runId = `${cnStampForFile()}-${process.pid}`;
const reportPath = path.join(runsDir, `${runId}.json`);
const report = {
  runId,
  batchNo,
  startedAt: new Date().toISOString(),
  // config/tables.json 是唯一表定义源；这里只记摘要，不复制全量字段。
  // 注意：tableResults 才是"每张表的执行结果"，最终会把 status 合并回本数组，
  // 保证任何读取方写 `${t.key}:${t.status}` 都不会拿到 undefined（Bug7）。
  tables: selectedTables.map((t) => ({ key: t.key, label: t.label, baseToken: t.baseToken, tableId: t.tableId, activeDir: t.activeDir })),
  batchIntervalHours,
  transcriptWaitMinutes,
  batchWindow: {
    start: cnStamp(batchWindow.start),
    end: cnStamp(batchWindow.end),
    previousBatch: batchWindow.previousLabel
  },
  stages: [],
  phases: [],
  tableResults: [],
  // D2（2026-09-27）：顶层 stageErrors 恒为数组，任何新记录都必须带它。
  //   每个失败 stage 追加一条 { tableKey, phase, stage, exitCode, timedOut,
  //   error, startedAt, finishedAt, kind, affectsStatus }；
  //   顶层 error 只表示批次级致命错误，不代替 stageErrors。
  stageErrors: [],
  status: 'running'
};
const validateOnly = process.argv.includes('--validate-only');
const allExistingMode = process.argv.includes('--all-existing');
report.mode = validateOnly ? 'validate-only' : (allExistingMode ? 'all-existing' : 'scheduled');
writeLastRun({
  runId,
  start: report.startedAt,
  end: null,
  exitCode: null,
  status: 'running',
  needsBaiduLogin: false,
  needsFeishuLogin: false,
  errorSummary: null
});

// ============================================================================
// §唯一入口加固（2026-09-17）：只有计划任务 wrapper 才能触发真实业务写入
// ----------------------------------------------------------------------------
// 背景：2026-09-17 14:10 出现过一次"绕过计划任务的直拉运行"——在 Codex 窗口里
//   直接 `& $node scripts\run-baidu-feishu-batch.mjs`，完整跑完 18 个 stage。
//   而计划任务 LastRunTime 仍停在 12:00、scheduler\logs 下也没有对应的 wrapper
//   日志 → 唯一入口形同虚设，且事后归因极其昂贵。
// 机制：**普通命令行参数太容易被任何进程伪造**，所以不用参数做凭据，改用环境变量——
//   wrapper 在启动 runner 前设置 BAIDU_FEISHU_SCHEDULED_RUN=1（见同目录 wrapper 铁律）。
// 语义：
//   · 变量=1         → 正常跑（计划任务路径）；
//   · --validate-only → 放行（纯只读：只校验字段/表可达，不写任何业务数据）；
//   · 其余一切调用    → 输出 MANUAL_PRODUCTION_RUN_BLOCKED 并 exit(3)。
//     不抢 run.lock、不跑任何 stage、不调飞书、不碰 9223、不动百度文件。
// ⚠️ 这是"调度方凭据"而非密码学认证：能拿到本机 shell 且刻意设该变量的调用方仍可绕过。
//    它的目标是消灭"无意识/顺手的直拉"（14:10 那类）。更强方案（wrapper 写入一次性
//    令牌文件 + runner 校验并消费）需要受监督实跑，暂未实施。
// ============================================================================
const SCHEDULED_RUN_ENV = 'BAIDU_FEISHU_SCHEDULED_RUN';
const scheduledRunToken = process.env[SCHEDULED_RUN_ENV];
const scheduledRunAllowed = scheduledRunToken === '1';

if (!validateOnly && !scheduledRunAllowed) {
  // 归因信息尽力而为：父进程命令行是 14:10 事故里最难拿到的证据，这里直接落盘。
  let parentCommandLine = null;
  try {
    const { spawnSync } = await import('node:child_process');
    if (process.platform === 'win32') {
      const probe = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${process.ppid}").CommandLine`],
        { encoding: 'utf8', timeout: 8000, windowsHide: true }
      );
      if (probe.status === 0 && probe.stdout) parentCommandLine = String(probe.stdout).trim().slice(0, 800);
    } else {
      try {
        const raw = fsSync.readFileSync(`/proc/${process.ppid}/cmdline`, 'utf8');
        parentCommandLine = raw.replace(/\u0000/g, ' ').trim().slice(0, 800);
      } catch { /* 取不到就算了 */ }
    }
  } catch { /* 取不到就算了，绝不因此放过拦截 */ }

  const blockRecord = {
    event: 'MANUAL_PRODUCTION_RUN_BLOCKED',
    at: new Date().toISOString(),
    atLocal: cnStamp(),
    pid: process.pid,
    ppid: process.ppid,
    parentCommandLine,
    cwd: root,
    args: process.argv.slice(2),
    envVarName: SCHEDULED_RUN_ENV,
    envVarValueSeen: scheduledRunToken === undefined ? '(unset)' : JSON.stringify(scheduledRunToken),
    allowedPaths: ['计划任务 wrapper（自动设置 ' + SCHEDULED_RUN_ENV + '=1）', '--validate-only 只读检查'],
    note: '已拒绝真实业务写入。未抢锁、未启动任何 stage、未调用飞书、未访问百度页面。'
  };
  console.error('MANUAL_PRODUCTION_RUN_BLOCKED');
  console.error(JSON.stringify(blockRecord, null, 2));

  // 本地审计留痕：只写 state/ 根目录，**不写 state/runs/**，避免被巡检自动化误读成一轮业务运行。
  try {
    await fs.mkdir('state', { recursive: true });
    await fs.appendFile('state/manual-production-run-blocked.log', `${JSON.stringify(blockRecord)}\n`, 'utf8');
  } catch { /* 审计写失败也不得放行 */ }

  process.exit(3);
}

// 本轮触发方（诚实记录，替代不可信的 report.mode：mode 恒为 scheduled/all-existing，
// 无法区分"计划任务"与"有人设了环境变量"。判别真实触发方见 SKILL 规则 30b 三查法）。
report.trigger = scheduledRunAllowed ? 'scheduled-wrapper-env' : 'validate-only';

const writeReport = async () => {
  await fs.mkdir(runsDir, { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
};

const readJsonIfExists = async (file) => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
};

// 同一 4 小时档位只允许一个成功的自然生产批次。
// 计划任务自身已经配置 IgnoreNew，但历史上仍出现过同一 batchNo 被多个
// wrapper/窗口重复拉起的情况；这些重复运行会重复写回、重复上报，并放大
// 浏览器与百度接口的竞态。这里在抢锁和任何业务副作用前做第二道幂等闸门。
const findCompletedSameSlot = async () => {
  let names = [];
  try {
    names = (await fs.readdir(runsDir)).filter((name) => name.endsWith('.json'));
  } catch {
    return null;
  }
  const matches = [];
  for (const name of names) {
    const file = path.join(runsDir, name);
    const data = await readJsonIfExists(file);
    if (!data || data.runId === runId) continue;
    if (data.batchNo !== batchNo || data.status !== 'complete' || data.trigger !== 'scheduled-wrapper-env') continue;
    if (Array.isArray(data.stageErrors) && data.stageErrors.length > 0) continue;
    if (!data.finishedAt) continue;
    matches.push({ runId: data.runId, file, finishedAt: data.finishedAt });
  }
  return matches.sort((a, b) => String(a.finishedAt).localeCompare(String(b.finishedAt)))[0] || null;
};

// 飞书字段校验/读表统一走带重试的公共出口：临时网络错误
// （800100001 / 800004014 / THRIFT_EGRESS / remote or network error / ECONNRESET …）
// 会在原地重试 2s/5s/10s/20s（+抖动），不再让一次出口抖动把整轮批次打成 failed。
import { runLarkCliJson } from './lark-cli-utils.mjs';

// 三表字段名一致（各 61 列），但仍是"列名驱动"写入：任一列被删/改名，阶段脚本都会静默写空。
// 因此每张表都按 tables.json 的 requiredFields + 该表 videoLinkField 逐列校验。
// 注意：不做 ID 校验 —— 阶段脚本全部按列名读写，列名存在才是真正的前提。
const validateFeishuFields = async (table) => {
  const result = runLarkCliJson([
    'base', '+field-list',
    '--base-token', table.baseToken,
    '--table-id', table.tableId,
    '--limit', '200',
    '--as', 'user',
    '--format', 'json'
  ]);
  const fields = result.data?.fields || [];
  const present = new Set(fields.map((field) => field.name));
  const required = [...table.requiredFields, table.videoLinkField];
  const missing = required.filter((name) => !present.has(name));
  return { key: table.key, label: table.label, fieldCount: fields.length, requiredCount: required.length, missing };
};

// A lock is safe to take over when its holder process is dead, or its heartbeat
// has gone quiet for longer than this window — i.e. the holder is hung even if
// still alive. This prevents a hard-killed/hung run from leaving a "fresh" lock
// that silently skips every future run for up to LOCK_TTL_MINUTES.
const LOCK_HEARTBEAT_STALE_MS = 10 * 60 * 1000;

const isPidAlive = (pid) => {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
};

// Bug8：把"status=running 但进程与锁都已消失"的历史中断报告收敛为 aborted。
// 否则监控会一直以为流程还在跑（实测 state/runs/20260910-233335-5604.json 就是这种）。
// 保守原则：只处理①不是本轮自己 ②没有新鲜锁指向它 ③报告本身也已超过锁 TTL 的记录。
const sweepStaleRunningReports = async () => {
  const lock = await readJsonIfExists(lockPath);
  const lockHeldBySomeoneLive = Boolean(lock?.pid) && isPidAlive(lock.pid);
  let files = [];
  try {
    files = (await fs.readdir(runsDir)).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const swept = [];
  for (const name of files) {
    const file = path.join(runsDir, name);
    const data = await readJsonIfExists(file);
    if (!data || data.status !== 'running') continue;
    if (data.runId === runId) continue;
    if (lockHeldBySomeoneLive && lock?.runId === data.runId) continue;
    const stat = await fs.stat(file).catch(() => null);
    const ageMs = stat ? Date.now() - stat.mtimeMs : Number.POSITIVE_INFINITY;
    if (ageMs < LOCK_HEARTBEAT_STALE_MS) continue;
    const pidFromRunId = /-(\d+)$/.test(String(data.runId || '')) ? Number(String(data.runId).match(/-(\d+)$/)[1]) : null;
    if (pidFromRunId && isPidAlive(pidFromRunId)) continue;
    // D2 兼容红线：历史 run.json 绝不补写 stageErrors，也不得据此判成成功。
    // 这里只收敛 status，旧记录读取方须按 legacy/no-stageErrors 显示。
    data.status = 'aborted';
    data.abortReason = '进程/锁已不存在，历史中断报告自动收敛（Bug8，2026-09-11）';
    data.abortedAt = new Date().toISOString();
    await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
    swept.push(name);
  }
  return swept;
};

const acquireLock = async () => {
  await fs.mkdir('state', { recursive: true });
  const existing = await readJsonIfExists(lockPath);
  const now = Date.now();
  if (existing?.startedAt) {
    const ageMs = now - new Date(existing.heartbeatAt || existing.startedAt).getTime();
    const alive = existing.pid ? isPidAlive(existing.pid) : false;
    const frozen = !alive || ageMs >= LOCK_HEARTBEAT_STALE_MS;
    if (!frozen) {
      throw new Error(`Another run owns the fresh lock: ${JSON.stringify(existing)}`);
    }
    console.log(JSON.stringify({ event: 'lock_override', reason: !alive ? 'pid_dead' : 'heartbeat_stale', ageMs, oldPid: existing.pid }));
  }
  const lock = { runId, batchNo, pid: process.pid, startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() };
  await fs.writeFile(lockPath, JSON.stringify(lock, null, 2), 'utf8');
};

const refreshLock = async () => {
  const lock = await readJsonIfExists(lockPath);
  if (lock?.runId !== runId) throw new Error(`Run lock was taken by another process: ${JSON.stringify(lock)}`);
  lock.heartbeatAt = new Date().toISOString();
  await fs.writeFile(lockPath, JSON.stringify(lock, null, 2), 'utf8');
};

// 2026-09-12 修复：旧实现把删除失败静默吞掉（调用处还有 .catch(() => null)），
// 实测 run 20260912-005706-14972 正常 complete 后 state/run.lock 仍留在磁盘上、
// 心跳冻结在最后一拍，事后完全无法判断"锁到底释放没释放"。
// 删除本身不致命 —— 下一次 acquireLock 会按 pid_dead / heartbeat_stale 自动接管 ——
// 但"锁没释放"这件事必须留痕，否则每次都要靠 mtime 反推。这里改成失败重试一次 + 显式日志。
const releaseLock = async () => {
  const lock = await readJsonIfExists(lockPath);
  if (!lock) return;
  if (lock.runId !== runId) {
    console.log(JSON.stringify({ event: 'lock_release_skipped', reason: 'owned_by_another_run', lockRunId: lock.runId, lockPid: lock.pid }));
    return;
  }
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await fs.rm(lockPath, { force: true });
      if (attempt > 1) console.log(JSON.stringify({ event: 'lock_released', runId, attempt }));
      return;
    } catch (error) {
      // Windows 上偶发 EPERM/EBUSY（杀软或另一进程瞬时占用句柄），等 500ms 重试一次。
      if (attempt === 2) {
        console.log(JSON.stringify({ event: 'lock_release_failed', runId, code: error.code, message: error.message, note: '下一次 acquireLock 会按 pid_dead/heartbeat_stale 自动接管，无需手动删锁' }));
        return;
      }
      await sleep(500);
    }
  }
};

// 另一套锁：sweep_waiting.mjs 用的是 gen-work/.run.lock（pid+心跳）。两套锁文件名不同，
// 若只看本目录的 state/run.lock，sweep 正在跑时本入口会照样启动，两边同时操作同一个
// 9223 Chrome（各自还会关页面），轻则互相打断，重则把对方的产物当成自己的。
// 2026-09-10 起 zed 已归本入口、sweep 只管 jiang/yichen，但浏览器是同一个，仍需让位。
// 规则：对方 pid 活着且心跳新鲜 → 让位（不抢、不删锁）；心跳超时才视为卡死可继续。
const SWEEP_LOCK_STALE_MS = 10 * 60 * 1000;
const checkSweepLock = async () => {
  const lock = await readJsonIfExists(SWEEP_LOCK_PATH);
  if (!lock?.pid) return { held: false };
  const alive = isPidAlive(lock.pid);
  const last = Date.parse(lock.heartbeatAt || lock.at || '') || 0;
  const ageMs = last ? Date.now() - last : Number.POSITIVE_INFINITY;
  const held = alive && ageMs < SWEEP_LOCK_STALE_MS;
  return { held, pid: lock.pid, ageMs, alive };
};

const runCommand = async (name, args, { allowExitCodes = [0], reportFile = null, timeoutMs = 20 * 60 * 1000 } = {}) => {
  await refreshLock();
  if (reportFile) await fs.rm(reportFile, { force: true }).catch(() => null);
  const startedAt = new Date().toISOString();
  const stage = { name, args, startedAt, exitCode: null, timedOut: false, timeoutMs, stdoutTail: '', stderrTail: '' };
  report.stages.push(stage);
  await writeReport();

  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, BATCH_NO: batchNo },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32'
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => {
    const text = data.toString();
    stdout += text;
    process.stdout.write(text);
  });
  child.stderr.on('data', (data) => {
    const text = data.toString();
    stderr += text;
    process.stderr.write(text);
  });
  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      stage.timedOut = true;
      // Windows 的 child.kill() 只保证处理当前句柄，阶段脚本创建的
      // CDP/Node 子孙进程可能继续占用 9223。只杀本阶段自己的进程树。
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  stage.exitCode = exitCode;
  stage.finishedAt = new Date().toISOString();
  stage.stdoutTail = stdout.slice(-4000);
  stage.stderrTail = stderr.slice(-4000);
  if (reportFile) stage.report = await readJsonIfExists(reportFile);
  await writeReport();

  // ── D2：统一把 stage 失败写进顶层 stageErrors ──────────────────
  //   · 超时 → kind=timeout，timedOut=true（第 6 条）
  //   · 退出码不在 allowExitCodes → kind=failed（第 7 条：非 0 必留痕）
  //   · 退出码非 0 但在 allowExitCodes（例如 stage 空目标 exit 2）→ 只留痕不改判状态，
  //     避免把"正常放行"的 exit 2 打成批次失败（kind=allowedNonzero）
  const failedByExitCode = !allowExitCodes.includes(exitCode);
  const failed = stage.timedOut || failedByExitCode;
  if (failed || (exitCode !== 0 && allowExitCodes.includes(exitCode))) {
    pushStageError(report, {
      name,
      exitCode,
      timedOut: stage.timedOut,
      error: stage.timedOut
        ? `stage timed out after ${timeoutMs}ms（已被 taskkill /T /F 终止进程树）`
        : (failedByExitCode ? `exit code ${exitCode} 不在 allowExitCodes ${JSON.stringify(allowExitCodes)} 内` : `exit code ${exitCode} 非 0，但在 allowExitCodes 内，已放行`),
      startedAt: stage.startedAt,
      finishedAt: stage.finishedAt,
      allowExitCodes,
      kind: stage.timedOut ? 'timeout' : (failedByExitCode ? 'failed' : 'allowedNonzero')
    });
    await writeReport();
  }
  if (failed) {
    throw new Error(`${name} failed with exit code ${exitCode}${stage.timedOut ? ` (timed out after ${timeoutMs}ms)` : ''}`);
  }
  return stage;
};

// 按表读取飞书行。列为"列名"传入，三表通用。
const loadRecords = (table) => {
  const fields = [
    '录屏名称', '所属批次', '批次号', '最终结果', '移动状态', '直播稿doc', '文稿链接',
    '状态', '文稿状态', '返工次数', '点击导出结果', '点击导出备注', '异常备注',
    '文稿分享结果', 'doc上传结果', '移动结果'
  ];
  const result = listAllRecords({
    cli,
    baseToken: table.baseToken,
    tableId: table.tableId,
    fieldIds: fields,
    identity: 'user'
  });
  const recordIds = result.data?.record_id_list || [];
  const rows = result.data?.data || [];
  const index = Object.fromEntries((result.data?.fields || fields).map((field, i) => [field, i]));
  const cell = (row, field) => row[index[field]];
  const statusValue = (value) => Array.isArray(value) ? value[0] : value;
  return rows.map((row, i) => ({
    recordId: recordIds[i],
    name: cell(row, '录屏名称'),
    owningBatch: cell(row, '所属批次') || cell(row, '批次号'),
    finalResult: cell(row, '最终结果'),
    moveStatus: cell(row, '移动状态'),
    hasDocAttachment: Array.isArray(cell(row, '直播稿doc')) && cell(row, '直播稿doc').length > 0,
    transcriptUrl: cell(row, '文稿链接'),
    status: statusValue(cell(row, '状态')),
    docState: statusValue(cell(row, '文稿状态')),
    reworkCount: Number(cell(row, '返工次数') || 0),
    exportResult: cell(row, '点击导出结果'),
    exportNote: cell(row, '点击导出备注'),
    abnormalNote: cell(row, '异常备注'),
    docShareResult: cell(row, '文稿分享结果'),
    docUploadResult: cell(row, 'doc上传结果'),
    moveResult: cell(row, '移动结果')
  })).filter((record) => record.name);
};

const isComplete = (record) =>
  record.finalResult === '完成' ||
  (record.status === '已移动完成' && record.moveStatus === '已移动' && record.hasDocAttachment);

const isTerminalSkip = (record) => record.status === '已作废';
// 达到无文稿标签上限后，stage2 已明确写入“挂起待人工确认”。
// 这类记录不能再被每轮自动返工重复消耗名额，人工确认/解除挂起后才重新进入队列。
const isManualHold = (record) =>
  ['no_wengao_tab_or_no_doc', 'generating'].includes(record.docState) &&
  /挂起待人工确认|不得直接判|作废前置证据|自动重试上限|生成中.*人工确认/.test(`${record.exportNote || ''}\n${record.abnormalNote || ''}`);
const needsConvergence = (record) =>
  !isComplete(record) &&
  !isTerminalSkip(record) &&
  (
    record.hasDocAttachment ||
    Boolean(record.transcriptUrl) ||
    record.docState === 'has_doc' ||
    record.exportResult === '成功' ||
    record.docShareResult === '成功' ||
    record.docUploadResult === '成功'
  );

const writePhaseTargets = async (table, { phaseLabel, rework, videos, records = [] }) => {
  const targetNames = videos.map((video) => video.name);
  const owningBatchByName = Object.fromEntries(records.map((record) => [record.name, record.owningBatch || batchNo]));
  const reworkCountByName = Object.fromEntries(records.map((record) => [record.name, record.reworkCount || 0]));
  await fs.writeFile(table.statePath('deep-scan-baidu-videos.json'), JSON.stringify({
    checkedAt: new Date().toISOString(),
    tableKey: table.key,
    phaseLabel,
    count: videos.length,
    videos
  }, null, 2), 'utf8');
  await fs.writeFile(table.statePath('current-phase-targets.json'), JSON.stringify({
    checkedAt: new Date().toISOString(),
    tableKey: table.key,
    batchNo,
    phaseLabel,
    rework,
    targetNames,
    owningBatchByName,
    reworkCountByName
  }, null, 2), 'utf8');
};

// ───────────────────────── 阶段对象与执行器 ─────────────────────────
// phase 记录统一带 key 与 tableKey（Bug7）：任何读取方写 `${p.key}` 都不会是 undefined。
const makePhaseEntry = (table, { phaseLabel, rework, convergence = false, videos, records = [] }) => ({
  table,
  phaseLabel,
  rework,
  convergence,
  videos,
  records,
  processed: 0,
  stage1: null,
  phase: {
    key: table.key,
    tableKey: table.key,
    phaseLabel,
    rework,
    convergence,
    targetCount: videos.length,
    targetNames: videos.map((video) => video.name),
    stages: [],
    status: 'pending'
  }
});

const runStageSafely = async (label, args, opts) => {
  try {
    return await runCommand(label, args, opts);
  } catch (error) {
    // 单阶段崩溃不能中断整批：记录后跳过该阶段下游，外层继续。
    // runCommand 在 throw 之前已经把 stdoutTail/stderrTail 写进了 report.stages 里的那条记录，
    // 这里把它捞回来，避免崩溃存根只剩一行 error，导致事后无法定位（例如 lark 800030005）。
    // 注意：被 SIGKILL 的 stage（超时）exitCode 也是 null，所以不能用
    // "exitCode !== null" 当筛选条件，否则超时崩溃照样丢掉取证明细。
    // 直接按 name 取最后一条记录即可（runCommand 是先 push 再把同一对象补全的）。
    const raw = [...(report.stages || [])].reverse().find((s) => s.name === label);
    // D2：runCommand 在正常路径（超时/退出码非允许值）已经写过 stageErrors；
    // 这里只补"命令根本没跑起来就抛异常"的情况，避免同一 stage 记两条。
    const already = (report.stageErrors || []).some(
      (item) => item.name === label && (raw?.startedAt ? item.startedAt === raw.startedAt : item.startedAt === null)
    );
    if (!already) {
      pushStageError(report, {
        name: label,
        exitCode: raw?.exitCode ?? null,
        timedOut: Boolean(raw?.timedOut),
        error: error.message,
        startedAt: raw?.startedAt || null,
        finishedAt: raw?.finishedAt || null,
        kind: raw?.timedOut ? 'timeout' : 'crash'
      });
    }
    report.status = 'complete-with-errors';
    return {
      name: label,
      args,
      exitCode: raw?.exitCode ?? null,
      crashed: true,
      error: error.message,
      startedAt: raw?.startedAt,
      finishedAt: raw?.finishedAt,
      timedOut: raw?.timedOut,
      timeoutMs: raw?.timeoutMs,
      stdoutTail: raw?.stdoutTail || '',
      stderrTail: raw?.stderrTail || ''
    };
  }
};

// 阶段超时必须按目标数线性放大，不能钉死 20 分钟。
// 实测（2026-09-11 20时批次）：stage1 ≈21s/视频、stage2 ≈37s/视频。
// 固定 20 分钟会把 50+ 目标的阶段直接 SIGKILL —— 51 条新视频的 stage2 需要约 31 分钟，
// 结果整段下游（stage3/3b/4/5）被跳过，行次全部卡回「下一轮重新执行」。
const STAGE_BUDGET_MS = {
  stage1: 45 * 1000,
  stage2: 60 * 1000,
  stage3: 15 * 1000,
  stage3b: 30 * 1000,
  stage4: 15 * 1000,
  stage5: 15 * 1000,
  stage6: 10 * 1000
};
const STAGE_TIMEOUT_FLOOR_MS = 20 * 60 * 1000; // 小阶段仍给足 20 分钟
const STAGE_TIMEOUT_CAP_MS = 150 * 60 * 1000;  // 再大也不能超过 2.5 小时，避免真挂死拖住整批
// 历史返工不能吞掉整轮：新视频必须先得到一次完整处理机会；旧 pending 每表每轮限量，
// 剩余项目保持「下一轮重新执行」，由后续自然批次继续接力。
const MAX_HISTORY_REWORK_PER_TABLE = 30;
// 已被误标为 has_doc、但链接和附件尚未落表的行，不需要再点一次文稿；
// 先走下游收敛。每表每轮最多 30 条，避免一次下游上传超过计划任务 6 小时上限。
const MAX_CONVERGENCE_RECONCILE_PER_TABLE = 30;
// 达到 no_wengao_tab 上限后不能自动作废，但也不能永久饿死：每表每个自然批次
// 只取 5 条做低频复核，按返工次数轮转。若百度恢复了文稿页，就继续正常下游；
// 若仍没有文稿页，stage2 继续保留人工挂起，绝不把“无文稿页”当成视频损坏。
const MAX_MANUAL_HOLD_RECHECK_PER_TABLE = 5;
const stageTimeoutMs = (name, count) => {
  const budget = STAGE_BUDGET_MS[name] || 30 * 1000;
  const need = Math.ceil(Math.max(count, 1) * budget) + 5 * 60 * 1000; // 固定余量
  return Math.min(STAGE_TIMEOUT_CAP_MS, Math.max(STAGE_TIMEOUT_FLOOR_MS, need));
};

// 阶段间读取飞书前必须等一等：飞书是"写后一段时间才可见"，规则是 ≥28 秒。
// 这里取 30 秒，只在上一阶段确实产生了新数据时才等。
const FEISHU_SETTLE_MS = 30 * 1000;

// 只跑 stage1（点文稿 + 分享视频）。目标文件必须先写，因为 stage1 依赖它过滤。
const runPhaseStage1Only = async (entry) => {
  const { table, phaseLabel, rework, videos, records } = entry;
  await writePhaseTargets(table, { phaseLabel, rework, videos, records });
  const stage1 = await runStageSafely(
    `${table.key}:${phaseLabel}:stage1`,
    ['scripts/stage1-click-wengao-all.mjs', '--use-deep-scan', `--table=${table.key}`],
    { allowExitCodes: [0, 2], reportFile: table.statePath('stage1-report.json'), timeoutMs: stageTimeoutMs('stage1', videos.length) }
  );
  entry.stage1 = stage1;
  entry.phase.stages.push(stage1);
  entry.processed = stage1.report?.processed?.length || 0;
  entry.phase.stage1Processed = entry.processed;
  entry.phase.status = stage1.crashed ? 'stage1-crashed' : 'stage1-done';
  await writeReport();
  return entry;
};

// 跑某个阶段的下游（stage2→3→3b→4→5；收敛阶段跳过 stage2）。
// 关键：必须重新写一次目标文件 —— stage2/3/4/5 用 deep-scan-baidu-videos.json 做名字过滤，
// stage3b 用 current-phase-targets.json；不重写就会被别的阶段覆盖，导致串阶段。
const runPhaseDownstream = async (entry) => {
  const { table, phaseLabel, rework, convergence, videos, records } = entry;
  if (entry.stage1?.crashed) {
    entry.phase.stageErrors = entry.phase.stages.filter((s) => s.crashed).length;
    entry.phase.status = 'skipped-stage1-crashed';
    await writeReport();
    return entry;
  }
  await writePhaseTargets(table, { phaseLabel, rework, videos, records });
  const stagePlan = [
    ...(convergence ? [] : [['stage2', 'scripts/stage2-export-ready-transcripts.mjs', table.statePath('stage2-report.json')]]),
    ['stage3', 'scripts/stage3-share-exported-docs-api.mjs', table.statePath('stage3-api-report.json')],
    ['stage3b', 'scripts/stage3b-download-shared-docs-local.mjs', table.statePath('stage3b-download-report.json')],
    ['stage4', 'scripts/stage4-move-completed-files.mjs', table.statePath('stage4-report.json')],
    ['stage5', 'scripts/stage5-move-void-files.mjs', table.statePath('stage5-void-report.json')],
    ['stage6', 'scripts/stage6-clean-source-residue.mjs', table.statePath('stage6-source-residue-report.json')]
  ];
  for (const [name, script, reportFile] of stagePlan) {
    const stage = await runStageSafely(
      `${table.key}:${phaseLabel}:${name}`,
      [script, `--table=${table.key}`],
      { allowExitCodes: [0, 2], reportFile, timeoutMs: stageTimeoutMs(name, videos.length) }
    );
    entry.phase.stages.push(stage);
    if (stage.crashed) break;
    // ── 阶段间"写后可见"等待（关键时序修复）────────────────────────────
    // stage2 的产出（导出请求已提交，待百度目录实物核验）和 stage3 的产出（文稿链接）都是给
    // 下游当**输入**的飞书字段。stage2 不再伪造「导出成功」；stage3 只有在源目录确认同名
    // doc 后才写成功。这里仍须等待飞书写后可见，否则 stage3 会读不到刚提交的导出请求。
    // 只在真的产生了新数据时才等，避免空阶段也白等 30 秒。
    const producedNewData =
      (name === 'stage2' && ((stage.report?.exportRequested?.length || 0) > 0 || (stage.report?.exported?.length || 0) > 0)) ||
      (name === 'stage3' && (stage.report?.shared?.length || 0) > 0);
    if (producedNewData) await sleep(FEISHU_SETTLE_MS);
  }
  entry.phase.stageErrors = entry.phase.stages.filter((s) => s.crashed).length;
  entry.phase.status = entry.phase.stageErrors ? 'complete-with-errors' : 'complete';
  await writeReport();
  return entry;
};

const scanVideosInCurrentWindow = (videos) => videos.filter((video) => {
  const modified = parseCnStamp(video.modified);
  return modified && modified >= batchWindow.start && modified < batchWindow.end;
});

// ① 扫描 + 一次性算好各阶段目标集合
const prepareTable = async (table) => {
  const result = { key: table.key, label: table.label, status: 'running', phases: [] };
  report.tableResults.push(result);
  await fs.mkdir(table.stateDir, { recursive: true });

  await runCommand(`${table.key}:api-scan-baidu-videos`, ['scripts/api-scan-baidu-videos.mjs', `--table=${table.key}`], {
    allowExitCodes: [0, 3221226505],
    reportFile: table.statePath('deep-scan-baidu-videos.json'),
    timeoutMs: 90 * 1000
  });
  const fullScan = await readJsonIfExists(table.statePath('deep-scan-baidu-videos.json'));
  const fullVideos = fullScan?.videos || [];
  result.fullScanCount = fullVideos.length;

  const records = loadRecords(table);
  const recordsByName = new Map(records.map((record) => [record.name, record]));
  const fullByName = new Map(fullVideos.map((video) => [video.name, video]));
  const generatingWatch = await readJsonIfExists(table.statePath('generating-watch.json')) || {};
  const noWengaoWatch = await readJsonIfExists(table.statePath('no-wengao-watch.json')) || {};
  const manualHoldWatch = { ...noWengaoWatch, ...generatingWatch };
  const terminalGeneratingNames = new Set(Object.entries(generatingWatch)
    .filter(([, item]) => item?.terminal === true)
    .map(([name]) => name));
  const isHeldRecord = (record) => isManualHold(record) || terminalGeneratingNames.has(record.name);
  const currentWindowVideos = scanVideosInCurrentWindow(fullVideos);
  // P2: local processed fs_id cache as a fast skip (in addition to Feishu record check).
  const processedFsIds = new Set(Object.keys(await readJsonIfExists(table.statePath('processed-fsids.json')) || {}));

  // ── Bug1：第一阶段候选 = 源目录内所有 mp4，只要飞书没有同名记录且未被 processedFsIds 跳过。
  // 不再用"当前 4 小时窗口"把它们排除 —— 否则"上一轮开始后上传、下一轮已跨窗口"的视频
  // 永远进不了第一阶段，doc 也就永远进不了多维表。时间窗口只用于批次号/批次阶段/统计。
  const currentNewVideos = fullVideos.filter((video) =>
    !recordsByName.has(video.name) && !processedFsIds.has(String(video.fs_id))
  );
  const legacyVideos = [];
  const firstPhaseVideos = currentNewVideos;
  const inWindowNewVideos = currentNewVideos.filter((video) => {
    const modified = parseCnStamp(video.modified);
    return modified && modified >= batchWindow.start && modified < batchWindow.end;
  });
  const backlogVideos = currentNewVideos.filter((video) => {
    const modified = parseCnStamp(video.modified);
    return !(modified && modified >= batchWindow.start && modified < batchWindow.end);
  });
  const allExistingVideos = fullVideos.filter((video) => {
    const record = recordsByName.get(video.name);
    return !record || (!isComplete(record) && !isTerminalSkip(record) && !isHeldRecord(record));
  });
  const allExistingRecords = allExistingVideos.map((video) => recordsByName.get(video.name)).filter(Boolean);

  result.selection = {
    fullScanCount: fullVideos.length,
    currentWindowCount: currentWindowVideos.length,
    currentNewCount: currentNewVideos.length,
    inWindowNewCount: inWindowNewVideos.length,
    backlogCount: backlogVideos.length,
    legacyCount: legacyVideos.length,
    backlogNames: backlogVideos.map((video) => video.name),
    currentNewNames: currentNewVideos.map((video) => video.name),
    allExistingTargetCount: allExistingVideos.length,
    allExistingTargetNames: allExistingVideos.map((video) => video.name)
  };
  await writeReport();

  const entries = [];
  if (allExistingMode) {
    entries.push(makePhaseEntry(table, {
      phaseLabel: '全量现有补跑',
      rework: true,
      videos: allExistingVideos,
      records: allExistingRecords
    }));
  } else {
    const halfFinishedRecords = records.filter((record) =>
      needsConvergence(record) && !isHeldRecord(record) && fullByName.has(record.name))
      .sort((a, b) => Number(b.docState === 'has_doc') - Number(a.docState === 'has_doc') ||
        Number(a.reworkCount || 0) - Number(b.reworkCount || 0))
      .slice(0, MAX_CONVERGENCE_RECONCILE_PER_TABLE);
    entries.push(makePhaseEntry(table, {
      phaseLabel: '前置阶段-半成品收敛',
      convergence: true,
      rework: true,
      videos: halfFinishedRecords.map((record) => fullByName.get(record.name)).filter(Boolean),
      records: halfFinishedRecords
    }));

    // ── 同一行不能同时进两个阶段 ─────────────────────────────────────
    // 旧实现把 halfFinishedRecords 又放进「前置阶段-下一轮重新执行」，而那个阶段会从
    // stage1 重跑，把「半成品收敛」刚刚写好的 文稿链接 / 文稿分享结果=成功 全部清回
    // 待执行（stage1 的返工重置块），成果当场作废、下一轮再分享一次。
    // 实测 2026-09-11 20时批次姜律师 王白菜律师-P002 就是这样被清掉的。
    // 现在只收敛阶段收编一次；收敛阶段如果发现 doc 根本不存在，stage3 会把
    // 点击导出结果 清回待执行，下一轮自然回到本阶段重新导出 —— 不会死循环。
    const halfFinishedNames = new Set(halfFinishedRecords.map((record) => record.name));
    const retryRecords = records.filter((record) =>
      record.status === '下一轮重新执行' &&
      !isComplete(record) &&
      !isTerminalSkip(record) &&
      !isHeldRecord(record) &&
      !halfFinishedNames.has(record.name) &&
      fullByName.has(record.name)
    ).sort((a, b) => Number(a.reworkCount || 0) - Number(b.reworkCount || 0)).slice(0, MAX_HISTORY_REWORK_PER_TABLE);
    // 新批次必须先于历史返工：此前 300+ 条旧 pending 排在前面，单轮耗尽时间后，
    // 新视频虽已入表却迟迟轮不到 stage1/stage2，造成“每天都在跑、最近视频永远没稿”。
    entries.push(makePhaseEntry(table, {
      phaseLabel: '第一阶段-本次新批次',
      rework: false,
      videos: firstPhaseVideos
    }));

    entries.push(makePhaseEntry(table, {
      phaseLabel: '前置阶段-下一轮重新执行',
      rework: true,
      videos: retryRecords.map((record) => fullByName.get(record.name)).filter(Boolean),
      records: retryRecords
    }));

    // 第二阶段-上一批返工：与「前置阶段-下一轮重新执行」在定义上有重叠，
    // 重叠部分已在 0b 从第一步重跑过一遍，这里去掉重复，避免同一视频同轮被点两次文稿、
    // 返工次数被重复 +1（Bug2 的"不重复空等"同理）。
    const retryNames = new Set(retryRecords.map((record) => record.name));
    const previousReworkRecords = records.filter((record) =>
      record.owningBatch === batchWindow.previousLabel &&
      !isComplete(record) &&
      !isTerminalSkip(record) &&
      record.status === '下一轮重新执行' &&
      fullByName.has(record.name) &&
      !isHeldRecord(record) &&
      !retryNames.has(record.name)
    ).sort((a, b) => Number(a.reworkCount || 0) - Number(b.reworkCount || 0)).slice(0, MAX_HISTORY_REWORK_PER_TABLE);
    entries.push(makePhaseEntry(table, {
      phaseLabel: '第二阶段-上一批返工',
      rework: true,
      videos: previousReworkRecords.map((record) => fullByName.get(record.name)).filter(Boolean),
      records: previousReworkRecords
    }));

    const manualHoldRecheckRecords = records.filter((record) =>
      record.status === '下一轮重新执行' &&
      isManualHold(record) &&
      fullByName.has(record.name)
    ).sort((a, b) => {
      // 公平轮转：最久没有被低频复核的挂起记录优先，避免新建的低返工次数记录
      // 长期挤掉已经挂起很久的记录（尤其是 generating 终态挂起）。
      const seenAt = (record) => {
        const watch = manualHoldWatch[record.name] || {};
        const value = watch.lastSeenAt || watch.firstSeenAt || '';
        const time = Date.parse(value);
        return Number.isFinite(time) ? time : 0;
      };
      return seenAt(a) - seenAt(b) || Number(a.reworkCount || 0) - Number(b.reworkCount || 0);
    }).slice(0, MAX_MANUAL_HOLD_RECHECK_PER_TABLE);
    entries.push(makePhaseEntry(table, {
      phaseLabel: '挂起记录-低频复核',
      rework: true,
      videos: manualHoldRecheckRecords.map((record) => fullByName.get(record.name)).filter(Boolean),
      records: manualHoldRecheckRecords
    }));
  }

  for (const entry of entries) {
    if (!entry.videos.length) {
      entry.phase.skipped = true;
      entry.phase.reason = 'no targets';
      entry.phase.status = 'skipped';
    }
    result.phases.push(entry.phase);
  }
  await writeReport();
  return { table, result, fullVideos, fullByName, recordsByName, currentNewVideos, entries };
};

const finishTable = async (plan) => {
  const { table, result, fullVideos, recordsByName } = plan;
  // P2: persist processed fs_ids so future runs can skip already-completed files without a Feishu query.
  try {
    const done = new Set(Object.keys(await readJsonIfExists(table.statePath('processed-fsids.json')) || {}));
    for (const v of fullVideos) {
      const rec = recordsByName.get(v.name);
      if (rec && isComplete(rec)) done.add(String(v.fs_id));
    }
    await fs.writeFile(table.statePath('processed-fsids.json'), JSON.stringify(Object.fromEntries([...done].map((id) => [id, new Date().toISOString()])), null, 2), 'utf8');
  } catch {}
  await fs.rm(table.statePath('current-phase-targets.json'), { force: true }).catch(() => null);
  result.phaseSummary = result.phases.map((phase) => ({
    key: table.key,
    phaseLabel: phase.phaseLabel,
    targetCount: phase.targetCount,
    stage1Processed: phase.stage1Processed || 0,
    skipped: phase.skipped || false,
    status: phase.status,
    stageErrors: (phase.stages || []).filter((s) => s.crashed).length
  }));
  // 不允许收尾阶段掩盖前面真实的阶段错误。
  // 只有本表所有阶段都没有崩溃时，单表才可报告 complete。
  const tableHadStageError = (result.phases || []).some((phase) =>
    (phase.stages || []).some((stage) => stage.crashed || stage.timedOut ||
      (stage.exitCode !== null && stage.exitCode !== undefined && ![0, 2].includes(stage.exitCode)))
  );
  result.status = tableHadStageError ? 'complete-with-errors' : 'complete';
  await writeReport();
  return result;
};

let heartbeatTimer = null;

// 同一自然档位已有成功批次时，重复调用只留本地审计，不创建新的 run.json，
// 不抢锁、不连百度、不写飞书、不发送重复执行事件。
if (!validateOnly && !allExistingMode && scheduledRunAllowed) {
  const prior = await findCompletedSameSlot();
  if (prior) {
    const event = {
      event: 'scheduled_slot_duplicate_skipped',
      at: new Date().toISOString(),
      batchNo,
      skippedRunId: runId,
      priorRunId: prior.runId,
      priorFile: prior.file,
      reason: 'same batch slot already has a complete successful scheduled run'
    };
    try {
      await fs.mkdir('state', { recursive: true });
      await fs.appendFile('state/scheduled-slot-duplicate-skipped.log', `${JSON.stringify(event)}\n`, 'utf8');
    } catch { /* 审计失败不改变安全决策 */ }
    console.log(JSON.stringify(event, null, 2));
    process.exit(0);
  }
}

try {
  await writeReport();
  // Bug8：先把历史"假 running"收敛掉，再抢锁（只读+轻写 state/runs，不碰业务数据）。
  const swept = await sweepStaleRunningReports();
  if (swept.length) {
    report.staleRunningSwept = swept;
    console.log(JSON.stringify({ event: 'stale_running_swept', files: swept }, null, 2));
  }
  await acquireLock();
  heartbeatTimer = setInterval(() => { refreshLock().catch(() => null); }, 30000);

  // ① 先校验全部选中表的字段完整性（只读，不写任何业务数据）。
  //    任一表缺列即终止本轮，避免阶段脚本静默写空。
  const fieldChecks = [];
  for (const table of selectedTables) fieldChecks.push(await validateFeishuFields(table));
  report.fieldValidation = { ok: fieldChecks.every((c) => c.missing.length === 0), tables: fieldChecks };
  await writeReport();
  const broken = fieldChecks.filter((c) => c.missing.length);
  if (broken.length) {
    throw new Error(`飞书多维表字段缺失（列被删除或表被替换）：${JSON.stringify(broken)}；表定义见 config/tables.json 的 tables[].baseToken/tableId 与 requiredFields。`);
  }

  if (validateOnly) {
    report.status = 'validated';
    // 只读模式没有逐表执行结果，但仍要让 report.tables / tableSummary 带明确状态，
    // 保证任何读取方写 `${t.key}:${t.status}` 都不会得到 undefined（Bug7）。
    report.tables = report.tables.map((t) => ({ ...t, status: 'validated', fullScanCount: null }));
    report.tableSummary = selectedTables.map((t) => ({ key: t.key, status: 'validated', fullScanCount: null }));
  } else {
    // ②-a 让位检查：sweep_waiting 正在跑就本轮退出，不抢 9223。
    const sweepLock = await checkSweepLock();
    report.sweepLock = sweepLock;
    if (sweepLock.held) {
      console.log(JSON.stringify({ event: 'yield_to_sweep', ...sweepLock, note: 'sweep_waiting 持有 gen-work/.run.lock 且心跳新鲜，本入口让位不抢浏览器。' }, null, 2));
      report.status = 'skipped-infra-busy';
      throw Object.assign(new Error(`sweep_waiting 正在运行（pid=${sweepLock.pid}，心跳 ${Math.round((sweepLock.ageMs || 0) / 1000)}s 前），本轮让位。`), { __yield: true });
    }

    // ② 基础设施先修好：CDP 半死不响应就换掉、重启专用 Chrome、校验登录。
    //    这一步失败说明是基础设施问题，绝不能被记成"视频异常"。
    // D2 第 5 条：ensure-baidu-cdp 失败必须 ①写顶层 error ②写 stageErrors
    //    ③标记百度登录/基础设施失败 ④不写视频异常 ⑤不进入后续百度写操作。
    //    这里 throw 后直接跳过 ③~⑥（扫描/点文稿/分享/移动/清理），
    //    即本轮不再有任何百度写操作。
    try {
      await runCommand('ensure-baidu-cdp', ['scripts/ensure-baidu-cdp.mjs'], { allowExitCodes: [0, 3221226505], reportFile: 'state/baidu-cdp-login-check.json', timeoutMs: 90 * 1000 });
    } catch (error) {
      const cdpCheck = await readJsonIfExists('state/baidu-cdp-login-check.json').catch(() => null);
      // 2026-10-10：失败性质必须沿用 ensure 的真实判定，不得一律写成"登录失败"。
      //   · baidu-login-infra      → 真的掉登录/扫码页（才请求扫码）
      //   · baidu-api-transient    → 页面登录态正常、接口瞬时拒绝（绝不请求扫码）
      //   · baidu-api-rejected     → 页面登录态正常、接口明确拒绝（绝不请求扫码）
      const cdpKind = cdpCheck?.failureKind || 'baidu-login-cdp';
      const cdpRequiresScan = cdpCheck?.requiresScanLogin === true;
      const entry = [...(report.stageErrors || [])].reverse().find((item) => item.name === 'ensure-baidu-cdp');
      if (entry) {
        entry.kind = 'infra';
        entry.kindLabel = '基础设施失败（百度登录/CDP/ensure-baidu-cdp）';
        entry.phase = 'infra';
        entry.stage = 'ensure-baidu-cdp';
        entry.failureKind = cdpKind;
        entry.notVideoAnomaly = true;
      } else {
        pushStageError(report, {
          name: 'ensure-baidu-cdp',
          tableKey: null,
          phase: 'infra',
          stage: 'ensure-baidu-cdp',
          exitCode: null,
          error: error.message,
          kind: 'infra'
        });
      }
      report.infrastructureFailure = {
        kind: cdpKind,
        stage: 'ensure-baidu-cdp',
        // 登录失败属于基础设施问题，绝不是视频异常
        notVideoAnomaly: true,
        message: error.message,
        checkedFile: 'state/baidu-cdp-login-check.json',
        loggedIn: cdpCheck?.loggedIn ?? null,
        hasToken: cdpCheck?.hasToken ?? null,
        loginText: cdpCheck?.loginText ?? null,
        emptyAnonymousQuota: cdpCheck?.emptyAnonymousQuota ?? null,
        apiList: cdpCheck?.apiList ?? null,
        loginScreenshotPath: cdpCheck?.loginScreenshotPath ?? null,
        failureCodes: cdpCheck?.failureCodes ?? null,
        // 2026-10-10 新增：把"是否需要扫码"和"上下文就绪证据"如实带进批次记录，
        // 免得下游把接口瞬时失败当成掉登录去催扫码。
        requiresScanLogin: cdpRequiresScan,
        apiTransient: cdpCheck?.apiTransient === true,
        contextReady: cdpCheck?.contextReady ?? null,
        apiRetryDelaysMs: cdpCheck?.apiRetryDelaysMs ?? null,
        apiAttempts: cdpCheck?.apiAttempts ?? null,
        action: cdpRequiresScan
          ? '请打开 state/baidu-login-qr.png 扫码登录；本轮已中止，不执行任何百度写操作，等待下一轮计划批次'
          : '百度接口临时拒绝/页面上下文未就绪（页面登录态正常）；本轮已中止且不请求扫码，等待下一轮计划批次自动继续'
      };
      throw Object.assign(error, { __infraFailure: true });
    }

    // ③ 三表：扫描 + 一次性算目标（先不算"第三阶段-本批返工"，它依赖本轮新建的行）。
    const plans = [];
    for (const table of selectedTables) plans.push(await prepareTable(table));

    // ③-b 前置阶段-半成品收敛：已有后续步骤证据的行先收口。不需要等待文稿，所以最先做。
    const convergenceEntries = plans.flatMap((plan) => plan.entries.filter((entry) => entry.convergence && !entry.phase.skipped));
    for (const entry of convergenceEntries) await runPhaseDownstream(entry);

    // ④ 所有"需要点文稿"的阶段：三表全部 stage1 跑完，再统一等待。
    const runnableEntries = plans.flatMap((plan) => plan.entries.filter((entry) => !entry.convergence && !entry.phase.skipped));
    const stage1Entries = [
      // 三表的本轮新视频全部先处理，避免姜律师的历史返工把意晨/Zed的新视频饿死。
      ...runnableEntries.filter((entry) => entry.phaseLabel === '第一阶段-本次新批次'),
      ...runnableEntries.filter((entry) => entry.phaseLabel !== '第一阶段-本次新批次')
    ];
    for (const entry of stage1Entries) await runPhaseStage1Only(entry);

    const totalProcessed = stage1Entries.reduce((sum, entry) => sum + (entry.processed || 0), 0);
    // ── 全局等待闸门（2026-10-11 修复）────────────────────────────────────
    // 规则（本机负责人 2026-10-11 指令第 1 条）：
    //   · 正常批次 `globalWait.rounds` 必须恒等于 1；
    //   · 「第三阶段-本批返工」不得再触发第二个 10 分钟全局等待。
    // 旧实现在下面（第一处）与第三阶段（第二处）各写一次 `rounds += 1` + `sleep(10min)`，
    // 实测 run 20261011-000002-12728 与 20261011-040002-10108 都是 `rounds:2` + `secondWait`，
    // 整批白等 20 分钟；且"第二等"等来的文稿并不能让返工行在同一批次内完成。
    // 现在等待权收敛成一次性令牌：waitForTranscripts() 一辈子只睡一次，
    // 第三阶段改用 checkOnlyImmediately()（立即检查，绝不等待），rounds 结构上不可能 > 1。
    const globalWaitGate = createGlobalWaitGate({ minutes: transcriptWaitMinutes, sleepFn: sleep });
    globalWaitGate.setStage1Processed(totalProcessed);
    report.globalWait = globalWaitGate.state();
    await writeReport();
    // 第一处（唯一一次）全局等待：三表所有需要点文稿的阶段 stage1 跑完，统一等一轮，
    // 让百度把文稿生成出来，再统一跑下游 stage2→3→3b→4→5。
    await globalWaitGate.waitForTranscripts({
      reason: '第一阶段-全部表 stage1 完成后统一等待文稿生成',
      needed: totalProcessed > 0,
      // 睡之前先把 firstWaitAt 落 run.json，保证等待期间 run.json 就能看出"正在等文稿"。
      onWaitStart: async (snapshot) => {
        report.globalWait = snapshot;
        await writeReport();
      }
    });
    report.globalWait = globalWaitGate.state();
    await writeReport();

    // ⑤ 统一跑这些阶段的下游（stage2→3→3b→4→5）。
    for (const entry of stage1Entries) await runPhaseDownstream(entry);

    // ⑥ 第三阶段-本批返工：依赖 ④ 新建的行，只能在第一轮收尾后再算。
    const roundB = [];
    for (const plan of plans) {
      const { table, fullByName, currentNewVideos } = plan;
      const firstPhaseNames = new Set(currentNewVideos.map((video) => video.name));
      const freshRecords = loadRecords(table);
      const currentReworkRecords = freshRecords.filter((record) =>
        record.owningBatch === batchNo &&
        firstPhaseNames.has(record.name) &&
        !isComplete(record) &&
        !isTerminalSkip(record) &&
        !isManualHold(record) &&
        record.status === '下一轮重新执行' &&
        fullByName.has(record.name)
      );
      if (!currentReworkRecords.length) continue;
      const entry = makePhaseEntry(table, {
        phaseLabel: '第三阶段-本批返工',
        rework: true,
        videos: currentReworkRecords.map((record) => fullByName.get(record.name)).filter(Boolean),
        records: currentReworkRecords
      });
      plan.result.phases.push(entry.phase);
      roundB.push(entry);
    }
    for (const entry of roundB) await runPhaseStage1Only(entry);
    const roundBProcessed = roundB.reduce((sum, entry) => sum + (entry.processed || 0), 0);
    // ── 第三阶段-本批返工：立即检查，不再触发第二个全局等待（2026-10-11 修复）──────
    // 旧实现在这里 `rounds += 1` + `sleep(10min)`（run.json 里的 `secondWait`）——
    // 这 10 分钟等不来任何东西：返工行是**本批刚新建**的行，百度此刻仍在生成文稿，
    // 多等 10 分钟既不能保证就绪，又让整批时长平白 +10 分钟。
    // 现在的口径（指令第 1 条）：第三阶段只允许「立即检查已就绪文稿」——
    //   · 已就绪 → 紧接着的 runPhaseDownstream(roundB) 正常导出/分享/上传/移动；
    //   · 尚未就绪 → 下游按既有规则保持 `下一轮重新执行`（不新增作废、不动文件），
    //     由**下一自然批次**的「第二阶段-上一批返工」继续处理。
    const reworkImmediate = globalWaitGate.checkOnlyImmediately({
      reason: '第三阶段-本批返工 立即检查已就绪文稿（不等待）',
      detail: { tables: roundB.length, targets: roundB.reduce((sum, e) => sum + e.videos.length, 0), stage1Processed: roundBProcessed }
    });
    report.globalWait = globalWaitGate.state();
    report.globalWait.reworkImmediateCheck = {
      at: reworkImmediate.at,
      tables: roundB.length,
      targets: roundB.reduce((sum, e) => sum + e.videos.length, 0),
      stage1Processed: roundBProcessed,
      waited: false,
      note: '第三阶段只立即检查已就绪文稿；未就绪的行保持「下一轮重新执行」，交下一自然批次。'
    };
    await writeReport();
    for (const entry of roundB) await runPhaseDownstream(entry);

    for (const plan of plans) await finishTable(plan);

    // D2 第 4 条：只要还存在影响状态的 stage 错误，就绝不写成 complete。
    report.status = decideRunStatus(report, { fatalError: false });
    // 第 1 条硬校验（2026-10-11）：全局等待轮次恒 <= 1。
    // 闸门已在结构上保证「只睡一次」，这里是**兜底留痕**：一旦有人再往编排里加第二处等待，
    // 批次绝不能被静默记成 complete（kind=failed 会影响状态，符合 D2 的第 4 条口径）。
    const globalWaitRounds = Number(report.globalWait?.rounds ?? 0);
    report.globalWait = Object.assign({}, report.globalWait || {}, {
      roundsCheck: globalWaitRounds <= 1 ? 'ROUNDS_LE_1_OK' : 'ROUNDS_GT_1_VIOLATION'
    });
    if (globalWaitRounds > 1) {
      pushStageError(report, {
        name: 'global-wait-rounds-invariant',
        tableKey: null,
        phase: 'globalWait',
        stage: 'global-wait',
        exitCode: null,
        timedOut: false,
        error: `globalWait.rounds=${globalWaitRounds}（上限 1）：编排里出现了第二处全局等待，必须修回单次等待`,
        kind: 'failed'
      });
      report.status = decideRunStatus(report, { fatalError: false });
    }
    report.stageErrorSummary = summarizeStageErrors(report);

    // Bug7：把每张表的最终 status 合并回 report.tables，保证任何读取方写
    // `${t.key}:${t.status}` 都能拿到 jiang:complete 而不是 undefined:complete。
    const byKey = new Map(report.tableResults.map((t) => [t.key, t]));
    report.tables = report.tables.map((t) => {
      const done = byKey.get(t.key);
      return { ...t, status: done?.status || 'unknown', fullScanCount: done?.fullScanCount ?? null };
    });
    report.tableSummary = report.tableResults.map((t) => ({ key: t.key, status: t.status, fullScanCount: t.fullScanCount ?? null }));
    await writeReport();
  }
} catch (error) {
  if (error.__yield) {
    // 让位不是故障：不置 failed、不置非零退出码，只在报告里留痕。
    report.status = 'skipped-infra-busy';
    report.yieldReason = error.message;
  } else {
    // D2 第 3 条：顶层 error 只表示批次级致命错误；性质写进 failureKind，
    // 基础设施失败 / 字段校验失败一律 notVideoAnomaly=true —— 绝不记成视频异常。
    const isInfra = Boolean(error.__infraFailure) || Boolean(report.infrastructureFailure);
    const isFieldValidation = Boolean(error.__fieldValidation);
    report.status = 'failed';
    report.error = error.message;
    report.failureKind = isInfra ? 'infrastructure' : (isFieldValidation ? 'field-validation' : 'batch');
    report.notVideoAnomaly = isInfra || isFieldValidation;
    if (isFieldValidation) report.fieldValidationFailed = true;
    process.exitCode = 2;
  }
} finally {
  ensureStageErrors(report);
  // keepOnlyMainPage: 整轮结束把页面收敛成"恰好一个 zed 主目录页"。
  // 旧实现把所有 /disk/main 都当主页面保护，实测跑完会留下 4 个页面（意晨/姜律师/2×zed）。
  report.cleanup = await cleanupBaiduTargets({ keepMainDisk: true, closeAllBaidu: false, keepOnlyMainPage: true }).catch((error) => ({ error: error.message }));
  // cleanup 失败属于收尾问题：必须可见，但不改判业务状态（affectsStatus=false）。
  if (report.cleanup && (report.cleanup.error || report.cleanup.ok === false)) {
    pushStageError(report, {
      name: 'cleanup-baidu-targets',
      tableKey: null,
      phase: 'cleanup',
      stage: 'cleanup-baidu-targets',
      exitCode: null,
      timedOut: false,
      error: report.cleanup.error || 'cleanupBaiduTargets 返回 ok:false',
      kind: 'cleanup'
    });
  }
  report.finishedAt = new Date().toISOString();
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  await releaseLock().catch(() => null);
  // 最终再兜一次：确保 report.tables 里永远有 key/status（Bug7）。
  if (report.tables?.length) {
    const byKey = new Map(report.tableResults.map((t) => [t.key, t]));
    report.tables = report.tables.map((t) => ({
      ...t,
      status: t.status || byKey.get(t.key)?.status || 'unknown',
      fullScanCount: t.fullScanCount ?? byKey.get(t.key)?.fullScanCount ?? null
    }));
  }
  // D2：落盘前最后刷新一次 stageErrors 摘要，保证任何读取方都能直接拿到数量口径。
  report.stageErrorSummary = summarizeStageErrors(report);

  // ── 空扫描 / 上游断供告警（2026-09-28 新增）──────────────────────────────
  // 只读判定：不写飞书业务记录、不动百度文件、**不改变 report.status**。
  // 口径：空扫描不得判失败（批次确实跑成功了），也不得被静默记为"完全正常"。
  // 背景：2026-09-23 起三源目录连续 34 轮 mp4=0、持续 5.5 天，每轮都记成
  //       exitCode=0 / complete，导致"连续零产出"在监控上完全隐身。
  try {
    const srcCounts = {};
    for (const t of (report.tableResults?.length ? report.tableResults : (report.tables || []))) {
      if (t && t.key) srcCounts[t.key] = t.fullScanCount ?? 0;
    }
    const stage1Processed = Number(report.globalWait?.stage1Processed ?? 0);
    const stageEntered = stage1Processed > 0;
    // 写回报告，供后续批次的"连续未进入 stage"规则读取
    report.stageEntered = stageEntered;

    // 本批有产出（确实处理过视频）⇒ 刷新"最近一次有产出时间"
    const lastNewPath = 'state/last-new-record-at.json';
    if (stageEntered) {
      await fs.writeFile(lastNewPath, JSON.stringify({
        at: new Date().toISOString(), runId, batchNo, stage1Processed
      }, null, 2), 'utf8');
    }
    let lastNewRecordAt = null;
    try {
      const j = JSON.parse(await fs.readFile(lastNewPath, 'utf8'));
      lastNewRecordAt = j.at || null;
    } catch { /* 文件不存在则跳过 24h 规则，绝不影响批次 */ }

    const history = await loadRecentBatchHistory({ runsDir, limit: 12 });
    const tempScan = await loadTempDirScan('state/temp-dirs-scan.json');
    const warnResult = evaluateEmptyScanWarnings({
      sourceCounts: srcCounts,
      history,
      tempCounts: tempScan?.tempCounts || null,
      oldestTempFile: tempScan?.oldestTempFile || null,
      stageEntered,
      lastNewRecordAt
    });
    report.warnings = warnResult.warnings;
    report.warningSummary = warnResult.summary;
    if (warnResult.warnings.length) {
      console.log(JSON.stringify({
        event: 'empty_scan_warning',
        runId,
        batchNo,
        ...warnResult.summary,
        warnings: warnResult.warnings
      }, null, 2));
    }
  } catch (warningError) {
    // 告警判定失败绝不能影响批次本身
    console.log(JSON.stringify({
      event: 'empty_scan_warning_failed',
      error: String(warningError?.message || warningError).slice(0, 200)
    }));
  }

  await writeReport();
  // 本机汇报出口：最终业务报告已落盘后再提交，避免把运行中/未回读结果报成完成。
  // 发送箱/dispatcher 失败只留痕，不改变生产批次退出状态。
  if (!validateOnly && report.mode !== 'validate-only') {
    const reportEvents = {};
    const businessReadback = {};
    const eventType = 'execution_result';
    const level = report.status === 'complete' ? 'INFO' : 'P1';
    // 归属（方案 B）：双工具行的 execution_result 由本机真实执行主体（baidu_batch_script）如实提交，
    // 与 review_result（chatgpt 侧独立复核）用同一 关联执行ID 配对；两端缺一即为「待验收」。
    const collectBusiness = (tableKey, phases) => {
      try {
        return readBatchBusinessResult(tableKey, phases);
      } catch (error) {
        const targetNames = [...new Set(phases.flatMap((phase) => Array.isArray(phase.targetNames) ? phase.targetNames : []).filter(Boolean))];
        return {
          tableKey,
          readbackOk: false,
          targetCount: targetNames.length,
          successCount: 0,
          failedCount: 0,
          remainingCount: targetNames.length,
          targetNames,
          completedNames: [],
          voidedNames: [],
          remainingNames: [],
          missingFromTable: [],
          error: String(error?.message || error)
        };
      }
    };
    // 先把三表业务回读全部完成并落盘，再提交任何一条事件，避免发送箱拿到半份证据。
    for (const tableKey of Object.keys(REPORT_ROWS)) {
      const table = (report.tableResults || []).find((item) => item.key === tableKey) || (report.tables || []).find((item) => item.key === tableKey) || null;
      const phases = Array.isArray(table?.phases) ? table.phases : [];
      businessReadback[tableKey] = collectBusiness(tableKey, phases);
    }
    await fs.writeFile(`state/business-readback-${runId}.json`, JSON.stringify({ checkedAt: new Date().toISOString(), runId, businessReadback }, null, 2), 'utf8');
    for (const tableKey of Object.keys(REPORT_ROWS)) {
      const table = (report.tableResults || []).find((item) => item.key === tableKey) || (report.tables || []).find((item) => item.key === tableKey) || null;
      const phases = Array.isArray(table?.phases) ? table.phases : [];
      const business = businessReadback[tableKey];
      const targetCount = business.targetCount;
      const failedCount = business.failedCount;
      const successCount = business.successCount;
      const remainingCount = business.remainingCount;
      const summary = `${tableKey} 百度网盘→飞书执行结果${report.status === 'complete' && business.readbackOk && remainingCount === 0 ? '完成' : report.status === 'complete' ? '部分完成' : report.status === 'complete-with-errors' ? '部分完成' : '失败'}：${report.batchNo}`;
      reportEvents[tableKey] = submitLocalReportEvent({
        report, tableKey, eventType, level, summary,
        detail: {
          row_record_id: REPORT_ROWS[tableKey],
          // 稳定关联执行ID：执行端(本 runner)与验收端(chatgpt 侧)靠它配对，必须与 run_id 一致；
          // report_event 对 execution_result 强制要求该字段，缺失即拒收(exit 2)。
          关联执行ID: runId,
          run_id: runId,
          batch_no: batchNo,
          项目: table?.label || tableKey,
          任务名称: '对标录屏03文稿自动化',
          执行主体: 'baidu_batch_script',
          执行触发: report.trigger,
          工具: 'baidu_batch_script',
          真实开始时间: report.startedAt,
          真实结束时间: report.finishedAt,
          目标数: targetCount,
          成功数: successCount,
          失败数: failedCount,
          剩余数: remainingCount,
          真实状态: !business.readbackOk ? '待复核' : remainingCount > 0 ? '部分完成' : report.status === 'complete' ? '完成' : report.status,
          错误原因: business.error || report.error || report.infrastructureFailure?.message || null,
          下一步: !business.readbackOk ? '业务数据回读失败，禁止宣称完成；必须先复核表格后再验收' : remainingCount > 0 ? '剩余记录保持下一轮重新执行，由后续自然批次继续' : report.status === 'complete' ? '无需补做；以业务数据回读和本报告为完成证据' : '依据 stageErrors/infrastructureFailure 在下一轮返工或人工处理',
          产物证据: reportPath,
          业务数据回读证据: `state\\business-readback-${runId}.json`,
          产物清单: [...new Set(phases.flatMap((phase) => Array.isArray(phase.targetNames) ? phase.targetNames : []))].slice(0, 200),
          产物清单是否截断: [...new Set(phases.flatMap((phase) => Array.isArray(phase.targetNames) ? phase.targetNames : []))].length > 200,
          阶段摘要: phases.map((phase) => ({
            阶段: phase.phaseLabel,
            目标数: Number(phase.targetCount || 0),
            已处理: Number(phase.stage1Processed || phase.processed || 0),
            失败数: Number(phase.stageErrors || 0),
            状态: phase.status || null
          }))
        }
      });
    }
    report.localReportEvents = reportEvents;
    await writeReport();
    // 独立复核出口：必须在真实 execution_result 落箱、最终报告落盘后执行。
    // review_result 只追加事件证据，不修改负责人主行，也由脚本显式禁止通知。
    try {
      // 复核证据只在本地生成（--dry-run）：review_result 必须由 chatgpt 工具在真实回读后
      // 自行提交（--source chatgpt）。生产脚本不得以 chatgpt 名义代提交，否则验收来源失真。
      // 当前 Windows 生产仓库不一定部署独立复核脚本；缺失时明确记为“待复核”，
      // 不再伪装成生产失败，也不让一个可选钩子制造每日错误噪声。
      if (!fsSync.existsSync(REVIEW_SCRIPT)) {
        console.log(JSON.stringify({
          event: 'review_result_deferred',
          reason: 'chatgpt_independent_review_required',
          detail: 'review-03-run.mjs 不在生产仓库；保持待复核，不由生产 runner 冒充 chatgpt 提交。'
        }));
      } else {
        const review = spawnSync(process.execPath, [REVIEW_SCRIPT, '--run-report', reportPath, '--dry-run'], {
          encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024
        });
        if (review.error || review.status !== 0) {
          console.error(JSON.stringify({ event: 'review_result_failed', error: String(review.error?.message || review.stderr || `exit=${review.status}`).slice(0, 500) }));
        } else {
          console.log(JSON.stringify({ event: 'review_result_submitted', output: String(review.stdout || '').slice(-4000) }));
        }
      }
    } catch (reviewError) {
      console.error(JSON.stringify({ event: 'review_result_failed', error: String(reviewError?.message || reviewError).slice(0, 500) }));
    }
  }
  const needsBaidu = Boolean(report.infrastructureFailure?.requiresScanLogin);
  const errorSummary = report.error
    || report.infrastructureFailure?.message
    || report.stageErrorSummary?.firstError
    || (report.status && report.status !== 'complete' ? report.status : null);
  let feishuLoginNeeded = false;
  const blob = `${report.error || ''} ${JSON.stringify(report.stageErrorSummary || {})}`;
  if (/99991663|auth|未登录|not logged in|needsFeishuLogin|lark-cli auth/i.test(blob) && /lark|feishu|飞书/i.test(blob)) {
    feishuLoginNeeded = true;
  }
  writeLastRun({
    runId,
    start: report.startedAt,
    end: report.finishedAt || new Date().toISOString(),
    exitCode: process.exitCode ?? 0,
    status: report.status,
    needsBaiduLogin: needsBaidu,
    needsFeishuLogin: feishuLoginNeeded,
    errorSummary: errorSummary ? String(errorSummary).slice(0, 500) : null,
    loginScreenshotPath: report.infrastructureFailure?.loginScreenshotPath || null
  });
  console.log(JSON.stringify({
    event: 'run_complete',
    runId,
    batchNo,
    mode: report.mode,
    stageErrors: {
      present: Array.isArray(report.stageErrors),
      count: report.stageErrorSummary.count,
      affecting: report.stageErrorSummary.affecting,
      byKind: report.stageErrorSummary.byKind
    },
    tables: (report.tableResults.length
      ? report.tableResults
      : report.tables
    ).map((t) => ({ key: t.key ?? null, status: t.status ?? 'unknown', fullScanCount: t.fullScanCount ?? null })).filter((t) => t.key),
    tableSummary: report.tableSummary || null,
    globalWait: report.globalWait || null,
    // 空扫描/断供告警：批次仍按原口径结束（status 不变），但必须留下 warning 痕迹
    warningSummary: report.warningSummary || { count: 0, byKind: {}, hasWarning: false },
    warnings: report.warnings || [],
    status: report.status,
    reportPath,
    cleanup: report.cleanup
  }, null, 2));
}
