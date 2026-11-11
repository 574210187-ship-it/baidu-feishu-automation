// abnormal-remark-append.mjs —— 「异常备注」追加语义补丁（2026-09-17）
//
// 问题（2026-09-17 接手基线实测）：
//   飞书「异常备注」是普通文本列，一次写入 = 整格**覆盖**。stage1~stage5 过去都是
//   把本轮的新文本直接塞进 update 负载里 —— 于是**流转中的行每轮都把上一轮的备注冲掉**，
//   历史归因信息（第几轮 / 错误码 / 卡点字段 / 上一阶段的失败原因）全部丢失。
//   已经终结的行（已移动完成 / 已作废）不会再被写，所以历史旧账没被破坏，
//   但「下一轮重新执行」的行只要还在流转，备注就永远只剩最后一轮那一句。
//
// 修复策略（用户 2026-09-17 指定的 7 条要求）：
//   1. 写入前先按 recordId 读回该行现有「异常备注」；
//   2. 原备注非空 → 换行追加，绝不覆盖；
//   3. 要追加的内容已经存在（按行比较 / 以期望文本结尾）→ 不重复追加；
//   4. 每次写入后用飞书 API 回读确认落库值以期望文本结尾；
//   5. **只允许改写负载里的「异常备注」这一个 key**，状态 / 视频链接 / 文稿链接 /
//      直播稿doc / 移动结果 / 步骤结果列等一律不碰、不增、不删；
//   6. 本模块自身**不含任何写飞书的调用** —— 真正的写仍由各 stage 脚本原有的那一次
//      批量写命令完成（保持每阶段一次写的既有结构，不新增写次数、不改变写时序）。
//
// ── 健壮性设计（两条硬约束，别改坏了）──────────────────────────────────────
//   A. **前置读失败 = 本轮不写、不移动、下轮重试**（2026-09-23 按用户指令改造，
//      已**废除**旧的「读失败降级为整格覆盖」行为）。
//      旧行为的问题：读失败时会把本轮新文本**整格覆盖**上去，把历史备注冲掉。
//      新行为（用户 2026-09-23 指定的 6 条要求）：
//        ① 前置读失败 → **停止该条记录的写入**（从 updates 里摘掉「异常备注」key）；
//        ② **绝不覆盖原异常备注** —— 只有真正读到旧值才会写；
//        ③ 往运行日志写 `abnormal_remark_read_failed_write_blocked` +「备注读取失败，待重试」；
//        ④ 该行**保留到下一轮**（本轮不写库 → 行状态不变 → 下轮自然重新捞起）；
//        ⑤ **不得移动百度文件** —— stage4 / stage5 必须把 `preflight()` 放在
//           打开 CDP / 执行 move **之前**（读失败就零副作用退出）；
//        ⑥ **不得写入伪造的成功状态**（本轮一个字段都不写）。
//      ⚠️ 为什么 stage4/5 必须 preflight 前置：这两个阶段的写发生在「文件已移动完」之后。
//      若等到移动之后才发现读失败，就会掉进「文件已移走、飞书状态没改」——
//      全线最忌讳的「状态 ↔ 网盘目录不一致」。所以把读提前到移动之前：
//      读失败 ⇒ 连移动都不做 ⇒ 零副作用，安全等下轮。
//   B. **重试幂等**：stage2 的 flush 失败会保留 updates 下轮再试。此时内存里的
//      「异常备注」已经是上一次合并过的结果，直接再合并会把旧值二次追加。
//      解决：按 recordId 记住**本轮原始新文本**，每次都拿「缓存基线 + 原始新文本」重算；
//      写成功后（settle）再清掉该记忆。mergeAbnormalRemark 另有 endsWith 兜底。
//
// 为什么用 listAllRecords 而不是单行读：单行读（+record-get）在既有实测里存在
// 「内存捕获返回空」的坑（见技能坑 6），而 listAllRecords 是分页 + 统一重试的成熟入口，
// 且这里只需要「异常备注」一列，代价可控。读表入口与 stage1~stage5 完全一致。
import { listAllRecords } from './feishu-list-all.mjs';

export const ABNORMAL_REMARK_FIELD = '异常备注';

/**
 * 纯函数：非空追加 + 换行分隔 + 相同内容不重复追加。
 * - 新内容为空 → 返回原值（保底不清空）
 * - 原值为空 → 直接返回新内容
 * - 原值已含同一行 / 已以新内容结尾 → 返回原值（幂等）
 */
export const mergeAbnormalRemark = (existing, incoming) => {
  const cur = typeof existing === 'string' ? existing : '';
  const add = typeof incoming === 'string' ? incoming.trim() : '';
  if (!add) return cur.trim() ? cur : null;
  if (!cur.trim()) return add;
  if (cur.trim().endsWith(add)) return cur;
  const lines = cur.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.includes(add)) return cur;
  return `${cur.replace(/\s+$/, '')}\n${add}`;
};

/**
 * 只读：整表拉一次「异常备注」，返回 Map<recordId, string>。
 * ⚠️ 会抛错 —— 只允许在「失败也不会留下半成品副作用」的位置调用（= 由 appender 内部处理降级）。
 */
export const fetchAbnormalRemarks = ({ cli, baseToken, tableId, identity = 'user', log = () => {} }) => {
  const res = listAllRecords({ cli, baseToken, tableId, fieldIds: [ABNORMAL_REMARK_FIELD], identity });
  const ids = res.data?.record_id_list || [];
  const rows = res.data?.data || [];
  const fields = res.data?.fields || [ABNORMAL_REMARK_FIELD];
  const idx = fields.indexOf(ABNORMAL_REMARK_FIELD);
  const col = idx >= 0 ? idx : 0;
  const map = new Map();
  ids.forEach((rid, i) => {
    const cell = rows[i] ? rows[i][col] : null;
    const text = typeof cell === 'string'
      ? cell
      : (Array.isArray(cell) ? cell.map((x) => (x && (x.text || x.name)) || '').join('') : '');
    map.set(rid, text);
  });
  log(JSON.stringify({
    event: 'abnormal_remark_read_before_write',
    records: ids.length,
    withValue: [...map.values()].filter((v) => v && v.trim()).length
  }));
  return map;
};

/**
 * 就地改写 updates（recordId -> fields），**只动「异常备注」一个 key**。
 * @param memo 可选 Map<recordId, 原始新文本>，用于跨重试保持幂等（见头注释 B）。
 * @returns { changed, expected }  expected 供写后回读核验。
 */
export const applyAbnormalAppend = ({ updates, remarks, memo = new Map(), log = () => {} }) => {
  const changed = [];
  const expected = new Map();
  for (const [rid, fields] of Object.entries(updates || {})) {
    if (!fields || !Object.prototype.hasOwnProperty.call(fields, ABNORMAL_REMARK_FIELD)) continue;
    const current = fields[ABNORMAL_REMARK_FIELD];
    if (current === null || current === undefined || String(current).trim() === '') continue;
    // 首次见到该行时记住「本轮原始新文本」；重试时继续用第一次那份，避免二次追加。
    if (!memo.has(rid)) memo.set(rid, current);
    const incoming = memo.get(rid);
    const before = remarks instanceof Map ? (remarks.get(rid) || '') : '';
    const merged = mergeAbnormalRemark(before, incoming);
    fields[ABNORMAL_REMARK_FIELD] = merged;
    expected.set(rid, merged);
    const unchanged = String(merged || '') === before;
    if (!unchanged) changed.push(rid);
    log(JSON.stringify({
      event: 'abnormal_remark_append_planned',
      recordId: rid,
      beforeChars: before.length,
      afterChars: String(merged || '').length,
      duplicateSkipped: unchanged
    }));
  }
  return { changed, expected };
};

/**
 * 写后回读核验：真·飞书 API 重读，确认落库值以期望文本结尾（= 追加成功、没被覆盖）。
 * 核验只读；**核验失败只上报，绝不改字段**（不用「写」去掩盖「写失败」）。
 */
export const verifyAbnormalRemarks = ({ cli, baseToken, tableId, identity = 'user', expected, log = () => {} }) => {
  const ok = [];
  const bad = [];
  if (!expected || !expected.size) return { ok, bad };
  const map = fetchAbnormalRemarks({ cli, baseToken, tableId, identity, log: () => {} });
  for (const [rid, want] of expected) {
    const got = String(map.get(rid) || '').trim();
    const tail = String(want || '').trim();
    if (tail && got.endsWith(tail)) ok.push(rid);
    else bad.push({ recordId: rid, wantTail: tail.slice(-160), gotTail: got.slice(-160) });
  }
  log(JSON.stringify({
    event: 'abnormal_remark_verify_after_write',
    verified: ok.length,
    mismatched: bad.length,
    mismatchedDetail: bad.slice(0, 5)
  }));
  return { ok, bad };
};

/**
 * 会话级追加器：进程内只做一次全表读，之后用「我们自己写下去的值」更新本地缓存，
 * 避免 stage2 那种「每 5 条一 flush」的场景反复全表扫。
 * 批次由 state/run.lock 串行化，进程内是唯一写者，因此缓存不会读到脏值。
 *
 * ⚠️ prepare() / preflight() **永远不会抛错**（读失败 → 摘掉「异常备注」key、打阻断日志、整批跳过本轮写库）；
 *    settle() 的回读核验同样吃异常。
 */
export const createAbnormalRemarkAppender = ({ cli, baseToken, tableId, identity = 'user', log = () => {} }) => {
  let cache = null;
  let readFailed = false;          // 本轮前置读是否已失败（失败后整批阻断写入）
  const memo = new Map();          // recordId -> 本轮原始新文本（跨重试幂等）
  const ensure = () => {
    if (!cache) cache = fetchAbnormalRemarks({ cli, baseToken, tableId, identity, log });
    return cache;
  };
  // 前置读失败的统一处置：**摘掉「异常备注」key（保证绝不覆盖）** + 打阻断日志 + 标记本轮阻断。
  const blockWrite = (updates, error, phase) => {
    let stripped = 0;
    for (const fields of Object.values(updates || {})) {
      if (fields && Object.prototype.hasOwnProperty.call(fields, ABNORMAL_REMARK_FIELD)) {
        delete fields[ABNORMAL_REMARK_FIELD];
        stripped += 1;
      }
    }
    readFailed = true;
    cache = null;
    log(JSON.stringify({
      event: 'abnormal_remark_read_failed_write_blocked',
      phase,
      strippedFields: stripped,
      message: '备注读取失败，待重试',
      error: String(error && error.message ? error.message : error).slice(0, 400)
    }));
  };
  return {
    /**
     * 前置读（2026-09-23 新增）：**必须在任何副作用（打开 CDP / move 文件 / 点导出）之前调用**。
     * 返回 true = 读成功，可继续；false = 读失败，本轮必须整批跳过（不移动、不写库）。
     * **永不抛错**。
     */
    preflight(updates = {}) {
      try {
        ensure();
        return true;
      } catch (error) {
        blockWrite(updates, error, 'preflight');
        return false;
      }
    },
    /** 本轮前置读是否已失败（供调用方在写入点二次确认）。 */
    get blocked() { return readFailed; },
    /**
     * 写入前：读现有备注 → 换行追加 → 就地改写 updates。
     * 读失败：**移除 updates 里的「异常备注」key**（绝不覆盖原值）+ 打阻断日志，
     * 返回 { changed: [], expected, degraded: true, blocked: true } —— 调用方必须据此跳过本轮写库。
     */
    prepare(updates) {
      if (readFailed) {
        blockWrite(updates, new Error('preflight already failed'), 'prepare');
        return { changed: [], expected: new Map(), degraded: true, blocked: true };
      }
      let remarks = null;
      try {
        remarks = ensure();
      } catch (error) {
        blockWrite(updates, error, 'prepare');
        return { changed: [], expected: new Map(), degraded: true, blocked: true };
      }
      return { ...applyAbnormalAppend({ updates, remarks, memo, log }), degraded: false, blocked: false };
    },
    /** 写成功后：本地缓存落地已写值 + 真·API 回读核验。回读失败同样不抛。 */
    settle(expected, { readback = true } = {}) {
      if (!expected || !expected.size) return { verified: 0, mismatched: [] };
      for (const [rid, value] of expected) {
        if (cache) cache.set(rid, value);
        memo.delete(rid);          // 已落库，下一轮重新以最新值为基线
      }
      if (!readback) return { verified: 0, mismatched: [] };
      try {
        const res = verifyAbnormalRemarks({ cli, baseToken, tableId, identity, expected, log });
        return { verified: res.ok.length, mismatched: res.bad };
      } catch (error) {
        log(JSON.stringify({
          event: 'abnormal_remark_verify_failed',
          error: String(error.message).slice(0, 400)
        }));
        return { verified: 0, mismatched: [] };
      }
    },
    stats() {
      return { cached: cache ? cache.size : 0, pendingMemo: memo.size };
    }
  };
};
