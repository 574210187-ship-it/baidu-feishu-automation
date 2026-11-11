import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import CDP from 'chrome-remote-interface';
import { listAllRecords } from './feishu-list-all.mjs';
import { resolveTableFromArgv, LARK_CLI } from './table-context.mjs';
// 「异常备注」追加语义（2026-09-17）：写入前读回现有备注 → 换行追加，绝不覆盖、不重复追加。
import { createAbnormalRemarkAppender } from './abnormal-remark-append.mjs';

// 按 --table=<key> 选中目标表；三表字段名一致，只有 base/table/目录来自 config/tables.json。
const T = resolveTableFromArgv();
await fs.mkdir(T.stateDir, { recursive: true });
const port = Number(process.env.CDP_PORT || 9223);
const baseToken = T.baseToken;
const tableId = T.tableId;
const folderPath = T.activeDir;
const cli = LARK_CLI;
// 可观测性（2026-09-17）：模块默认 log = () => {}，调用方不传就一个事件都不输出，
// 「追加是否真生效 / 是否悄悄降级为覆盖」在日志上都看不见。传 console.log 直出 JSON 行。
const remarkAppender = createAbnormalRemarkAppender({
  cli, baseToken, tableId, identity: 'user',
  log: (line) => console.log(line)
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pad = (n) => String(n).padStart(2, '0');
const cnStamp = (date = new Date()) => {
  const d = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};
const parseCnStamp = (value) => {
  if (!value || typeof value !== 'string') return null;
  if (/^20\d\d-\d\d-\d\dT\d\d:\d\d/.test(value)) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const match = value.match(/^(20\d\d)-(\d\d)-(\d\d)\s+(\d\d):(\d\d)$/);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]) - 8, Number(match[5])));
};

// 飞书调用统一走带重试的公共出口（临时网络错误自动重试，确定性错误立即失败）。
import { runLarkCliJson } from './lark-cli-utils.mjs';
const runLark = (args, options = {}) => runLarkCliJson(args, options);

const records = listAllRecords({
  cli,
  baseToken,
  tableId,
  fieldIds: ['录屏名称', '状态', '点击导出时间', '点击文稿时间', '备注', '点击导出结果'],
  identity: 'user'
});
const ids = records.data?.record_id_list || [];
const rows = records.data?.data || [];
const currentNames = new Set(JSON.parse(await fs.readFile(T.statePath('deep-scan-baidu-videos.json'), 'utf8')).videos?.map((item) => item.name) || []);
// 达到观察上限的“文稿生成中”记录转人工挂起，后续不再每轮重复打开页面空转。
const GENERATING_WATCH = T.statePath('generating-watch.json');
const GENERATING_MAX_RUNS = 3;
const GENERATING_MAX_MS = 24 * 60 * 60 * 1000;
const readWatch = async () => {
  try { return JSON.parse(await fs.readFile(GENERATING_WATCH, 'utf8')); } catch { return {}; }
};
const watch = await readWatch();

const allRows = rows.map((row, index) => ({
  recordId: ids[index],
  name: row[0],
  status: Array.isArray(row[1]) ? row[1][0] : row[1],
  exportedAt: row[2],
  clickedWengaoAt: row[3],
  note: row[4],
  exportResult: row[5]
}));
const candidates = allRows.filter((row) => {
  // 「导出成功」只能由 stage3 在百度源目录确认同名 doc 后写入。
  // stage2 自己只提交导出请求；上一轮尚未核验完的「重试中」不能重复点，
  // 防止同一个视频反复触发导出，等待 stage3 的目录实物核验即可。
  const readyToClick = !row.exportedAt || row.exportResult === '待执行' || row.exportResult === '失败';
  return row.name && currentNames.has(row.name) && readyToClick && row.status !== '已作废' && row.status !== '已移动完成' && !watch[row.name]?.terminal;
});
console.log(JSON.stringify({ event: 'candidates_loaded', candidates: candidates.length }));

// 百度视频页「播放失败」必须与「文稿生成中」分开计数：
//   页面文案：视频播放失败，请稍后重试 / 错误码 7200003
// 它既不是 31339（文件损坏/不存在），也不该被当成"文稿仍在生成"无限拖延。
// 分级策略（用户 2026-09-11 明确要求）：
//   · 第 1~2 轮：状态仍 = 下一轮重新执行，点击导出结果=重试中，异常备注写清错误码
//   · 连续第 3 轮仍失败，且没有文稿导出 / 没有 doc / 页面依旧播放失败 → 判定视频不可用：
//       状态=已作废，点击导出结果=失败，异常备注写明，随后由 stage5 移入 /作废
const PLAYBACK_WATCH = T.statePath('playback-failure-watch.json');
const PLAYBACK_MAX_ROUNDS = 3;
const readPlaybackWatch = async () => {
  try { return JSON.parse(await fs.readFile(PLAYBACK_WATCH, 'utf8')); } catch { return {}; }
};
const playbackWatch = await readPlaybackWatch();

// 「视频页没有文稿 tab」也必须按轮次收敛，否则 `下一轮重新执行` 会无限堆积
// （实测 2026-09-11 一轮就从 30 条涨到 52 条，全是 no_wengao_tab）。
//   规则与 7200003 对齐：
//   · 第 1 ~ (N-1) 轮：状态仍 = 下一轮重新执行，点击导出结果=失败，异常备注写清轮次
//   · 连续第 N 轮仍没有文稿 tab → 判定"该视频无法生成文稿"：
//       状态=已作废，点击导出结果=失败，随后由 stage5 移入 /作废
const NO_WENGAO_WATCH = T.statePath('no-wengao-watch.json');
const NO_WENGAO_MAX_ROUNDS = 3;
const readNoWengaoWatch = async () => {
  try { return JSON.parse(await fs.readFile(NO_WENGAO_WATCH, 'utf8')); } catch { return {}; }
};
const noWengaoWatch = await readNoWengaoWatch();

// ── 作废前置证据闸门（2026-10-10 落地）────────────────────────────────────
// 规则（来源：本机负责人 2026-10-10 指令第 4 条）：
//   「连续达到上限后，必须先确认视频文件存在且可播放，再决定『已作废』，不得直接作废。」
// 背景：旧实现在「连续 N 轮没有文稿 tab」的第 N 轮直接写 状态=已作废。
//   但「没有文稿 tab」只说明**百度没给这条视频生成文稿**，它**不构成视频不可播放的证据**；
//   实测 2026-10-03 ~ 10-10 共 39 行以此被作废，而 `作废验证次数` 全部为空/0（零可播放性证据）。
// 落点：任何作废动作都必须先取得「可播放性证据」，证据等级分三档：
//   · broken       —— 页面明确报 该视频无法播放 / 文件已损坏 / 文件不存在  → 证据充分，允许作废
//   · 7200003 × N  —— 连续 N 轮页面报「视频播放失败，请稍后重试」          → 证据充分，允许作废
//   · no_wengao_tab—— 只是没有文稿 tab                                   → 证据不足，**不得作废**
// 证据不足时的处置：状态保持 `下一轮重新执行`，异常备注写明「已达上限但证据不足、不得作废、待人工确认」，
//   同时把该条写入 state/<key>/void-hold-manual-review.json 供人工逐条处置（绝不静默作废）。
const VOID_VERIFY_PATH = T.statePath('void-verification.json');
const VOID_HOLD_PATH = T.statePath('void-hold-manual-review.json');
const readJsonOrEmpty = async (p) => {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return {}; }
};
const voidVerify = await readJsonOrEmpty(VOID_VERIFY_PATH);
const voidHold = await readJsonOrEmpty(VOID_HOLD_PATH);

// 源目录库存快照（本批次 api-scan 的产物，只读来源；不额外打 CDP、不动网盘任何文件）。
// 用途：作废前先证明「视频文件确实存在于源目录」，并留字节数。
const deepScanSnapshot = JSON.parse(await fs.readFile(T.statePath('deep-scan-baidu-videos.json'), 'utf8'));
const deepScanCheckedAt = deepScanSnapshot.checkedAt || null;
const deepScanByName = new Map((deepScanSnapshot.videos || []).map((v) => [v.name, v]));
const probeSourceFile = (name) => {
  const hit = deepScanByName.get(name);
  if (hit) return { exists: true, size: hit.size != null ? String(hit.size) : '', fs_id: hit.fs_id ?? null, snapshotAt: deepScanCheckedAt };
  return { exists: false, size: '', fs_id: null, snapshotAt: deepScanCheckedAt };
};

/** 记录一条作废前证据；返回可写进异常备注的一行摘要 */
const recordVoidEvidence = (name, patch) => {
  const prev = voidVerify[name] || {};
  voidVerify[name] = Object.assign({}, prev, {
    name,
    verifiedAt: new Date().toISOString(),
    snapshotCheckedAt: deepScanCheckedAt
  }, patch);
  const v = voidVerify[name];
  const filePart = v.fileExists === true
    ? `源目录文件存在（size=${v.size || '未知'}）`
    : v.fileExists === false
      ? '源目录快照中未见该文件'
      : '源目录存在性未知';
  return `${filePart}；可播放性证据=${v.playability}${v.playabilityEvidence ? '（' + v.playabilityEvidence + '）' : ''}`;
};

const openVideoClient = async (url) => {
  const target = await CDP.New({ port, url });
  const client = await CDP({ port, target });
  const { Page, Runtime, Input, Browser } = client;
  await Page.enable();
  await Runtime.enable();
  const { windowId } = await Browser.getWindowForTarget({ targetId: target.id });
  await Browser.setWindowBounds({ windowId, bounds: { left: -32000, top: -32000, width: 1500, height: 950, windowState: 'normal' } });
  await sleep(8000);
  const evalPage = async (expression, timeout = 15000) => {
    const result = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true, timeout });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed');
    return result.result.value;
  };
  return { target, client, Input, evalPage };
};

const exported = [];
const exportRequested = [];
const stillGenerating = [];
const noDoc = [];
const tooEarly = [];
const failed = [];
const updates = {};

// 已达到“文稿生成”自动观察上限的记录，转为明确人工挂起：
// 保持“下一轮重新执行”，不擅自作废；但后续批次不再重复打开页面空转。
for (const item of allRows.filter((row) => row.status === '下一轮重新执行' && watch[row.name]?.terminal)) {
  const count = watch[item.name]?.count || GENERATING_MAX_RUNS;
  updates[item.recordId] = {
    "状态": ["下一轮重新执行"],
    "文稿状态": ["generating"],
    "点击导出结果": "重试中",
    "点击导出备注": `文稿连续 ${count} 轮仍处于生成中，已达到自动重试上限 ${GENERATING_MAX_RUNS} 轮，挂起待人工确认。`,
    "备注": "第二阶段检查：文稿生成达到自动重试上限，保留下一轮重新执行但暂停自动重复操作，待人工确认。",
    "异常备注": `文稿连续 ${count} 轮未产出 doc，已达到自动重试上限 ${GENERATING_MAX_RUNS} 轮；未确认视频损坏，不作废，挂起待人工确认。`
  };
}
if (Object.keys(updates).length) {
  console.log(JSON.stringify({ event: 'stage2_generating_terminal_hold', count: Object.keys(updates).length, maxRounds: GENERATING_MAX_RUNS }));
}

// ── 增量落库（关键健壮性修复）────────────────────────────────────────────
// 旧实现把全部 updates 攒到进程末尾一次性提交。stage2 一旦被 SIGKILL（阶段超时）就
// 全部丢失 —— 2026-09-11 20时批次实测丢掉 22 个「已点击导出」的证据，stage3 候选=0，
// 整条 doc 链（分享→上传→移动）空转一整轮，而飞书上看不出任何异常。
// 改成每 FLUSH_EVERY 条落一次盘，并同步把轮次计数写盘。
const FLUSH_EVERY = 5;
const flushUpdates = async () => {
  await fs.writeFile(PLAYBACK_WATCH, JSON.stringify(playbackWatch, null, 2), 'utf8').catch(() => null);
  await fs.writeFile(NO_WENGAO_WATCH, JSON.stringify(noWengaoWatch, null, 2), 'utf8').catch(() => null);
  // 作废前置证据台账同步增量落盘（stage2 可能被阶段超时 SIGKILL，证据不能只在内存里）。
  await fs.writeFile(VOID_VERIFY_PATH, JSON.stringify(voidVerify, null, 2), 'utf8').catch(() => null);
  await fs.writeFile(VOID_HOLD_PATH, JSON.stringify(voidHold, null, 2), 'utf8').catch(() => null);
  const keys = Object.keys(updates);
  if (!keys.length) return;
  // 追加语义：只改写 updates 里的「异常备注」key，其它字段原样不动。
  const remarkPlan = remarkAppender.prepare(updates);
  // 前置读失败 → 本轮**不写库、不清空 updates**，本批保留到下一轮重试。
  if (remarkPlan.blocked) {
    console.log(JSON.stringify({
      event: 'stage2_write_blocked_abnormal_remark_read_failed',
      count: keys.length,
      message: '备注读取失败，待重试；本批保留到下一轮。'
    }));
    return;
  }
  const updatePath = T.statePath('stage2-update-records-part.json');
  await fs.writeFile(updatePath, JSON.stringify({ update_records: updates }, null, 2), 'utf8');
  try {
    runLark([
      'base', '+record-batch-update',
      '--base-token', baseToken,
      '--table-id', tableId,
      '--json', `@${updatePath}`,
      '--as', 'user',
      '--format', 'json'
    ]);
  } catch (error) {
    // 整批被拒（典型是受限单选字段写了非法值，lark 返回 800030005）绝不能让数据静默丢失。
    console.log(JSON.stringify({ event: 'stage2_update_failed', count: keys.length, error: String(error.message).slice(0, 500) }));
    return; // 保留 updates，下一次 flush 再试
  }
  // 写后回读核验（只读）：确认「异常备注」以追加后的文本结尾。
  remarkAppender.settle(remarkPlan.expected);
  for (const key of keys) delete updates[key];
  console.log(JSON.stringify({ event: 'stage2_update_flushed', count: keys.length }));
};

for (const item of candidates) {
  // 上一批已攒够就落盘（放在循环开头，避免被下面各种 continue 跳过）。
  if (Object.keys(updates).length >= FLUSH_EVERY) await flushUpdates();
  const clickedAt = parseCnStamp(item.clickedWengaoAt);
  if (clickedAt && Date.now() - clickedAt.getTime() < T.transcriptWaitMinutes * 60 * 1000) {
    tooEarly.push({ ...item, waitUntil: cnStamp(new Date(clickedAt.getTime() + T.transcriptWaitMinutes * 60 * 1000)) });
    continue;
  }

  const videoUrl = `https://pan.baidu.com/pfile/video?path=${encodeURIComponent(`${folderPath}/${item.name}`)}&theme=light&view_from=personal_file&from=home`;
  let target = null;
  let client = null;
  try {
    console.log(JSON.stringify({ event: 'stage2_start', name: item.name }));
    const opened = await openVideoClient(videoUrl);
    ({ target, client } = opened);
    const { Input, evalPage } = opened;
    const loaded = await evalPage(`(() => document.body.innerText.includes(${JSON.stringify(item.name)}))()`);
    console.log(JSON.stringify({ event: 'stage2_open_done', name: item.name, loaded, targetId: target.id }));
    // 与 stage1 同步：库库AI iframe 会覆盖「文稿」页签，必须先以真实鼠标点击关闭。
    const closeAiSidebar = async () => {
      let observed = false;
      let gone = false;
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const close = await evalPage(`(() => {
          const iframe = document.querySelector('iframe.vp-genflow-view__container');
          if (!iframe) return { present: false };
          const r = iframe.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return { present: false };
          return { present: true, x: Math.round(r.x + r.width - 25), y: Math.round(r.y + 31) };
        })()`);
        if (close?.present) {
          observed = true;
          for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
            await Input.dispatchMouseEvent({ type, x: close.x, y: close.y, button: 'left', clickCount: 1 });
          }
          await sleep(500);
          continue;
        }
        if (observed) {
          gone = true;
          break;
        }
        await sleep(300);
      }
      return { observed, gone };
    };
    const aiClose = await closeAiSidebar();
    console.log(JSON.stringify({ event: 'stage2_ai_sidebar_close_attempt', name: item.name, observed: aiClose.observed, gone: aiClose.gone }));
    const pageCheck = await evalPage(`(() => {
      const body = document.body.innerText || '';
      return {
        broken: /该视频无法播放|错误码\\s*31339|视频文件已损坏|文件不存在|视频不存在|文件已被删除/.test(body),
        playbackFail: /7200003/.test(body) || /视频播放失败/.test(body),
        hasExportContainer: !!document.querySelector('.ai-draft__export-container'),
        bodyTail: body.slice(-1000)
      };
    })()`);
    if (pageCheck?.broken) {
      noDoc.push({ ...item, reason: 'video_broken_or_missing', pageCheck });
      // 作废前置证据：页面明确报「无法播放 / 文件已损坏 / 文件不存在」→ 证据充分，允许作废。
      const srcBroken = probeSourceFile(item.name);
      const evBroken = recordVoidEvidence(item.name, {
        fileExists: srcBroken.exists, size: srcBroken.size, fsId: srcBroken.fs_id,
        playability: 'confirmed_unplayable',
        playabilityEvidence: '页面明确报「无法播放/视频文件已损坏/文件不存在」',
        voidAllowed: true, voidPath: 'broken'
      });
      updates[item.recordId] = {
        "状态": ["已作废"],
        "文稿状态": ["no_wengao_tab_or_no_doc"],
        "点击导出结果": "失败",
        "点击导出备注": `视频本身无法播放或文件不存在，判定作废：${(pageCheck.bodyTail || '').slice(0, 300)}`,
        "备注": "第二阶段检查：视频本身无法播放或文件不存在，等待移动到作废目录。",
        "异常备注": `第二阶段判定作废：视频本身无法播放或文件不存在（作废前置证据：${evBroken}）。页面摘要：${(pageCheck.bodyTail || '').slice(0, 300)}`
      };
      console.log(JSON.stringify({ event: 'stage2_video_broken', name: item.name, voidEvidence: evBroken }));
      continue;
    }

    // 播放失败（7200003 等）单独处理。hasExportContainer 为真说明文稿导出入口仍在，
    // 那就不是"视频不可用"，交给后面的正常导出逻辑即可，不能误判作废。
    if (pageCheck?.playbackFail && !pageCheck.hasExportContainer) {
      const now = new Date();
      const prev = playbackWatch[item.name] || { firstSeenAt: now.toISOString(), count: 0 };
      // 同一批次内同一个视频可能被「前置阶段-下一轮重新执行」和「第三阶段-本批返工」各跑一次。
      // 轮次必须按"批次"计，否则一轮就把计数 +2，上限 3 轮实际 2 轮就作废。
      const sameBatch = prev.batchNo && process.env.BATCH_NO && prev.batchNo === process.env.BATCH_NO;
      const count = sameBatch ? (prev.count || 1) : (prev.count || 0) + 1;
      playbackWatch[item.name] = {
        firstSeenAt: prev.firstSeenAt || now.toISOString(),
        count,
        lastSeenAt: now.toISOString(),
        batchNo: process.env.BATCH_NO || null,
        errorCode: '7200003',
        pageText: '视频播放失败，请稍后重试'
      };
      if (count >= PLAYBACK_MAX_ROUNDS) {
        noDoc.push({ ...item, reason: 'playback_failed_7200003_terminal', count, pageCheck });
        // 作废前置证据：连续 N 轮页面自报「视频播放失败」→ 已取得不可播放证据，允许作废。
        const srcPlayback = probeSourceFile(item.name);
        const evPlayback = recordVoidEvidence(item.name, {
          fileExists: srcPlayback.exists, size: srcPlayback.size, fsId: srcPlayback.fs_id,
          playability: 'confirmed_unplayable',
          playabilityEvidence: `连续 ${count} 轮页面报 7200003「视频播放失败，请稍后重试」`,
          voidAllowed: true, voidPath: 'playback_7200003', rounds: count
        });
        updates[item.recordId] = {
          "状态": ["已作废"],
          // 注意：`文稿状态` 是**受限单选字段**，合法值只有 has_doc / generating /
          // no_wengao_tab_or_no_doc。写自定义值会被 lark 以 800030005 not_found 拒绝，
          // 且整批 update 一起失败。播放失败的本质就是"没有产出 doc"，用第三个。
          "文稿状态": ["no_wengao_tab_or_no_doc"],
          "点击导出结果": "失败",
          "点击导出备注": `视频页连续 ${count} 轮「视频播放失败，请稍后重试」（错误码 7200003），且无文稿导出、无 doc，判定视频不可用。`,
          "备注": `第二阶段判定：连续 ${count} 轮 7200003 播放失败，等待移动到作废目录。`,
          "异常备注": `连续 ${count} 轮 7200003，确认视频无法正常生成文稿，移入作废（作废前置证据：${evPlayback}）。页面摘要：${(pageCheck.bodyTail || '').slice(0, 300)}`
        };
        console.log(JSON.stringify({ event: 'stage2_playback_failed_terminal', name: item.name, count, voidEvidence: evPlayback }));
      } else {
        stillGenerating.push({ ...item, reason: 'playback_failed_7200003_transient', count, pageCheck });
        updates[item.recordId] = {
          "状态": ["下一轮重新执行"],
          // 同上：必须用受限单选字段的既有选项，不能自造值。
          "文稿状态": ["no_wengao_tab_or_no_doc"],
          "点击导出结果": "重试中",
          "点击导出备注": `视频页返回「视频播放失败，请稍后重试」（错误码 7200003），已观察 ${count} 轮，未确认视频损坏，下一轮重新执行。`,
          "备注": "第二阶段检查：视频页播放失败（7200003），待下轮批次重试。",
          "异常备注": `第二阶段待返工：视频页播放失败，错误码 7200003（第 ${count} 轮 / 上限 ${PLAYBACK_MAX_ROUNDS} 轮）。页面摘要：${(pageCheck.bodyTail || '').slice(0, 300)}`
        };
        console.log(JSON.stringify({ event: 'stage2_playback_failed_retry', name: item.name, count }));
      }
      continue;
    }

    // 首轮给满 30 秒等页面把 tab 栏渲染出来（避免慢加载被误判成"没有文稿 tab"）。
    // 已经被判定过至少一次"没有文稿 tab"的视频走 8 秒快速复检：它的结论方向就是作废，
    // 慢一点没有意义，而 stage2 单条 ~47 秒里有 30 秒耗在这个循环上。
    const tabWaitSeconds = noWengaoWatch[item.name] ? 8 : 30;
    let tab = null;
    for (let i = 0; i < tabWaitSeconds; i += 1) {
      tab = await evalPage(`(() => {
        const textOf = (node) => (node.innerText || node.textContent || '').replace(/\\s+/g, '').trim();
        const visible = (node) => {
          const r = node.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.top >= -10 && r.top < 300;
        };
        const nodes = [...document.querySelectorAll('[role="tab"],button,a,.vp-tabs__header-item,div,span')]
          .filter((node) => textOf(node) === '文稿' && visible(node));
        const el = nodes.find((node) => node.matches('[role="tab"],button,a,.vp-tabs__header-item')) || nodes[0];
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      if (tab) break;
      await sleep(1000);
    }

    if (!tab) {
      const roundNow = new Date();
      const prevNoWengao = noWengaoWatch[item.name] || { firstSeenAt: roundNow.toISOString(), count: 0 };
      // 同批次只计一轮（见上面 7200003 分支同样的理由）。
      const sameBatch = prevNoWengao.batchNo && process.env.BATCH_NO && prevNoWengao.batchNo === process.env.BATCH_NO;
      const noWengaoCount = sameBatch ? (prevNoWengao.count || 1) : (prevNoWengao.count || 0) + 1;
      noWengaoWatch[item.name] = {
        firstSeenAt: prevNoWengao.firstSeenAt || roundNow.toISOString(),
        count: noWengaoCount,
        lastSeenAt: roundNow.toISOString(),
        batchNo: process.env.BATCH_NO || null
      };
      if (noWengaoCount >= NO_WENGAO_MAX_ROUNDS) {
        // 🔴 2026-10-10 作废前置证据闸门：
        //   「连续 N 轮没有文稿 tab」只说明**百度没给这条视频生成文稿**，
        //   它**不构成视频不可播放的证据**。按本机负责人 2026-10-10 指令第 4 条
        //   「连续达到上限后，必须先确认视频文件存在且可播放，再决定『已作废』，不得直接作废」，
        //   此处**不再写 状态=已作废**，改为：保持 下一轮重新执行 + 落人工复核清单。
        // 展示轮次封顶到上限，保证追加文案在达到上限后逐轮完全一致 → 依赖 remarkAppender 的幂等去重，不再无限膨胀。
        const shownRounds = Math.min(noWengaoCount, NO_WENGAO_MAX_ROUNDS);
        noDoc.push({ ...item, reason: 'no_wengao_tab_limit_hold_pending_manual', count: noWengaoCount });
        const srcHold = probeSourceFile(item.name);
        const evHold = recordVoidEvidence(item.name, {
          fileExists: srcHold.exists, size: srcHold.size, fsId: srcHold.fs_id,
          playability: 'unverified',
          playabilityEvidence: `仅有「连续 ${shownRounds} 轮无文稿 tab」；该现象不能证明视频不可播放`,
          voidAllowed: false, voidHoldReason: 'no_playability_proof',
          rounds: noWengaoCount
        });
        const prevHold = voidHold[item.name] || {};
        voidHold[item.name] = {
          name: item.name,
          recordId: item.recordId,
          tableKey: T.key,
          命中原因: '连续达到轮次上限（no_wengao_tab）但未取得可播放性证据',
          noWengaoRounds: noWengaoCount,
          maxRounds: NO_WENGAO_MAX_ROUNDS,
          源目录文件存在: srcHold.exists,
          字节: srcHold.size || null,
          源目录快照时间: srcHold.snapshotAt,
          证据摘要: evHold,
          首次挂起时间: prevHold.首次挂起时间 || new Date().toISOString(),
          挂起次数: (prevHold.挂起次数 || 0) + 1,
          待人工动作: '人工确认该视频文件存在且可播放后，再决定是否作废；未确认前禁止作废'
        };
        updates[item.recordId] = {
          "状态": ["下一轮重新执行"],
          // `文稿状态` 是受限单选，只能写 has_doc / generating / no_wengao_tab_or_no_doc。
          "文稿状态": ["no_wengao_tab_or_no_doc"],
          "点击导出结果": "失败",
          "点击导出备注": `连续 ${shownRounds} 轮视频页没有文稿 tab（已达上限 ${NO_WENGAO_MAX_ROUNDS} 轮），但未取得「视频不可播放」证据，按规则不判作废，挂起待人工确认。`,
          "备注": "第二阶段检查：已达轮次上限但无可播放性证据，挂起待人工确认（不自动作废）。",
          "异常备注": `已达轮次上限（${shownRounds}/${NO_WENGAO_MAX_ROUNDS} 轮）视频页仍没有文稿 tab：该现象只说明百度未生成文稿，不能证明视频损坏，按规则不得直接判「已作废」。作废前置证据：${evHold}。已挂起待人工确认视频可播放性后再决定；未确认前保持「下一轮重新执行」。`
        };
        console.log(JSON.stringify({ event: 'stage2_no_wengao_limit_hold', name: item.name, count: noWengaoCount, shownRounds, voidAllowed: false, voidEvidence: evHold }));
      } else {
        noDoc.push({ ...item, reason: 'no_wengao_tab_or_no_doc' });
        updates[item.recordId] = {
          "状态": ["下一轮重新执行"],
          "文稿状态": ["no_wengao_tab_or_no_doc"],
          "点击导出结果": "失败",
          "点击导出备注": "视频页没有文稿 tab，无法导出。",
          "备注": "第二阶段检查：视频页没有文稿 tab，无法导出。",
          "异常备注": `第二阶段待返工：视频页没有文稿 tab（第 ${noWengaoCount} 轮 / 上限 ${NO_WENGAO_MAX_ROUNDS} 轮），暂未确认视频本身损坏，下一轮重新执行。`
        };
        console.log(JSON.stringify({ event: 'stage2_no_wengao', name: item.name, count: noWengaoCount, maxRounds: NO_WENGAO_MAX_ROUNDS }));
      }
      continue;
    }

    const activeTab = async () => evalPage(`(() => {
      const textOf = (node) => (node.innerText || node.textContent || '').replace(/\\s+/g, '').trim();
      const nodes = [...document.querySelectorAll('[role="tab"],.vp-tabs__header-item')];
      return nodes.find((node) => textOf(node) === '文稿' && (
        node.getAttribute('aria-selected') === 'true' ||
        node.classList.contains('active') ||
        node.className.includes('active')
      )) ? '文稿' : '视频';
    })()`);
    const domClicked = await evalPage(`(() => {
      const textOf = (node) => (node.innerText || node.textContent || '').replace(/\\s+/g, '').trim();
      const el = [...document.querySelectorAll('[role="tab"],button,a,.vp-tabs__header-item,div,span')]
        .find((node) => textOf(node) === '文稿' && node.getBoundingClientRect().width > 0);
      if (!el) return false;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus?.();
      el.click();
      return true;
    })()`);
    await sleep(700);
    if ((await activeTab()) !== '文稿') {
      await Input.dispatchMouseEvent({ type: 'mouseMoved', x: tab.x, y: tab.y });
      await Input.dispatchMouseEvent({ type: 'mousePressed', x: tab.x, y: tab.y, button: 'left', clickCount: 1 });
      await Input.dispatchMouseEvent({ type: 'mouseReleased', x: tab.x, y: tab.y, button: 'left', clickCount: 1 });
    }
    console.log(JSON.stringify({ event: 'stage2_wengao_tab_click_attempt', name: item.name, domClicked }));

    let state = null;
    for (let i = 0; i < 30; i += 1) {
      await sleep(1000);
      state = await evalPage(`(() => {
        const body = document.body.innerText;
        const textOf = (node) => (node.innerText || node.textContent || '').replace(/\\s+/g, '').trim();
        const activeNode = [...document.querySelectorAll('[role="tab"],.vp-tabs__header-item')]
          .find((el) => el.getAttribute('aria-selected') === 'true' || el.className.includes('active'));
        const active = activeNode ? textOf(activeNode) : '';
        const exportEl = document.querySelector('.ai-draft__export-container');
        const copyEl = document.querySelector('.ai-draft__copy-container');
        return {
          active,
          hasGenerating: body.includes('系统正努力生成文稿中'),
          hasEstimate: body.includes('预计仅需'),
          hasExport: !!exportEl,
          hasCopy: !!copyEl,
          hasWengaoTab: [...document.querySelectorAll('[role="tab"],.vp-tabs__header-item,button,a,div,span')]
            .some((el) => textOf(el) === '文稿' && el.getBoundingClientRect().width > 0),
          bodyTail: body.slice(-1000)
        };
      })()`);
      if (state.hasExport || state.hasGenerating || !state.hasWengaoTab) break;
    }

    if (state.active !== '文稿') {
      noDoc.push({ ...item, reason: 'wengao_tab_not_activated_after_click', state });
      updates[item.recordId] = {
        "状态": ["下一轮重新执行"],
        "点击导出结果": "失败",
        "点击导出备注": "已找到文稿页签但点击后未真正进入文稿页，未执行导出。",
        "备注": "第二阶段检查：文稿页签点击未生效，待下轮重试。",
        "异常备注": "第二阶段待返工：已找到文稿页签但点击后未真正进入文稿页，未执行导出。"
      };
      console.log(JSON.stringify({ event: 'stage2_wengao_tab_not_activated', name: item.name, active: state.active }));
      continue;
    }

    if (!state.hasExport) {
      stillGenerating.push({ ...item, state });
      const now = new Date();
      const prev = watch[item.name] || { firstSeenAt: now.toISOString(), count: 0, terminal: false };
      const firstMs = new Date(prev.firstSeenAt || now.toISOString()).getTime();
      // 同批次只计一轮（2026-10-11 修复，与上面 7200003 / no_wengao_tab 两个计数口径对齐）：
      // 同一批次内同一个视频可能被「第一阶段-本次新批次」的下游和「第三阶段-本批返工」各跑一次；
      // 2026-10-11 起第三阶段改为**立即检查**（不再等 10 分钟），同一批次内两次检查几乎背靠背发生，
      // 若仍按"每次 stage2 运行 +1"，生成中轮次会在一批之内 +2，把「连续 N 轮」报成虚高，
      // 可能让本该继续等文稿的行提前被写成 `最终结果=未完成`。
      // 轮次必须按"批次"计，才与 rollout 的真实节奏一致（上线后旧条目无 batchNo，首轮照旧 +1 后开始生效）。
      const sameBatch = prev.batchNo && process.env.BATCH_NO && prev.batchNo === process.env.BATCH_NO;
      const count = sameBatch ? (prev.count || 1) : (prev.count || 0) + 1;
      const elapsedMs = now.getTime() - firstMs;
      const terminal = count >= GENERATING_MAX_RUNS || elapsedMs >= GENERATING_MAX_MS;
      watch[item.name] = {
        firstSeenAt: prev.firstSeenAt || now.toISOString(),
        count,
        terminal,
        lastSeenAt: now.toISOString(),
        batchNo: process.env.BATCH_NO || null
      };
      if (terminal) {
        updates[item.recordId] = {
          "状态": ["下一轮重新执行"],
          "最终结果": "未完成",
          "文稿状态": ["generating"],
          "点击导出结果": "重试中",
          "点击导出备注": `文稿连续 ${count} 轮（约 ${Math.round(elapsedMs / 3600000)}h）仍处于生成中，下一轮重新执行。`,
          "备注": "第二阶段检查：文稿生成超时但未确认视频损坏，下一轮重新执行。",
          "异常备注": `第二阶段待返工：文稿连续 ${count} 轮未产出 doc，未确认视频损坏，下一轮重新执行。`
        };
        console.log(JSON.stringify({ event: 'stage2_generating_timeout', name: item.name, count, elapsedMs }));
      } else {
        updates[item.recordId] = {
          "状态": ["下一轮重新执行"],
          "文稿状态": ["generating"],
          "点击导出结果": "重试中",
          "点击导出备注": `文稿仍在生成中（已观察 ${count} 轮），保留到下轮批次继续导出。`,
          "备注": "第二阶段检查：文稿仍在生成中，待后续周期继续导出。",
          "异常备注": "暂未异常：文稿仍在生成中，保留到下轮批次继续导出。"
        };
        console.log(JSON.stringify({ event: 'stage2_still_generating', name: item.name, count }));
      }
      continue;
    }

    // 不能只 dispatch DOM Event：百度视频页的导出入口会吞掉合成事件，
    // 表面得到坐标却没有真正发起导出。必须和 stage1 一样使用 CDP 真实鼠标点击。
    const exportButton = await evalPage(`(() => {
      const el = document.querySelector('.ai-draft__export-container');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!exportButton) throw new Error('文稿导出按钮不可见，未发起导出请求');
    await Input.dispatchMouseEvent({ type: 'mouseMoved', x: exportButton.x, y: exportButton.y });
    await Input.dispatchMouseEvent({ type: 'mousePressed', x: exportButton.x, y: exportButton.y, button: 'left', clickCount: 1 });
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x: exportButton.x, y: exportButton.y, button: 'left', clickCount: 1 });
    await sleep(1500);
    const afterClick = await evalPage(`(() => document.body.innerText.slice(-1500))()`);
    const now = cnStamp();
    updates[item.recordId] = {
      "状态": ["下一轮重新执行"],
      // 关键口径：真实 doc 尚未由百度源目录实物确认，绝不写 has_doc / 成功。
      // stage3 会统一扫描目录；只有确认同名 doc 后才将本字段改为 has_doc。
      "文稿状态": ["generating"],
      "点击导出时间": now,
      "点击导出结果": "重试中",
      "点击导出备注": "已通过真实鼠标点击提交文稿导出请求，等待百度源目录出现同名 doc 后再确认成功。",
      "备注": "文稿导出请求已提交，等待百度源目录实物核验；未确认前不写导出成功。"
    };
    exportRequested.push({ ...item, videoUrl, click: exportButton, afterClick: afterClick.slice(0, 500) });
    console.log(JSON.stringify({ event: 'stage2_export_requested', name: item.name, click: exportButton }));
    await sleep(1000);
  } catch (error) {
    failed.push({ ...item, error: error.message });
    updates[item.recordId] = {
      "状态": ["下一轮重新执行"],
      "点击导出结果": "失败",
      "点击导出备注": `第二阶段打开视频或点击导出失败：${error.message.slice(0, 500)}`,
      "异常备注": `第二阶段异常：${error.message.slice(0, 500)}`,
      "备注": "第二阶段打开视频或点击导出失败，已写入异常备注。"
    };
    console.log(JSON.stringify({ event: 'stage2_failed', name: item.name, error: error.message }));
  } finally {
    if (client) await client.close().catch(() => null);
    if (target?.id) await CDP.Close({ port, id: target.id }).catch(() => null);
  }
}

await fs.writeFile(GENERATING_WATCH, JSON.stringify(watch, null, 2), 'utf8').catch(() => null);
await fs.writeFile(PLAYBACK_WATCH, JSON.stringify(playbackWatch, null, 2), 'utf8').catch(() => null);
await fs.writeFile(NO_WENGAO_WATCH, JSON.stringify(noWengaoWatch, null, 2), 'utf8').catch(() => null);
// 作废前置证据台账（2026-10-10）：逐条记录「源文件是否存在+字节 / 可播放性证据等级 / 是否允许作废」。
await fs.writeFile(VOID_VERIFY_PATH, JSON.stringify(voidVerify, null, 2), 'utf8').catch(() => null);
// 证据不足而挂起的、待人工确认的行（禁止静默作废）。
await fs.writeFile(VOID_HOLD_PATH, JSON.stringify(voidHold, null, 2), 'utf8').catch(() => null);

// 收尾：把剩下的更新与轮次计数落盘（增量 flush 已处理大部分）。
await flushUpdates();
const leftover = Object.keys(updates).length;
if (leftover) console.log(JSON.stringify({ event: 'stage2_update_leftover', count: leftover, note: 'lark 拒绝，未落库，下一轮会重跑这些行。' }));

const report = { checkedAt: new Date().toISOString(), tableKey: T.key, candidates: candidates.length, exported, exportRequested, stillGenerating, noDoc, tooEarly, failed, playbackFailures: Object.entries(playbackWatch).map(([name, v]) => ({ name, ...v })), noWengaoRounds: Object.entries(noWengaoWatch).map(([name, v]) => ({ name, ...v })), voidHoldPendingManual: Object.values(voidHold), voidVerify };
await fs.writeFile(T.statePath('stage2-report.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({
  checkedAt: report.checkedAt,
  tableKey: T.key,
  candidates: candidates.length,
  exported: exported.length,
  exportRequested: exportRequested.length,
  stillGenerating: stillGenerating.length,
  noDoc: noDoc.length,
  tooEarly: tooEarly.length,
  failed: failed.length,
  playbackFailures: report.playbackFailures.filter((x) => x.count > 0).length,
  playbackTerminalNames: report.playbackFailures.filter((x) => (x.count || 0) >= PLAYBACK_MAX_ROUNDS).map((x) => x.name),
  noWengaoRounds: report.noWengaoRounds.filter((x) => x.count > 0).length,
  noWengaoTerminalNames: report.noWengaoRounds.filter((x) => (x.count || 0) >= NO_WENGAO_MAX_ROUNDS).map((x) => x.name),
  // 2026-10-10 闸门：达到上限但无可播放性证据 → 不判作废，挂起待人工确认（此列表必须为空才说明无挂起）。
  voidHoldPendingManualNames: Object.keys(voidHold),
  voidAllowedNames: Object.values(voidVerify).filter((v) => v.voidAllowed === true).map((v) => v.name),
  exportedNames: exported.map((x) => x.name),
  stillGeneratingNames: stillGenerating.map((x) => x.name),
  failedItems: failed
}, null, 2));
process.exit(failed.length ? 2 : 0);
