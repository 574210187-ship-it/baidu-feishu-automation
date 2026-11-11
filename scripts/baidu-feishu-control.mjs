// 百度网盘→飞书跨 AI 受控接口。
//
// inspect       读取配置、锁、最近批次和计划任务，不启动浏览器、不写业务数据
// validate      调用现有 --validate-only，只读校验，不启动生产阶段
// request-run   写入人工/调度请求，不直接启动生产批次
//
// 本接口没有 run/force/only/补跑命令。真实生产只能由 Windows 计划任务 wrapper 启动。
// 其他 AI 不得伪造 BAIDU_FEISHU_SCHEDULED_RUN，也不得自行创建 Chrome/Profile/页面。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  BAIDU_PROFILE_DIR,
  CDP_PORT,
  LARK_CLI_PATH,
  REPO_ROOT,
  REPORTER_ROOT,
  SWEEP_LOCK_PATH
} from './runtime-config.mjs';
import { readTablesConfig } from './table-context.mjs';

const argv = process.argv.slice(2);
const command = argv.find((item) => !item.startsWith('--')) || 'help';
const jsonMode = argv.includes('--json');
const cdpMode = argv.includes('--cdp');
const dryRun = argv.includes('--dry-run');

const flagValue = (name, fallback = '') => {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const prefix = name + '=';
  const item = argv.find((value) => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : fallback;
};

const exists = (file) => fs.existsSync(file);
const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};
const tail = (value, max = 4000) => String(value || '').slice(-max);

function scheduledTaskInfo() {
  try {
    const raw = execFileSync('schtasks.exe', ['/Query', '/TN', 'BaiduFeishuTranscriptBatch', '/FO', 'LIST', '/V'], {
      encoding: 'utf8', windowsHide: true, timeout: 10000
    });
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const pick = (names) => {
      const line = lines.find((item) => names.some((name) => item.startsWith(name + ':')));
      return line ? line.slice(line.indexOf(':') + 1).trim() : null;
    };
    return {
      available: true,
      state: pick(['状态', 'Status']),
      lastRun: pick(['上次运行时间', 'Last Run Time']),
      nextRun: pick(['下次运行时间', 'Next Run Time']),
      lastResult: pick(['上次运行结果', 'Last Result']),
      taskToRun: pick(['任务要运行的程序', 'Task To Run'])
    };
  } catch (error) {
    return { available: false, error: String(error?.message || error).slice(0, 300) };
  }
}

function latestRuns(limit = 5) {
  const dir = path.join(REPO_ROOT, 'state', 'runs');
  if (!exists(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const file = path.join(dir, name);
      const data = readJson(file);
      return data ? {
        runId: data.runId || path.basename(name, '.json'),
        batchNo: data.batchNo || null,
        status: data.status || null,
        mode: data.mode || null,
        trigger: data.trigger || null,
        startedAt: data.startedAt || null,
        finishedAt: data.finishedAt || null,
        stageErrors: Array.isArray(data.stageErrors) ? data.stageErrors.length : null,
        fileMtime: fs.statSync(file).mtime.toISOString()
      } : null;
    })
    .filter(Boolean)
    .sort((a, b) => String(b.startedAt || b.fileMtime).localeCompare(String(a.startedAt || a.fileMtime)))
    .slice(0, limit);
}

async function cdpSummary() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/list', { signal: controller.signal });
    const targets = await response.json();
    return {
      available: response.ok,
      pageCount: targets.filter((item) => item.type === 'page').length,
      pages: targets.filter((item) => item.type === 'page')
        .map((item) => ({ id: item.id, url: item.url, title: item.title }))
    };
  } catch (error) {
    return { available: false, error: String(error?.message || error).slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

function baseInfo() {
  const tables = readTablesConfig();
  const runLock = path.join(REPO_ROOT, 'state', 'run.lock');
  const controlDir = path.join(REPO_ROOT, 'state', 'control-requests');
  return {
    schema: 'baidu_feishu_control_v1',
    command,
    repoRoot: REPO_ROOT,
    productionPolicy: {
      scheduledTaskOnly: true,
      directRunCommand: 'blocked',
      validateOnlySupported: true,
      externalAiMayRequestButMayNotStart: true
    },
    paths: {
      node: process.execPath,
      larkCli: LARK_CLI_PATH,
      baiduProfile: BAIDU_PROFILE_DIR,
      reporterRoot: REPORTER_ROOT,
      runLock,
      sweepLock: SWEEP_LOCK_PATH
    },
    pathExists: {
      repo: exists(REPO_ROOT),
      tablesConfig: exists(path.join(REPO_ROOT, 'config', 'tables.json')),
      runtimeConfig: exists(path.join(REPO_ROOT, 'config', 'runtime.json')),
      larkCli: exists(LARK_CLI_PATH),
      reporter: exists(REPORTER_ROOT),
      runLock: exists(runLock),
      sweepLock: exists(SWEEP_LOCK_PATH),
      controlRequestDir: exists(controlDir)
    },
    tables: Array.isArray(tables.tables) ? tables.tables.map((item) => ({
      key: item.key, tableId: item.tableId, activeDir: item.activeDir, downloadDir: item.downloadDir
    })) : [],
    scheduledTask: scheduledTaskInfo(),
    latestRuns: latestRuns(),
    noProductionProcessClaim: '此接口不启动或停止生产进程；生产进程状态由计划任务日志和批次回读确认。'
  };
}

function print(result) {
  console.log(JSON.stringify(result, null, 2));
}

async function main() {
  if (command === 'inspect') {
    const result = baseInfo();
    if (cdpMode) result.cdp = await cdpSummary();
    print(result);
    return 0;
  }

  if (command === 'validate') {
    const runner = path.join(REPO_ROOT, 'scripts', 'run-baidu-feishu-batch.mjs');
    const child = spawnSync(process.execPath, [runner, '--validate-only'], {
      cwd: REPO_ROOT,
      env: { ...process.env, BAIDU_FEISHU_REPO: REPO_ROOT },
      encoding: 'utf8', windowsHide: true, timeout: 10 * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024
    });
    const result = {
      schema: 'baidu_feishu_control_validate_v1',
      command,
      readOnly: true,
      productionStarted: false,
      exitCode: child.status ?? null,
      signal: child.signal || null,
      spawnError: child.error ? String(child.error.message || child.error) : null,
      stdoutTail: tail(child.stdout),
      stderrTail: tail(child.stderr)
    };
    print(result);
    return child.error || child.status !== 0 ? 1 : 0;
  }

  if (command === 'request-run') {
    const requester = flagValue('--requester', 'unknown');
    const reason = flagValue('--reason', '');
    const mode = flagValue('--mode', 'validate-only');
    if (!reason) {
      print({ ok: false, error: '缺少 --reason；请求不会写入。' });
      return 2;
    }
    if (!['validate-only', 'human-review', 'scheduled-observation'].includes(mode)) {
      print({ ok: false, error: 'mode 只能是 validate-only、human-review、scheduled-observation；不提供生产启动模式。' });
      return 2;
    }
    const requestId = 'req-' + new Date().toISOString().replace(/[-:.TZ]/g, '') + '-' + process.pid;
    const request = {
      schema: 'baidu_feishu_control_request_v1',
      requestId,
      createdAt: new Date().toISOString(),
      requester,
      mode,
      reason,
      status: 'pending',
      productionStart: false,
      note: '这是请求记录，不会直接启动生产批次；由人工或唯一计划任务入口决定是否执行。'
    };
    const dir = path.join(REPO_ROOT, 'state', 'control-requests');
    const file = path.join(dir, requestId + '.json');
    if (!dryRun) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(request, null, 2), 'utf8');
    }
    print({ ok: true, dryRun, request, file: dryRun ? null : file });
    return 0;
  }

  print({
    schema: 'baidu_feishu_control_help_v1',
    commands: {
      inspect: '读取配置、锁、计划任务和最近批次；加 --cdp 只读列出已存在页面',
      validate: '运行现有 --validate-only，只读校验，不启动生产阶段',
      'request-run': '生成待处理请求；必须 --reason，可选 --mode；不会启动生产'
    },
    examples: [
      'node scripts/baidu-feishu-control.mjs inspect --json',
      'node scripts/baidu-feishu-control.mjs inspect --cdp --json',
      'node scripts/baidu-feishu-control.mjs validate --json',
      'node scripts/baidu-feishu-control.mjs request-run --requester=workbuddy --mode=validate-only --reason=检查最近批次 --json'
    ],
    forbidden: ['直接生产启动', '伪造计划任务环境变量', '自行新建 Chrome/Profile/页面', '把校验结果写成业务完成']
  });
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  print({ ok: false, error: String(error?.stack || error) });
  process.exitCode = 1;
});
