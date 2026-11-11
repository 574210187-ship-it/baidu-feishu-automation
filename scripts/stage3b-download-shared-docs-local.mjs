import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import CDP from 'chrome-remote-interface';
import {
  cleanupBaiduTargets,
  port,
  sleep,
  baiduApiFetchJson
} from './baidu-cdp-utils.mjs';
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
// 源目录 + 已完成目录 + 该表的历史遗留目录（仅 zed 有 /6月 zed 系列）
const baiduDirs = [T.activeDir, T.doneDir, ...(T.legacyDirs || [])];
const activeDir = T.activeDir;
const downloadDir = T.downloadDir;
const attachmentField = '直播稿doc';
const phaseTargets = await fs.readFile(T.statePath('current-phase-targets.json'), 'utf8')
  .then((text) => JSON.parse(text))
  .catch(() => null);
const targetNames = phaseTargets?.targetNames?.length ? new Set(phaseTargets.targetNames) : null;

const docNameForVideo = (name) => name.replace(/\.mp4$/i, '.doc');
const safeFileName = (name) => String(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
const relativeFileArg = (filePath) => `.${path.sep}${path.basename(filePath)}`;

// 飞书调用统一走带重试的公共出口（临时网络错误自动重试，确定性错误立即失败）。
import { runLarkCliJson } from './lark-cli-utils.mjs';
const runLark = (args, options = {}) => runLarkCliJson(args, options);

// —— 幂等+收敛守卫：飞书附件字段 record-upload-attachment 是「追加」语义，
//     必须先查实时附件再决定是否上传，否则重跑会累积多个同名 doc。——
// 注意：record-get --format json 返回二维矩阵 {data:{fields:[...],data:[[cell]]}}，不是 {data:{record:{fields}}}。
function liveAtt(rid) {
  try {
    const j = runLark(['base', '+record-get', '--base-token', baseToken, '--table-id', tableId,
      '--record-id', rid, '--field-id', attachmentField, '--as', 'user', '--format', 'json']);
    const rowArr = j && j.data && Array.isArray(j.data.data) ? j.data.data[0] : null;
    if (!Array.isArray(rowArr)) return [];
    const idx = Array.isArray(j.data.fields) ? j.data.fields.indexOf(attachmentField) : 0;
    const cell = idx >= 0 ? rowArr[idx] : rowArr[0];
    return Array.isArray(cell) ? cell : [];
  } catch { return []; }
}
function removeAttach(rid, token) {
  try {
    const j = runLark(['base', '+record-remove-attachment', '--base-token', baseToken, '--table-id', tableId,
      '--record-id', rid, '--field-id', attachmentField, '--file-token', token, '--yes', '--as', 'user']);
    return j && j.ok === true;
  } catch { return false; }
}
// 收敛：已有同名 doc 则删掉多余只留 1 份；返回 { hasSame, removed }
function ensureSingle(rid, docName) {
  const att = liveAtt(rid);
  let kept = false, removed = 0, hasSame = false;
  for (const a of att) {
    if (a && a.name === docName) {
      hasSame = true;
      if (!kept) { kept = true; continue; }
    }
    if (removeAttach(rid, a.file_token)) removed++;
  }
  return { hasSame, removed };
}

const writeUpdates = async (updates) => {
  if (!Object.keys(updates).length) return;
  // 追加语义：只改写 updates 里的「异常备注」key，其它字段原样不动。
  const remarkPlan = remarkAppender.prepare(updates);
  // 前置读失败 → 本轮不写库，本批保留到下一轮（不覆盖原异常备注、不写伪造状态）。
  if (remarkPlan.blocked) {
    console.log(JSON.stringify({
      event: 'stage3b_write_blocked_abnormal_remark_read_failed',
      tableKey: T.key,
      count: Object.keys(updates).length,
      message: '备注读取失败，待重试；本批保留到下一轮。'
    }));
    return;
  }
  const updatePath = T.statePath('stage3b-download-update-records.json');
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
};

await fs.mkdir(downloadDir, { recursive: true });
await cleanupBaiduTargets({ keepMainDisk: true, mainUrl: T.activeUrl });

const records = listAllRecords({
  cli,
  baseToken,
  tableId,
  fieldIds: ['录屏名称', '文稿链接', '文稿文件名', attachmentField, '状态'],
  identity: 'user'
});

const recordIds = records.data?.record_id_list || [];
const rows = records.data?.data || [];
const fields = records.data?.fields || ['录屏名称', '文稿链接', '文稿文件名', attachmentField, '状态'];
const getCell = (row, name) => row[fields.indexOf(name)];
const attachmentCount = (cell) => Array.isArray(cell) ? cell.length : 0;
const candidates = rows.map((row, index) => {
  const statusCell = getCell(row, '状态');
  const status = Array.isArray(statusCell) ? statusCell[0] : statusCell;
  return {
    recordId: recordIds[index],
    videoName: getCell(row, '录屏名称'),
    transcriptLink: getCell(row, '文稿链接'),
    docName: getCell(row, '文稿文件名'),
    docAttachmentCount: attachmentCount(getCell(row, attachmentField)),
    status
  };
}).filter((row) =>
  row.videoName &&
  (!targetNames || targetNames.has(row.videoName)) &&
  row.transcriptLink &&
  row.docAttachmentCount === 0 &&
  row.status !== '已作废' &&
  row.status !== '已移动完成'
);

console.log(JSON.stringify({ event: 'stage3b_candidates', count: candidates.length, downloadDir }));

if (!candidates.length) {
  await fs.writeFile(T.statePath('stage3b-download-report.json'), JSON.stringify({
    checkedAt: new Date().toISOString(),
    downloadDir,
    candidates: 0,
    uploaded: [],
    failed: []
  }, null, 2), 'utf8');
  process.exit(0);
}

const ensureBaiduCdp = () => {
  const result = spawnSync(process.execPath, ['scripts/ensure-baidu-cdp.mjs', `--table=${T.key}`], {
    encoding: 'utf8',
    timeout: 45000
  });
  if (result.status !== 0) {
    throw new Error((result.stdout || result.stderr || `ensure-baidu-cdp exited ${result.status}`).trim());
  }
};

const failAllBeforeCdp = async (reason) => {
  const updates = Object.fromEntries(candidates.map((item) => [
    item.recordId,
    {
      'doc上传结果': '重试中',
      '状态': ['下一轮重新执行'],
      'doc上传备注': `待下载：${reason}，下轮继续重试。`,
      '备注': `待下载：${reason}，下轮继续重试。`,
      '异常备注': `第三阶段补充待重试：${reason}`
    }
  ]));
  await writeUpdates(updates);
  const report = {
    checkedAt: new Date().toISOString(),
    downloadDir,
    candidates: candidates.length,
    uploaded: [],
    failed: candidates.map((item) => ({ ...item, error: reason }))
  };
  await fs.writeFile(T.statePath('stage3b-download-report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ event: 'stage3b_blocked', reason, candidates: candidates.length }, null, 2));
  process.exit(2);
};

let targets = await CDP.List({ port }).catch(async () => {
  try {
    ensureBaiduCdp();
    return await CDP.List({ port });
  } catch (error) {
    await failAllBeforeCdp(`后台 Chrome/CDP 不可用，且自动启动失败：${error.message}`);
  }
});
const target = targets.find((t) =>
  t.type === 'page' &&
  t.url.includes('pan.baidu.com') &&
  t.url.includes('/disk/main')
);
if (!target) {
  await failAllBeforeCdp('后台 Chrome/CDP 未找到已登录的百度网盘主页面');
}

const client = await CDP({ port, target });
const { Browser, Network } = client;
await Network.enable().catch(() => null);
await Browser.getWindowForTarget({ targetId: target.id }).then(({ windowId }) =>
  Browser.setWindowBounds({ windowId, bounds: { left: -32000, top: -32000, width: 1500, height: 950, windowState: 'normal' } })
).catch(() => null);

// Doc download uses a Node-side fetch with the full cookie jar (incl. HttpOnly BDUSS),
// which is what Baidu's dlink CDN requires. The duplicate-STOKEN -6 problem only affects
// /api/list; the file dlink is not sensitive to it, so the original getAllCookies approach
// (proven working in the 03:50 run) is the right choice here. Node fetch is also immune
// to the CORS issue that broke the page-context download.
const { cookies } = await Network.getAllCookies().catch(() => ({ cookies: [] }));
const baiduCookie = cookies
  .filter((item) => String(item.domain || '').includes('baidu.com'))
  .map((item) => `${item.name}=${item.value}`)
  .join('; ');

// Baidu API list/filemetas calls go through an authenticated page context (see
// baidu-cdp-utils.mjs) to avoid the Node-side duplicate-cookie errno=-6 problem.
const baiduFetchJson = async (apiPath, params, timeoutMs = 60000) => baiduApiFetchJson(apiPath, params, { timeoutMs });

const listAll = async (dir) => {
  const all = [];
  for (let page = 1; page <= 20; page += 1) {
    const result = await baiduFetchJson('/api/list', {
      order: 'name',
      desc: '0',
      showempty: '0',
      web: '1',
      page: String(page),
      num: '1000',
      dir
    });
    if (result.status !== 200 || result.json?.errno !== 0 || !Array.isArray(result.json.list)) {
      throw new Error(`list failed for ${dir}: ${JSON.stringify({ status: result.status, errno: result.json?.errno, raw: result.json?.raw }).slice(0, 260)}`);
    }
    const list = result.json.list;
    all.push(...list);
    if (!result.json.has_more && list.length < 1000) break;
  }
  return all.map((item) => ({
    server_filename: item.server_filename,
    path: item.path,
    fs_id: item.fs_id,
    dlink: item.dlink || '',
    isdir: item.isdir
  }));
};

const fileMeta = async (filePath) => baiduFetchJson('/api/filemetas', {
  target: JSON.stringify([filePath]),
  dlink: '1',
  web: '1'
}, 30000);

const downloadViaFetch = async (url, targetPath, timeoutMs = 90000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        cookie: baiduCookie,
        'user-agent': 'Mozilla/5.0'
      }
    });
    if (!response.ok) throw new Error(`download HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) throw new Error('downloaded file is empty');
    await fs.writeFile(targetPath, bytes);
    return await fs.stat(targetPath);
  } finally {
    clearTimeout(timer);
  }
};

const dirResults = await Promise.all(baiduDirs.map((dir) =>
  listAll(dir)
    .then((files) => ({ dir, files }))
    .catch((error) => ({ dir, files: [], error: error.message }))
));

const docs = new Map();
for (const { dir, files } of dirResults) {
  for (const item of files) {
    if (!item.server_filename || !/\.doc$/i.test(item.server_filename)) continue;
    docs.set(item.server_filename, { ...item, dir });
  }
}
console.log(JSON.stringify({
  event: 'stage3b_docs_loaded',
  dirs: dirResults.map((item) => ({ dir: item.dir, files: item.files.length, error: item.error || null })),
  docs: docs.size
}));

const uploaded = [];
const failed = [];
const updates = {};

try {
  for (const item of candidates) {
    const expectedDoc = item.docName || docNameForVideo(item.videoName);
    const doc = docs.get(expectedDoc) ||
      [...docs.values()].find((file) => file.server_filename.startsWith(expectedDoc.replace(/\.doc$/i, '')));

    if (!doc) {
      failed.push({ ...item, expectedDoc, error: 'doc not found in source or completed folder' });
      continue;
    }

    const localPath = path.join(downloadDir, safeFileName(doc.server_filename));
    try {
      let stat = await fs.stat(localPath).catch(() => null);
      if (!stat || stat.size <= 0) {
        let dlink = doc.dlink;
        if (!dlink) {
          const meta = await fileMeta(doc.path);
          if (meta?.status !== 200 || meta?.json?.errno !== 0) {
            throw new Error(`filemetas failed: ${JSON.stringify(meta?.json || meta).slice(0, 260)}`);
          }
          dlink = meta.json?.info?.[0]?.dlink || '';
        }
        if (!dlink) throw new Error('download link missing from Baidu filemetas API');
        stat = await downloadViaFetch(dlink, localPath);
      }
      if (stat.size <= 0) throw new Error('downloaded file is empty');

      // ① 上传前守卫：已有同名 doc → 跳过上传，并清掉多余副本（防重复累积）
      const docBaseName = safeFileName(doc.server_filename);
      const pre = ensureSingle(item.recordId, docBaseName);
      if (pre.hasSame) {
        uploaded.push({ ...item, docName: docBaseName, localPath, bytes: stat.size, skipped: true, removed: pre.removed });
        console.log(JSON.stringify({ event: 'stage3b_skip_exists', videoName: item.videoName, docName: docBaseName, removed: pre.removed }));
        await sleep(300);
        continue;
      }

      runLark([
        'base', '+record-upload-attachment',
        '--base-token', baseToken,
        '--table-id', tableId,
        '--record-id', item.recordId,
        '--field-id', attachmentField,
        '--file', relativeFileArg(localPath),
        '--as', 'user',
        '--format', 'json'
      ], { cwd: path.dirname(localPath) });

      // ② 上传后收敛：复查实时附件，把除「刚上传那份」以外的全部清掉，确保恰好 1 份
      const post = ensureSingle(item.recordId, docBaseName);
      if (post.removed > 0) {
        console.log(JSON.stringify({ event: 'stage3b_dedup', videoName: item.videoName, docName: docBaseName, removed: post.removed }));
      }
      updates[item.recordId] = {
        // 不再写「doc已放入」过程态（8 选项方案已删除）。stage4 以 直播稿doc 单元格
        // 附件数 > 0 作为「可移动」的真实信号，不依赖状态选项。
        'doc上传结果': '成功',
        'doc上传备注': `已上传直播稿doc附件：${doc.server_filename}，缓存大小 ${stat.size} 字节。`,
        '备注': '文稿分享链接已写入，直播稿doc附件已上传到多维表。'
      };
      uploaded.push({ ...item, docName: doc.server_filename, localPath, bytes: stat.size });
      console.log(JSON.stringify({ event: 'stage3b_uploaded_doc_attachment', videoName: item.videoName, docName: doc.server_filename, localPath, bytes: stat.size }));
      await sleep(300);
    } catch (error) {
      updates[item.recordId] = {
        '状态': ['下一轮重新执行'],
        'doc上传结果': '失败',
        'doc上传备注': `直播稿doc附件上传失败：${error.message.slice(0, 500)}`,
        '备注': `直播稿doc附件上传失败，下轮继续重试：${error.message.slice(0, 180)}`,
        '异常备注': `第三阶段补充异常：直播稿doc附件上传失败：${error.message.slice(0, 500)}`
      };
      failed.push({ ...item, docName: doc.server_filename, localPath, error: error.message });
      console.log(JSON.stringify({ event: 'stage3b_failed', videoName: item.videoName, docName: doc.server_filename, error: error.message }));
    }
  }
} finally {
  await cleanupBaiduTargets({ keepMainDisk: true, mainUrl: T.activeUrl });
}

console.log(JSON.stringify({ event: 'stage3b_skip_client_close', reason: 'avoid Node v24 Windows chrome-remote-interface close assertion' }));

await writeUpdates(updates);

const report = { checkedAt: new Date().toISOString(), downloadDir, candidates: candidates.length, uploaded, failed };
await fs.writeFile(T.statePath('stage3b-download-report.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({
  event: 'stage3b_complete',
  candidates: candidates.length,
  uploaded: uploaded.length,
  failed: failed.length,
  failedItems: failed.map((item) => ({ videoName: item.videoName, docName: item.docName, error: item.error }))
}, null, 2));
process.exit(failed.length ? 2 : 0);
