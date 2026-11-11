// lark-cli-utils.mjs —— 飞书 lark-cli 调用的唯一出口（带「临时网络错误」重试）
//
// 为什么需要它（2026-09-15）：
//   `2026-09-14-16时批次` 因为飞书接口偶发返回
//     `800100001 / 800004014 / THRIFT_EGRESS / remote or network error`
//   让 runner 直接 failed —— 一秒的网络抖动毁掉一整轮 4 小时批次。
//   过去每个脚本各自写一份 `const runLark = (args) => { spawnSync...; if (status!==0) throw }`，
//   零重试，任何一次出口抖动都是"当场失败"。
//
// 本模块只做三件事，且只做这三件事：
//   ① 调固定的 lark-cli（默认取 table-context.mjs 的 LARK_CLI）
//   ② 只在**瞬时**错误上重试（有预算、有退避、有抖动、有 JSON 日志）
//   ③ 把 stdout 当 UTF-8 解析成 JSON（需要 JSON 时走 runLarkCliJson）
//
// 明确**不做**：不写飞书字段、不碰百度 CDP/9223、不读写 state/run.lock、
// 不改变任何业务语义（批次规则 / 阶段顺序 / 三态 / 目录映射全部原样）。
//
// 用法：
//   import { runLarkCli, runLarkCliJson } from './lark-cli-utils.mjs';
//   const raw = runLarkCli(['base', '+field-list', ...]);          // 不抛，返回完整结果
//   const j   = runLarkCliJson(['base', '+record-list', ...]);     // 重试耗尽后抛错
//
// 可调开关（默认值即用户 2026-09-15 指定的策略，一般不需要改）：
//   LARK_CLI_MAX_ATTEMPTS=<n>       覆盖最多尝试次数（默认 5）
//   LARK_CLI_RETRY_DELAYS_MS=a,b,c  覆盖退避阶梯（默认 2000,5000,10000,20000,40000）
//   LARK_CLI_RETRY_DISABLED=1       应急：关闭重试，退回"一次失败即抛"的老行为

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { LARK_CLI } from './table-context.mjs';
import { REPO_ROOT } from './runtime-config.mjs';

// 默认最多尝试 5 次 = 首次 + 4 次重试。
// 退避阶梯给出 5 档（2/5/10/20/40s），第 N 次失败后取第 N 档；
// 因此默认策略实际用到 2s/5s/10s/20s，最坏额外等待 ≈ 37s（不含抖动）。
// 若把 LARK_CLI_MAX_ATTEMPTS 提到 6，第 5 档 40s 才会用上。
export const LARK_DEFAULT_MAX_ATTEMPTS = 5;
export const LARK_DEFAULT_DELAYS_MS = [2000, 5000, 10000, 20000, 40000];
// 抖动系数：每次退避乘以 [1-0.2, 1+0.2) 的随机因子，避免多进程同时重试形成尖峰。
export const LARK_JITTER_RATIO = 0.2;

// ── 「瞬时」错误指纹：命中即重试 ────────────────────────────────────────────────
// 全部是"再试一次大概率就好"的量：飞书临时码、出口抖动、短连接异常、fetch 失败。
export const LARK_RETRYABLE_PATTERNS = [
  '800100001',              // 飞书内部/网关临时错误
  '800004014',              // 飞书临时错误（用户明确列入可重试）
  'THRIFT_EGRESS',          // 出口抖动
  'remote or network error',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ECONNREFUSED',
  'EPIPE',
  'socket hang up',
  'fetch failed',
  // ── 2026-09-23 补充：DNS / 网络层故障的「人话」形态（Go net 与 curl 的报错文案）──
  // 背景：`2026-09-18-16时批次` 因 `dial tcp: lookup open.feishu.cn: no such host`
  // 一条指纹都命中不了，落到兜底 non-retryable，**只试 1 次就整批 failed**，
  // 白白丢掉一个 4 小时档期（当天系统代理 127.0.0.1:7897 悬空所致）。
  // 这批指纹与 LARK_FATAL_PATTERNS 无交集，只会让"再来一次"的次数变多，不会误伤确定性错误。
  'no such host',                          // Go：DNS 解析无此主机
  'dial tcp',                              // Go：net 拨号失败
  'temporary failure in name resolution',  // Linux/glibc 解析器瞬时失败
  'server misbehaving',                    // Go：解析器返回异常
  'i/o timeout',                           // 读写超时
  'TLS handshake timeout',
  'handshake timeout',
  '"type": "network"',               // 结构化 JSON 被截断、无法 JSON.parse 时的兜底
  '"type":"network"',
  '"subtype": "timeout"',
  '"subtype":"timeout"',
  'network is unreachable',
  'no route to host',
  'connection refused',
  'reset by peer'
];

// 「瞬时」HTTP 状态码：命中即重试
export const LARK_RETRYABLE_HTTP_STATUS = [429, 500, 502, 503, 504];

// ── 「确定性」错误指纹：只用于给出**更准确的不可重试理由** ──────────────────────
// 注意：分类器的默认结论本来就是"不可重试"，所以本表不是安全网，只是让日志能说清
// "为什么这条不该重试"，避免运维把"字段缺失/权限不足"误当成网络问题反复等。
// 判定顺序上「瞬时指纹」优先，因此 `ENOTFOUND` 不会被这里的 `not found` 抢走。
export const LARK_FATAL_PATTERNS = [
  '800030005',              // 字段值被拒（受限单选写自定义值 / 非法枚举）
  'FieldNameNotFound',
  'fieldNameInvalid',
  'field not found',
  'InvalidParameter',
  'invalid parameter',
  'invalid request parameter',
  '99991672',               // app/token 维度权限不足
  '99991663',               // tenant/user token 无效
  'access denied',
  'permission denied',
  'no permission',
  'forbidden',
  'table not found',
  'base not found',
  'app_token not exist',
  'not exist'
];

const LARK_MAX_BUFFER = 20 * 1024 * 1024;

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 「代码型」指纹（纯字母数字下划线，如 ENOTFOUND / 800100001 / THRIFT_EGRESS）必须加词边界：
// 首次烟测就抓到假阳性 —— 裸子串匹配会让 `ENOTFOUND` 命中 `FieldNameNotFound`（字段缺失），
// 把"确定性错误"误判成"网络抖动"并白等 37 秒。带空格的短语指纹用普通子串匹配即可。
const buildMatcher = (pattern) => (/^[A-Za-z0-9_]+$/.test(pattern)
  ? new RegExp(`\\b${escapeRegExp(pattern)}\\b`, 'i')
  : new RegExp(escapeRegExp(pattern), 'i'));

const RETRYABLE_MATCHERS = LARK_RETRYABLE_PATTERNS.map((pattern) => ({ label: pattern, re: buildMatcher(pattern) }));
const FATAL_MATCHERS = LARK_FATAL_PATTERNS.map((pattern) => ({ label: pattern, re: buildMatcher(pattern) }));

// 同步睡眠：脚本全是 spawnSync 的同步链，不能用 await。
// Atomics.wait 在 Node 主线程可用（浏览器才禁用）；异常时退化为忙等兜底。
const sleepSync = (ms) => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* busy wait fallback */ }
  }
};

// argsSummary：日志里只留"能认出来是哪条命令"的最短摘要，避免把超长 JSON 灌进日志。
const summarizeArgs = (args) => {
  const list = Array.isArray(args) ? args : [String(args)];
  const head = list.slice(0, 6).map((item) => {
    const text = String(item);
    return text.length > 48 ? `${text.slice(0, 45)}...` : text;
  });
  let summary = head.join(' ');
  if (list.length > 6) summary += ` ...(+${list.length - 6})`;
  return summary.length > 300 ? `${summary.slice(0, 297)}...` : summary;
};

// 从真实输出里抠出 HTTP 状态码（只认 http/status/code 紧邻的那 3 位数字）
const HTTP_STATUS_RE = /(?:http[^\d]{0,8}|status[^\d]{0,8}|statuscode[^\d]{0,8}|code[^\d]{0,8})(429|500|502|503|504)(?!\d)/i;

/**
 * 判断一次失败是否属于「临时网络错误」。
 * @param {{stdout?:string, stderr?:string, status?:number|null, signal?:string|null, error?:{code?:string,message?:string}|null}} outcome
 * @returns {{retryable:boolean, reason:string}}
 */
export const classifyLarkFailure = (outcome) => {
  const parts = [
    outcome?.stdout,
    outcome?.stderr,
    outcome?.error?.message,
    outcome?.error?.code,
    outcome?.signal ? `signal ${outcome.signal}` : null
  ].filter((part) => part !== null && part !== undefined && String(part).trim() !== '');
  const text = parts.join('\n');

  // ①a lark-cli 结构化失败：{ ok:false, error:{ type, subtype, message } }
  // 2026-11-11 01:59 批次 zed 第三阶段在 offset 2600 遇到
  //   type=network / subtype=timeout / message="API call failed: Get https://open.feishu.cn/..."
  // 文案常常没有 "TLS handshake timeout" 或 "i/o timeout" 这些旧指纹，
  // 被兜底判成 non-retryable，只试 1 次就把整阶段打成 failed。
  const stdoutText = String(outcome?.stdout || '').trim();
  if (stdoutText.startsWith('{')) {
    try {
      const parsed = JSON.parse(stdoutText);
      const err = parsed && parsed.ok === false ? parsed.error : null;
      if (err && typeof err === 'object') {
        const typ = String(err.type || '').toLowerCase();
        const sub = String(err.subtype || '').toLowerCase();
        if (typ === 'network' || typ === 'timeout' || sub === 'timeout') {
          return { retryable: true, reason: `transient:lark_json_${typ || 'error'}_${sub || 'none'}` };
        }
      }
    } catch {
      // stdout 不是完整 JSON，继续走文本指纹
    }
  }

  // ① 瞬时指纹优先：这些码本身就是"请重试"
  for (const { label, re } of RETRYABLE_MATCHERS) {
    if (re.test(text)) return { retryable: true, reason: `transient:${label}` };
  }
  // ② HTTP 瞬时状态码
  const httpHit = text.match(HTTP_STATUS_RE);
  if (httpHit) return { retryable: true, reason: `transient:http_${httpHit[1]}` };
  // ③ 显式信号（被 SIGKILL/SIGTERM 干掉）不算网络抖动，不重试 —— 重试也只会再被杀一次
  if (outcome?.signal) return { retryable: false, reason: `signal:${outcome.signal}` };
  // ④ 确定性错误：给出明确理由（结论仍是不可重试）
  for (const { label, re } of FATAL_MATCHERS) {
    if (re.test(text)) return { retryable: false, reason: `fatal:${label}` };
  }
  return { retryable: false, reason: 'non-retryable' };
};

const resolveMaxAttempts = (options) => {
  const fromEnv = Number(process.env.LARK_CLI_MAX_ATTEMPTS);
  const raw = Number(options?.maxAttempts) || (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 0) || LARK_DEFAULT_MAX_ATTEMPTS;
  return Math.max(1, Math.floor(raw));
};

const resolveDelays = (options) => {
  if (Array.isArray(options?.delaysMs) && options.delaysMs.length) {
    return options.delaysMs.map((ms) => Math.max(0, Number(ms) || 0));
  }
  const fromEnv = String(process.env.LARK_CLI_RETRY_DELAYS_MS || '')
    .split(',')
    .map((piece) => Number(piece.trim()))
    .filter((ms) => Number.isFinite(ms) && ms >= 0);
  return fromEnv.length ? fromEnv : LARK_DEFAULT_DELAYS_MS;
};

const retryDisabled = () => process.env.LARK_CLI_RETRY_DISABLED === '1';

const emit = (payload, options) => {
  if (typeof options?.onEvent === 'function') {
    options.onEvent(payload);
    return;
  }
  try {
    console.log(JSON.stringify(payload));
  } catch { /* 日志失败绝不改变控制流 */ }
};

const withJitter = (ms, jitter) => {
  if (!ms) return 0;
  if (jitter === false) return ms;
  const factor = 1 + (Math.random() * 2 - 1) * LARK_JITTER_RATIO;
  return Math.max(1, Math.round(ms * factor));
};

const buildFailure = ({ argsSummary, attempts, reason, status, signal, stdout, stderr, error }) => {
  const tail = String(stderr || stdout || (error && error.message) || '').trim().slice(0, 400);
  const err = new Error(
    `lark-cli failed after ${attempts} attempt(s): ${reason}; args=[${argsSummary}]${tail ? `; output=${tail}` : ''}`
  );
  err.code = 'LARK_CLI_FAILED';
  err.lark = { argsSummary, attempts, reason, status, signal, stdout, stderr, retryable: false };
  return err;
};

const isWithin = (base, target) => {
  const relative = path.relative(base, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
};

// lark-cli 的 --json/--file 只接受相对于 cwd 的文件名。
// 内部模块可以使用绝对 state 路径，但传给 CLI 前必须转换，否则会把整批 stage3 判成失败。
export const normalizeLarkFileArgs = (args, requestedCwd = process.cwd()) => {
  const normalized = [...args];
  let cwd = path.resolve(requestedCwd);
  const repo = path.resolve(REPO_ROOT);
  const fileFlags = new Set(['--json', '--file']);
  for (let i = 0; i < normalized.length - 1; i += 1) {
    if (!fileFlags.has(normalized[i])) continue;
    const original = String(normalized[i + 1]);
    const at = original.startsWith('@');
    const fileValue = at ? original.slice(1) : original;
    if (!path.isAbsolute(fileValue)) continue;
    const absolute = path.resolve(fileValue);
    if (!isWithin(cwd, absolute) && isWithin(repo, absolute)) cwd = repo;
    if (!isWithin(cwd, absolute)) continue;
    const relative = path.relative(cwd, absolute).replace(/\\/g, '/');
    normalized[i + 1] = (at ? '@' : '') + (relative || path.basename(absolute));
  }
  return { args: normalized, cwd };
};

// 核心：调用 + 判定 + 重试。parseJson 决定是否顺带解析（解析失败的处理见下）。
const invoke = (args, options, parseJson) => {
  const cli = options?.cli || LARK_CLI;
  const maxAttempts = resolveMaxAttempts(options);
  const delays = resolveDelays(options);
  // 所有生产调用默认固定在仓库根目录执行；调用方若有上传文件等特殊目录，必须显式传 cwd。
  // 这样即使脚本从计划任务、WorkBuddy 或其他工作目录启动，--json/--file 仍能被统一归一化。
  const normalized = normalizeLarkFileArgs(args, options?.cwd || REPO_ROOT);
  const effectiveArgs = normalized.args;
  const argsSummary = summarizeArgs(effectiveArgs);
  const spawnOptions = {
    encoding: 'utf8',
    maxBuffer: options?.maxBuffer || LARK_MAX_BUFFER
  };
  spawnOptions.cwd = normalized.cwd;
  if (options?.timeout) spawnOptions.timeout = options.timeout;
  if (options?.env) spawnOptions.env = options.env;
  if (options?.input !== undefined) spawnOptions.input = options.input;

  const tried = [];
  let last = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const startedAt = Date.now();
    const raw = spawnSync(cli, effectiveArgs, spawnOptions);
    const stdout = raw.stdout === null || raw.stdout === undefined ? '' : String(raw.stdout);
    const stderr = raw.stderr === null || raw.stderr === undefined ? '' : String(raw.stderr);
    const error = raw.error ? { code: raw.error.code, message: raw.error.message } : null;
    const status = raw.status === undefined ? null : raw.status;
    const signal = raw.signal || null;
    const processOk = status === 0 && !error && !signal;

    // 进程成功但需要 JSON 时，还要过一次解析。
    if (processOk && parseJson) {
      const trimmed = stdout.trim();
      if (!trimmed) {
        // 退出码 0 却一个字节都没有 —— 典型的响应被截断，按瞬时错误重试。
        last = { attempt, status, signal, stdout, stderr, error, reason: 'empty_stdout', retryable: true };
      } else {
        try {
          const json = JSON.parse(stdout);
          tried.push({ attempt, ok: true, ms: Date.now() - startedAt });
          return { ok: true, json, status, signal, stdout, stderr, attempts: attempt, tried, argsSummary };
        } catch (parseError) {
          // 有内容但解析不了 —— 这是确定性故障（CLI 打了非 JSON 文本），立刻失败，不浪费时间重试。
          last = {
            attempt, status, signal, stdout, stderr, error,
            reason: `json_parse_failed:${String(parseError.message).slice(0, 120)}`,
            retryable: false
          };
        }
      }
    } else if (processOk) {
      tried.push({ attempt, ok: true, ms: Date.now() - startedAt });
      return { ok: true, json: null, status, signal, stdout, stderr, attempts: attempt, tried, argsSummary };
    } else {
      const verdict = classifyLarkFailure({ stdout, stderr, status, signal, error });
      last = { attempt, status, signal, stdout, stderr, error, reason: verdict.reason, retryable: verdict.retryable };
    }

    tried.push({ attempt, ok: false, ms: Date.now() - startedAt, reason: last.reason });

    const hasBudget = attempt < maxAttempts;
    if (!last.retryable || !hasBudget || retryDisabled()) break;

    const baseDelay = delays[Math.min(attempt - 1, delays.length - 1)] || 0;
    const delayMs = withJitter(baseDelay, options?.jitter);
    emit({
      event: 'lark_cli_retry',
      attempt,
      maxAttempts,
      delayMs,
      reason: last.reason,
      argsSummary
    }, options);
    sleepSync(delayMs);
  }

  // 重试耗尽（或不该重试）：日志 + 抛出/返回。
  emit({
    event: 'lark_cli_failed_final',
    attempts: last ? last.attempt : 0,
    reason: last ? last.reason : 'unknown',
    argsSummary
  }, options);

  const failure = {
    argsSummary,
    attempts: last ? last.attempt : 0,
    reason: last ? last.reason : 'unknown',
    status: last ? last.status : null,
    signal: last ? last.signal : null,
    stdout: last ? last.stdout : '',
    stderr: last ? last.stderr : '',
    error: last ? last.error : null,
    retryable: false,
    tried
  };

  // 退出码 0 但输出为空、且调用方给了 emptyFallback —— 沿用老脚本 `JSON.parse(stdout || '{}')` 的语义。
  if (parseJson && options && Object.prototype.hasOwnProperty.call(options, 'emptyFallback')
      && last && last.reason === 'empty_stdout' && last.status === 0) {
    return { ok: true, json: options.emptyFallback, status: 0, signal: null, stdout: '', stderr: '', attempts: last.attempt, tried, argsSummary };
  }

  if (!parseJson) return { ok: false, ...failure };
  throw buildFailure(failure);
};

/**
 * 调用 lark-cli 并返回完整原始结果，**不抛错**（由调用方自己判断）。
 * @param {string[]} args
 * @param {object} [options] 支持 { cli, cwd, timeout, maxBuffer, env, input, maxAttempts, delaysMs, jitter, onEvent, emptyFallback }
 */
export const runLarkCli = (args, options = {}) => invoke(args, options, false);

/**
 * 调用 lark-cli、按 UTF-8 解析 stdout JSON；失败时按策略重试，重试耗尽再抛错。
 * 抛出的 Error 带 `.code='LARK_CLI_FAILED'` 与 `.lark={attempts,reason,status,signal,stdout,stderr,argsSummary}`，
 * 便于上游把"临时网络错误"与"真实业务错误"分开归类。
 * @param {string[]} args
 * @param {object} [options] 同 runLarkCli
 */
export const runLarkCliJson = (args, options = {}) => invoke(args, options, true).json;

export default { runLarkCli, runLarkCliJson, classifyLarkFailure };
