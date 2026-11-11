// table-context.mjs — 三表统一入口的共享上下文解析器
//
// 为什么需要它：2026-09-10 之前 stage1~stage4 与 api-scan 都把 zed 的
// baseToken / tableId / 网盘目录 / state 文件名写死在源码里，所以
// run-baidu-feishu-batch.mjs 只能处理 zed，姜律师与意晨被迫留在旧的
// sweep_waiting 链路 —— 两条链路各自往「直播稿doc」附件列追加一次，
// 这正是"一个单元格多个 doc"复发的结构性根源。
//
// 现在：所有按表变化的量都来自 config/tables.json，脚本用 --table=<key> 选中。
// state 文件按表隔离到 state/<key>/，三表在同一轮批次里互不覆盖。
//
// 用法：
//   node scripts/stage1-click-wengao-all.mjs --table=jiang
//   node scripts/api-scan-baidu-videos.mjs --table=yichen
//
// 未传 --table 时默认 zed（保持旧命令行可用），但统一入口永远显式传参。

import fs from 'node:fs';
import path from 'node:path';
import { LARK_CLI_PATH, REPO_ROOT } from './runtime-config.mjs';

export const DEFAULT_TABLE_KEY = 'zed';
export const LARK_CLI = LARK_CLI_PATH;
export const TABLES_CONFIG_PATH = process.env.BAIDU_FEISHU_TABLES_CONFIG
  ? path.resolve(process.env.BAIDU_FEISHU_TABLES_CONFIG)
  : path.join(REPO_ROOT, 'config', 'tables.json');

export const readTablesConfig = () => JSON.parse(fs.readFileSync(TABLES_CONFIG_PATH, 'utf8'));

export const parseTableArg = (argv = process.argv) => {
  const eq = argv.find((arg) => arg.startsWith('--table='));
  if (eq) return eq.slice('--table='.length).trim();
  const i = argv.indexOf('--table');
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1].trim();
  return '';
};

export const tableKeys = () => {
  const config = readTablesConfig();
  return config.tableOrder?.length ? config.tableOrder : config.tables.map((t) => t.key);
};

export const resolveTable = (key) => {
  const config = readTablesConfig();
  const entry = config.tables.find((t) => t.key === key);
  if (!entry) {
    throw new Error(`未知表 key="${key}"；${TABLES_CONFIG_PATH} 中有效的 key = ${config.tables.map((t) => t.key).join(', ')}`);
  }
  const stateDir = path.join(REPO_ROOT, 'state', entry.key);
  return {
    ...entry,
    batchIntervalHours: config.batchIntervalHours,
    transcriptWaitMinutes: config.transcriptWaitMinutes,
    requiredFields: config.requiredFields || [],
    stateDir,
    // state 文件按表隔离；返回绝对路径，外部 AI 从任意工作目录调用仍指向同一现场。
    statePath: (name) => `${stateDir}/${name}`,
    ensureStateDir: () => {
      fs.mkdirSync(stateDir, { recursive: true });
      return stateDir;
    }
  };
};

export const resolveTableFromArgv = (argv = process.argv) =>
  resolveTable(parseTableArg(argv) || DEFAULT_TABLE_KEY);

// 统一入口遍历用：按 config.tableOrder 顺序解析全部表
export const resolveAllTables = () => tableKeys().map((key) => resolveTable(key));
