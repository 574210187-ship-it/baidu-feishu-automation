import fs from 'node:fs/promises';
import path from 'node:path';
import { listAllRecords } from './feishu-list-all.mjs';
import { LARK_CLI, readTablesConfig } from './table-context.mjs';

const from = new Date('2026-11-08T02:12:07+08:00');
const to = new Date('2026-11-09T02:12:07+08:00');
const text = (value) => {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(' ').trim();
  if (typeof value === 'object') return String(value.text ?? value.name ?? value.url ?? '').trim();
  return String(value).trim();
};
const docs = (value) => Array.isArray(value) ? value.length : (value ? 1 : 0);

const runDir = path.resolve('state/runs');
const names = (await fs.readdir(runDir)).filter((name) => name.endsWith('.json'));
const runs = [];
for (const name of names) {
  const file = path.join(runDir, name);
  const run = JSON.parse(await fs.readFile(file, 'utf8'));
  const started = new Date(run.startedAt);
  if (started >= from && started <= to) runs.push(run);
}
runs.sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));

const config = readTablesConfig();
const byTable = new Map(config.tables.map((table) => [table.key, { table, newRows: [], attempts: 0 }]));
for (const run of runs) {
  for (const tableResult of run.tableResults || []) {
    const bucket = byTable.get(tableResult.key);
    if (!bucket) continue;
    for (const phase of tableResult.phases || []) {
      const stage1 = (phase.stages || []).find((stage) => String(stage.name || '').endsWith(':stage1'));
      const processed = stage1?.report?.processed;
      if (Array.isArray(processed)) bucket.attempts += processed.length;
      if (phase.rework === false && Array.isArray(processed)) {
        bucket.newRows.push(...processed.map((item) => ({
          runId: run.runId,
          batchNo: run.batchNo,
          recordId: item.recordId || null,
          name: item.name || '',
          statusFromRun: item.status || '',
          sourceModified: item.modified || null,
          videoShare: item.videoShare?.ok === true,
          videoShareLink: item.videoShare?.link || null
        })));
      }
    }
  }
}

const output = { from: from.toISOString(), to: to.toISOString(), runCount: runs.length, runs: runs.map((r) => ({ runId: r.runId, batchNo: r.batchNo, startedAt: r.startedAt, finishedAt: r.finishedAt, status: r.status, stageErrors: (r.stageErrors || []).length })), tables: [] };
for (const bucket of byTable.values()) {
  const result = listAllRecords({ cli: LARK_CLI, baseToken: bucket.table.baseToken, tableId: bucket.table.tableId, fieldIds: ['录屏名称', '状态', '文稿链接', '直播稿doc', '批次号', '最后执行批次'] });
  const fields = result.data?.fields || [];
  const index = Object.fromEntries(fields.map((field, i) => [typeof field === 'string' ? field : field.name, i]));
  const ids = result.data?.record_id_list || [];
  const values = result.data?.data || [];
  const rows = new Map(values.map((row, i) => [ids[i], {
    recordId: ids[i],
    name: text(row[index['录屏名称']]),
    status: text(row[index['状态']]),
    link: text(row[index['文稿链接']]),
    docCount: docs(row[index['直播稿doc']]),
    batchNo: text(row[index['批次号']]),
    lastRun: text(row[index['最后执行批次']])
  }]));
  const entries = [];
  const seen = new Set();
  for (const item of bucket.newRows) {
    const key = item.recordId || `${item.name}|${item.sourceModified}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const current = item.recordId ? rows.get(item.recordId) : null;
    entries.push({ ...item, current: current || null, realDocComplete: Boolean(current?.link) && current.docCount === 1 });
  }
  output.tables.push({ key: bucket.table.key, label: bucket.table.label, attempts: bucket.attempts, newCandidateCount: entries.length, realDocCompleteCount: entries.filter((entry) => entry.realDocComplete).length, entries });
}
console.log(JSON.stringify(output, null, 2));
