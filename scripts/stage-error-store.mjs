// stage-error-store.mjs — 顶层 stageErrors 的统一出口（缺陷 D2，2026-09-27 修复）
//
// 背景：修复前 run.json 顶层**没有** stageErrors 键。失败信息散落在三处：
//   ① 顶层 error（只有整批致命错误才有，且是纯字符串）；
//   ② report.stages[]（记录全量 stage，但成功失败混在一起，读的人要自己判）；
//   ③ 各 phase 内部的 stageErrors（那是个**数字** count，不是数组）。
// 后果：任何一个 stage 失败，读取方只能靠"扫 stages[].exitCode"自己拼，
//   漏读即漏报；「某个 stage 失败但批次继续执行」到底该叫什么状态也没有统一口径。
//
// 修复后的口径：
//   · 顶层 stageErrors 恒为数组（新记录必然存在，空数组也算存在）；
//   · 每个失败 stage 追加一条 { tableKey, phase, stage, exitCode, timedOut,
//     error, startedAt, finishedAt, kind, affectsStatus, ... }；
//   · 顶层 error **只**表示批次级致命错误，不代替 stageErrors；
//   · 有 affecting 错误且批次仍跑完 → complete-with-errors，绝不写成 complete。
//
// 历史兼容：旧 run.json 没有该字段时，读取方必须显示 legacy/no-stageErrors，
//   且**不得**把旧记录补写成成功（本模块只提供只读读取，没有写回函数）。

export const STAGE_ERROR_KINDS = {
  // 决定性失败：一定影响批次状态
  failed: { affectsStatus: true, label: '子进程退出码非允许值' },
  timeout: { affectsStatus: true, label: 'stage 超时被杀' },
  crash: { affectsStatus: true, label: 'stage 抛异常/崩溃' },
  infra: { affectsStatus: true, label: '基础设施失败（百度登录/CDP/飞书链路）' },
  // 可观测但不改判批次状态：避免把"允许的非零退出码"和"收尾清理失败"打成业务失败
  allowedNonzero: { affectsStatus: false, label: '退出码非 0 但在 allowExitCodes 内（已放行）' },
  cleanup: { affectsStatus: false, label: '收尾清理失败' }
};

const FALLBACK = { affectsStatus: true, label: '未分类' };

// stage 名字形如 `jiang:第一阶段-本次新批次:stage2` / `ensure-baidu-cdp`
export const parseStageName = (name) => {
  const raw = typeof name === 'string' ? name : '';
  const parts = raw.split(':');
  if (parts.length >= 3) {
    return { tableKey: parts[0] || null, phase: parts.slice(1, parts.length - 1).join(':') || null, stage: parts[parts.length - 1] || null };
  }
  if (parts.length === 2) return { tableKey: parts[0] || null, phase: null, stage: parts[1] || null };
  return { tableKey: null, phase: null, stage: raw || null };
};

export const ensureStageErrors = (report) => {
  if (!report || typeof report !== 'object') return [];
  if (!Array.isArray(report.stageErrors)) report.stageErrors = [];
  return report.stageErrors;
};

const normalizeKind = (kind) => (Object.prototype.hasOwnProperty.call(STAGE_ERROR_KINDS, kind) ? kind : 'failed');

export const makeStageError = (raw = {}) => {
  const parsed = parseStageName(raw.name || raw.stage || '');
  const kind = normalizeKind(raw.kind || 'failed');
  const meta = STAGE_ERROR_KINDS[kind] || FALLBACK;
  return {
    tableKey: raw.tableKey === undefined ? parsed.tableKey : raw.tableKey,
    phase: raw.phase === undefined ? parsed.phase : raw.phase,
    stage: raw.stage === undefined ? parsed.stage : raw.stage,
    name: raw.name || null,
    exitCode: raw.exitCode === undefined ? null : raw.exitCode,
    timedOut: Boolean(raw.timedOut),
    error: raw.error === undefined || raw.error === null ? null : String(raw.error),
    startedAt: raw.startedAt || null,
    finishedAt: raw.finishedAt || null,
    kind,
    affectsStatus: raw.affectsStatus === undefined ? meta.affectsStatus : Boolean(raw.affectsStatus),
    kindLabel: meta.label,
    allowExitCodes: Array.isArray(raw.allowExitCodes) ? [...raw.allowExitCodes] : null,
    recordedAt: new Date().toISOString()
  };
};

export const pushStageError = (report, raw) => {
  const store = ensureStageErrors(report);
  const entry = makeStageError(raw);
  store.push(entry);
  return entry;
};

export const summarizeStageErrors = (report) => {
  const items = Array.isArray(report?.stageErrors) ? report.stageErrors : [];
  const byKind = {};
  let affecting = 0;
  for (const item of items) {
    byKind[item.kind] = (byKind[item.kind] || 0) + 1;
    if (item.affectsStatus) affecting += 1;
  }
  return {
    present: Array.isArray(report?.stageErrors),
    count: items.length,
    affecting,
    timedOutCount: items.filter((item) => item.timedOut).length,
    byKind,
    items
  };
};

/**
 * 最终状态判定。特殊态（validated / skipped-infra-busy）优先保留，
 * 批次级致命错误 → failed；有决定性 stage 错误 → complete-with-errors；否则 complete。
 */
export const decideRunStatus = (report = {}, { fatalError = false } = {}) => {
  if (report.status === 'validated') return 'validated';
  if (report.status === 'skipped-infra-busy') return 'skipped-infra-busy';
  if (report.status === 'aborted') return 'aborted';
  if (fatalError) return 'failed';
  const { affecting } = summarizeStageErrors(report);
  return affecting > 0 ? 'complete-with-errors' : 'complete';
};

/**
 * 历史兼容读取：旧 run.json 没有 stageErrors 时不得崩溃，只能显示 legacy/no-stageErrors。
 * 只读 —— 本模块刻意不提供任何"补写旧记录"的函数。
 */
export const readStageErrors = (run) => {
  if (!run || typeof run !== 'object') {
    return { present: false, legacy: true, label: 'legacy/no-stageErrors', items: [], note: 'run 记录不可解析' };
  }
  if (Array.isArray(run.stageErrors)) {
    return {
      present: true,
      legacy: false,
      label: 'stageErrors',
      items: run.stageErrors,
      count: run.stageErrors.length,
      affecting: run.stageErrors.filter((item) => item && item.affectsStatus).length
    };
  }
  return {
    present: false,
    legacy: true,
    label: 'legacy/no-stageErrors',
    items: [],
    count: 0,
    affecting: 0,
    note: '历史记录不含 stageErrors；不得据此判定成功或失败，也不得补写成成功'
  };
};

export default {
  STAGE_ERROR_KINDS,
  parseStageName,
  ensureStageErrors,
  makeStageError,
  pushStageError,
  summarizeStageErrors,
  decideRunStatus,
  readStageErrors
};
