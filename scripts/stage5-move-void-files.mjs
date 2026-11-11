import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import CDP from 'chrome-remote-interface';
import { cleanupBaiduTargets, port, sleep } from './baidu-cdp-utils.mjs';
import { listAllRecords } from './feishu-list-all.mjs';
import { resolveTableFromArgv, LARK_CLI } from './table-context.mjs';
// 「异常备注」追加语义（2026-09-17）：写入前读回现有备注 → 换行追加，绝不覆盖、不重复追加。
import { createAbnormalRemarkAppender } from './abnormal-remark-append.mjs';

const T = resolveTableFromArgv();
await fs.mkdir(T.stateDir, { recursive: true });
const baseToken = T.baseToken;
const tableId = T.tableId;
const cli = LARK_CLI;
// 可观测性（2026-09-17）：模块默认 log = () => {}，调用方不传就一个事件都不输出，
// 「追加是否真生效 / 是否悄悄降级为覆盖」在日志上都看不见。传 console.log 直出 JSON 行。
const remarkAppender = createAbnormalRemarkAppender({
  cli, baseToken, tableId, identity: 'user',
  log: (line) => console.log(line)
});
const srcDir = T.activeDir;
const voidDir = T.voidDir;

const pad = (n) => String(n).padStart(2, '0');
const cnStamp = (date = new Date()) => {
  const d = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};
const pathJoin = (dir, name) => `${dir.replace(/\/$/, '')}/${name}`;
const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  sleep(ms).then(() => {
    throw new Error(`${label} timed out after ${ms}ms`);
  })
]);

// 飞书调用统一走带重试的公共出口（临时网络错误自动重试，确定性错误立即失败）。
import { runLarkCliJson } from './lark-cli-utils.mjs';
const runLark = (args, options = {}) => runLarkCliJson(args, options);

const records = listAllRecords({
  cli,
  baseToken,
  tableId,
  fieldIds: ['录屏名称', '状态', '移动状态'],
  identity: 'user'
});
const recordIds = records.data?.record_id_list || [];
const rows = records.data?.data || [];
const fields = records.data?.fields || ['录屏名称', '状态', '移动状态'];
const getCell = (row, name) => row[fields.indexOf(name)];
const currentNames = new Set(JSON.parse(await fs.readFile(T.statePath('deep-scan-baidu-videos.json'), 'utf8')).videos?.map((item) => item.name) || []);
const candidates = rows.map((row, index) => {
  const statusCell = getCell(row, '状态');
  return {
    recordId: recordIds[index],
    videoName: getCell(row, '录屏名称'),
    status: Array.isArray(statusCell) ? statusCell[0] : statusCell,
    moveStatus: getCell(row, '移动状态')
  };
}).filter((row) =>
  row.videoName &&
  currentNames.has(row.videoName) &&
  row.status === '已作废'
);

console.log(JSON.stringify({ event: 'stage5_void_candidates', tableKey: T.key, count: candidates.length }));
if (!candidates.length) {
  await fs.writeFile(T.statePath('stage5-void-report.json'), JSON.stringify({
    checkedAt: new Date().toISOString(),
    tableKey: T.key,
    candidates: 0,
    moved: [],
    failed: []
  }, null, 2), 'utf8');
  process.exit(0);
}

let client;
const moved = [];
const failed = [];
const updates = {};

// ── 前置读闸门（2026-09-23）：必须在打开 CDP / 移动任何百度文件**之前**完成。
// 读失败 ⇒ 本轮不移动、不写库、零副作用退出，该行保留到下一轮。
// 这样既满足「不得移动百度文件」，又避免「文件已移走、飞书状态没改」的状态↔目录不一致。
if (!remarkAppender.preflight()) {
  await fs.writeFile(T.statePath('stage5-void-report.json'), JSON.stringify({
    checkedAt: new Date().toISOString(),
    tableKey: T.key,
    candidates: candidates.length,
    blocked: true,
    reason: '备注读取失败，待重试',
    note: '本轮未移动任何百度文件、未写飞书；该批保留到下一轮重新执行。',
    moved: [],
    failed: []
  }, null, 2), 'utf8');
  console.log(JSON.stringify({
    event: 'stage5_void_blocked_abnormal_remark_read_failed',
    tableKey: T.key,
    candidates: candidates.length,
    message: '备注读取失败，待重试；本轮不移动、不写库。'
  }));
  process.exit(2);
}

try {
  const findFolderPage = async () => (await withTimeout(CDP.List({ port }), 10000, 'CDP.List')).find((t) =>
    t.type === 'page' &&
    t.url.includes('/disk/main') &&
    decodeURIComponent(t.url).includes(srcDir)
  );

  let target = await findFolderPage();
  if (!target) {
    const created = await CDP.New({ port, url: 'about:blank' }).catch(() => null);
    if (created) {
      const opener = await CDP({ port, target: created }).catch(() => null);
      if (opener) {
        await opener.Page.enable().catch(() => null);
        await opener.Page.navigate({ url: T.activeUrl }).catch(() => null);
        await opener.close().catch(() => null);
      }
      for (let i = 0; i < 20 && !target; i += 1) {
        await sleep(1000);
        target = await findFolderPage();
      }
    }
  }
  if (!target) throw new Error(`No logged-in Baidu folder page found for ${srcDir}（表 ${T.key}）`);

  client = await withTimeout(CDP({ port, target }), 10000, 'CDP connect');
  const { Runtime, Browser } = client;
  await withTimeout(Runtime.enable(), 10000, 'Runtime.enable');
  await Browser.getWindowForTarget({ targetId: target.id }).then(({ windowId }) =>
    Browser.setWindowBounds({ windowId, bounds: { left: -32000, top: -32000, width: 1500, height: 950, windowState: 'normal' } })
  ).catch(() => null);

  const evalPage = async (expression, timeout = 30000) => {
    const result = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true, timeout });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Runtime.evaluate failed');
    }
    return result.result.value;
  };

  const api = await evalPage(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    for (let i = 0; i < 40; i += 1) {
      if (document.body && document.body.innerText.includes('已压缩')) break;
      await sleep(500);
    }
    const getToken = () => {
      try {
        if (window.locals?.get) return window.locals.get('bdstoken') || window.locals.get('csrf') || '';
      } catch {}
      return window.locals?.bdstoken || window.locals?.csrf || window.yunData?.MYBDSTOKEN || window.yunData?.bdstoken || window.bdstoken || '';
    };
    const token = getToken();
    if (!token) return { ok: false, reason: 'bdstoken not available in page context' };
    window.__codexMoveFile = async ({ source, destDir, newname }) => {
      const params = new URLSearchParams({ opera: 'move', async: '2', onnest: 'fail', bdstoken: token });
      const body = new URLSearchParams({
        filelist: JSON.stringify([{ path: source, dest: destDir, newname, ondup: 'newcopy' }])
      });
      const response = await fetch('/api/filemanager?' + params.toString(), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body
      });
      const text = await response.text();
      let json;
      try { json = JSON.parse(text); } catch { json = { raw: text }; }
      return { status: response.status, json };
    };
    window.__codexDeleteFile = async ({ path }) => {
      const params = new URLSearchParams({ opera: 'delete', async: '2', bdstoken: token });
      const body = new URLSearchParams({ filelist: JSON.stringify([path]) });
      const response = await fetch('/api/filemanager?' + params.toString(), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body
      });
      const text = await response.text();
      let json;
      try { json = JSON.parse(text); } catch { json = { raw: text }; }
      return { status: response.status, json };
    };
    window.__codexListDir = async (dir) => {
      const params = new URLSearchParams({ order: 'name', desc: '0', showempty: '0', web: '1', page: '1', num: '5000', dir, bdstoken: token });
      const response = await fetch('/api/list?' + params.toString(), { credentials: 'include' });
      const text = await response.text();
      let json;
      try { json = JSON.parse(text); } catch { json = { raw: text }; }
      return { status: response.status, json };
    };
    return { ok: true };
  })()`);
  if (!api?.ok) throw new Error(api?.reason || 'failed to initialize Baidu page API');

  const listDir = async (dir) => {
    const result = await evalPage(`window.__codexListDir(${JSON.stringify(dir)})`, 30000);
    return new Set((result?.json?.list || []).map((item) => item.server_filename).filter(Boolean));
  };
  let voidNames = await listDir(voidDir);
  let srcNames = await listDir(srcDir);

  for (const item of candidates) {
    let ok = false;
    let last = null;
    if (voidNames.has(item.videoName) && srcNames.has(item.videoName)) {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await sleep(attempt === 1 ? 800 : 3000);
        last = await evalPage(`window.__codexDeleteFile(${JSON.stringify({
          path: pathJoin(srcDir, item.videoName)
        })})`, 30000);
        srcNames = await listDir(srcDir).catch(() => srcNames);
        if (!srcNames.has(item.videoName)) {
          ok = true;
          last = { reason: 'source_duplicate_deleted_after_void_exists', response: last };
          break;
        }
      }
    } else if (voidNames.has(item.videoName)) {
      ok = true;
      last = { reason: 'already_in_void_and_not_in_source' };
    } else if (!srcNames.has(item.videoName)) {
      ok = true;
      last = { reason: 'not_in_source_dir' };
    } else {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await sleep(attempt === 1 ? 800 : 3000);
        last = await evalPage(`window.__codexMoveFile(${JSON.stringify({
          source: pathJoin(srcDir, item.videoName),
          destDir: voidDir,
          newname: item.videoName
        })})`, 30000);
        const errno = last?.json?.errno;
        if (last?.status === 200 && (errno === 0 || errno === undefined && last?.json?.taskid)) {
          ok = true;
          break;
        }
        voidNames = await listDir(voidDir).catch(() => voidNames);
        srcNames = await listDir(srcDir).catch(() => srcNames);
        if (voidNames.has(item.videoName) && !srcNames.has(item.videoName)) {
          ok = true;
          break;
        }
      }
    }

    if (ok) {
      const now = cnStamp();
      updates[item.recordId] = {
        // 作废移动成功必须同时落主状态。否则「状态 ↔ 网盘目录」不一致：
        // 视频已经躺在 /作废 里，行却还停在旧状态，下一轮会被当成待处理重新捞起来。
        '状态': ['已作废'],
        '移动状态': '已作废移动',
        '移动完成时间': now,
        '移动结果': '成功',
        '移动备注': `已将确认有问题的视频移动到 ${voidDir}。`,
        '最终结果': '作废',
        '最终备注': '视频本身确认有问题，已移动到作废目录。',
        '最终完成时间': now
      };
      moved.push({ ...item, response: last });
    } else {
      updates[item.recordId] = {
        '状态': ['下一轮重新执行'],
        '移动状态': '作废移动失败',
        '移动结果': '失败',
        '移动备注': `作废移动失败：${JSON.stringify(last).slice(0, 500)}`,
        '最终结果': '未完成',
        '最终备注': '作废移动失败，下一轮重新执行。',
        '异常备注': `第五阶段异常：作废移动失败：${JSON.stringify(last).slice(0, 500)}`
      };
      failed.push({ ...item, response: last });
    }
  }
} finally {
  if (client) await client.close().catch(() => null);
  await cleanupBaiduTargets({ keepMainDisk: true, mainUrl: T.activeUrl });
}

if (Object.keys(updates).length) {
  // 追加语义：只改写 updates 里的「异常备注」key，其它字段原样不动。
  const remarkPlan = remarkAppender.prepare(updates);
  // 读失败时 prepare 已把「异常备注」key 从 updates 里摘掉 → 绝不覆盖原值。
  // stage5 的文件**已经移动完**，此时必须把状态/移动结果写下去，否则会留下
  // 「文件已在 /作废、飞书状态没改」的状态↔目录不一致。故此处照写（只是不追加备注）。
  if (remarkPlan.blocked) {
    console.log(JSON.stringify({
      event: 'stage5_abnormal_remark_blocked_status_still_written',
      tableKey: T.key,
      records: Object.keys(updates).length,
      message: '备注读取失败，待重试；本轮跳过备注追加，仅写状态列以保持状态↔目录一致。'
    }));
  }
  const updatePath = T.statePath('stage5-void-update-records.json');
  await fs.writeFile(updatePath, JSON.stringify({ update_records: updates }, null, 2), 'utf8');
  runLark([
    'base', '+record-batch-update',
    '--base-token', baseToken,
    '--table-id', tableId,
    '--json', `@${updatePath}`,
    '--as', 'user',
    '--format', 'json'
  ]);
  // 写后回读核验（只读）：确认「异常备注」以追加后的文本结尾。
  remarkAppender.settle(remarkPlan.expected);
}

const report = { checkedAt: new Date().toISOString(), tableKey: T.key, candidates: candidates.length, moved, failed };
await fs.writeFile(T.statePath('stage5-void-report.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({
  event: 'stage5_void_complete',
  tableKey: T.key,
  candidates: candidates.length,
  moved: moved.length,
  failed: failed.length
}));
process.exit(failed.length ? 2 : 0);
