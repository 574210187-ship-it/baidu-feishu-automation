// 三态只读报表：全量分页回读三张业务表，不写飞书、不碰百度页面。
// 输出 latest 与带时间戳的证据，供巡检/看守器判断真实闭合情况。
import fs from 'node:fs/promises';
import { listAllRecords } from './feishu-list-all.mjs';
import { LARK_CLI, readTablesConfig } from './table-context.mjs';

const STATUS = new Set(['已移动完成', '已作废', '下一轮重新执行']);
const text = (value) => {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(' ').trim();
  if (typeof value === 'object') return String(value.text ?? value.name ?? value.url ?? '').trim();
  return String(value).trim();
};
const docCount = (value) => Array.isArray(value) ? value.length : (value ? 1 : 0);

const rowsFrom = (result) => {
  const fields = result.data?.fields || [];
  const index = Object.fromEntries(fields.map((field, i) => [typeof field === 'string' ? field : field.name, i]));
  const ids = result.data?.record_id_list || [];
  const values = result.data?.data || [];
  return values.map((row, i) => ({
    recordId: ids[i] || null,
    status: text(row[index['状态']]),
    link: text(row[index['文稿链接']]),
    docs: docCount(row[index['直播稿doc']]),
    name: text(row[index['录屏名称']])
  }));
};

const config = readTablesConfig();
const checkedAt = new Date().toISOString();
const stamp = checkedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const summaries = [];
const errors = [];

for (const table of config.tables) {
  try {
    const result = listAllRecords({
      cli: LARK_CLI,
      baseToken: table.baseToken,
      tableId: table.tableId,
      fieldIds: ['录屏名称', '状态', '文稿链接', '直播稿doc']
    });
    const rows = rowsFrom(result);
    const statusCounts = Object.fromEntries([...STATUS].map((status) => [status, 0]));
    for (const row of rows) if (STATUS.has(row.status)) statusCounts[row.status] += 1;
    const nonThreeState = rows.filter((row) => !STATUS.has(row.status));
    const multiDoc = rows.filter((row) => row.docs > 1);
    const linkWithoutDoc = rows.filter((row) => row.link && row.docs === 0);
    const docWithoutLink = rows.filter((row) => !row.link && row.docs > 0);
    const closure = Object.values(statusCounts).reduce((sum, n) => sum + n, 0) === rows.length;
    summaries.push({
      tableKey: table.key,
      label: table.label,
      total: rows.length,
      statusCounts,
      pending: statusCounts['下一轮重新执行'],
      nonThreeState: nonThreeState.length,
      multiDoc: multiDoc.length,
      linkWithoutDoc: linkWithoutDoc.length,
      docWithoutLink: docWithoutLink.length,
      closure,
      pendingNames: rows.filter((row) => row.status === '下一轮重新执行').map((row) => row.name).filter(Boolean),
      nonThreeStateNames: nonThreeState.map((row) => ({ recordId: row.recordId, name: row.name, status: row.status })),
      multiDocNames: multiDoc.map((row) => ({ recordId: row.recordId, name: row.name, docs: row.docs })),
      linkWithoutDocNames: linkWithoutDoc.map((row) => ({ recordId: row.recordId, name: row.name })),
      docWithoutLinkNames: docWithoutLink.map((row) => ({ recordId: row.recordId, name: row.name, docs: row.docs }))
    });
  } catch (error) {
    errors.push({ tableKey: table.key, error: String(error?.message || error) });
  }
}

const failedChecks = [
  ...errors.map((item) => `${item.tableKey}:读取失败`),
  ...summaries.flatMap((item) => [
    ...(item.closure ? [] : [`${item.tableKey}:三态不闭合`]),
    ...(item.nonThreeState ? [`${item.tableKey}:存在非三态 ${item.nonThreeState}`] : []),
    ...(item.multiDoc ? [`${item.tableKey}:存在多doc ${item.multiDoc}`] : []),
    ...(item.linkWithoutDoc ? [`${item.tableKey}:有链接无doc ${item.linkWithoutDoc}`] : []),
    ...(item.docWithoutLink ? [`${item.tableKey}:有doc无文稿链接 ${item.docWithoutLink}`] : [])
  ])
];
const report = {
  checkedAt,
  readOnly: true,
  ok: failedChecks.length === 0,
  failedChecks,
  errors,
  summaries
};
await fs.mkdir('state', { recursive: true });
await fs.writeFile('state/three-state-report-latest.json', JSON.stringify(report, null, 2), 'utf8');
await fs.writeFile(`state/three-state-report-${stamp}.json`, JSON.stringify(report, null, 2), 'utf8');
const lines = [
  `检查时间: ${checkedAt}`,
  `只读: 是`,
  `结果: ${report.ok ? '通过' : '发现问题'}`,
  ...summaries.map((item) => `${item.label}: 总数=${item.total} 已移动完成=${item.statusCounts['已移动完成']} 已作废=${item.statusCounts['已作废']} 下一轮重新执行=${item.pending} 非三态=${item.nonThreeState} 多doc=${item.multiDoc} 有链接无doc=${item.linkWithoutDoc} 三态闭合=${item.closure ? '是' : '否'}`),
  ...(failedChecks.length ? ['问题:', ...failedChecks.map((item) => `- ${item}`)] : ['问题: 无'])
];
await fs.writeFile('state/three-state-check.txt', `${lines.join('\n')}\n`, 'utf8');
console.log(JSON.stringify({ event: 'three_state_report_complete', checkedAt, ok: report.ok, failedChecks, summaries }, null, 2));
if (!report.ok) process.exitCode = 1;
