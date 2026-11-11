// 把原 winlp_reporter 告警通道换成落盘状态文件，供巡检/人工查看，不打印任何密钥。
import fs from 'node:fs';
import path from 'node:path';
import { LAST_RUN_PATH } from './runtime-config.mjs';

const FIELDS = ['runId', 'start', 'end', 'exitCode', 'status', 'needsBaiduLogin', 'needsFeishuLogin', 'errorSummary'];

const empty = () => ({
  runId: null,
  start: null,
  end: null,
  exitCode: null,
  status: null,
  needsBaiduLogin: false,
  needsFeishuLogin: false,
  errorSummary: null
});

export const lastRunPath = () => process.env.BAIDU_FEISHU_LAST_RUN || LAST_RUN_PATH;

export const readLastRun = () => {
  try {
    const raw = JSON.parse(fs.readFileSync(lastRunPath(), 'utf8'));
    return { ...empty(), ...(raw && typeof raw === 'object' ? raw : {}) };
  } catch {
    return empty();
  }
};

export const writeLastRun = (patch = {}) => {
  const file = lastRunPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const prev = readLastRun();
  const next = empty();
  for (const key of FIELDS) {
    next[key] = Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] : prev[key];
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'loginScreenshotPath') || prev.loginScreenshotPath) {
    next.loginScreenshotPath = Object.prototype.hasOwnProperty.call(patch, 'loginScreenshotPath')
      ? patch.loginScreenshotPath
      : prev.loginScreenshotPath;
  }
  next.updatedAt = new Date().toISOString();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return next;
};

