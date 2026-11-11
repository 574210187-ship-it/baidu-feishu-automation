import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import CDP from 'chrome-remote-interface';
import { createVideoShareLink } from './baidu-share-video.mjs';
import { collectBaiduVideos } from './baidu-scan-folder.mjs';
import { listAllRecords } from './feishu-list-all.mjs';
import { resolveTableFromArgv, LARK_CLI } from './table-context.mjs';
// 「异常备注」追加语义（2026-09-17）：写入前读回现有备注 → 换行追加，绝不覆盖、不重复追加。
import { createAbnormalRemarkAppender } from './abnormal-remark-append.mjs';

// 按 --table=<key> 选中目标表（jiang / yichen / zed）；三表字段名一致（各 61 列），
// 仅 videoLinkField 与 base/table/目录不同，全部来自 config/tables.json。
const T = resolveTableFromArgv();
await fs.mkdir(T.stateDir, { recursive: true });
const port = Number(process.env.CDP_PORT || 9223);
const baseToken = T.baseToken;
const tableId = T.tableId;
const folderPath = T.activeDir;
const folderUrl = T.activeUrl;
const videoLinkField = T.videoLinkField;
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
const accountNameOf = (fileName) => fileName.split('-')[0] || '';
const dateOf = (fileName) => {
  const match = fileName.match(/-(20\d{2})(\d{2})(\d{2})-/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
};
const makeCode = () => {
  const chars = 'abcdefghijkmnopqrstuvwxyz23456789';
  let code = '';
  for (let i = 0; i < 4; i += 1) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
};
// 批次名必须与统一入口的 batchWindow.label 完全一致（槽宽来自 config/tables.json），
// 否则第二阶段"上一批返工"永远匹配不到，故槽宽取自 config/tables.json。
const batchName = process.env.BATCH_NO || (() => {
  const d = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const slot = Math.floor(d.getUTCHours() / T.batchIntervalHours) * T.batchIntervalHours;
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(slot)}时批次`;
})();
// 飞书调用统一走带重试的公共出口（临时网络错误自动重试，字段缺失/权限/参数等确定性错误立即失败）。
import { runLarkCliJson } from './lark-cli-utils.mjs';
const runLark = (args, options = {}) => runLarkCliJson(args, options);

console.log(JSON.stringify({ event: 'read_feishu_existing_start' }));
const existing = listAllRecords({
  cli,
  baseToken,
  tableId,
  fieldIds: ['录屏名称', '点击文稿时间', '所属批次', '返工次数'],
  identity: 'user'
});
console.log(JSON.stringify({ event: 'read_feishu_existing_done', records: existing.data?.data?.length || 0 }));
const existingNames = new Set();
const existingByName = new Map();
const existingIds = existing.data?.record_id_list || [];
for (const [index, row] of (existing.data?.data || []).entries()) {
  if (row[0]) {
    existingNames.add(row[0]);
    existingByName.set(row[0], { recordId: existingIds[index], owningBatch: row[2], reworkCount: row[3] || 0 });
  }
}
const phaseTargets = await fs.readFile(T.statePath('current-phase-targets.json'), 'utf8')
  .then((text) => JSON.parse(text))
  .catch(() => null);
const targetNames = phaseTargets?.targetNames?.length ? new Set(phaseTargets.targetNames) : null;
const phaseLabel = phaseTargets?.phaseLabel || '第一阶段-新批次';
const isReworkPhase = Boolean(phaseTargets?.rework);

console.log(JSON.stringify({ event: 'cdp_list_start', port }));
const targets = await CDP.List({ port });
console.log(JSON.stringify({ event: 'cdp_list_done', pages: targets.filter((t) => t.type === 'page').length }));
let videos = [];
if (process.argv.includes('--use-deep-scan')) {
  const deepScan = JSON.parse(await fs.readFile(T.statePath('deep-scan-baidu-videos.json'), 'utf8'));
  videos = deepScan.videos || [];
  if (targetNames) videos = videos.filter((item) => targetNames.has(item.name));
  console.log(JSON.stringify({ event: 'deep_scan_loaded', totalVideos: videos.length, checkedAt: deepScan.checkedAt }));
} else {
  const diskTarget = await CDP.New({ port, url: folderUrl });
  console.log(JSON.stringify({ event: 'connect_disk_start', url: diskTarget.url }));
  const disk = await CDP({ port, target: diskTarget });
  await disk.Page.enable();
  await disk.Runtime.enable();
  console.log(JSON.stringify({ event: 'connect_disk_done' }));
  const scan = await collectBaiduVideos({ Runtime: disk.Runtime, Page: disk.Page, folderUrl });
  videos = scan.videos || [];
  console.log(JSON.stringify({ event: 'scan_complete', totalVideos: videos.length, scroll: scan.scroll }));
  await disk.close().catch(() => null);
  await CDP.Close({ port, id: diskTarget.id }).catch(() => null);
}

const openVideoClient = async (url) => {
  const videoTarget = await CDP.New({ port, url });
  const video = await CDP({ port, target: videoTarget });
  await video.Runtime.enable();
  await video.Page.enable();
  const { windowId } = await video.Browser.getWindowForTarget({ targetId: videoTarget.id });
  await video.Browser.setWindowBounds({ windowId, bounds: { left: -32000, top: -32000, width: 1500, height: 950, windowState: 'normal' } });
  await sleep(8000);
  const evalVideo = async (expression, timeout = 15000) => {
    const result = await video.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true, timeout });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed');
    return result.result.value;
  };
  return { videoTarget, video, evalVideo };
};

const processed = [];
const skipped = [];
const failed = [];

for (const item of videos) {
  const existingRecord = existingByName.get(item.name);
  if (existingNames.has(item.name) && !isReworkPhase) {
    skipped.push({ ...item, reason: 'already_in_feishu' });
    continue;
  }

  console.log(JSON.stringify({ event: 'start_video', name: item.name, modified: item.modified, size: item.size }));
  const videoPath = `${folderPath}/${item.name}`;
  const videoUrl = `https://pan.baidu.com/pfile/video?path=${encodeURIComponent(videoPath)}&theme=light&view_from=personal_file&from=home`;
  let videoTarget = null;
  let video = null;
  let evalVideo = null;

  try {
    console.log(JSON.stringify({ event: 'open_video_start', name: item.name }));
    ({ videoTarget, video, evalVideo } = await openVideoClient(videoUrl));
    const loaded = await evalVideo(`(() => document.body.innerText.includes(${JSON.stringify(item.name)}))()`);
    if (!loaded) await sleep(5000);
    console.log(JSON.stringify({ event: 'open_video_done', name: item.name, loaded, targetId: videoTarget.id }));

    // 百度视频页会自动打开「库库AI」侧栏；它的 iframe 会覆盖右侧的「文稿」页签。
    // 旧逻辑仅把鼠标事件发出就记为点击成功，实际命中的是 iframe，导致表内出现假成功。
    const closeAiSidebar = async () => {
      const close = await evalVideo(`(() => {
        const iframe = document.querySelector('iframe.vp-genflow-view__container');
        if (!iframe) return null;
        const r = iframe.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return null;
        return { x: Math.round(r.x + r.width - 25), y: Math.round(r.y + 31) };
      })()`);
      if (!close) return false;
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await video.Input.dispatchMouseEvent({ type, x: close.x, y: close.y, button: 'left', clickCount: 1 });
      }
      await sleep(1200);
      return true;
    };
    const aiSidebarClosed = await closeAiSidebar();
    console.log(JSON.stringify({ event: 'ai_sidebar_close_attempt', name: item.name, closed: aiSidebarClosed }));

    // 百度页面改版后，旧的“找坐标→只发一次 CDP 鼠标事件”会出现假成功：
    // 日志显示点击成功，但 active 仍是“视频”，后续永远不会进入导出。
    // 这里同时使用页面真实 click、CDP 坐标点击和 active/aria-selected 双重确认。
    const readWengaoTab = async () => evalVideo(`(() => {
      const textOf = (node) => (node.innerText || node.textContent || '').replace(/\\s+/g, '').trim();
      const visible = (node) => {
        const r = node.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.top >= -10 && r.top < 300;
      };
      const candidates = [...document.querySelectorAll('[role="tab"],button,a,.vp-tabs__header-item,div,span')]
        .filter((node) => textOf(node) === '文稿' && visible(node));
      const el = candidates.find((node) => node.matches('[role="tab"],button,a,.vp-tabs__header-item')) || candidates[0];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), tag: el.tagName, cls: el.className || '' };
    })()`);
    const isWengaoActive = async () => evalVideo(`(() => {
      const textOf = (node) => (node.innerText || node.textContent || '').replace(/\\s+/g, '').trim();
      const nodes = [...document.querySelectorAll('[role="tab"],.vp-tabs__header-item')];
      return nodes.some((node) => textOf(node) === '文稿' && (
        node.getAttribute('aria-selected') === 'true' ||
        node.classList.contains('active') ||
        node.className.includes('active')
      ));
    })()`);
    const clickWengaoTab = async () => {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const tab = await readWengaoTab();
        if (!tab) {
          await sleep(1000);
          continue;
        }
        const domClicked = await evalVideo(`(() => {
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
        if (await isWengaoActive()) return { ok: true, method: 'dom', ...tab, attempt };
        await video.Input.dispatchMouseEvent({ type: 'mouseMoved', x: tab.x, y: tab.y });
        await video.Input.dispatchMouseEvent({ type: 'mousePressed', x: tab.x, y: tab.y, button: 'left', clickCount: 1 });
        await video.Input.dispatchMouseEvent({ type: 'mouseReleased', x: tab.x, y: tab.y, button: 'left', clickCount: 1 });
        await sleep(1200);
        if (await isWengaoActive()) return { ok: true, method: 'cdp', ...tab, attempt, domClicked };
      }
      return { ok: false, reason: 'wengao_tab_not_activated_after_click' };
    };
    // 百度视频页的“文稿”页签可能在首屏后异步挂载；只探测一次会把
    // 页面加载时序误判成 no_wengao_tab。有限重试，避免把真实缺页与慢加载混为一谈。
    let tab = null;
    let tabLookupAttempts = 0;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      tabLookupAttempts = attempt;
      tab = await readWengaoTab();
      if (tab) break;
      await sleep(attempt * 1000);
    }
    console.log(JSON.stringify({ event: 'wengao_tab_lookup_done', name: item.name, found: !!tab, tab, attempts: tabLookupAttempts }));

    const clickResult = tab ? await clickWengaoTab() : { ok: false, reason: 'no_wengao_tab_after_retry' };
    console.log(JSON.stringify({ event: 'wengao_click_done', name: item.name, clickResult }));

    let state = null;
    if (clickResult.ok) {
      for (let i = 0; i < 25; i += 1) {
        await sleep(1000);
        state = await evalVideo(`(() => {
        const body = document.body.innerText;
        const textOf = (node) => (node.innerText || node.textContent || '').replace(/\\s+/g, '').trim();
        const activeNode = [...document.querySelectorAll('[role="tab"],.vp-tabs__header-item')]
          .find((el) => el.getAttribute('aria-selected') === 'true' || el.className.includes('active'));
        const active = activeNode ? textOf(activeNode) : '';
        return {
          active,
          hasGenerating: body.includes('系统正努力生成文稿中'),
          hasEstimate: body.includes('预计仅需'),
          hasTranscript: active === '文稿' && body.length > 800 && !body.includes('系统正努力生成文稿中'),
          bodyTail: body.slice(-1200)
        };
      })()`);
        if (state.active === '文稿' && (state.hasGenerating || state.hasTranscript || state.hasEstimate)) break;
      }
    } else {
      state = { active: '视频', hasGenerating: false, hasTranscript: false, hasEstimate: false };
    }
    if (clickResult.ok && state?.active !== '文稿') {
      clickResult = { ok: false, reason: 'wengao_tab_not_activated_after_click' };
    }
    console.log(JSON.stringify({ event: 'wengao_state_done', name: item.name, active: state?.active, hasGenerating: state?.hasGenerating, hasTranscript: state?.hasTranscript, hasEstimate: state?.hasEstimate }));

    const now = cnStamp();
    const wengaoStatus = state?.hasTranscript ? 'has_doc' : clickResult.ok ? 'generating' : 'no_wengao_tab_or_no_doc';
    const note = clickResult.ok
      ? (state?.hasGenerating || state?.hasEstimate ? '已点击文稿，页面显示生成中。' : '已点击文稿，等待后续导出检查。')
      : `点击文稿失败：${clickResult.reason || 'unknown'}`;
    const apiVideoShare = async () => {
      if (!item.fs_id) return { ok: false, reason: 'missing_fs_id' };
      const code = makeCode();
      const result = await evalVideo(`(async () => {
        const getToken = () => {
          try {
            if (window.locals?.get) return window.locals.get('bdstoken') || window.locals.get('csrf') || '';
          } catch {}
          return window.locals?.bdstoken || window.locals?.csrf || window.yunData?.MYBDSTOKEN || window.yunData?.bdstoken || window.bdstoken || '';
        };
        const token = getToken();
        if (!token) return { ok: false, reason: 'token not available' };
        const params = new URLSearchParams({
          channel: 'chunlei',
          bdstoken: token,
          clienttype: '0',
          app_id: '250528',
          web: '1'
        });
        const body = new URLSearchParams({
          fid_list: JSON.stringify([${JSON.stringify(item.fs_id)}]),
          schannel: '4',
          channel_list: '[]',
          period: '0',
          pwd: ${JSON.stringify(code)}
        });
        const response = await fetch('/share/set?' + params.toString(), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
          body
        });
        const text = await response.text();
        let json;
        try { json = JSON.parse(text); } catch { json = { raw: text }; }
        if (response.status !== 200 || json.errno !== 0) return { ok: false, reason: JSON.stringify(json).slice(0, 200) };
        return { ok: true, link: json.link || json.shorturl || json.url, code: json.pwd || json.passwd || json.password || ${JSON.stringify(code)} };
      })()`, 30000);
      return result?.ok && result.link ? result : { ok: false, reason: result?.reason || 'share link missing' };
    };
    const videoShare = clickResult.ok
      ? (console.log(JSON.stringify({ event: 'video_share_start', name: item.name })),
        await apiVideoShare().catch((error) => ({ ok: false, reason: error.message })))
      : { ok: false, reason: 'skip_video_share_without_wengao_click' };
    console.log(JSON.stringify({ event: 'video_share_done', name: item.name, ok: videoShare.ok, reason: videoShare.reason || null }));
    const isNoWengaoTab = clickResult.reason === 'no_wengao_tab';
    // 主状态只保留三类最终/返工态：已移动完成 / 已作废 / 下一轮重新执行。
    // 过程细节写入步骤列，不能再写「已分享视频」「失败待返工」「跳过-无文稿」等旧状态。
    const status = '下一轮重新执行';
    const recordFields = {
          "账号名称": accountNameOf(item.name),
          "日期": dateOf(item.name),
          "录屏名称": item.name,
          "上传时间": item.modified || null,
          [videoLinkField]: `[${item.name}](${videoUrl})`,
          "分享视频链接": videoShare.ok ? videoShare.link : null,
          "视频提取码": videoShare.ok ? videoShare.code : null,
          "状态": [status],
          "文稿状态": [wengaoStatus],
          "批次号": batchName,
          "所属批次": isReworkPhase ? (existingRecord?.owningBatch || phaseTargets?.owningBatchByName?.[item.name] || batchName) : batchName,
          "最后执行批次": batchName,
          "批次阶段": phaseLabel,
          "首次发现时间": now,
          "点击文稿时间": clickResult.ok ? now : null,
          "重试次数": clickResult.ok ? 0 : 1,
          "返工次数": isReworkPhase ? Number(existingRecord?.reworkCount || phaseTargets?.reworkCountByName?.[item.name] || 0) + 1 : 0,
          "点击文稿结果": clickResult.ok ? "成功" : "失败",
          "点击文稿备注": clickResult.ok ? note : `点击文稿失败：${clickResult.reason || 'unknown'}`,
          "视频分享结果": videoShare.ok ? "成功" : "失败",
          "视频分享备注": videoShare.ok ? `已创建永久有效视频分享链接，提取码：${videoShare.code}` : `视频分享失败：${videoShare.reason || 'unknown'}`,
          "最终结果": "待完成",
          "备注": videoShare.ok ? `${note} 已创建永久有效视频分享链接。` : `${note} 视频分享未完成：${videoShare.reason || 'unknown'}`,
          "异常备注": !clickResult.ok
            ? `第一阶段待返工：${isNoWengaoTab ? '视频页暂未找到“文稿”tab' : clickResult.reason || 'unknown'}；视频分享状态：${videoShare.ok ? '已完成' : videoShare.reason || 'unknown'}`
            : (videoShare.ok ? null : `第一阶段待返工：视频分享失败：${videoShare.reason || 'unknown'}`)
    };
    if (isReworkPhase) {
      Object.assign(recordFields, {
        "点击导出时间": null,
        "分享完成时间": null,
        "文稿链接": null,
        "文稿文件名": null,
        "文稿提取码": null,
        // 注意：这里必须把导出证据清回「待执行」。否则「点击导出结果=成功 但文件夹里没有 doc」
        // 的行会永远命中 前置阶段-半成品收敛（needsConvergence 把 导出=成功 当半成品证据），
        // 而半成品收敛不跑 stage2、stage3 又找不到 doc → 每轮空转、永远不重新导出。
        // 清成待执行后，本阶段的 stage2 会重新点导出，链路重新走通。
        "点击导出结果": "待执行",
        "点击导出备注": null,
        "文稿分享结果": "待执行",
        "文稿分享备注": null,
        "doc上传结果": "待执行",
        "doc上传备注": null,
        "移动结果": "待执行",
        "移动备注": null,
        "移动状态": null,
        "最终备注": null
      });
    }
    const updateRecords = (existingRecord && isReworkPhase) ? { [existingRecord.recordId]: recordFields } : null;
    // 追加语义：只改写 updateRecords 里的「异常备注」key，其它字段原样不动。
    const remarkPlan = updateRecords ? remarkAppender.prepare(updateRecords) : { changed: [], expected: new Map(), blocked: false };
    // 前置读失败 → 本条**不写库**，保留到下一轮（不覆盖原异常备注、不写伪造状态）。
    // 仅对「更新既有行」生效；新建行没有可覆盖的历史备注，不受影响。
    const writeBlocked = Boolean(updateRecords && remarkPlan.blocked);
    if (writeBlocked) {
      console.log(JSON.stringify({
        event: 'stage1_write_blocked_abnormal_remark_read_failed',
        name: item.name,
        recordId: existingRecord.recordId,
        message: '备注读取失败，待重试；本条保留到下一轮。'
      }));
    }
    const payload = updateRecords
      ? { update_records: updateRecords }
      : { create_records: [recordFields] };
    const payloadPath = T.statePath(`stage1-create-${item.name.replace(/[\\\\/:*?"<>|]/g, '_')}.json`);
    await fs.writeFile(payloadPath, JSON.stringify(payload, null, 2), 'utf8');
    console.log(JSON.stringify({ event: 'feishu_create_start', name: item.name }));
    const writeCommand = updateRecords ? '+record-batch-update' : '+record-batch-create';
    const create = writeBlocked ? null : runLark([
      'base', writeCommand,
      '--base-token', baseToken,
      '--table-id', tableId,
      '--json', `@${payloadPath}`,
      '--as', 'user',
      '--format', 'json'
    ]);
    // 写后回读核验（只读）：确认「异常备注」以追加后的文本结尾。
    if (updateRecords && !writeBlocked) remarkAppender.settle(remarkPlan.expected);
    processed.push({ ...item, videoUrl, status, recordId: existingRecord?.recordId || create?.data?.record_id_list?.[0] || null, clickResult, state, videoShare, rework: isReworkPhase, writeBlocked });
    console.log(JSON.stringify({ event: 'processed_video', name: item.name, status, videoShare: videoShare.ok ? 'ok' : videoShare.reason }));
    existingNames.add(item.name);
    await video.close().catch(() => null);
    await CDP.Close({ port, id: videoTarget.id }).catch(() => null);
    await sleep(1000);
  } catch (error) {
    failed.push({ ...item, error: error.message });
    console.log(JSON.stringify({ event: 'failed_video', name: item.name, error: error.message }));
    if (video) await video.close().catch(() => null);
    if (videoTarget?.id) await CDP.Close({ port, id: videoTarget.id }).catch(() => null);
  }
}

const report = { checkedAt: new Date().toISOString(), tableKey: T.key, batchName, totalVideos: videos.length, processed, skipped, failed };
await fs.writeFile(T.statePath('stage1-report.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({
  checkedAt: report.checkedAt,
  tableKey: T.key,
  batchName,
  totalVideos: videos.length,
  processed: processed.length,
  skipped: skipped.length,
  failed: failed.length,
  processedNames: processed.map((x) => x.name),
  failedItems: failed
}, null, 2));
process.exit(failed.length ? 2 : 0);
