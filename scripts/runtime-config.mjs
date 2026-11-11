// 本机运行时配置：把机器路径集中到一个无密钥模块，供计划任务和外部调试入口共用。
// 任何路径都可用环境变量覆盖；不要在这里放飞书 token、Cookie 或机器人密钥。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = process.env.BAIDU_FEISHU_REPO
  ? path.resolve(process.env.BAIDU_FEISHU_REPO)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const runtimeFile = process.env.BAIDU_FEISHU_RUNTIME_CONFIG
  ? path.resolve(process.env.BAIDU_FEISHU_RUNTIME_CONFIG)
  : path.join(REPO_ROOT, 'config', 'runtime.json');

let fileConfig = {};
try {
  fileConfig = JSON.parse(fs.readFileSync(runtimeFile, 'utf8')) || {};
} catch {
  // 配置文件不存在时使用安全的本机默认值；调用方仍会在实际使用前检查路径。
}

const value = (envName, key, fallback) => process.env[envName] || fileConfig[key] || fallback;

const LINUX_DATA = '/workspace/baidu-feishu-data';

export const DATA_DIR = value('BAIDU_FEISHU_DATA_DIR', 'dataDir', LINUX_DATA);
export const LARK_CLI_PATH = value('LARK_CLI_PATH', 'larkCliPath', '/usr/local/bin/lark-cli');
export const CDP_PORT = Number(value('CDP_PORT', 'cdpPort', 9333));
export const BAIDU_PROFILE_DIR = value('BAIDU_PROFILE_DIR', 'baiduProfileDir', path.join(DATA_DIR, 'chrome-profile'));
export const CHROME_PATH = value('CHROME_PATH', 'chromePath', '/usr/bin/google-chrome');
export const CHROME_HEADLESS = String(value('BAIDU_CHROME_HEADLESS', 'chromeHeadless', 'true')).toLowerCase() !== 'false';
export const LOGIN_QR_PATH = value('BAIDU_LOGIN_QR_PATH', 'loginQrPath', path.join(DATA_DIR, 'state', 'baidu-login-qr.png'));
export const LAST_RUN_PATH = value('BAIDU_FEISHU_LAST_RUN', 'lastRunPath', path.join(DATA_DIR, 'state', 'last-run.json'));
export const REPORTER_ROOT = value('REPORTER_ROOT', 'reporterRoot', path.join(DATA_DIR, 'reporter-disabled'));
export const REPORT_EVENT_PATH = value('REPORT_EVENT_PATH', 'reportEventPath', path.join(REPORTER_ROOT, 'bin', 'report_event.mjs'));
export const ALERT_SUBMIT_PATH = value('ALERT_SUBMIT_PATH', 'alertSubmitPath', path.join(REPORTER_ROOT, 'bin', 'submit_alert.mjs'));
export const ALERT_NODE_PATH = value('ALERT_NODE_PATH', 'alertNodePath', process.execPath);
export const SWEEP_LOCK_PATH = value('SWEEP_LOCK_PATH', 'sweepLockPath', path.join(DATA_DIR, 'state', 'sweep.lock'));
export const SCHEDULER_ROOT = value('SCHEDULER_ROOT', 'schedulerRoot', REPO_ROOT);
export const ACTIVE_BAIDU_DIR = value('ACTIVE_BAIDU_DIR', 'activeBaiduDir', '/8月新录屏/zed已压缩');
export const ACTIVE_BAIDU_URL = value('ACTIVE_BAIDU_URL', 'activeBaiduUrl', 'https://pan.baidu.com/disk/main?from=homeFlow#/index?category=all&path=%2F8%E6%9C%88%E6%96%B0%E5%BD%95%E5%B1%8F%2Fzed%E5%B7%B2%E5%8E%8B%E7%BC%A9');

export const repoPath = (...parts) => path.join(REPO_ROOT, ...parts);
