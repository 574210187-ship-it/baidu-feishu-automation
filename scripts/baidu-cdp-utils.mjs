import fs from 'node:fs/promises';
import path from 'node:path';
import CDP from 'chrome-remote-interface';
import { ACTIVE_BAIDU_DIR, ACTIVE_BAIDU_URL, BAIDU_PROFILE_DIR, CDP_PORT } from './runtime-config.mjs';

export const port = CDP_PORT;
export const baiduProfileDir = BAIDU_PROFILE_DIR;
export const activeBaiduDir = ACTIVE_BAIDU_DIR;
export const activeBaiduUrl = ACTIVE_BAIDU_URL;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const listTargets = async (timeoutMs = 5000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: controller.signal });
    if (!response.ok) throw new Error(`CDP target list HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
};

export const isMainBaiduDiskPage = (target) =>
  target?.type === 'page' &&
  target.url.includes('pan.baidu.com/disk/main');

// 唯一"主页面"判定：只有 zed 活动目录页才算。
// 旧实现把**所有** /disk/main 都当主页面保护，导致每轮跑完都会累积（实测 left=4：
// 意晨页 + 姜律师页 + 2 个 zed 页）。用 keepOnlyMainPage 收紧成"只留一个 zed 主页"。
export const isKeepableMainPage = (target) =>
  isMainBaiduDiskPage(target) && decodeURIComponent(target.url || '').includes(activeBaiduDir);

export const isTemporaryBaiduPage = (target) => {
  if (target?.type !== 'page') return false;
  const url = target.url || '';
  return (
    url === 'about:blank' ||
    url === 'chrome://newtab/' ||
    url === 'chrome://intro/' ||
    url.includes('/login') ||
    url.includes('/pfile/video') ||
    url.includes('d.pcs.baidu.com') ||
    url.includes('bdbl-') ||
    url.includes('/s/')
  );
};

export const cleanupBaiduTargets = async ({ keepMainDisk = true, closeAllBaidu = false, mainUrl = activeBaiduUrl, keepOnlyMainPage = false } = {}) => {
  const targets = await listTargets().catch(() => []);
  const pages = targets.filter((target) => target.type === 'page');
  const closed = [];
  const CHROME_PAGES = ['about:blank', 'chrome://newtab/', 'chrome://intro/'];
  // keepOnlyMainPage：整轮结束时把状态收敛成"恰好一个 zed 主目录页"，
  // 其余百度页（含其它表的目录页）一律关闭；非百度标签页不动。
  const keepTarget = keepOnlyMainPage && keepMainDisk
    ? pages.find((target) => isKeepableMainPage(target))
    : null;

  for (const target of pages) {
    if (keepTarget && target.id === keepTarget.id) continue;
    if (keepMainDisk && !keepOnlyMainPage && isMainBaiduDiskPage(target)) continue;
    const isBaidu = (target.url || '').includes('pan.baidu.com');
    if (keepOnlyMainPage) {
      if (!isBaidu && !CHROME_PAGES.includes(target.url)) continue;
    } else if (closeAllBaidu) {
      if (!isBaidu && !CHROME_PAGES.includes(target.url)) continue;
    } else if (!isTemporaryBaiduPage(target)) {
      continue;
    }
    await CDP.Close({ port, id: target.id })
      .then(() => closed.push({ id: target.id, url: target.url }))
      .catch(() => null);
  }
  if (closed.length) await sleep(1000);
  const afterClose = await listTargets().catch(() => []);
  const hasMain = afterClose.some((target) =>
    keepMainDisk && (keepOnlyMainPage ? isKeepableMainPage(target) : isMainBaiduDiskPage(target))
  );
  if (keepMainDisk && !closeAllBaidu && !hasMain) {
    await CDP.New({ port, url: activeBaiduUrl }).catch((error) => {
      closed.push({ id: 'CREATE_MAIN_FAILED', url: String(error.message || error).slice(0, 200) });
    });
    await sleep(3000);
  }

  return {
    before: pages.length,
    keepOnlyMainPage,
    closed,
    left: (await listTargets().catch(() => []))
      .filter((target) => target.type === 'page')
      .map((target) => ({ id: target.id, url: target.url, title: target.title }))
  };
};

export const waitForLocalFile = async (targetPath, timeoutMs = 90000) => {
  const deadline = Date.now() + timeoutMs;
  const dir = path.dirname(targetPath);
  const name = path.basename(targetPath);

  while (Date.now() < deadline) {
    const files = await fs.readdir(dir).catch(() => []);
    const hasTemp = files.some((file) => file.endsWith('.crdownload') || file.endsWith('.tmp'));
    if (files.includes(name) && !hasTemp) {
      const stat = await fs.stat(targetPath);
      if (stat.size > 0) return stat;
    }
    await sleep(1000);
  }

  throw new Error(`Chrome native download did not finish: ${targetPath}`);
};

// Page-context Baidu API fetch.
// Node-side `Network.getAllCookies()` reconstruction sends duplicate/conflicting cookies
// (e.g. STOKEN appears 4x across domains) which makes pan.baidu.com return errno=-6.
// Fetching inside an authenticated page context lets the browser apply correct
// domain/path-matched cookies automatically, so auth always succeeds.
export const getBaiduPageTargetForApi = async () => {
  const targets = await listTargets();
  let target = targets.find((t) => t.type === 'page' && t.url.includes('pan.baidu.com/disk/main'));
  if (!target) target = targets.find((t) => t.type === 'page' && t.url.includes('pan.baidu.com'));
  if (!target) {
    target = await CDP.New({ port, url: 'https://pan.baidu.com/disk/main' });
    await sleep(4000);
  }
  return target;
};

// Returns the browser's own cookie string for the authenticated Baidu page.
// Unlike Network.getAllCookies() (which dumps every baidu.com domain cookie, including
// duplicates like STOKEN x4 that make pan.baidu.com reject the request with errno=-6),
// document.cookie yields exactly the cookies valid for the current origin, de-duplicated
// by the browser. Use this string for Node-side fetch (which is not subject to CORS),
// e.g. when downloading a doc file whose dlink points at a cross-origin CDN.
export const getPageCookie = async () => {
  const target = await getBaiduPageTargetForApi();
  const client = await CDP({ port, target });
  const { Runtime } = client;
  await Runtime.enable();
  try {
    const r = await Runtime.evaluate({ expression: 'document.cookie', returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails?.exception?.description || r.exceptionDetails.text);
    return r.result?.value || '';
  } finally {
    await client.close().catch(() => null);
  }
};

export const baiduApiFetchJson = async (apiPath, params = {}, { method = 'GET', timeoutMs = 30000 } = {}) => {
  const target = await getBaiduPageTargetForApi();
  const client = await CDP({ port, target });
  const { Runtime } = client;
  await Runtime.enable();
  const url = `https://pan.baidu.com${apiPath}?${new URLSearchParams(params).toString()}`;
  const expr = `(async () => { try { const r = await fetch(${JSON.stringify(url)}, {method:${JSON.stringify(method)}, credentials:'include', headers:{'user-agent':'Mozilla/5.0'}}); const t = await r.text(); try { return {ok:true, json:JSON.parse(t)}; } catch (e) { return {ok:true, json:{raw:t}}; } } catch (e) { return {ok:false, error:String(e)}; } })()`;
  let res;
  try {
    const r = await Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true, timeout: timeoutMs });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails?.exception?.description || r.exceptionDetails.text);
    res = r.result?.value;
  } finally {
    await client.close().catch(() => null);
  }
  if (!res?.ok) throw new Error(res?.error || 'page-context fetch failed');
  return { status: 200, json: res.json };
};

export const baiduBinaryFetchBase64 = async (url, { timeoutMs = 90000 } = {}) => {
  const target = await getBaiduPageTargetForApi();
  const client = await CDP({ port, target });
  const { Runtime } = client;
  await Runtime.enable();
  const expr = `(async () => { try { const r = await fetch(${JSON.stringify(url)}, {credentials:'include', headers:{'user-agent':'Mozilla/5.0'}}); const b = await r.arrayBuffer(); const a = new Uint8Array(b); let s = ''; for (let i = 0; i < a.length; i += 8192) { s += String.fromCharCode.apply(null, a.subarray(i, i + 8192)); } return btoa(s); } catch (e) { return {__err:String(e)}; } })()`;
  let res;
  try {
    const r = await Runtime.evaluate({ expression: expr, awaitPromise: true, returnByValue: true, timeout: timeoutMs });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails?.exception?.description || r.exceptionDetails.text);
    res = r.result?.value;
  } finally {
    await client.close().catch(() => null);
  }
  if (res && res.__err) throw new Error(res.__err);
  if (typeof res !== 'string') throw new Error('unexpected binary fetch result');
  return res;
};

export const createDownloadSession = async (downloadDir) => {
  await fs.mkdir(downloadDir, { recursive: true });
  const target = await CDP.New({ port, url: 'about:blank' });
  const client = await CDP({ port, target });
  const { Browser, Page } = client;
  await Page.enable();
  await Browser.setDownloadBehavior({
    behavior: 'allow',
    downloadPath: downloadDir,
    eventsEnabled: true
  }).catch(async () => {
    await Page.setDownloadBehavior({ behavior: 'allow', downloadPath: downloadDir });
  });

  return {
    async download(url, targetPath) {
      await fs.rm(targetPath, { force: true }).catch(() => null);
      await Page.navigate({ url: 'about:blank' }).catch(() => null);
      await Page.navigate({ url });
      return waitForLocalFile(targetPath);
    },
    async close() {
      await client.close().catch(() => null);
      await CDP.Close({ port, id: target.id }).catch(() => null);
    }
  };
};
