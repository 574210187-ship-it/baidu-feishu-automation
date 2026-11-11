import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import pathMod from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import CDP from 'chrome-remote-interface';
import {
  ALERT_NODE_PATH,
  ALERT_SUBMIT_PATH,
  CHROME_HEADLESS,
  CHROME_PATH,
  LOGIN_QR_PATH,
  REPORTER_ROOT,
  repoPath
} from './runtime-config.mjs';
import { writeLastRun } from './last-run-status.mjs';
import {
  baiduProfileDir as profileDir,
  listTargets,
  port,
  sleep
} from './baidu-cdp-utils.mjs';
import { resolveTableFromArgv } from './table-context.mjs';
import { evaluateLoginState, buildLoginRequiredMessage, buildApiRejectedMessage, evaluateContextReadiness, isRetryableApiFailure } from './baidu-login-verdict.mjs';

// 登录/CDP 健康检查的目标目录默认取 zed 新目录（/8月新录屏/zed已压缩）；
// 传 --table=<key> 时改用该表的源目录。任何情况下都只做只读探测：
// 不下载、不分享、不移动、不写飞书。
const T = resolveTableFromArgv();
const activeBaiduDir = T.activeDir;
const baiduUrl = T.activeUrl;

const chromePath = CHROME_PATH;
const loginScreenshotPath = LOGIN_QR_PATH;
const loginScreenshotRepoPath = repoPath('state', 'baidu-login-qr.png');
const logStep = (step, extra = {}) => {
  console.log(JSON.stringify({ event: 'ensure_step', step, at: new Date().toISOString(), ...extra }));
};
const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  sleep(ms).then(() => {
    throw new Error(`${label} timed out after ${ms}ms`);
  })
]);

// ── 统一故障告警（本机唯一入口 → 企业微信群05）──────────────────────
// 硬性边界：本脚本全程只读（不下载/不分享/不移动/不写飞书），告警同样只做「提交一个事件」，
// 不直写飞书、不直接调机器人；任何异常只打日志，绝不改变本脚本的退出码与只读性质。
const ALERT_SUBMIT = ALERT_SUBMIT_PATH;
const ALERT_ROOT = REPORTER_ROOT;
const ALERT_STATE_PATH = pathMod.join(ALERT_ROOT, 'state', 'alert_state.json');
const ALERT_NODE = process.env.WINLP_NODE_PATH
  || ALERT_NODE_PATH
  || process.execPath;

function cdpErrorCode(v) {
  if (v && v.requiresScanLogin) return 'BAIDU_NEED_SCAN_LOGIN';
  const kind = String((v && v.failureKind) || '');
  if (kind === 'baidu-api-transient') return 'BAIDU_API_TRANSIENT';
  if (kind === 'baidu-api-rejected') return 'BAIDU_API_REJECTED';
  if (kind === 'baidu-login-infra') return 'BAIDU_LOGIN_EXPIRED';
  return 'BAIDU_PAGE_UNREACHABLE';
}

function emitCdpAlert(params) {
  try {
    const code = String(params['error-code'] || '');
    const recovered = params.recovered === 'true';
    const needsScan = code === 'BAIDU_NEED_SCAN_LOGIN' || code === 'BAIDU_LOGIN_EXPIRED';
    writeLastRun({
      status: recovered ? 'recovered' : 'failed',
      needsBaiduLogin: recovered ? false : needsScan,
      errorSummary: recovered ? (params.summary || 'recovered') : (params.summary || code || null)
    });
  } catch { /* 状态文件失败不得影响登录检查 */ }
  try {
    if (!ALERT_SUBMIT || !fsSync.existsSync(ALERT_SUBMIT)) {
      logStep('unified_alert_skipped', { reason: 'reporter_disabled', error_code: params['error-code'] });
      return null;
    }
    const tag = process.pid + '-' + Date.now();
    const pfile = pathMod.join(os.tmpdir(), 'cdp-alert-' + tag + '.json');
    const ofile = pathMod.join(os.tmpdir(), 'cdp-alert-out-' + tag + '.txt');
    fsSync.writeFileSync(pfile, JSON.stringify(params), 'utf8');
    const argv = [ALERT_SUBMIT, pfile, ofile];
    if (process.env.ALERT_DRY_RUN === '1') argv.push('--dry-run');
    // 告警是旁路，不能阻塞百度登录检查；发送器卡住时最多等待 5 秒，
    // 主链路仍以真实页面/API 判定为准，不能被告警通道拖成 ensure 超时。
    spawnSync(ALERT_NODE, argv, { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    let res = null;
    try {
      const txt = fsSync.readFileSync(ofile, 'utf8');
      const a = txt.indexOf('{');
      const b = txt.lastIndexOf('}');
      if (a >= 0 && b > a) res = JSON.parse(txt.slice(a, b + 1));
    } catch (e) { /* 读不到就按未知处理，不影响退出码 */ }
    for (const p of [pfile, ofile]) {
      try { fsSync.unlinkSync(p); } catch (e) { /* 临时文件无害 */ }
    }
    logStep('unified_alert_submitted', {
      error_code: params['error-code'],
      decision: res ? res.decision : null,
      notify: res ? res.notify : null,
      event_id: res ? res.event_id : null,
      recovered: params.recovered === 'true'
    });
    return res;
  } catch (e) {
    logStep('unified_alert_failed', { error: String(e && e.message || e) });
    return null;
  }
}

function cdpAlertBase() {
  return {
    'project-id': 'baidu_transcript_03',
    source: 'winlp_batch_listener',
    component: 'baidu_batch',
    'task-id': 'baidu-cdp-' + new Date().toISOString().slice(0, 10),
    stage: '百度网盘登录保障',
    // 登录/接口故障跨自然日仍属于同一故障；不能把日期拼进去，
    // 否则零点后无法配对恢复，也会把同一故障重新当成首次故障。
    'dedupe-key': 'baidu03|cdp'
  };
}

function activeCdpAlert() {
  try {
    const state = JSON.parse(fsSync.readFileSync(ALERT_STATE_PATH, 'utf8'));
    const matches = Object.entries(state || {})
      .filter(([key, value]) => value?.active === true && (key === 'baidu03|cdp' || key.startsWith('baidu03|cdp|')))
      .sort((a, b) => String(a[1]?.first_seen || '').localeCompare(String(b[1]?.first_seen || '')));
    if (!matches.length) return null;
    const [key, value] = matches[matches.length - 1];
    return { key, value };
  } catch {
    return null;
  }
}

function emitCdpRecoveryIfNeeded() {
  const active = activeCdpAlert();
  if (!active) {
    logStep('unified_alert_skipped', {
      reason: 'no_active_cdp_fault',
      summary: '当前没有待恢复的百度登录或接口故障，不生成恢复事件。'
    });
    return null;
  }
  const base = cdpAlertBase();
  base['dedupe-key'] = active.key;
  base['error-code'] = active.value.error_code || 'BATCH_TASK_FAILED';
  base.severity = 'INFO';
  base.recovered = 'true';
  base.summary = '百度网盘登录与目录接口已恢复，后续自然批次可继续执行。';
  base['next-action'] = '无需人工补跑，继续观察下一自然批次。';
  return emitCdpAlert(base);
}

const readCmdline = (pid) => {
  try {
    return fsSync.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\u0000/g, ' ');
  } catch {
    return '';
  }
};

const isOurChromeCmd = (cmd) => {
  if (!cmd) return false;
  if (!/chrome|chromium/i.test(cmd)) return false;
  return cmd.includes(profileDir);
};

const listOurChromePids = () => {
  const pids = new Set();
  try {
    const out = execFileSync('ps', ['-eo', 'pid=,args='], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    for (const line of out.split(/\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const sp = trimmed.indexOf(' ');
      const pid = Number(trimmed.slice(0, sp).trim());
      const args = sp >= 0 ? trimmed.slice(sp + 1) : '';
      if (Number.isInteger(pid) && pid > 0 && isOurChromeCmd(args)) pids.add(pid);
    }
  } catch { }
  return [...pids];
};

const killPortOwner = () => {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('netstat.exe', ['-ano', '-p', 'tcp'], {
        encoding: 'utf8',
        timeout: 15000,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        if (!line.includes(':' + port) || !/\bLISTENING\b/i.test(line)) continue;
        const parts = line.trim().split(/\s+/);
        const pid = Number(parts[parts.length - 1]);
        if (Number.isInteger(pid) && pid > 0) pids.add(pid);
      }
      const killed = [];
      for (const pid of pids) {
        try { process.kill(pid, 'SIGTERM'); killed.push(pid); } catch { }
      }
      if (killed.length) logStep('killed_unhealthy_cdp_port_owner', { pids: killed });
      return;
    }
    // Linux：只杀「监听本任务专用端口、且命令行带有本任务 profile」的进程，绝不碰桌面浏览器。
    const out = execFileSync('ss', ['-ltnp'], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const pids = new Set();
    const portToken = `:${port}`;
    for (const line of out.split(/\n/)) {
      if (!line.includes(portToken) || !/LISTEN/i.test(line)) continue;
      for (const match of line.matchAll(/pid=(\d+)/g)) {
        const pid = Number(match[1]);
        if (!Number.isInteger(pid) || pid <= 0) continue;
        if (isOurChromeCmd(readCmdline(pid))) pids.add(pid);
      }
    }
    const killed = [];
    for (const pid of pids) {
      try { process.kill(pid, 'SIGTERM'); killed.push(pid); } catch { }
    }
    if (killed.length) logStep('killed_unhealthy_cdp_port_owner', { pids: killed });
  } catch (error) {
    logStep('kill_unhealthy_cdp_port_owner_failed', { error: String(error.message || error).slice(0, 160) });
  }
};

const killProfileChrome = () => {
  try {
    if (process.platform === 'win32') {
      const escapedProfile = profileDir.replace(/'/g, "''");
      const script = `$profile = '${escapedProfile}'; Get-CimInstance Win32_Process -Filter "name='chrome.exe'" | Where-Object { $_.CommandLine -like ('*' + $profile + '*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Output $_.ProcessId }`;
      const killed = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
        encoding: 'utf8',
        timeout: 15000,
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      if (killed) logStep('killed_profile_chrome', { pids: killed.split(/\s+/).filter(Boolean) });
      return;
    }
    const killed = [];
    for (const pid of listOurChromePids()) {
      try { process.kill(pid, 'SIGTERM'); killed.push(pid); } catch { }
    }
    if (killed.length) logStep('killed_profile_chrome', { pids: killed });
  } catch (error) {
    logStep('kill_profile_chrome_failed', { error: String(error.message || error).slice(0, 160) });
  }
};

const chromeLaunchArgs = (startUrl) => {
  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-allow-origins=*',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=ChromeWhatsNewUI',
    '--window-size=1500,950',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu'
  ];
  if (CHROME_HEADLESS) args.push('--headless=new');
  else args.push('--window-position=-32000,-32000');
  args.push(startUrl);
  return args;
};

const chromeLaunchEnv = () => {
  const env = { ...process.env };
  // 绝不继承桌面浏览器的 DISPLAY / 沙箱代理，避免挂到桌面 Chrome。
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  delete env.SAND_GATEWAY_TOKEN;
  delete env.SAND_EGRESS_TUNNEL_BEARER;
  return env;
};

const spawnChromeAndWait = async (reason) => {
  logStep('spawn_chrome', { reason });
  await fs.mkdir(profileDir, { recursive: true });
  const child = spawn(chromePath, chromeLaunchArgs(baiduUrl), {
    detached: true,
    stdio: 'ignore',
    env: chromeLaunchEnv()
  });
  child.unref();
  logStep('wait_for_cdp');
  try {
    return await waitForCdp(30000);
  } catch (error) {
    logStep('spawn_wait_for_cdp_failed_retry_once', { error: String(error.message || error).slice(0, 160) });
    killPortOwner();
    killProfileChrome();
    await sleep(2000);
    logStep('spawn_chrome_retry');
    const retry = spawn(chromePath, chromeLaunchArgs(baiduUrl), {
      detached: true,
      stdio: 'ignore',
      env: chromeLaunchEnv()
    });
    retry.unref();
    return waitForCdp(30000);
  }
};

const waitForCdp = async (timeoutMs = 20000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      logStep('list_targets_wait');
      return await withTimeout(listTargets(), 5000, 'CDP.List');
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`CDP port ${port} did not become available`);
};

const ensurePage = async () => {
  let targets = [];
  try {
    logStep('list_targets_initial');
    targets = await listTargets();
  } catch {
    logStep('cdp_unhealthy_restart_port_owner');
    killPortOwner();
    killProfileChrome();
    await sleep(1500);
    targets = await spawnChromeAndWait('initial_cdp_unhealthy');
  }

  let target = targets.find((item) => item.type === 'page' && item.url.includes('pan.baidu.com') && item.url.includes('/disk/main'));
  if (!target) {
    logStep('create_baidu_target');
    target = await withTimeout(CDP.New({ port, url: baiduUrl }), 10000, 'create Baidu target');
    await sleep(5000);
  }

  logStep('target_ready', { targetId: target.id, url: target.url });
  return target;
};

const target = await ensurePage();
logStep('connect_target');
const client = await withTimeout(CDP({ port, target }), 10000, 'connect target CDP');
const { Page, Browser, Network, Runtime, Input, Emulation } = client;
logStep('enable_domains');
  // 复用现有页面时，百度网盘页面可能正处于恢复/渲染阶段；握手等待不能
  // 因 5 秒过短把真实登录态误判为基础设施失败。这里只延长握手超时，
  // 不新建浏览器、Profile 或页面。
  await withTimeout(Page.enable(), 15000, 'Page.enable');
await withTimeout(Network.enable(), 5000, 'Network.enable').catch(() => null);
logStep('hide_window');
await withTimeout(Browser.getWindowForTarget({ targetId: target.id }).then(({ windowId }) =>
  Browser.setWindowBounds({ windowId, bounds: { left: -32000, top: -32000, width: 1500, height: 950, windowState: 'normal' } })
), 5000, 'hide Baidu window').catch(() => null);

if (!decodeURIComponent(target.url || '').includes(activeBaiduDir)) {
  logStep('navigate_folder');
  await withTimeout(Page.navigate({ url: baiduUrl }), 10000, 'navigate Baidu folder');
  await sleep(6000);
}

// ── D1 修复（2026-09-27）────────────────────────────────────────
// 此前 loginText / emptyAnonymousQuota 只在这里初始化成 false、全文再无赋值，
// 于是 loggedIn 退化成只看 apiOk：页面正在弹扫码框或容量是 -/- 也会被判"已登录"。
// 现在改成：页面上下文真实采集（正文/容量/bdstoken/登录弹层）→ 交给
// baidu-login-verdict.mjs 统一判定。本文件只负责采集，不自己拍脑袋下结论。
// 采集动作全程只读：不下载、不分享、不移动、不上传、不读也不写飞书。
const pageProbeExpression = `(() => {
  const out = { url: '', title: '', pageText: '', quotaText: '', quotaCandidates: [], bdstokenCandidates: [], bdstoken: null, csrfToken: null, loginPrompt: false, loginPromptSelectors: [], pageReadyState: '', cookieLength: 0, cookieHasStoken: false, hasYunData: false };
  // ── 就绪信号（2026-10-10 修复）────────────────────────────────────
  // 页面刚创建/刚导航时，readyState 还是 loading、cookie 尚未下发、
  // bdstoken 与容量文本都读不到；此时任何判定都会把"没渲染完"误当成"掉登录"。
  try { out.pageReadyState = String(document.readyState || ''); } catch (e) {}
  try { out.cookieLength = String(document.cookie || '').length; } catch (e) {}
  try { out.cookieHasStoken = /(?:^|;\\s*)STOKEN=/.test(String(document.cookie || '')); } catch (e) {}
  try { out.hasYunData = Boolean(window.YunData); } catch (e) {}
  try { out.url = String(location.href || ''); } catch (e) {}
  try { out.title = String(document.title || ''); } catch (e) {}
  try { out.pageText = String((document.body && document.body.innerText) || '').replace(/\\s+/g, ' ').slice(0, 6000); } catch (e) {}
  const quotaSelectors = ['.quota-num', '.quota', '.capacity', '.storage', '.disk-capacity', '.user-quota', '.member-progress', '[class*="quota"]', '[class*="capacity"]', '[class*="storage"]'];
  for (const sel of quotaSelectors) {
    try {
      const el = document.querySelector(sel);
      if (!el) continue;
      const text = String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
      if (text) out.quotaCandidates.push(text.slice(0, 60));
    } catch (e) {}
  }
  try {
    if (window.YunData && window.YunData.bdstoken) out.bdstokenCandidates.push(String(window.YunData.bdstoken));
  } catch (e) {}
  try {
    const l = window.locals;
    if (l && typeof l.get === 'function') {
      const v = l.get('bdstoken');
      if (v) out.bdstokenCandidates.push(String(v));
    } else if (l && l.bdstoken) {
      out.bdstokenCandidates.push(String(l.bdstoken));
    }
  } catch (e) {}
  try {
    const m = document.cookie.match(/(?:^|;\\s*)bdstoken=([^;]+)/);
    if (m) out.bdstokenCandidates.push(decodeURIComponent(m[1]));
  } catch (e) {}
  try {
    const html = String(document.documentElement.outerHTML || '').slice(0, 400000);
    const m1 = html.match(/"bdstoken"\\s*:\\s*"([^"]{6,})"/);
    if (m1) out.bdstokenCandidates.push(m1[1]);
    const m2 = html.match(/bdstoken=([0-9a-zA-Z_-]{20,})/);
    if (m2) out.bdstokenCandidates.push(m2[1]);
  } catch (e) {}
  try {
    const m = document.cookie.match(/(?:^|;\\s*)csrfToken=([^;]+)/);
    if (m) out.csrfToken = decodeURIComponent(m[1]);
  } catch (e) {}
  const loginSelectors = ['.login-dialog', '.login-wrapper', '.pass-login', '.passport-login', '#login-form', '.qrcode-login', '.scan-login', '.login-panel', '.tang-pass-login', '.pass-mod-login', '[class*="login-mask"]', '[class*="passport"]'];
  for (const sel of loginSelectors) {
    try {
      const el = document.querySelector(sel);
      if (!el) continue;
      const visible = (el.offsetParent !== null) || (el.getClientRects && el.getClientRects().length > 0);
      if (visible) { out.loginPrompt = true; out.loginPromptSelectors.push(sel); }
    } catch (e) {}
  }
  return JSON.stringify(out);
})()`;

const collectPageSignals = async () => {
  try {
    await withTimeout(Runtime.enable(), 5000, 'Runtime.enable(probe)');
  } catch { /* api 探测已经 enable 过，失败不影响后续 */ }
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const res = await withTimeout(
        Runtime.evaluate({ expression: pageProbeExpression, returnByValue: true }),
        15000,
        'pageSignalProbe'
      );
      const raw = res?.result?.value;
      if (!raw) throw new Error('page probe returned empty value');
      const parsed = JSON.parse(raw);
      // 正文为空通常是页面还没渲染完；等 3 秒再采一次，仍为空就按"读不到"如实上报。
      if (!String(parsed.pageText || '').trim() && attempt < 2) {
        await sleep(3000);
        continue;
      }
      parsed.probeError = null;
      logStep('page_signals_collected', {
        attempt,
        pageTextLength: String(parsed.pageText || '').length,
        quotaCandidates: (parsed.quotaCandidates || []).length,
        bdstokenCandidates: (parsed.bdstokenCandidates || []).length,
        loginPrompt: Boolean(parsed.loginPrompt)
      });
      return parsed;
    } catch (error) {
      if (attempt === 2) {
        logStep('page_signal_probe_failed', { error: String(error.message || error).slice(0, 200) });
        return { url: '', title: '', pageText: '', quotaText: '', quotaCandidates: [], bdstokenCandidates: [], bdstoken: null, csrfToken: null, loginPrompt: false, loginPromptSelectors: [], probeError: String(error.message || error) };
      }
      await sleep(3000);
    }
  }
  return { probeError: 'unreachable' };
};

// ── 页面上下文就绪等待（2026-10-10 修复）──────────────────────────────
// 必须同时等到 readyState=complete、cookie 已下发、bdstoken 可读、容量文本可读，
// 才算"上下文就绪"；未就绪期间一律重采，不进入登录判定，更不进入登录页分支。
// 目录接口（/api/list）是否就绪由后面的退避重试负责，两者合起来才是"全部就绪"。
const CONTEXT_READY_TIMEOUT_MS = 24000;
const CONTEXT_READY_INTERVAL_MS = 2000;
// 就绪口径本身是纯逻辑，放在 baidu-login-verdict.mjs 里（可离线测试）。
const contextReadinessOf = evaluateContextReadiness;

const waitForBaiduContextReady = async () => {
  const deadline = Date.now() + CONTEXT_READY_TIMEOUT_MS;
  let readiness = null;
  let signals = null;
  let attempt = 0;
  while (Date.now() <= deadline) {
    attempt += 1;
    signals = await collectPageSignals();
    readiness = contextReadinessOf(signals);
    readiness.attempts = attempt;
    logStep('context_ready_probe', {
      attempt,
      readyState: readiness.readyState,
      cookieLength: Number(signals.cookieLength || 0),
      bdstokenPresent: readiness.bdstokenOk,
      quotaPresent: readiness.quotaOk,
      pageTextLength: String(signals.pageText || '').length,
      ready: readiness.ready
    });
    if (readiness.ready) return { readiness, signals, timedOut: false };
    await sleep(CONTEXT_READY_INTERVAL_MS);
  }
  logStep('context_ready_timeout', {
    attempts: attempt,
    readyState: readiness ? readiness.readyState : null,
    bdstokenPresent: readiness ? readiness.bdstokenOk : null,
    quotaPresent: readiness ? readiness.quotaOk : null,
    note: '上下文就绪等待超时：按当前真实信号继续判定；就绪项缺失本身不等于登录失效'
  });
  return { readiness, signals, timedOut: true };
};

// 先等页面上下文就绪（readyState/cookie/bdstoken/容量文本），再做目录接口探测。
logStep('wait_context_ready');
const contextState = await waitForBaiduContextReady();
const contextReady = contextState.readiness || null;

logStep('verify_api_list');
const value = {
  url: target.url,
  title: target.title,
  loggedIn: false,
  loginAvailable: false,
  hasToken: false,
  hasBdstoken: false,
  hasCsrfOnly: false,
  // ↓ 这三个不再是"永远 false"的摆设：下面由 verdict 用真实页面信号赋值
  loginText: false,
  loginPrompt: false,
  loginPromptDom: false,
  loginPromptSelectors: [],
  emptyAnonymousQuota: false,
  quotaText: '',
  apiAuthMode: null,
  apiList: null,
  apiAttempts: [],
  textSample: ''
};
const apiAttempts = [];
// Login check uses the browser page context only. Node-side cookie reconstruction sends
// duplicate/conflicting cookies (STOKEN etc. repeat across domains) and Baidu rejects it as -6,
// even when the browser is actually logged in. The page context fetch uses the real cookie jar.
// ── /api/list 有限次退避重试（2026-09-28 修复 errno=-6；2026-10-10 统一重试口径）──
// 实测证据：HTTP=200 且页面明确已登录（容量 24T/30T、无登录/扫码按钮、bdstoken 存在）
// 时，/api/list 仍会短暂返回 errno=-6；同一参数重试到第 4 次即返回 errno=0。
// 2026-10-10 追加：以下三种形态一律按"可重试的上下文未就绪"处理，**不得**据此判定登录失效：
//   ① fetch 抛 Failed to fetch（页面上下文刚建立、请求被浏览器拒绝）
//   ② status === null（拿不到 HTTP 状态）
//   ③ errno === -6（接口侧瞬时拒绝）
// 因此：单次失败**不得**直接判定需要扫码，必须在**页面上下文**内按退避重试，
// 每次重试都重新读取当前页面 URL、目录参数与 bdstoken，避免拿着陈旧凭据重复失败。
// 仍失败则归类为 baidu-api-transient / baidu-api-rejected：不请求扫码、不做百度写操作。
const API_RETRY_DELAYS_MS = [0, 2000, 5000, 10000];
// 可重试判据（Failed to fetch / status=null / errno=-6）同样放在纯逻辑模块里，便于离线测试。

const pageContextListProbe = async () => {
  const expression = `(async () => {
    // ① 重新读取当前页面 URL，从中解析出真实目录参数
    let dir = ${JSON.stringify(activeBaiduDir)};
    try {
      const m = String(location.href).match(/path=([^&]+)/);
      if (m) {
        const p = decodeURIComponent(m[1]);
        if (p && p.charAt(0) === '/') dir = p;
      }
    } catch (e) {}
    // ② 重新从当前页面读取 bdstoken（不用上一次的陈旧值）
    let bdstoken = null;
    try { if (window.YunData && YunData.MYBDSTOKEN) bdstoken = YunData.MYBDSTOKEN; } catch (e) {}
    if (!bdstoken) { try { if (window.locals && locals.get && locals.get('bdstoken')) bdstoken = locals.get('bdstoken'); } catch (e) {} }
    const params = new URLSearchParams({ order: 'name', desc: '0', showempty: '0', web: '1', page: '1', num: '20', dir });
    if (bdstoken) params.set('bdstoken', bdstoken);
    const url = 'https://pan.baidu.com/api/list?' + params.toString();
    try {
      const r = await fetch(url, { credentials: 'include' });
      const j = await r.json().catch(() => null);
      return JSON.stringify({
        status: r.status,
        errno: j ? j.errno : null,
        hasList: Boolean(j && Array.isArray(j.list)),
        count: j && Array.isArray(j.list) ? j.list.length : null,
        sample: j && Array.isArray(j.list) ? j.list.slice(0, 5).map(i => i.server_filename) : [],
        dir,
        bdstokenPresent: Boolean(bdstoken),
        href: String(location.href).slice(0, 200)
      });
    } catch (e) {
      return JSON.stringify({ status: null, error: String(e.message || e), dir, href: String(location.href).slice(0, 200) });
    }
  })()`;
  const evalResult = await withTimeout(
    Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true }),
    20000,
    'pageContextFetch'
  );
  const raw = evalResult?.result?.value;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return { status: null, error: 'unparsable' }; }
};

try {
  await withTimeout(Runtime.enable(), 5000, 'Runtime.enable');
  for (let attempt = 0; attempt < API_RETRY_DELAYS_MS.length; attempt++) {
    const delay = API_RETRY_DELAYS_MS[attempt];
    if (delay > 0) await sleep(delay);
    const probe = await pageContextListProbe();
    if (!probe) {
      apiAttempts.push({ mode: 'pageContext', attempt: attempt + 1, error: 'no value returned' });
      continue;
    }
    apiAttempts.push({
      mode: 'pageContext',
      attempt: attempt + 1,
      status: probe.status,
      errno: probe.errno,
      hasList: probe.hasList,
      count: probe.count,
      sample: probe.sample,
      dir: probe.dir,
      bdstokenPresent: probe.bdstokenPresent,
      retryable: isRetryableApiFailure(probe),
      error: probe.error || null
    });
    if (probe.status === 200 && probe.errno === 0 && probe.hasList) break;
    logStep('api_list_retry', {
      attempt: attempt + 1,
      status: probe.status,
      errno: probe.errno,
      dir: probe.dir,
      bdstokenPresent: probe.bdstokenPresent,
      retryable: isRetryableApiFailure(probe),
      error: probe.error || null
    });
  }
} catch (error) {
  apiAttempts.push({ mode: 'pageContext', attempt: apiAttempts.length + 1, error: error.message, retryable: String(error.message || '').includes('Failed to fetch') });
}

// ── 目录接口未就绪的补试（2026-10-10 修复）──────────────────────────
// 标准退避用完仍失败、且失败形态属于「上下文未就绪/接口瞬时」（Failed to fetch /
// status=null / errno=-6）时：重新等一次上下文就绪，再补一次 /api/list。
// 这一轮仍失败才交给 verdict 归类；无论如何都不在此处断定"登录失效"。
const apiOkAfterAttempts = apiAttempts.some((item) => item.status === 200 && item.errno === 0 && item.hasList);
const lastAttempt = apiAttempts[apiAttempts.length - 1] || null;
if (!apiOkAfterAttempts && lastAttempt && lastAttempt.retryable) {
  logStep('api_list_context_recovery', {
    attempts: apiAttempts.length,
    lastStatus: lastAttempt.status ?? null,
    lastErrno: lastAttempt.errno ?? null,
    lastError: lastAttempt.error || null,
    contextReadyBefore: contextReady ? contextReady.ready : null,
    note: '标准退避未通过且属可重试形态：重等上下文就绪后补试一次，不判登录失效'
  });
  await waitForBaiduContextReady();
  try {
    const probe = await pageContextListProbe();
    if (probe) {
      apiAttempts.push({
        mode: 'pageContext',
        attempt: apiAttempts.length + 1,
        recovery: true,
        status: probe.status,
        errno: probe.errno,
        hasList: probe.hasList,
        count: probe.count,
        sample: probe.sample,
        dir: probe.dir,
        bdstokenPresent: probe.bdstokenPresent,
        retryable: isRetryableApiFailure(probe),
        error: probe.error || null
      });
    }
  } catch (error) {
    apiAttempts.push({ mode: 'pageContext', attempt: apiAttempts.length + 1, recovery: true, error: error.message });
  }
}
const apiList = apiAttempts.find((item) => item.status === 200 && item.errno === 0 && item.hasList) || apiAttempts[0] || null;
const apiOk = apiList?.status === 200 && apiList?.errno === 0 && apiList?.hasList;

logStep('collect_page_login_signals');
const pageSignals = await collectPageSignals();

// 判定全部交给纯逻辑模块：loggedIn / hasToken / loginText / emptyAnonymousQuota
// / apiList.status / apiList.errno / 页面登录提示 / 容量 -/- 或空值，八个条件一起看，
// 任一不成立即"登录不可用"。
const verdict = evaluateLoginState({
  api: apiList,
  page: {
    url: pageSignals.url || target.url,
    title: pageSignals.title || target.title,
    pageText: pageSignals.pageText,
    quotaText: pageSignals.quotaText,
    quotaCandidates: pageSignals.quotaCandidates,
    bdstoken: pageSignals.bdstoken,
    bdstokenCandidates: pageSignals.bdstokenCandidates,
    csrfToken: pageSignals.csrfToken,
    loginPrompt: pageSignals.loginPrompt,
    loginPromptSelectors: pageSignals.loginPromptSelectors,
    probeError: pageSignals.probeError
  }
});

value.apiAttempts = apiAttempts;
value.apiList = apiList;
value.apiAuthMode = apiOk ? apiList.mode : null;
value.url = pageSignals.url || target.url;
value.title = pageSignals.title || target.title;
value.textSample = String(pageSignals.pageText || '').slice(0, 400);
value.hasBdstoken = verdict.hasBdstoken;
value.hasCsrfOnly = verdict.hasCsrfOnly;
value.hasToken = verdict.hasToken;
value.loginText = verdict.loginText;
value.loginPrompt = verdict.loginPrompt;
value.loginPromptDom = verdict.loginPromptDom;
value.loginPromptSelectors = verdict.loginPromptSelectors;
value.emptyAnonymousQuota = verdict.emptyAnonymousQuota;
value.quotaText = verdict.quotaText;
value.apiStatusOk = verdict.apiStatusOk;
value.apiErrnoOk = verdict.apiErrnoOk;
value.pageProbeOk = verdict.pageProbeOk;
value.probeError = verdict.probeError;
value.reasons = verdict.reasons;
value.failureCodes = verdict.failureCodes;
value.failureReasons = verdict.failureReasons;
value.failureKind = verdict.failureKind;
value.notVideoAnomaly = verdict.notVideoAnomaly;
value.loggedIn = verdict.loggedIn;
value.loginAvailable = verdict.loginAvailable;
// 上下文就绪证据（2026-10-10 新增）：审计侧可据此判断"未就绪"与"掉登录"的区别
value.contextReady = contextReady
  ? {
    ready: contextReady.ready,
    attempts: contextReady.attempts,
    readyState: contextReady.readyState,
    cookieOk: contextReady.cookieOk,
    bdstokenOk: contextReady.bdstokenOk,
    quotaOk: contextReady.quotaOk,
    probeOk: contextReady.probeOk,
    timedOut: Boolean(contextState.timedOut),
    timeoutMs: CONTEXT_READY_TIMEOUT_MS
  }
  : null;
value.apiRetryDelaysMs = API_RETRY_DELAYS_MS;

let loginScreenshotWritten = false;
// 接口侧问题：页面仍显示已登录，只是 /api/list 被拒绝。
// ⇒ 不弹窗、不导航到登录页、不截图、不输出扫码提示（2026-09-28 修复）。
const apiSideOnly = !value.loggedIn && verdict.apiSideIssue === true;
if (apiSideOnly) {
  logStep('api_rejected_no_scan', {
    failureKind: verdict.failureKind,
    errno: verdict.apiList ? verdict.apiList.errno : null,
    attempts: apiAttempts.length,
    requiresScanLogin: verdict.requiresScanLogin,
    note: '页面登录态正常，属百度接口临时拒绝；本轮不请求扫码、不执行百度写操作'
  });
} else if (!value.loggedIn) {
  // ── 登录不可用处理（D1 第 5 条）─────────────────────────────────
  //   · 停止一切百度写操作：本脚本全程只读，绝不下载/分享/移动/上传；
  //   · 不读不写飞书业务记录：本脚本不 import 任何飞书模块；
  //   · 生成 state/baidu-login-qr.png，输出明确扫码提示；
  //   · 以退出码 2 结束，让 runner 记成基础设施失败而非视频异常；
  //   · 不创建任何"成功批次"（run.json 由 runner 负责，本脚本从不写）。
  logStep('login_required_show_window', { failureCodes: verdict.failureCodes });
  await withTimeout(Browser.getWindowForTarget({ targetId: target.id }).then(({ windowId }) =>
    Browser.setWindowBounds({ windowId, bounds: { left: 60, top: 40, width: 1200, height: 850, windowState: 'normal' } })
  ), 5000, 'show login window').catch(() => null);
  if (!String(value.url || '').includes('/login')) {
    await withTimeout(Page.navigate({ url: baiduUrl }), 10000, 'navigate visible Baidu login');
    await sleep(5000);
  }
  // headless 下「去登录」必须用真实鼠标事件才会弹出扫码框；截图优先裁二维码。
  let qrClip = null;
  try {
    await withTimeout(Emulation?.setDeviceMetricsOverride
      ? Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
      : Promise.resolve(), 3000, 'viewport').catch(() => null);
    const ev = async (expression) => {
      const result = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true, timeout: 8000 });
      return result?.result?.value;
    };
    const rect = await ev(`(() => {
      const el = [...document.querySelectorAll('button, a')].find((e) => (e.innerText || '').includes('去登录'));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (rect && Input) {
      const x = Math.round(rect.x), y = Math.round(rect.y);
      await Input.dispatchMouseEvent({ type: 'mouseMoved', x, y, button: 'left' });
      await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      logStep('login_button_clicked', { x, y });
    }
    for (let i = 0; i < 20; i += 1) {
      const box = await ev(`(() => {
        const img = document.querySelector('img.tang-pass-qrcode-img');
        if (!img || /loading\\.gif/.test(img.src || '')) return null;
        const r = img.getBoundingClientRect();
        if (r.width < 80 || r.height < 80) return null;
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })()`);
      if (box) { qrClip = box; break; }
      await sleep(500);
    }
    if (qrClip) logStep('login_qr_ready', { w: Math.round(qrClip.width), h: Math.round(qrClip.height) });
  } catch (error) {
    logStep('login_qr_reveal_failed', { error: String(error.message || error).slice(0, 160) });
  }
  const screenshot = await withTimeout(Page.captureScreenshot(qrClip
    ? { format: 'png', clip: { x: Math.max(0, qrClip.x - 16), y: Math.max(0, qrClip.y - 16), width: qrClip.width + 32, height: qrClip.height + 32, scale: 2 }, captureBeyondViewport: false }
    : { format: 'png', captureBeyondViewport: true }
  ), 10000, 'capture login screenshot').catch(() => null);
  await fs.mkdir(pathMod.dirname(loginScreenshotPath), { recursive: true });
  if (screenshot?.data) {
    const buf = Buffer.from(screenshot.data, 'base64');
    await fs.mkdir(pathMod.dirname(loginScreenshotPath), { recursive: true });
    await fs.writeFile(loginScreenshotPath, buf);
    await fs.mkdir(pathMod.dirname(loginScreenshotRepoPath), { recursive: true });
    await fs.writeFile(loginScreenshotRepoPath, buf);
    loginScreenshotWritten = true;
  }
}

logStep('skip_client_close', { reason: 'avoid Node v24 Windows chrome-remote-interface close assertion' });
const cleanup = { skipped: true, reason: 'ensure only verifies login; runner owns page cleanup', closed: [] };
const effectiveScreenshotPath = value.loggedIn
  ? null
  : (loginScreenshotWritten ? loginScreenshotPath : null);
const loginCheckPath = repoPath('state', 'baidu-cdp-login-check.json');
await fs.mkdir(pathMod.dirname(loginCheckPath), { recursive: true });
await fs.writeFile(loginCheckPath, JSON.stringify({
  checkedAt: new Date().toISOString(),
  port,
  profileDir,
  cleanup,
  loginScreenshotPath: effectiveScreenshotPath,
  loginScreenshotWritten,
  ...value
}, null, 2), 'utf8');

if (value.loggedIn) {
  console.log(JSON.stringify({
    event: 'baidu_cdp_ready',
    port,
    profileDir,
    cleanupClosed: cleanup.closed.length,
    loginScreenshotPath: null,
    ...value
  }, null, 2));
  // 健康路径不提交“登录失效”告警或恢复事件。
  // 旧逻辑在每次成功检查时伪造 BAIDU_LOGIN_EXPIRED + recovered=true，
  // 造成告警侧重复出现“登录故障/恢复”噪音。只有真实失败，或告警状态机
  // 已确认存在同一故障时，才允许由失败/恢复路径提交统一事件。
  logStep('unified_alert_skipped', {
    reason: 'healthy_login',
    summary: '百度网盘登录态和目录接口均正常，本轮不生成新的故障告警；恢复事件仅按活动故障状态机决定。'
  });
  emitCdpRecoveryIfNeeded();
  process.exit(0);
}

// ── 接口侧拒绝（页面登录态正常）─────────────────────────────────────
// 明确输出"接口临时拒绝"，**不请求扫码**；退出码 2（基础设施失败，绝不是视频异常）。
if (apiSideOnly) {
  console.error(JSON.stringify(buildApiRejectedMessage(verdict), null, 2));
  console.log(JSON.stringify({
    event: verdict.apiTransient ? 'baidu_api_transient' : 'baidu_api_rejected',
    port,
    profileDir,
    cleanupClosed: cleanup.closed.length,
    loginScreenshotPath: null,
    requiresScanLogin: false,
    apiAttempts,
    exitCode: 2,
    ...value
  }, null, 2));
  emitCdpAlert(Object.assign(cdpAlertBase(), {
    'error-code': verdict.apiTransient ? 'BAIDU_API_TRANSIENT' : 'BAIDU_API_REJECTED',
    severity: 'P1',
    summary: '百度网盘接口异常：页面登录态正常，但列表接口被拒绝（错误码 ' +
      String(verdict.apiList ? verdict.apiList.errno : '未知') + '，已重试 ' +
      apiAttempts.length + ' 次）。属接口侧问题，无需扫码。',
    'next-action': '保留实际接口错误，等待退避后的下一自然批次；若持续拒绝再核对权限与限流。'
  }));
  process.exit(2);
}

// 登录不可用：明确输出扫码指引，退出码 2（基础设施失败，绝不是视频异常）。
console.error(JSON.stringify(
  buildLoginRequiredMessage(verdict, effectiveScreenshotPath || loginScreenshotPath),
  null,
  2
));
console.log(JSON.stringify({
  event: 'baidu_cdp_login_unavailable',
  port,
  profileDir,
  cleanupClosed: cleanup.closed.length,
  loginScreenshotPath: effectiveScreenshotPath,
  exitCode: 2,
  ...value
}, null, 2));
emitCdpAlert(Object.assign(cdpAlertBase(), {
  'error-code': cdpErrorCode(verdict),
  severity: 'P1',
  summary: '百度网盘登录不可用：' + String((verdict.failureReasons || []).join('；') ||
    verdict.failureKind || '未取到具体原因') + '（失败码 ' +
    String((verdict.failureCodes || []).join(',') || '无') + '）。',
  'next-action': verdict.requiresScanLogin
    ? '打开专用百度网盘页面完成扫码登录；无需手动补跑，下一自然批次会自动继续。'
    : '先确认专用页面可访问与登录态；不要把它笼统归因为网络问题。'
}));
process.exit(2);
