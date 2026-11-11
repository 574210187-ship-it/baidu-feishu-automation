// baidu-login-verdict.mjs — 百度登录可用性判定（纯逻辑，可离线测试）
//
// 背景（2026-09-27 修复缺陷 D1）：
//   ensure-baidu-cdp.mjs 里 loginText / emptyAnonymousQuota 曾被 `const value = { ... }`
//   初始化成 false 之后**再也没有任何赋值**，导致
//     loggedIn = apiOk && !loginText && !emptyAnonymousQuota
//   实际退化成 loggedIn = apiOk —— 只要 /api/list 返回 errno=0，即使页面正在弹扫码
//   登录框、容量显示 -/-（匿名态），也会被判定为"已登录"，进而放行整批百度写操作。
//
// 本模块把"页面信号 → 登录可用性"这一段抽成不依赖 CDP 的纯函数，
//   ① 让 ensure-baidu-cdp.mjs 只负责采集信号、判定统一走这里；
//   ② 让 7 种场景（已登录/登录弹窗/无 bdstoken/API 非 200/errno 非 0/容量 -/-/匿名）
//      可以在完全没有 9223 与网络的情况下离线验证。
//
// 判定口径（任一命中即「登录不可用」）：
//   loggedIn=false / hasToken=false / loginText=true / emptyAnonymousQuota=true
//   / apiList.status !== 200 / apiList.errno !== 0 / 页面出现登录或扫码提示
//   / 容量为 -/- 或空值
//
// 只读模块：不做任何网络请求、不写文件、不碰飞书、不动百度文件。

// ── 登录提示关键词 ────────────────────────────────────────────────
// 注意：绝不能把裸的「登录」当关键词 —— 已登录页也到处是「退出登录/账号与安全」。
// 因此关键词全部取"登录动作短语"，并先剔除「退出登录 / 退出 / 注销」再匹配。
export const LOGIN_TEXT_PATTERNS = [
  '扫码登录',
  '扫描二维码登录',
  '短信登录',
  '密码登录',
  '立即登录',
  '马上登录',
  '一键登录',
  '请先登录',
  '请登录',
  '未登录',
  '重新登录',
  '登录百度账号',
  '登录网盘',
  '登录后查看',
  '登录后才能',
  '登录以',
  '登录才',
  '账号登录',
  'Sign in',
  'Sign In',
  'Log in',
  'Login to'
];

const LOGIN_TEXT_STRIP = /退出登录|退出当前账号|退出|注销|切换账号/g;

// 命中即说明当前页面是 passport 登录页/登录跳转
export const LOGIN_URL_PATTERNS = [
  /passport\.baidu\.com/i,
  /pan\.baidu\.com\/login/i,
  /\/waplogin/i,
  /[?&]login=/i,
  /passport\?.*login/i
];

// ── 已知"接口侧瞬时拒绝"的 errno ──────────────────────────────────
// -6：服务端判定会话凭证无效。实测在页面明确已登录（容量正常、bdstoken 存在）时
//     也会短暂出现，退避重试即可恢复，因此**不得**直接等同于"需要扫码"。
//     只有同时满足"页面未显示登录态"时才按真登录失效处理。
export const API_TRANSIENT_ERRNO = new Set([-6]);

// ── 容量异常形态 ──────────────────────────────────────────────────
// 未登录/匿名态的百度网盘容量条会显示 "-/-" 或干脆空白。
const QUOTA_DASH_PATTERN = /^\s*[-—–－]+\s*\/\s*[-—–－]*\s*$/;
const QUOTA_ZERO_PATTERN = /^\s*0\s*(?:B|K|KB|M|MB|G|GB|T|TB)?\s*\/\s*0\s*(?:B|KB|MB|GB|TB)?\s*$/i;
const QUOTA_USAGE_PATTERN =
  /(\d[\d.,]*\s*(?:B|K|KB|M|MB|G|GB|T|TB|P|PB)?\s*\/\s*\d[\d.,]*\s*(?:B|KB|MB|GB|TB|PB))/i;
const QUOTA_PERCENT_PATTERN = /(\d{1,3}\s*%\s*(?:已用|可用|使用))/;

export const isQuotaEmptyValue = (text) => {
  const raw = typeof text === 'string' ? text : '';
  const trimmed = raw.replace(/\s+/g, ' ').trim();
  if (!trimmed) return true;
  if (QUOTA_DASH_PATTERN.test(trimmed)) return true;
  if (QUOTA_ZERO_PATTERN.test(trimmed)) return true;
  return false;
};

export const detectLoginText = (text) => {
  const raw = typeof text === 'string' ? text : '';
  if (!raw.trim()) return { loginText: false, matched: null, reason: 'empty_text' };
  const cleaned = raw.replace(LOGIN_TEXT_STRIP, ' ');
  for (const pattern of LOGIN_TEXT_PATTERNS) {
    if (cleaned.includes(pattern)) {
      return { loginText: true, matched: pattern, reason: 'page_text_match' };
    }
  }
  return { loginText: false, matched: null, reason: 'no_match' };
};

export const detectLoginUrl = (url) => {
  const raw = typeof url === 'string' ? url : '';
  if (!raw) return { loginUrl: false, matched: null };
  for (const pattern of LOGIN_URL_PATTERNS) {
    if (pattern.test(raw)) return { loginUrl: true, matched: String(pattern) };
  }
  return { loginUrl: false, matched: null };
};

// 从页面正文里兜底提取容量文本（选择器没命中时的第二道防线）。
export const extractQuotaFromText = (text) => {
  const raw = typeof text === 'string' ? text : '';
  if (!raw) return '';
  const usage = raw.match(QUOTA_USAGE_PATTERN);
  if (usage) return usage[1];
  const percent = raw.match(QUOTA_PERCENT_PATTERN);
  if (percent) return percent[1];
  const dash = raw.match(/[-—–－]+\s*\/\s*[-—–－]+/);
  if (dash) return dash[0];
  return '';
};

// 页面探测可能给出多个容量候选（不同选择器）；取第一个非空。
export const pickQuotaText = ({ quotaText, quotaCandidates = [], pageText = '' } = {}) => {
  if (typeof quotaText === 'string' && quotaText.trim()) return quotaText.trim();
  for (const candidate of quotaCandidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return extractQuotaFromText(pageText);
};

// bdstoken 是真登录态的硬凭据。csrfToken 单独存在不算（未登录也会下发）。
const TOKEN_JUNK = new Set(['', 'null', 'undefined', 'none', 'false', '0']);
export const pickBdstoken = (candidates = []) => {
  for (const candidate of candidates) {
    const value = typeof candidate === 'string' ? candidate.trim() : '';
    if (!value) continue;
    if (TOKEN_JUNK.has(value.toLowerCase())) continue;
    if (value.length < 6) continue;
    return value;
  }
  return null;
};

export const isCsrfOnlyToken = ({ bdstoken, csrfToken }) =>
  !bdstoken && Boolean(csrfToken);

const normalizeApiList = (apiList) => {
  if (!apiList || typeof apiList !== 'object') return null;
  return {
    mode: apiList.mode ?? null,
    status: apiList.status === undefined ? null : apiList.status,
    errno: apiList.errno === undefined ? null : apiList.errno,
    hasList: Boolean(apiList.hasList),
    count: apiList.count === undefined ? null : apiList.count
  };
};

/**
 * 综合判定登录可用性。
 *
 * @param {object} signals
 * @param {object|null} signals.api         /api/list 探测结果 { status, errno, hasList, count }
 * @param {object}      signals.page        页面采集结果
 *   - url / title / pageText / quotaText / quotaCandidates
 *   - bdstoken / csrfToken / loginPrompt（DOM 里出现登录弹层）/ probeError
 * @returns {object} verdict
 */
export const evaluateLoginState = (signals = {}) => {
  const apiInput = signals.api ?? null;
  const page = signals.page && typeof signals.page === 'object' ? signals.page : {};
  const apiList = normalizeApiList(apiInput);

  const pageText = typeof page.pageText === 'string' ? page.pageText : '';
  const quotaText = pickQuotaText({
    quotaText: page.quotaText,
    quotaCandidates: Array.isArray(page.quotaCandidates) ? page.quotaCandidates : [],
    pageText
  });
  const bdstoken = pickBdstoken([
    page.bdstoken,
    ...(Array.isArray(page.bdstokenCandidates) ? page.bdstokenCandidates : [])
  ]);
  const hasBdstoken = Boolean(bdstoken);
  const hasCsrfOnly = isCsrfOnlyToken({ bdstoken, csrfToken: page.csrfToken });

  const textHit = detectLoginText(pageText);
  const urlHit = detectLoginUrl(page.url);
  const loginPromptDom = Boolean(page.loginPrompt);
  const loginPrompt = textHit.loginText || urlHit.loginUrl || loginPromptDom;
  const loginText = textHit.loginText || loginPromptDom;

  const quotaEmpty = isQuotaEmptyValue(quotaText);
  const emptyAnonymousQuota = quotaEmpty;

  const apiStatusOk = Boolean(apiList) && apiList.status === 200;
  const apiErrnoOk = Boolean(apiList) && apiList.errno === 0;
  const apiListOk = Boolean(apiList) && apiList.hasList;
  const apiOk = apiStatusOk && apiErrnoOk && apiListOk;

  const probeError = page.probeError ? String(page.probeError) : null;

  const hasToken = hasBdstoken && apiStatusOk && apiErrnoOk;

  const failureCodes = [];
  const failureReasons = [];
  const push = (code, reason) => {
    failureCodes.push(code);
    failureReasons.push(reason);
  };

  if (!apiList) push('api_missing', '/api/list 探测无结果');
  else {
    if (apiList.status !== 200) push('api_status_not_200', `/api/list status=${apiList.status}（要求 200）`);
    if (apiList.errno !== 0) push('api_errno_not_0', `/api/list errno=${apiList.errno}（要求 0）`);
    if (!apiList.hasList) push('api_list_missing', '/api/list 未返回 list 数组');
  }
  if (!hasBdstoken) push('bdstoken_missing', '页面未取到 bdstoken（未登录或已掉登录态）');
  if (textHit.loginText) push('login_text_on_page', `页面出现登录提示文案：${textHit.matched}`);
  if (urlHit.loginUrl) push('login_url', `当前 URL 是登录/通行证页面：${page.url}`);
  if (loginPromptDom) push('login_prompt_dom', `页面存在登录弹层元素：${(page.loginPromptSelectors || []).join(', ') || '(未记录选择器)'}`);
  if (quotaEmpty) push('quota_empty_or_dash', `容量显示为 ${JSON.stringify(quotaText)}（-/- 或空值 = 匿名/未登录）`);
  if (probeError) push('page_probe_failed', `页面信号采集失败：${probeError}`);

  const loggedIn =
    Boolean(apiList) &&
    apiOk &&
    hasToken &&
    !loginText &&
    !loginPrompt &&
    !emptyAnonymousQuota &&
    !probeError;

  // ── errno≠0 不等于登录失效（2026-09-28 修复）───────────────────────────
  // 实测：HTTP=200、页面正文是已登录的网盘主页（容量 24T/30T、有「我的文件」、
  // 无登录/扫码按钮）、bdstoken 存在，但 /api/list 仍可能返回 errno=-6。
  // 这是百度接口侧的瞬时拒绝，有限次重试即可恢复（实测同一参数第 4 次即 errno=0），
  // 把它判成"需要扫码"会中断整条链路，并生成一张名为二维码、实为已登录页面的截图。
  //
  // 口径：
  //   · pageLooksLoggedIn —— 页面层面确实处于登录态（有 bdstoken + 容量非空 + 无登录提示 + 探测未出错）
  //   · apiSideIssue      —— HTTP 200 但 errno≠0，且页面确实已登录 ⇒ 问题在接口侧，不在登录态
  //   · requiresScanLogin —— 只有"出现真实登录/扫码提示"或"bdstoken 确实缺失"才为 true
  const pageLooksLoggedIn =
    hasBdstoken && !quotaEmpty && !loginPrompt && !probeError && !hasCsrfOnly;
  const httpOk = Boolean(apiList) && apiList.status === 200;
  const errnoNotOk = Boolean(apiList) && apiList.errno !== 0;
  const apiSideIssue = httpOk && errnoNotOk && pageLooksLoggedIn;
  const apiTransient = apiSideIssue && API_TRANSIENT_ERRNO.has(apiList.errno);
  const apiRejected = apiSideIssue && !apiTransient;
  const scanEvidence = textHit.loginText || urlHit.loginUrl || loginPromptDom || !hasBdstoken || quotaEmpty;
  const requiresScanLogin = !loggedIn && !apiSideIssue && Boolean(scanEvidence);

  const failureKind = loggedIn
    ? null
    : apiTransient
      ? 'baidu-api-transient'
      : apiRejected
        ? 'baidu-api-rejected'
        : 'baidu-login-infra';

  const reasons = [];
  reasons.push(`api=${apiList ? `status:${apiList.status},errno:${apiList.errno},hasList:${apiList.hasList}` : 'null'}`);
  reasons.push(`bdstoken=${hasBdstoken ? 'present' : hasCsrfOnly ? 'csrf-only' : 'absent'}`);
  reasons.push(`loginText=${loginText}${textHit.matched ? `(${textHit.matched})` : ''}`);
  reasons.push(`loginUrl=${urlHit.loginUrl}`);
  reasons.push(`loginPromptDom=${loginPromptDom}`);
  reasons.push(`quota=${JSON.stringify(quotaText)}`);
  reasons.push(`probeError=${probeError || 'none'}`);

  return {
    // 兼容性字段：ensure-baidu-cdp.mjs 与既有读取方都读这些键名
    loggedIn,
    loginAvailable: loggedIn,
    hasToken,
    hasBdstoken,
    hasCsrfOnly,
    loginText,
    loginPrompt,
    loginPromptDom,
    loginPromptSelectors: page.loginPromptSelectors || [],
    emptyAnonymousQuota,
    quotaText,
    apiList,
    apiStatusOk,
    apiErrnoOk,
    apiOk,
    pageProbeOk: !probeError,
    probeError,
    reasons,
    failureCodes,
    failureReasons,
    // errno≠0 但页面确实已登录 ⇒ 接口侧问题，不是登录失效（2026-09-28 新增）
    pageLooksLoggedIn,
    apiSideIssue,
    apiTransient,
    apiRejected,
    // 只有真实扫码页 / bdstoken 确实缺失才为 true；接口侧问题一律 false
    requiresScanLogin,
    // 登录失败属于基础设施问题，绝不是视频异常：任何下游都不许把它记成视频异常。
    notVideoAnomaly: true,
    failureKind
  };
};

// ── 页面上下文就绪判定（2026-10-10 新增，纯逻辑）───────────────────────
// 背景：页面刚创建/刚导航时 readyState 仍是 loading、cookie 尚未下发、
// bdstoken 与容量文本都读不到。旧实现只在「正文为空」时重采一次，
// 于是"没渲染完"会被当成"掉登录"，进而误弹二维码、误中断整批。
//
// 就绪口径（五项全中才算就绪）：
//   ① document.readyState === 'complete'
//   ② document.cookie 非空（会话 cookie 已下发）
//   ③ bdstoken 可读（真登录态硬凭据；仅 csrfToken 不算）
//   ④ 容量文本可读（非空；"-/-" 也算"读到了"，由 evaluateLoginState 判匿名）
//   ⑤ 页面探测本身没有出错
// 注意：④ 只要求"读得到文本"，**不**要求它必须是有效容量——
// 把 "-/-" 当成"未就绪"会让匿名态永远等不到就绪，反而掩盖真问题。
export const evaluateContextReadiness = (signals = {}) => {
  const readyState = String(signals.pageReadyState || '');
  const cookieOk = Number(signals.cookieLength || 0) > 0 || Boolean(signals.cookieHasStoken);
  const bdstoken = pickBdstoken([
    signals.bdstoken,
    ...(Array.isArray(signals.bdstokenCandidates) ? signals.bdstokenCandidates : [])
  ]);
  const quotaText = pickQuotaText({
    quotaText: signals.quotaText,
    quotaCandidates: Array.isArray(signals.quotaCandidates) ? signals.quotaCandidates : [],
    pageText: signals.pageText
  });
  const probeOk = !signals.probeError;
  const ready = probeOk && readyState === 'complete' && cookieOk && Boolean(bdstoken) && Boolean(quotaText);
  return {
    readyState,
    readyStateOk: readyState === 'complete',
    cookieOk,
    bdstoken,
    bdstokenOk: Boolean(bdstoken),
    quotaText,
    quotaOk: Boolean(quotaText),
    probeOk,
    ready,
    attempts: 0
  };
};

// ── /api/list 失败是否"可重试"（2026-10-10 新增，纯逻辑）───────────────
// 三种形态一律按"上下文未就绪/接口瞬时"处理，**不得**据此判定登录失效：
//   ① fetch 抛 Failed to fetch（上下文刚建立，请求被浏览器拒绝）
//   ② status === null / undefined（拿不到 HTTP 状态）
//   ③ errno === -6（接口侧瞬时拒绝，退避即可恢复）
// 其余（如 403/404、errno 非 -6 的明确拒绝）不算可重试，交由 verdict 归类。
export const RETRYABLE_FETCH_ERRORS = ['Failed to fetch', 'NetworkError', 'Load failed'];

export const isRetryableApiFailure = (probe) => {
  if (!probe) return true;
  const errorText = String(probe.error || '');
  if (RETRYABLE_FETCH_ERRORS.some((needle) => errorText.includes(needle))) return true;
  if (probe.status === null || probe.status === undefined) return true;
  if (probe.errno === -6 || probe.errno === '-6') return true;
  return false;
};

// 供调用方拼装"扫码提示"。登录失败时 ensure-baidu-cdp.mjs 必须原样输出这段。
export const buildLoginRequiredMessage = (verdict, screenshotPath) => ({
  event: 'baidu_login_required',
  action: '请打开截图扫码登录百度网盘，登录成功后下一轮计划批次会自动继续',
  screenshotPath,
  failureKind: 'baidu-login-infra',
  // 登录失败不得被写成视频异常，也不得生成"成功批次"。
  notVideoAnomaly: true,
  mustNotWriteFeishu: true,
  mustNotMoveBaiduFiles: true,
  mustNotCreateSuccessBatch: true,
  loggedIn: verdict.loggedIn,
  hasToken: verdict.hasToken,
  loginText: verdict.loginText,
  emptyAnonymousQuota: verdict.emptyAnonymousQuota,
  apiList: verdict.apiList,
  failureCodes: verdict.failureCodes,
  failureReasons: verdict.failureReasons
});

// 供调用方拼装"接口侧拒绝"消息（2026-09-28 新增）。
// 与 buildLoginRequiredMessage 的关键区别：
//   · **绝对不请求扫码**（页面仍是已登录状态，扫码毫无意义且会误导）；
//   · 不生成"二维码"截图（实测旧逻辑截出来的是已登录页面，名字却叫 baidu-login-qr.png）；
//   · 不导航到登录页、不执行任何百度写操作；
//   · 仍是基础设施失败（exitCode 2），但明确归类为接口瞬时/拒绝，不是登录失效。
export const buildApiRejectedMessage = (verdict) => ({
  event: verdict.apiTransient ? 'baidu_api_transient' : 'baidu_api_rejected',
  // ↓ 这里绝不出现"请扫码"
  // ↓ 这条文案刻意不含任何登录动作关键词：下游若有"检测到请求登录就中断"的正则，
  //   绝不能因为一句澄清说明而误命中。是否请求扫码一律以 requiresScanLogin 字段为准。
  action: '百度网盘接口临时拒绝（页面登录态正常），本轮不会要求重新登录；已按有限次退避重试仍未通过，等待下一轮计划批次自动继续',
  failureKind: verdict.failureKind,
  requiresScanLogin: false,
  notVideoAnomaly: true,
  mustNotRequestScanLogin: true,
  mustNotWriteFeishu: true,
  mustNotMoveBaiduFiles: true,
  mustNotCreateSuccessBatch: true,
  loggedIn: verdict.loggedIn,
  pageLooksLoggedIn: verdict.pageLooksLoggedIn,
  hasToken: verdict.hasToken,
  quotaText: verdict.quotaText,
  apiList: verdict.apiList,
  failureCodes: verdict.failureCodes,
  failureReasons: verdict.failureReasons
});

export default evaluateLoginState;
