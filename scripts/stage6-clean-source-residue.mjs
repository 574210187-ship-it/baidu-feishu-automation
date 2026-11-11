import fs from 'node:fs/promises';
import { resolveTableFromArgv, LARK_CLI } from './table-context.mjs';
import { listAllRecords } from './feishu-list-all.mjs';
import { baiduApiFetchJson } from './baidu-cdp-utils.mjs';

// 第六阶段是收尾审计。恢复期采用保守策略：只读取飞书和本轮扫描结果，
// 记录终态文件残留，不在缺少原始实现证据时擅自移动文件。
const T = resolveTableFromArgv();
await fs.mkdir(T.stateDir, { recursive: true });

const scanPath = T.statePath('deep-scan-baidu-videos.json');
const scan = JSON.parse(await fs.readFile(scanPath, 'utf8'));
const snapshotNames = new Set((scan.videos || []).map((item) => item.name).filter(Boolean));

// 不能使用批次开始时的 deep-scan 快照判断残留：stage4/stage5 可能已经在本轮把
// 文件移走。收尾时重新读取当前源目录，确保“残留”是实时事实而不是旧名字。
const currentEntries = [];
const sourceAttempts = [];
for (let page = 1; page <= 100; page += 1) {
  const result = await baiduApiFetchJson('/api/list', {
    order: 'name', desc: '0', showempty: '0', web: '1', page: String(page), num: '1000', dir: T.activeDir
  });
  const json = result?.json || {};
  sourceAttempts.push({ page, status: result?.status ?? null, errno: json.errno ?? null, count: Array.isArray(json.list) ? json.list.length : null, hasMore: json.has_more ?? null });
  if (result?.status !== 200 || json.errno !== 0 || !Array.isArray(json.list)) {
    throw new Error(`stage6 实时源目录读取失败：${JSON.stringify(sourceAttempts.at(-1))}`);
  }
  currentEntries.push(...json.list);
  if (!json.has_more && json.list.length < 1000) break;
}
const currentNames = new Set(currentEntries.map((item) => item.server_filename).filter(Boolean));
const fields = ['录屏名称', '状态', '移动状态'];
const result = listAllRecords({
  cli: LARK_CLI,
  baseToken: T.baseToken,
  tableId: T.tableId,
  fieldIds: fields,
  identity: 'user'
});
const returnedFields = result.data?.fields || fields;
const rows = result.data?.data || [];
const recordIds = result.data?.record_id_list || [];
const cell = (row, name) => row[returnedFields.indexOf(name)];
const scalar = (value) => Array.isArray(value) ? value[0] : value;
const terminalRows = new Map();
for (let i = 0; i < rows.length; i += 1) {
  const name = cell(rows[i], '录屏名称');
  const status = scalar(cell(rows[i], '状态'));
  if (name && (status === '已移动完成' || status === '已作废')) {
    terminalRows.set(name, { recordId: recordIds[i], status, moveStatus: cell(rows[i], '移动状态') });
  }
}

const candidates = [...currentNames]
  .map((name) => ({ name, ...terminalRows.get(name) }))
  .filter((item) => item.status && currentNames.has(item.name));
const report = {
  checkedAt: new Date().toISOString(),
  tableKey: T.key,
  mode: 'audit-only-during-recovery',
  scannedVideoCount: snapshotNames.size,
  currentSourceEntryCount: currentEntries.length,
  currentSourceMp4Count: currentEntries.filter((item) => !item.isdir && /\.mp4$/i.test(item.server_filename || '')).length,
  sourceAttempts,
  terminalResidueCandidates: candidates,
  candidates: candidates.length,
  cleaned: 0,
  failed: [],
  note: '恢复期未执行网盘移动；主移动由 stage4/stage5 完成，待原 stage6 实现恢复后再启用收尾移动。'
};
await fs.writeFile(T.statePath('stage6-source-residue-report.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({
  event: 'stage6_source_residue_complete',
  tableKey: T.key,
  mode: report.mode,
  candidates: report.candidates,
  cleaned: 0,
  failed: 0
}));
