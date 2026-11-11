#!/usr/bin/env node
/**
 * 全局文稿等待闸门（2026-10-11 落地）
 * ────────────────────────────────────────────────────────────────────────────
 * 规则（来源：本机负责人 2026-10-11 指令第 1 条）：
 *   1) 正常批次 `globalWait.rounds` 必须恒等于 1；
 *   2) 「第三阶段-本批返工」不得再触发第二个 10 分钟全局等待；
 *   3) 第三阶段只允许**立即检查已就绪文稿**；尚未就绪的行保留到下一自然批次。
 *
 * 旧实现的两个缺陷（实测复现于 run 20261011-000002-12728 与 20261011-040002-10108）：
 *   · 第一处等待用 `report.globalWait.rounds += 1; await sleep(...)`；
 *   · 第三阶段-本批返工又写了一次 `rounds += 1` + `sleep(10min)`，
 *     于是 run.json 长期是 `rounds:2` + `secondWait:*`，一个批次实际等了 20 分钟，
 *     而"第二等"等来的文稿并不会让返工行在同一批次里完成 —— 白等。
 *
 * 这个模块把"等待权"收敛成**一次性令牌**：`waitForTranscripts()` 一辈子只 sleep 一次，
 * 之后再调用只会被记成 `skippedWaits`（`already_waited_once`）；
 * `checkOnlyImmediately()` 永远不 sleep，只能记录"看一眼、不等"。
 * ⇒ `rounds` 在结构上不可能 > 1，不依赖调用方自觉。
 *
 * 纯内存 + 注入 sleepFn，可离线单测（见 scripts/test-global-wait-rounds.mjs）。
 */

const MAX_ROUNDS = 1;

/** 与 runner 的 cnStamp() 保持一致的本地时间戳文案 */
export const cnStamp = (date = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
};

/**
 * @param {object} opts
 * @param {number} opts.minutes            单次全局等待时长（分钟）
 * @param {(ms:number)=>Promise<void>} opts.sleepFn  真正睡觉的函数（可注入假实现）
 * @param {()=>Date} [opts.now]            时钟（可注入）
 * @param {boolean} [opts.enabled]         false 时任何 waitForTranscripts 都只记录不睡（用于演练/降级）
 */
export function createGlobalWaitGate({ minutes, sleepFn, now = () => new Date(), enabled = true } = {}) {
  const totalMinutes = Number(minutes) || 0;
  if (typeof sleepFn !== 'function') throw new Error('createGlobalWaitGate: sleepFn is required');

  const waits = [];        // 真正发生过的等待（长度即 rounds）
  const skippedWaits = []; // 被拒绝/跳过的等待（含"立即检查"）
  let stage1Processed = 0;

  const state = () => ({
    rounds: waits.length,
    minutes: totalMinutes,
    stage1Processed,
    firstWaitAt: waits.length ? waits[0].at : null,
    waitReasons: waits.map((w) => w.reason),
    skippedWaits: skippedWaits.map((s) => ({ ...s })),
    policy: {
      maxRounds: MAX_ROUNDS,
      reworkPhase: 'immediate-check-no-wait',
      invariant: 'rounds<=1：全局等待权是一次性令牌，第二次调用不再 sleep'
    },
    note: '全局只等待一次；旧编排是"每表×每阶段"各等一次 10 分钟（最坏 15 次）。第三阶段-本批返工只做立即检查，不再等待。'
  });

  const recordSkip = (reason, skippedBecause, detail) => {
    const rec = { reason, at: cnStamp(now()), applied: false, skippedBecause };
    if (detail !== undefined) rec.detail = detail;
    skippedWaits.push(rec);
    return { waited: false, ...rec, state: state() };
  };

  return {
    /** 记录本批所有需要文稿的阶段的处理条数（供 run.json 与空扫描告警读取） */
    setStage1Processed(n) {
      stage1Processed = Number(n) || 0;
      return state();
    },

    /**
     * 唯一的全局等待入口。只有第一次调用（且 needed=true）才真的睡。
     * @param {object} args
     * @param {string} args.reason
     * @param {boolean} [args.needed=true]   没有目标要等时传 false（不会占用等待权）
     * @param {(s:object)=>any} [args.onWaitStart] 睡之前回调（runner 用它把 firstWaitAt 先落 run.json）
     */
    async waitForTranscripts({ reason, needed = true, onWaitStart } = {}) {
      if (!needed) return recordSkip(reason || '(no reason)', 'no_targets_processed');
      if (!enabled) return recordSkip(reason || '(no reason)', 'gate_disabled');
      if (waits.length >= MAX_ROUNDS) return recordSkip(reason || '(no reason)', 'already_waited_once');
      const at = cnStamp(now());
      waits.push({ reason: reason || '(no reason)', at });
      const snap = state();
      if (typeof onWaitStart === 'function') await onWaitStart(snap);
      await sleepFn(totalMinutes * 60 * 1000);
      return { waited: true, reason, at, state: state() };
    },

    /**
     * 第三阶段-本批返工专用：**立即检查已就绪文稿，绝不等待**。
     * 尚未就绪的行由下游按既有规则保留「下一轮重新执行」，交给下一自然批次。
     */
    checkOnlyImmediately({ reason, detail } = {}) {
      return recordSkip(reason || '(immediate check)', 'check_only_no_wait', detail);
    },

    state
  };
}
