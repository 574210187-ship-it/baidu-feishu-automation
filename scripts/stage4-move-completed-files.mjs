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
const doneDir = T.doneDir;
const attachmentField = '直播稿doc';

const pad = (n) => String(n).padStart(2, '0');
const cnStamp = (date = new Date()) => {
  const d = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};
const docNameForVideo = (name) => name.replace(/\.mp4$/i, '.doc');
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
  fieldIds: ['录屏名称', '文稿链接', '文稿文件名', attachmentField, '状态', '移动状态'],
  identity: 'user'
});

const recordIds = records.data?.record_id_list || [];
const rows = records.data?.data || [];
const fields = records.data?.fields || ['录屏名称', '文稿链接', '文稿文件名', attachmentField, '状态', '移动状态'];
const getCell = (row, name) => row[fields.indexOf(name)];
const attachmentCount = (cell) => Array.isArray(cell) ? cell.length : 0;
const currentNames = new Set(JSON.parse(await fs.readFile(T.statePath('deep-scan-baidu-videos.json'), 'utf8')).videos?.map((item) => item.name) || []);
const candidates = rows.map((row, index) => ({
  recordId: recordIds[index],
  videoName: getCell(row, '录屏名称'),
  transcriptLink: getCell(row, '文稿链接'),
  docName: getCell(row, '文稿文件名'),
  docAttachmentCount: attachmentCount(getCell(row, attachmentField)),
  status: Array.isArray(getCell(row, '状态')) ? getCell(row, '状态')[0] : getCell(row, '状态'),
  moveStatus: getCell(row, '移动状态')
})).filter((row) =>
  // 新的已完成判定必须闭合：只有返工态、文稿链接已回读、且恰有一个直播稿附件，
  // 才允许把源视频移动到“已完成”。历史已完成行不再作为 stage4 候选，避免重复搬运，
  // 也避免再次制造“状态已完成但文稿链接为空”的记录。
  row.videoName &&
  currentNames.has(row.videoName) &&
  row.status === '下一轮重新执行' &&
  row.moveStatus !== '已移动' &&
  Boolean(row.transcriptLink) &&
  row.docAttachmentCount === 1
);

console.log(JSON.stringify({ event: 'stage4_candidates', count: candidates.length }));

if (!candidates.length) {
  await fs.writeFile(T.statePath('stage4-report.json'), JSON.stringify({
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
  await fs.writeFile(T.statePath('stage4-report.json'), JSON.stringify({
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
    event: 'stage4_move_blocked_abnormal_remark_read_failed',
    tableKey: T.key,
    candidates: candidates.length,
    message: '备注读取失败，待重试；本轮不移动、不写库。'
  }));
  process.exit(2);
}

try {
  console.log(JSON.stringify({ event: 'stage4_cdp_list_start' }));
  // 取本表目录页：优先复用已打开的页面，没有就新开一个。
  // 原实现只"查找"不"新建"，而批次保留的唯一主页是 zed 目录页，
  // jiang/yichen 会找不到目标页导致整个 stage4 被跳过（视频不移动）。
  const findFolderPage = async () => (await withTimeout(CDP.List({ port }), 10000, 'CDP.List')).find((t) =>
    t.type === 'page' &&
    t.url.includes('/disk/main') &&
    decodeURIComponent(t.url).includes(srcDir)
  );

  let target = await findFolderPage();
  if (!target) {
    // 目录 URL 带 # 片段，CDP.New 建页会丢掉 path，必须建页后 Page.navigate 显式导航。
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
    console.log(JSON.stringify({ event: 'stage4_folder_page', tableKey: T.key, opened: Boolean(target), url: T.activeUrl }));
  }
  if (!target) throw new Error(`No logged-in Baidu folder page found for ${srcDir}（表 ${T.key}）`);

  console.log(JSON.stringify({ event: 'stage4_cdp_target', id: target.id, url: target.url }));
  client = await withTimeout(CDP({ port, target }), 10000, 'CDP connect');
  const { Runtime, Browser } = client;
  console.log(JSON.stringify({ event: 'stage4_cdp_connected' }));
  await withTimeout(Runtime.enable(), 10000, 'Runtime.enable');

  await Browser.getWindowForTarget({ targetId: target.id }).catch(() => null);
  await sleep(1000);
  console.log(JSON.stringify({ event: 'stage4_page_ready' }));

  const evalPage = async (expression, timeout = 30000) => {
    const result = await Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: true,
      timeout
    });
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
        if (window.locals?.get) {
          const token = window.locals.get('bdstoken') || window.locals.get('csrf');
          if (token) return token;
        }
      } catch {}
      return window.locals?.bdstoken || window.locals?.csrf || window.yunData?.MYBDSTOKEN || window.yunData?.bdstoken || window.bdstoken || '';
    };
    const token = getToken();
    if (!token) return { ok: false, reason: 'bdstoken not available in page context' };

    window.__codexMoveFile = async ({ source, destDir, newname }) => {
      const params = new URLSearchParams({
        opera: 'move',
        async: '2',
        onnest: 'fail',
        bdstoken: token
      });
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
      const params = new URLSearchParams({
        order: 'name',
        desc: '0',
        showempty: '0',
        web: '1',
        page: '1',
        num: '5000',
        dir,
        bdstoken: token
      });
      const response = await fetch('/api/list?' + params.toString(), { credentials: 'include' });
      const text = await response.text();
      let json;
      try { json = JSON.parse(text); } catch { json = { raw: text }; }
      return { status: response.status, json };
    };

    return { ok: true };
  })()`);

  if (!api?.ok) throw new Error(api?.reason || 'failed to initialize Baidu page API');

  const listDone = async () => {
    const result = await evalPage(`window.__codexListDir(${JSON.stringify(doneDir)})`, 30000);
    const list = result?.json?.list || [];
    return new Set(list.map((item) => item.server_filename).filter(Boolean));
  };

  const listSrc = async () => {
    const result = await evalPage(`window.__codexListDir(${JSON.stringify(srcDir)})`, 30000);
    const list = result?.json?.list || [];
    return new Set(list.map((item) => item.server_filename).filter(Boolean));
  };

  let doneNames = await listDone();
  let srcNames = await listSrc();

  for (const item of candidates) {
    const docName = item.docName || docNameForVideo(item.videoName);
    const files = [item.videoName, docName];
    const fileResults = [];
    let allOk = true;

    console.log(JSON.stringify({ event: 'stage4_move_start', videoName: item.videoName, docName }));

    for (const fileName of files) {
      if (doneNames.has(fileName) && srcNames.has(fileName)) {
        let deleteResult = null;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          await sleep(attempt === 1 ? 800 : 3000);
          deleteResult = await evalPage(`window.__codexDeleteFile(${JSON.stringify({
            path: pathJoin(srcDir, fileName)
          })})`, 30000);
          srcNames = await listSrc().catch(() => srcNames);
          if (!srcNames.has(fileName)) break;
        }
        if (!srcNames.has(fileName)) {
          fileResults.push({ fileName, ok: true, reason: 'source_duplicate_deleted_after_completed_exists', response: deleteResult?.json });
          continue;
        }
        allOk = false;
        fileResults.push({ fileName, ok: false, reason: 'source_duplicate_delete_failed', response: deleteResult?.json, status: deleteResult?.status });
        continue;
      }

      if (doneNames.has(fileName)) {
        fileResults.push({ fileName, ok: true, reason: 'already_in_completed_and_not_in_source' });
        continue;
      }

      // If the doc is not present in the source dir (e.g. a legacy record whose doc was
      // already uploaded to Feishu from another location), skip it — the mp4 is the only
      // Baidu artifact to move, and the doc is already delivered to Feishu.
      if (fileName !== item.videoName && !srcNames.has(fileName)) {
        fileResults.push({ fileName, ok: true, reason: 'doc_not_in_source_dir_but_uploaded_to_feishu' });
        continue;
      }

      let result = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await sleep(attempt === 1 ? 800 : 3000);
        result = await evalPage(`window.__codexMoveFile(${JSON.stringify({
          source: pathJoin(srcDir, fileName),
          destDir: doneDir,
          newname: fileName
        })})`, 30000);
        const errno = result?.json?.errno;
        if (result?.status === 200 && (errno === 0 || errno === undefined && result?.json?.taskid)) break;
        doneNames = await listDone().catch(() => doneNames);
        srcNames = await listSrc().catch(() => srcNames);
        if (doneNames.has(fileName) && !srcNames.has(fileName)) break;
      }

      const errno = result?.json?.errno;
      if (result?.status === 200 && (errno === 0 || errno === undefined && result?.json?.taskid)) {
        fileResults.push({ fileName, ok: true, response: result.json });
        doneNames.add(fileName);
        continue;
      }

      doneNames = await listDone().catch(() => doneNames);
      srcNames = await listSrc().catch(() => srcNames);
      if (doneNames.has(fileName) && !srcNames.has(fileName)) {
        fileResults.push({ fileName, ok: true, reason: 'already_in_completed_after_error', response: result?.json });
        continue;
      }

      allOk = false;
      fileResults.push({ fileName, ok: false, response: result?.json, status: result?.status });
    }

    if (allOk) {
      const now = cnStamp();
      updates[item.recordId] = {
        '状态': ['已移动完成'],
        '移动状态': '已移动',
        '移动完成时间': now,
        '移动结果': '成功',
        '移动备注': `已移动 mp4 和 doc 到 ${doneDir}。`,
        '最终结果': '完成',
        '最终备注': '视频分享、文稿分享、doc附件上传、移动均已完成。',
        '最终完成时间': now
      };
      moved.push({ ...item, docName, files: fileResults });
      console.log(JSON.stringify({ event: 'stage4_moved', videoName: item.videoName }));
    } else {
      updates[item.recordId] = {
        '状态': ['下一轮重新执行'],
        '移动状态': '移动失败',
        '移动结果': '失败',
        '移动备注': `移动失败：${JSON.stringify(fileResults).slice(0, 500)}`,
        '最终结果': '未完成',
        '最终备注': '移动阶段失败，等待下一批返工。',
        '异常备注': `第四阶段异常：移动失败：${JSON.stringify(fileResults).slice(0, 500)}`
      };
      failed.push({ ...item, docName, files: fileResults });
      console.log(JSON.stringify({ event: 'stage4_failed', videoName: item.videoName, files: fileResults }));
    }
  }
} finally {
  if (client) await client.close().catch(() => {});
  await cleanupBaiduTargets({ keepMainDisk: true, mainUrl: T.activeUrl });
}

if (Object.keys(updates).length) {
  // 追加语义：只改写 updates 里的「异常备注」key，其它字段原样不动。
  const remarkPlan = remarkAppender.prepare(updates);
  // 读失败时 prepare 已把「异常备注」key 从 updates 里摘掉 → 绝不覆盖原值。
  // stage4 的文件**已经移动完**，此时必须把状态/移动结果等字段写下去，
  // 否则会留下「文件已移走、飞书状态没改」的状态↔目录不一致。故此处照写（只是不追加备注）。
  if (remarkPlan.blocked) {
    console.log(JSON.stringify({
      event: 'stage4_abnormal_remark_blocked_status_still_written',
      tableKey: T.key,
      records: Object.keys(updates).length,
      message: '备注读取失败，待重试；本轮跳过备注追加，仅写状态列以保持状态↔目录一致。'
    }));
  }
  const updatePath = T.statePath('stage4-update-records.json');
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
await fs.writeFile(T.statePath('stage4-report.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({
  event: 'stage4_complete',
  tableKey: T.key,
  candidates: candidates.length,
  moved: moved.length,
  failed: failed.length
}));
