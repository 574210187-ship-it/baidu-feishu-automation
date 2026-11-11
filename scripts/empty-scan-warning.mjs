// empty-scan-warning.mjs — 连续空扫描 / 上游断供的**只读**告警判定（纯逻辑，可离线测试）
//
// 背景（2026-09-28 建立）：
//   2026-09-23 00:00 起三个源目录 mp4 连续为 0，持续 34 轮、5.5 天，
//   每轮 wrapper 都记成 exitCode=0 / status=complete —— 既没被标失败，也没有任何 warning，
//   于是"连续 5 天零产出"在监控上完全隐身。根因是上游压缩链路 9/2 停产，
//   但链路自身的健康指标只看"脚本跑完没报错"，从不看"业务产出是多少"。
//
// 本模块的口径（用户 2026-09-28 明确要求）：
//   · 空扫描**不得**标记为失败（批次本身确实跑成功了，业务写入逻辑不变）；
//   · 空扫描也**不得**静默标记为"完全正常"（必须留下 warning 痕迹）；
//   · 批次照常结束，warning 写入运行报告并打到 stdout 事件。
//
// 只读：本模块不发起任何网络请求、不写任何文件、不碰飞书、不动百度文件。

import fs from 'node:fs/promises';
import path from 'node:path';

// ── 阈值 ─────────────────────────────────────────────────────────
export const THRESHOLDS = {
  // 连续多少批三源目录 mp4 全为 0 才告警
  consecutiveEmptyBatches: 3,
  // 连续多少小时无新增记录才告警
  noNewRecordHours: 24,
  // .lock 存在超过多少小时算"陈旧锁"
  staleLockHours: 24,
  // 连续多少批"扫描成功但没进任何 stage"才告警
  consecutiveNoStageBatches: 3
};

const SOURCE_KEYS = ['jiang', 'yichen', 'zed'];

const hoursSince = (isoOrMs, nowMs) => {
  if (isoOrMs === null || isoOrMs === undefined) return null;
  let ms;
  if (typeof isoOrMs === 'number') ms = isoOrMs;
  else {
    const t = Date.parse(isoOrMs);
    if (!Number.isFinite(t)) return null;
    ms = t;
  }
  return Math.max(0, Math.round(((nowMs - ms) / 3600000) * 10) / 10);
};

/**
 * 判定空扫描告警。
 *
 * @param {object} input
 * @param {object} input.sourceCounts       本批三源目录 mp4 数，如 { jiang: 0, yichen: 0, zed: 0 }
 * @param {Array}  input.history            历史批次（由新到旧或由旧到新均可，内部按时间排序）
 *                                          每项 { at, sourceCounts?, newRecords? }
 * @param {object} [input.tempCounts]       临时目录统计 { tmpMp4, lock, partial }（null = 未扫描，跳过相关规则）
 * @param {object} [input.oldestTempFile]   { name, mtimeMs|mtime, dir }
 * @param {boolean} [input.stageEntered]    本批是否进入过 stage1-stage5
 * @param {string|null} [input.lastNewRecordAt]  最后一次新增记录的时间（ISO）
 * @param {number} [input.now]              当前时间戳（便于测试注入）
 * @returns {{ warnings: Array, summary: object }}
 */
export const evaluateEmptyScanWarnings = (input = {}) => {
  const now = typeof input.now === 'number' ? input.now : Date.now();
  const sourceCounts = input.sourceCounts && typeof input.sourceCounts === 'object' ? input.sourceCounts : {};
  const history = Array.isArray(input.history) ? [...input.history] : [];
  const tempCounts = input.tempCounts && typeof input.tempCounts === 'object' ? input.tempCounts : null;
  const warnings = [];

  const affectedTables = SOURCE_KEYS.filter((k) => Number(sourceCounts[k] ?? 0) > 0);
  const totalSource = SOURCE_KEYS.reduce((n, k) => n + Number(sourceCounts[k] ?? 0), 0);
  const isEmptyBatch = totalSource === 0;

  // ── 规则 1：连续 N 批三源目录 mp4 全为 0 ──────────────────────
  const sorted = history
    .map((h) => ({
      at: h.at,
      src: h.sourceCounts || {},
      newRecords: h.newRecords,
      // stageEntered 必须保留：规则 6 要用它算"连续未进入 stage"的批次
      stageEntered: h.stageEntered
    }))
    .filter((h) => h.at)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)); // 由新到旧

  let consecutiveEmpty = 0;
  if (isEmptyBatch) {
    consecutiveEmpty = 1; // 算上本批
    for (const h of sorted) {
      const n = SOURCE_KEYS.reduce((s, k) => s + Number(h.src[k] ?? 0), 0);
      if (n === 0) consecutiveEmpty += 1;
      else break;
    }
  }
  if (consecutiveEmpty >= THRESHOLDS.consecutiveEmptyBatches) {
    warnings.push({
      warningKind: 'consecutive-empty-source',
      severity: 'warn',
      affectedTables: [], // 三源目录全空，没有"受影响的表"这一说
      sourceCounts,
      consecutiveEmptyBatches: consecutiveEmpty,
      tempCounts,
      oldestTempFile: input.oldestTempFile || null,
      recommendedAction:
        '三个源目录连续 ' + consecutiveEmpty + ' 批扫描到 0 个 mp4。请先核对上游压缩/上传链路是否仍在产出' +
        '（检查录制机、压缩任务、上传任务），再决定是否补跑；本批不视为失败。'
    });
  }

  // ── 规则 2：连续 24 小时无新增记录 ────────────────────────────
  const sinceNew = hoursSince(input.lastNewRecordAt, now);
  if (input.lastNewRecordAt && sinceNew !== null && sinceNew >= THRESHOLDS.noNewRecordHours) {
    warnings.push({
      warningKind: 'no-new-records-24h',
      severity: 'warn',
      affectedTables: SOURCE_KEYS,
      sourceCounts,
      hoursSinceLastNewRecord: sinceNew,
      lastNewRecordAt: input.lastNewRecordAt,
      tempCounts,
      oldestTempFile: input.oldestTempFile || null,
      recommendedAction:
        '距最后一次新增记录已 ' + sinceNew + ' 小时。若源目录同时为 0，基本可判定上游断供；' +
        '请核对录制与压缩环节，不要靠反复补跑本链路解决。'
    });
  }

  // ── 规则 3/4/5：临时目录残留 ──────────────────────────────────
  if (tempCounts) {
    const tmpMp4 = Number(tempCounts.tmpMp4 ?? 0);
    const lock = Number(tempCounts.lock ?? 0);
    const partial = Number(tempCounts.partial ?? 0);

    if (tmpMp4 > 0) {
      warnings.push({
        warningKind: 'temp-tmp-mp4-present',
        severity: 'warn',
        affectedTables: SOURCE_KEYS,
        sourceCounts,
        tempCounts,
        oldestTempFile: input.oldestTempFile || null,
        recommendedAction:
          '.compression-temp 下存在 ' + tmpMp4 + ' 个 .tmp.mp4，说明压缩链路有中断的半成品。' +
          '这些文件**不得**由本链路删除或强行移入正式源目录，应交上游压缩环节自行续传/清理。'
      });
    }

    const oldest = input.oldestTempFile || null;
    const oldestAge = oldest ? hoursSince(oldest.mtimeMs ?? oldest.mtime, now) : null;
    if (lock > 0 && oldestAge !== null && oldestAge >= THRESHOLDS.staleLockHours) {
      warnings.push({
        warningKind: 'temp-lock-stale',
        severity: 'warn',
        affectedTables: SOURCE_KEYS,
        sourceCounts,
        tempCounts,
        oldestTempFile: oldest,
        oldestTempAgeHours: oldestAge,
        recommendedAction:
          '.compression-temp 下存在 ' + lock + ' 个 .lock，最老的已滞留 ' + oldestAge + ' 小时。' +
          '大概率是压缩进程异常退出留下的死锁；需人工确认上游进程确实已停止后再清理，本链路不动。'
      });
    }

    if (partial > 0) {
      warnings.push({
        warningKind: 'quarantine-partial-present',
        severity: 'warn',
        affectedTables: SOURCE_KEYS,
        sourceCounts,
        tempCounts,
        oldestTempFile: input.oldestTempFile || null,
        recommendedAction:
          '_partial_quarantine 下存在 ' + partial + ' 个 .partial 分片，说明有上传中断的残片。' +
          '同样不由本链路处理，需上游确认后重传或清理。'
      });
    }
  }

  // ── 规则 6：扫描成功但连续未进入 stage1-stage5 ────────────────
  if (input.stageEntered === false || input.stageEntered === undefined) {
    let consecutiveNoStage = input.stageEntered === false ? 1 : 0;
    if (consecutiveNoStage > 0) {
      for (const h of sorted) {
        if (h.stageEntered === false) consecutiveNoStage += 1;
        else break;
      }
    }
    if (consecutiveNoStage >= THRESHOLDS.consecutiveNoStageBatches) {
      warnings.push({
        warningKind: 'no-stage-entered',
        severity: 'warn',
        affectedTables: affectedTables.length ? affectedTables : SOURCE_KEYS,
        sourceCounts,
        consecutiveNoStageBatches: consecutiveNoStage,
        tempCounts,
        oldestTempFile: input.oldestTempFile || null,
        recommendedAction:
          '连续 ' + consecutiveNoStage + ' 批扫描成功但没有进入任何 stage（无视频可处理）。' +
          '与源目录为空通常同源，优先查上游。'
      });
    }
  }

  const byKind = {};
  for (const w of warnings) byKind[w.warningKind] = (byKind[w.warningKind] || 0) + 1;

  return {
    warnings,
    summary: {
      count: warnings.length,
      byKind,
      // 供下游/巡检快速判断：空扫描不等于失败，但也不是"完全正常"
      hasWarning: warnings.length > 0,
      isEmptyBatch,
      totalSourceMp4: totalSource,
      consecutiveEmptyBatches: consecutiveEmpty
    }
  };
};

/**
 * 读取最近若干批次的运行报告，构造 history。
 * 只读：只读 state/runs/*.json，不写任何文件。
 */
export const loadRecentBatchHistory = async ({ runsDir, limit = 12 } = {}) => {
  if (!runsDir) return [];
  let files = [];
  try {
    files = await fs.readdir(runsDir);
  } catch {
    return [];
  }
  const jsonFiles = files.filter((f) => f.endsWith('.json')).sort().reverse().slice(0, limit * 2);
  const out = [];
  for (const f of jsonFiles) {
    try {
      const raw = await fs.readFile(path.join(runsDir, f), 'utf8');
      const j = JSON.parse(raw);
      const at = j.finishedAt || j.startedAt || j.checkedAt || null;
      if (!at) continue;
      const src = {};
      const list = Array.isArray(j.tables) ? j.tables : Array.isArray(j.tableResults) ? j.tableResults : [];
      for (const t of list) {
        if (t && t.key) src[t.key] = t.fullScanCount ?? 0;
      }
      if (!Object.keys(src).length) continue;
      out.push({ at, sourceCounts: src, stageEntered: j.stageEntered });
    } catch {
      // 单个报告损坏不影响整体
    }
    if (out.length >= limit) break;
  }
  return out;
};

/**
 * 读取临时目录扫描结果（由 scan-temp-dirs.mjs 产出）。文件不存在时返回 null。
 */
export const loadTempDirScan = async (statePath) => {
  if (!statePath) return null;
  try {
    const j = JSON.parse(await fs.readFile(statePath, 'utf8'));
    return {
      tempCounts: j.tempCounts || null,
      oldestTempFile: j.oldestTempFile || null,
      checkedAt: j.checkedAt || null
    };
  } catch {
    return null;
  }
};

export default evaluateEmptyScanWarnings;
