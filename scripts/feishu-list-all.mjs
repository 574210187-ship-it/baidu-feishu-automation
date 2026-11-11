// Feishu Bitable `record-list` caps `--limit` at 200 per page. When a table
// grows past 200 rows, every caller that used `--limit 200` silently ignored
// all rows beyond the first 200 — so records past row 200 could never be
// selected, exported, shared, downloaded, or moved, and got re-created as
// duplicates on every run. This helper paginates through ALL rows (offset +200
// until a short page) and returns the SAME shape as a single `record-list`
// call: { data: { record_id_list, data, fields } }.
//
// 2026-09-15：所有 lark-cli 调用改走 lark-cli-utils 的统一出口 ——
// 「临时网络错误」（800100001 / 800004014 / THRIFT_EGRESS / remote or network error /
// ECONNRESET / fetch failed / HTTP 429,5xx …）会在原地重试（2s/5s/10s/20s + 抖动），
// 不再让一次出口抖动把整轮 4 小时批次打成 failed。
// 返回值与抛错语义保持原样：失败仍抛 `lark-cli list failed (offset N): ...`。
//
// 本文件是 stage1~stage5 / report-three-state / report-state-sync / report-run-metrics
// 共用的唯一分页读表入口 —— 改这里等于同时给上述所有脚本加上重试。
import { runLarkCliJson } from './lark-cli-utils.mjs';

export const listAllRecords = ({ cli, baseToken, tableId, fieldIds = [], identity = 'user', extraArgs = [] }) => {
  let offset = 0;
  const allIds = [];
  const allRows = [];
  let fieldsSchema = null;
  for (let page = 0; page < 200; page += 1) {
    const args = [
      'base', '+record-list',
      '--base-token', baseToken,
      '--table-id', tableId,
      '--limit', '200',
      '--offset', String(offset),
      '--as', identity,
      '--format', 'json',
      ...fieldIds.flatMap((f) => ['--field-id', f]),
      ...extraArgs
    ];
    let j;
    try {
      j = runLarkCliJson(args, { cli });
    } catch (error) {
      // 重试已耗尽 / 命中确定性错误：保留 offset 上下文，便于定位是哪一页出的问题。
      throw new Error(`lark-cli list failed (offset ${offset}): ${error.message}`);
    }
    const ids = j.data?.record_id_list || [];
    const rows = j.data?.data || [];
    if (!fieldsSchema && j.data?.fields) fieldsSchema = j.data.fields;
    allIds.push(...ids);
    allRows.push(...rows);
    if (ids.length < 200) break;
    offset += 200;
  }
  return { data: { record_id_list: allIds, data: allRows, fields: fieldsSchema } };
};
