// 一次性历史修复：为“已移动完成但文稿链接为空”的记录，
// 仅根据百度“已完成”目录中的同名 doc 创建永久分享链接并回填。
// 不改状态、视频链接、直播稿doc附件、移动字段；默认只预演，必须显式 --apply 才写入。
import fs from 'node:fs/promises';
import path from 'node:path';
import CDP from 'chrome-remote-interface';
import { resolveAllTables, LARK_CLI } from './table-context.mjs';
import { REPO_ROOT } from './runtime-config.mjs';
import { listAllRecords } from './feishu-list-all.mjs';
import { runLarkCliJson } from './lark-cli-utils.mjs';

const APPLY = process.argv.includes('--apply');
const PORT = Number(process.env.CDP_PORT || 9223);
const REPORT_DIR = 'D:/winlp_reporter/backups/20261106-debt-drain-convergence';
const UPDATE_PATH = path.join(REPO_ROOT, 'state', 'historical-link-repair-update.json');
const REPORT_PATH = path.join(REPORT_DIR, `historical-link-repair-${APPLY ? 'apply' : 'dry-run'}-2026-11-06.json`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (value) => Array.isArray(value)
  ? value.map((item) => typeof item === 'object' ? (item.text ?? item.name ?? '') : String(item)).join('')
  : String(value ?? '');
const status = (value) => Array.isArray(value) ? value[0] : value;

const fields = ['录屏名称', '状态', '文稿文件名', '文稿链接', '文稿提取码', '直播稿doc', '文稿分享结果', '文稿分享备注', '分享完成时间'];

async function listBaiduFiles(page, dir) {
  const files = [];
  for (let pageNo = 1; pageNo <= 20; pageNo += 1) {
    const result = await page.eval(`(async () => {
      const token = window.locals?.get?.('bdstoken') || window.locals?.bdstoken || window.yunData?.MYBDSTOKEN || window.yunData?.bdstoken || window.bdstoken || '';
      const params = new URLSearchParams({ order: 'name', desc: '0', showempty: '0', web: '1', page: '${pageNo}', num: '1000', dir: ${JSON.stringify(dir)}, bdstoken: token });
      const response = await fetch('/api/list?' + params.toString(), { credentials: 'include' });
      const json = await response.json();
      return { status: response.status, errno: json.errno, hasMore: json.has_more, list: json.list || [] };
    })()`);
    if (result.status !== 200 || result.errno !== 0) throw new Error(`百度目录读取失败 ${dir} page=${pageNo}: ${JSON.stringify(result)}`);
    files.push(...result.list);
    if (!result.hasMore && result.list.length < 1000) break;
  }
  return files;
}

async function connectExistingPage() {
  const target = (await CDP.List({ port: PORT })).find((item) => item.type === 'page' && item.url.includes('pan.baidu.com'));
  if (!target) throw new Error('没有找到已存在的百度页面；脚本不会新建页面。');
  const client = await CDP({ port: PORT, target });
  await client.Runtime.enable();
  const evalPage = async (expression, timeout = 30000) => {
    const result = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true, timeout });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || '页面脚本执行失败');
    return result.result.value;
  };
  return { client, eval: evalPage, target };
}

async function createShare(page, fsId, code) {
  return page.eval(`(async () => {
    const token = window.locals?.get?.('bdstoken') || window.locals?.bdstoken || window.yunData?.MYBDSTOKEN || window.yunData?.bdstoken || window.bdstoken || '';
    const params = new URLSearchParams({ channel: 'chunlei', bdstoken: token, clienttype: '0', app_id: '250528', web: '1' });
    const body = new URLSearchParams({ fid_list: JSON.stringify([${JSON.stringify(fsId)}]), schannel: '4', channel_list: '[]', period: '0', pwd: ${JSON.stringify(code)} });
    const response = await fetch('/share/set?' + params.toString(), { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body });
    const raw = await response.text();
    let json; try { json = JSON.parse(raw); } catch { json = { raw }; }
    return { status: response.status, json };
  })()`);
}

const allPlans = [];
for (const table of resolveAllTables()) {
  const records = listAllRecords({ cli: LARK_CLI, baseToken: table.baseToken, tableId: table.tableId, fieldIds: fields, identity: 'user' });
  const ids = records.data?.record_id_list || [];
  const rows = records.data?.data || [];
  const schema = records.data?.fields || fields;
  const index = Object.fromEntries(schema.map((field, i) => [field, i]));
  const candidates = rows.map((row, i) => ({
    table,
    recordId: ids[i],
    name: text(row[index['录屏名称']]),
    status: status(row[index['状态']]),
    docName: text(row[index['文稿文件名']]),
    hasLink: Boolean(row[index['文稿链接']]),
    oldDoc: row[index['直播稿doc']],
    oldCode: text(row[index['文稿提取码']])
  })).filter((row) => row.name && row.status === '已移动完成' && !row.hasLink && row.docName);
  allPlans.push(...candidates);
}

const page = await connectExistingPage();
const byTable = new Map();
for (const table of resolveAllTables()) {
  const files = await listBaiduFiles(page, table.doneDir);
  byTable.set(table.key, new Map(files.filter((item) => item.server_filename && /\.doc$/i.test(item.server_filename)).map((item) => [item.server_filename, item])));
}

const found = allPlans.map((item) => {
  const file = byTable.get(item.table.key)?.get(item.docName) || null;
  return { ...item, fsId: file?.fs_id ?? null, fileSize: file?.size ?? null, found: Boolean(file) };
});
const missing = found.filter((item) => !item.found);
const repairable = found.filter((item) => item.found);
const result = { generatedAt: new Date().toISOString(), mode: APPLY ? 'apply' : 'dry-run', candidates: found.length, repairable: repairable.length, missing: missing.length, missingRows: missing.map(({ table, recordId, name, docName }) => ({ table: table.key, recordId, name, docName })), shared: [], updatedRecordIds: [], failed: [] };

if (APPLY && repairable.length) {
  const updatesByTable = new Map();
  const shareCache = new Map();
  for (const item of repairable) {
    try {
      let share = shareCache.get(String(item.fsId));
      if (!share) {
        const code = Math.random().toString(36).slice(2, 6).replace(/[^a-z0-9]/g, 'a');
        const response = await createShare(page, item.fsId, code);
        const data = response?.json || {};
        if (response?.status !== 200 || data.errno !== 0) throw new Error(`分享接口失败：${JSON.stringify(data).slice(0, 400)}`);
        const link = data.link || data.shorturl || data.url || '';
        const pwd = data.pwd || data.passwd || data.password || code;
        if (!link) throw new Error(`分享接口未返回链接：${JSON.stringify(data).slice(0, 400)}`);
        share = { link, code: pwd, fsId: item.fsId };
        shareCache.set(String(item.fsId), share);
      }
      const key = item.table.key;
      if (!updatesByTable.has(key)) updatesByTable.set(key, { table: item.table, updates: {} });
      updatesByTable.get(key).updates[item.recordId] = {
        '文稿链接': share.link,
        '文稿提取码': share.code,
        '文稿分享结果': '成功',
        '文稿分享备注': `历史补全：已根据“已完成”目录同名 doc（fs_id=${item.fsId}）重新创建永久分享链接。`,
        '分享完成时间': new Date().toISOString()
      };
      result.shared.push({ table: key, recordId: item.recordId, name: item.name, docName: item.docName, fsId: item.fsId, link: share.link, code: share.code });
      await sleep(250);
    } catch (error) {
      result.failed.push({ table: item.table.key, recordId: item.recordId, name: item.name, error: error.message });
    }
  }
  for (const { table, updates } of updatesByTable.values()) {
    const payload = { update_records: updates };
    await fs.writeFile(UPDATE_PATH, JSON.stringify(payload, null, 2), 'utf8');
    runLarkCliJson(['base', '+record-batch-update', '--base-token', table.baseToken, '--table-id', table.tableId, '--json', `@${UPDATE_PATH}`, '--as', 'user', '--format', 'json'], { cli: LARK_CLI });
    result.updatedRecordIds.push(...Object.keys(updates));
  }
}

await page.client.close().catch(() => null);
await fs.mkdir(REPORT_DIR, { recursive: true });
await fs.writeFile(REPORT_PATH, JSON.stringify(result, null, 2), 'utf8');
console.log(JSON.stringify({ reportPath: REPORT_PATH, mode: result.mode, candidates: result.candidates, repairable: result.repairable, missing: result.missing, shared: result.shared.length, updated: result.updatedRecordIds.length, failed: result.failed.length }, null, 2));
if (result.failed.length) process.exitCode = 2;
