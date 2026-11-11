// api-scan-baidu-videos.mjs — 扫描指定表的网盘源目录，列出全部 mp4
// 用法: node scripts/api-scan-baidu-videos.mjs --table=jiang|yichen|zed
// 输出: state/<key>/deep-scan-baidu-videos.json（按表隔离，三表同轮互不覆盖）
import fs from 'node:fs/promises';
import { baiduApiFetchJson } from './baidu-cdp-utils.mjs';
import { resolveTableFromArgv } from './table-context.mjs';

const table = resolveTableFromArgv();
const folderPath = table.activeDir;
await fs.mkdir(table.stateDir, { recursive: true });

const pad = (n) => String(n).padStart(2, '0');
const cnStamp = (date = new Date()) => {
  const d = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

const files = [];
const attempts = [];

for (let page = 1; page <= 100; page += 1) {
  const json = await baiduApiFetchJson('/api/list', {
    order: 'name',
    desc: '0',
    showempty: '0',
    web: '1',
    page: String(page),
    num: '1000',
    dir: folderPath
  });
  attempts.push({
    page,
    status: json.status,
    errno: json.json?.errno,
    count: Array.isArray(json.json?.list) ? json.json.list.length : null,
    hasMore: json.json?.has_more ?? null
  });
  if (json.status !== 200 || json.json?.errno !== 0 || !Array.isArray(json.json.list)) {
    throw new Error(`Baidu list failed for ${table.key} (${folderPath}): ${JSON.stringify(attempts.at(-1))}`);
  }
  files.push(...json.json.list);
  if (!json.json.has_more && json.json.list.length < 1000) break;
}

const videos = files
  .filter((item) => item.server_filename && /\.mp4$/i.test(item.server_filename) && !item.isdir)
  .map((item) => ({
    name: item.server_filename,
    fs_id: item.fs_id,
    size: item.size ? String(item.size) : '',
    modified: item.server_mtime ? cnStamp(new Date(item.server_mtime * 1000)) : '',
    modifiedUtc: item.server_mtime ? new Date(item.server_mtime * 1000).toISOString() : '',
    isdir: item.isdir
  }))
  .sort((a, b) => a.name.localeCompare(b, 'zh-CN'));

const outPath = table.statePath('deep-scan-baidu-videos.json');
await fs.writeFile(outPath, JSON.stringify({
  checkedAt: new Date().toISOString(),
  tableKey: table.key,
  folderPath,
  attempts,
  count: videos.length,
  videos
}, null, 2), 'utf8');

console.log(JSON.stringify({ event: 'api_scan_done', table: table.key, folderPath, count: videos.length, pages: attempts.length, outPath }, null, 2));
process.exit(0);
