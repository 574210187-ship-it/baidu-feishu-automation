import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import CDP from 'chrome-remote-interface';

import { resolveTableFromArgv, LARK_CLI } from './table-context.mjs';
// 「异常备注」追加语义（2026-09-17）：写入前读回现有备注 → 换行追加，绝不覆盖、不重复追加。
import { createAbnormalRemarkAppender } from './abnormal-remark-append.mjs';

const T = resolveTableFromArgv();
await fs.mkdir(T.stateDir, { recursive: true });
const port = Number(process.env.CDP_PORT || 9223);
const baseToken = T.baseToken;
const tableId = T.tableId;
const cli = LARK_CLI;
// 可观测性（2026-09-17）：模块默认 log = () => {}，调用方不传就一个事件都不输出，
// 「追加是否真生效 / 是否悄悄降级为覆盖」在日志上都看不见。传 console.log 直出 JSON 行。
const remarkAppender = createAbnormalRemarkAppender({
  cli, baseToken, tableId, identity: 'user',
  log: (line) => console.log(line)
});
const folderPath = T.activeDir;
const folderUrl = T.activeUrl;

const pad = (n) => String(n).padStart(2, '0');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cnStamp = (date = new Date()) => {
  const d = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};
const docNameForVideo = (name) => name.replace(/\.mp4$/i, '.doc');
const makeCode = () => {
  const chars = 'abcdefghijkmnopqrstuvwxyz23456789';
  let code = '';
  for (let i = 0; i < 4; i += 1) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
};

import { listAllRecords } from './feishu-list-all.mjs';

// 飞书调用统一走带重试的公共出口（临时网络错误自动重试，确定性错误立即失败）。
import { runLarkCliJson } from './lark-cli-utils.mjs';
const runLark = (args, options = {}) => runLarkCliJson(args, options);

const records = listAllRecords({
  cli,
  baseToken,
  tableId,
  fieldIds: ['录屏名称', '状态', '文稿状态', '文稿链接', '文稿文件名', '文稿提取码', '点击导出结果'],
  identity: 'user'
});

const recordIds = records.data?.record_id_list || [];
const rows = records.data?.data || [];
const currentNames = new Set(JSON.parse(await fs.readFile(T.statePath('deep-scan-baidu-videos.json'), 'utf8')).videos?.map((item) => item.name) || []);
const candidates = rows.map((row, index) => ({
  recordId: recordIds[index],
  videoName: row[0],
  status: Array.isArray(row[1]) ? row[1][0] : row[1],
  docState: Array.isArray(row[2]) ? row[2][0] : row[2],
  transcriptLink: row[3],
  docName: row[4],
  code: row[5],
  exportResult: row[6]
})).filter((row) =>
  row.videoName &&
  currentNames.has(row.videoName) &&
  row.status !== '已作废' &&
  row.status !== '已移动完成' &&
  // stage2 的安全语义是：只有源目录发现同名 doc 后，才把「点击导出结果」写成成功；
  // 刚点击导出但尚未完成时写的是「重试中」。旧过滤器只接收「成功」，导致
  // stage2 已真实点击导出、但 doc 还未被确认的行永远进不了 stage3，形成
  // “点击了导出 → 永远没有分享/上传/移动”的结构性死循环。
  (['成功', '重试中'].includes(row.exportResult) || row.docState === 'has_doc') &&
  !row.transcriptLink
);

console.log(JSON.stringify({ event: 'stage3_api_candidates', count: candidates.length }));

if (!candidates.length) {
  await fs.writeFile(T.statePath('stage3-api-report.json'), JSON.stringify({
    checkedAt: new Date().toISOString(),
    tableKey: T.key,
    candidates: 0,
    shared: [],
    missingDocs: [],
    failed: []
  }, null, 2), 'utf8');
  process.exit(0);
}

let openedFolderPage = false;
let target = (await CDP.List({ port })).find((t) =>
  t.type === 'page' &&
  t.url.includes('/disk/main') &&
    decodeURIComponent(t.url).includes(folderPath)
);
if (!target) {
  // Directory URLs carry their path after a hash fragment. CDP.New({ url })
  // can drop that fragment, so create a blank page and navigate explicitly.
  target = await CDP.New({ port, url: 'about:blank' });
  openedFolderPage = true;
  const opener = await CDP({ port, target });
  try {
    await opener.Page.enable();
    await opener.Page.navigate({ url: folderUrl });
  } finally {
    await opener.close().catch(() => null);
  }
  for (let i = 0; i < 20; i += 1) {
    await sleep(1000);
    const match = (await CDP.List({ port })).find((t) =>
      t.type === 'page' &&
      t.url.includes('/disk/main') &&
      decodeURIComponent(t.url).includes(folderPath)
    );
    if (match) {
      target = match;
      break;
    }
  }
}
if (!decodeURIComponent(target.url || '').includes(folderPath)) {
  throw new Error(`No Baidu folder page target found for ${folderPath}`);
}

const client = await CDP({ port, target });
const { Runtime, Browser } = client;
await Runtime.enable();
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
  if (!token) return { ok: false, reason: 'token not available' };

  window.__codexListAll = async (dir) => {
    const all = [];
    for (let page = 1; page <= 20; page += 1) {
      const params = new URLSearchParams({
        order: 'name',
        desc: '0',
        showempty: '0',
        web: '1',
        page: String(page),
        num: '1000',
        dir,
        bdstoken: token
      });
      const response = await fetch('/api/list?' + params.toString(), { credentials: 'include' });
      const json = await response.json();
      const list = json.list || [];
      all.push(...list);
      if (!json.has_more && list.length < 1000) break;
    }
    return all.map((item) => ({
      server_filename: item.server_filename,
      path: item.path,
      fs_id: item.fs_id,
      isdir: item.isdir
    }));
  };

  window.__codexShareFsId = async (fsId, pwd) => {
    const params = new URLSearchParams({
      channel: 'chunlei',
      bdstoken: token,
      clienttype: '0',
      app_id: '250528',
      web: '1'
    });
    const body = new URLSearchParams({
      fid_list: JSON.stringify([fsId]),
      schannel: '4',
      channel_list: '[]',
      period: '0',
      pwd
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
    return { status: response.status, json };
  };

  return { ok: true };
})()`);
if (!api?.ok) throw new Error(api?.reason || 'failed to initialize Baidu API');

const allFiles = await evalPage(`window.__codexListAll(${JSON.stringify(folderPath)})`, 60000);
const docs = new Map(allFiles
  .filter((item) => item.server_filename && /\.doc$/i.test(item.server_filename))
  .map((item) => [item.server_filename, item]));
console.log(JSON.stringify({ event: 'stage3_api_docs_loaded', docs: docs.size, files: allFiles.length }));

const shared = [];
const missingDocs = [];
const failed = [];
const updates = {};

for (const item of candidates) {
  const expectedDoc = docNameForVideo(item.videoName);
  const doc = docs.get(expectedDoc) ||
    [...docs.values()].find((file) => file.server_filename.startsWith(expectedDoc.replace(/\.doc$/i, '')));

  if (!doc) {
    missingDocs.push({ ...item, expectedDoc });
    updates[item.recordId] = {
      '状态': ['下一轮重新执行'],
      // 源目录没有同名 doc 时，不能保留上游残留的 has_doc；否则表格会出现
      // 「文稿状态=has_doc」但「文稿链接/直播稿doc 为空」的自相矛盾状态。
      '文稿状态': ['generating'],
      // 关键：把导出证据清回「待执行」。否则这一行会永远命中 前置阶段-半成品收敛
      // （needsConvergence 把 点击导出结果=成功 当半成品证据），而收敛阶段不跑 stage2、
      // 这里又找不到 doc → 每轮空转，永远不会重新导出。
      '点击导出结果': '待执行',
      '点击导出备注': `上一轮标记为已导出，但源目录里没有同名 doc（${expectedDoc}），已清回待执行，下一轮重新点导出。`,
      '文稿分享结果': '重试中',
      '文稿分享备注': `未在 ${folderPath} 找到同名 doc：${expectedDoc}。`,
      '异常备注': `第三阶段待重试：未在 ${folderPath} 找到同名 doc：${expectedDoc}。`
    };
    continue;
  }

  try {
    const shareCode = makeCode();
    const result = await evalPage(`window.__codexShareFsId(${JSON.stringify(doc.fs_id)}, ${JSON.stringify(shareCode)})`, 30000);
    const data = result?.json || {};
    if (result?.status !== 200 || data.errno !== 0) throw new Error(`share failed: ${JSON.stringify(data).slice(0, 300)}`);
    const link = data.link || data.shorturl || data.url || '';
    const code = data.pwd || data.passwd || data.password || shareCode;
    if (!link) throw new Error(`share link missing: ${JSON.stringify(data).slice(0, 300)}`);
    const now = cnStamp();
    updates[item.recordId] = {
      '文稿文件名': doc.server_filename,
      '文稿链接': link,
      '文稿提取码': code,
      // 不再写「已分享doc」过程态（8 选项方案已删除）。下游 stage3b 以 文稿链接 字段
      // 是否非空作为「文稿已分享」的真实信号，不依赖状态选项。
      '分享完成时间': now,
      '文稿分享结果': '成功',
      '文稿分享备注': `已创建永久有效文稿分享链接，提取码：${code}`,
      '备注': '已通过百度网盘接口创建永久有效文稿分享链接。'
    };
    shared.push({ ...item, docName: doc.server_filename, link, code });
    console.log(JSON.stringify({ event: 'stage3_api_shared', videoName: item.videoName, docName: doc.server_filename }));
    await sleep(500);
  } catch (error) {
    failed.push({ ...item, docName: doc.server_filename, error: error.message });
    updates[item.recordId] = {
      '状态': ['下一轮重新执行'],
      '文稿分享结果': '失败',
      '文稿分享备注': `文稿分享失败：${error.message.slice(0, 500)}`,
      '异常备注': `第三阶段异常：文稿分享失败：${error.message.slice(0, 500)}`
    };
    console.log(JSON.stringify({ event: 'stage3_api_failed', videoName: item.videoName, docName: doc.server_filename, error: error.message }));
  }
}

await client.close().catch(() => null);
// 只为本阶段新建的目录页要顺手关掉，避免批次结束时残留临时页。
if (openedFolderPage) await CDP.Close({ port, id: target.id }).catch(() => null);

if (Object.keys(updates).length) {
  // 追加语义：只改写 updates 里的「异常备注」key，其它字段原样不动。
  const remarkPlan = remarkAppender.prepare(updates);
  // 前置读失败 → 本轮不写库，本批保留到下一轮（不覆盖原异常备注、不写伪造状态）。
  if (remarkPlan.blocked) {
    console.log(JSON.stringify({
      event: 'stage3_write_blocked_abnormal_remark_read_failed',
      tableKey: T.key,
      count: Object.keys(updates).length,
      message: '备注读取失败，待重试；本批保留到下一轮。'
    }));
  } else {
    const updatePath = T.statePath('stage3-api-update-records.json');
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
}

const report = { checkedAt: new Date().toISOString(), tableKey: T.key, candidates: candidates.length, shared, missingDocs, failed };
await fs.writeFile(T.statePath('stage3-api-report.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({
  checkedAt: report.checkedAt,
  tableKey: T.key,
  candidates: candidates.length,
  shared: shared.length,
  missingDocs: missingDocs.length,
  failed: failed.length,
  missingDocNames: missingDocs.map((item) => item.expectedDoc),
  failedItems: failed.map((item) => ({ videoName: item.videoName, docName: item.docName, error: item.error }))
}, null, 2));
process.exit(failed.length ? 2 : 0);
