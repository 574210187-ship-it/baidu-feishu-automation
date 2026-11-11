// apply-legacy-write-guard.mjs —— 一次性/可重复运行的维护工具（2026-09-11）
//
// 目的：scripts/ 目录里存在大量历史脚本，包含写飞书 / 上传附件 / 移动百度文件等危险操作。
// 统一入口（run-baidu-feishu-batch.mjs）不使用它们，但一旦被误调用就会：
//   · 污染「状态」列与步骤列
//   · 重复往「直播稿doc」附件列追加（一个单元格多个 doc 的复发源）
//   · 白白消耗 token
// 因此给所有"非当前主链路"的危险脚本在文件最前面插入一段硬保护：
//   除非显式设置 ALLOW_LEGACY_WRITE=1，否则打印 LEGACY_WRITE_SCRIPT_BLOCKED 并 exit(2)。
//
// 不删除任何旧脚本，只加封口，避免误伤历史资料。
// 本工具幂等：已加过保护的文件会跳过。
//
// 用法：
//   node scripts/apply-legacy-write-guard.mjs --dry-run
//   node scripts/apply-legacy-write-guard.mjs --check   # 只校验"入口可达闭包 ⊆ 白名单"，不写文件
//   node scripts/apply-legacy-write-guard.mjs

import fs from 'node:fs';
import path from 'node:path';

const SCRIPTS_DIR = 'scripts';
const MARKER = 'LEGACY_WRITE_GUARD_20260911';

// 当前允许正常运行的主链路脚本（用户 2026-09-11 明确指定）——绝不加保护。
const ALLOWLIST = new Set([
  'run-baidu-feishu-batch.mjs',
  'runtime-config.mjs',
  'ensure-baidu-cdp.mjs',
  'api-scan-baidu-videos.mjs',
  'stage1-click-wengao-all.mjs',
  'stage2-export-ready-transcripts.mjs',
  'stage3-share-exported-docs-api.mjs',
  'stage3b-download-shared-docs-local.mjs',
  'stage4-move-completed-files.mjs',
  'stage5-move-void-files.mjs',
  // 2026-09-17 修复：stage6 被唯一入口以**子进程**方式调用
  //   run-baidu-feishu-batch.mjs 里 ['stage6', 'scripts/stage6-clean-source-residue.mjs', …]
  // 且自身含 `/api/filemanager` 指纹。旧白名单漏了它 → 只要真跑一次本工具，
  // stage6 就会被封口，批次跑到它必然 exit 2。用户 2026-09-17 明确要求补入。
  'stage6-clean-source-residue.mjs',
  // 以下三个同属"唯一入口的可达闭包"（用 `--check` 可复算），当前虽不含危险指纹，
  // 但一旦将来指纹表扩充、或脚本自身新增写调用，就会变成同一类地雷。
  // 因此白名单判据统一为「是否为唯一入口的可达闭包成员」，不再按单个脚本临时决定。
  'baidu-scan-folder.mjs',
  'baidu-share-video.mjs',
  'lark-cli-utils.mjs',
  // 2026-10-09：入口直接 import 的空扫描告警模块，纳入闭包白名单。
  'empty-scan-warning.mjs',
  'report-three-state.mjs',
  'report-state-sync.mjs',
  'table-context.mjs',
  'feishu-list-all.mjs',
  'baidu-cdp-utils.mjs',
  // 2026-09-17：「异常备注」追加语义的共享模块（只读表 + 内存改写，自身不含任何写飞书调用）。
  'abnormal-remark-append.mjs',
  // 2026-09-27 修复 D1/D2 时新增的两个共享模块，同样属于唯一入口的可达闭包：
  //   · stage-error-store.mjs  —— 被 run-baidu-feishu-batch.mjs 直接 import（顶层 stageErrors）
  //   · baidu-login-verdict.mjs —— 被 ensure-baidu-cdp.mjs import（登录判定纯逻辑）
  // 两者都不含任何写飞书/写百度调用，但一旦被本工具封口，主链路跑到就会 exit 2，
  // 因此必须登记进白名单（否则 `node scripts/apply-legacy-write-guard.mjs --check` 报缺口）。
  'stage-error-store.mjs',
  'baidu-login-verdict.mjs',
  'lib/global-wait-gate.mjs'
]);

// 本工具自身不封口（它只是插入器，不写业务数据）。
const SELF = path.basename(new URL(import.meta.url).pathname.includes('%') ? decodeURIComponent(new URL(import.meta.url).pathname) : new URL(import.meta.url).pathname);

// 危险操作指纹。命中任一即视为"含写操作的旧脚本"。
const DANGER_PATTERNS = [
  'record-batch-update',
  'record-upload-attachment',
  'record-remove-attachment',
  'field-update',
  '/share/set',
  '/api/filemanager',
  // 额外：建行同样会污染表（用户未列，但属同一类写操作）
  'record-batch-create',
  'record-create'
];

const buildGuard = (relPath, hits) => `// ${MARKER} —— 非主链路脚本硬保护（勿手删）
// 本脚本不属于当前唯一入口（scripts/run-baidu-feishu-batch.mjs），且包含写操作：
//   ${hits.join(', ')}
// 误调用会造成「状态」列污染 / 「直播稿doc」重复追加 / token 浪费。
// 如确需刻意执行历史修复，请显式设置 ALLOW_LEGACY_WRITE=1。
if (process.env.ALLOW_LEGACY_WRITE !== '1') {
  console.error('LEGACY_WRITE_SCRIPT_BLOCKED');
  console.error('  脚本: ${relPath}');
  console.error('  含写操作: ${hits.join(', ')}');
  console.error('  唯一允许的写表入口: node scripts/run-baidu-feishu-batch.mjs');
  console.error('  确需执行本脚本: 设置环境变量 ALLOW_LEGACY_WRITE=1 后重跑。');
  process.exit(2);
}
// ${MARKER}_END
`;

const dryRun = process.argv.includes('--dry-run');

// ---- --check：把"白名单地雷"变成可自动发现的错误（2026-09-17 新增）----
// 判据：从唯一入口出发做可达闭包 —— ① 本地 `from './x.mjs'` import；
// ② 源码里 'scripts/x.mjs' 字面引用（这些是 spawn 出去的子进程脚本，静态 import
//    闭包覆盖不到，正是 stage6 被漏掉的原因）。闭包内任何脚本若不在 ALLOWLIST，
// 就可能被本工具封口 → 批次跑到它时 exit 2。
// 退出码：0 = 闭包 ⊆ 白名单；1 = 存在缺口（打印 WRITE_GUARD_ALLOWLIST_GAP）。
const checkMode = process.argv.includes('--check');
if (checkMode) {
  const ENTRY = 'run-baidu-feishu-batch.mjs';
  const readSafe = (f) => {
    try { return fs.readFileSync(path.join(SCRIPTS_DIR, f), 'utf8'); } catch { return ''; }
  };
  const refsOf = (src, current) => {
    const refs = [];
    // 入口和 stage 都同时存在单引号/双引号 import；还要支持 ./lib/...
    // 这种带子目录的本地依赖。只收集本地 .mjs，不把 node: 或第三方包算进闭包。
    for (const m of src.matchAll(/(?:from\s*|import\s*\()\s*(['"])(\.\/[^'"]+\.mjs)\1/g)) {
      const base = path.posix.dirname(current);
      refs.push(path.posix.normalize(path.posix.join(base, m[2].slice(2))));
    }
    // stage 脚本由入口以 scripts/xxx.mjs 字面量 spawn，静态 import 闭包本身看不到它们。
    for (const m of src.matchAll(/(['"])scripts\/([^'"]+\.mjs)\1/g)) {
      refs.push(path.posix.normalize(m[2]));
    }
    return [...new Set(refs)];
  };
  const reachable = new Set();
  const queue = [ENTRY];
  while (queue.length) {
    const cur = queue.shift();
    if (reachable.has(cur)) continue;
    reachable.add(cur);
    for (const dep of refsOf(readSafe(cur), cur)) if (!reachable.has(dep)) queue.push(dep);
  }
  const exposed = [...reachable]
    .filter((n) => !ALLOWLIST.has(n) && fs.existsSync(path.join(SCRIPTS_DIR, n)))
    .sort();
  console.log(JSON.stringify({
    check: 'entry-closure-subset-of-allowlist',
    entry: ENTRY,
    allowlistSize: ALLOWLIST.size,
    reachableCount: reachable.size,
    reachable: [...reachable].sort(),
    exposedCount: exposed.length,
    exposed,
    ok: exposed.length === 0
  }, null, 2));
  if (exposed.length) {
    console.error('WRITE_GUARD_ALLOWLIST_GAP');
    process.exit(1);
  }
  process.exit(0);
}

const entries = fs.readdirSync(SCRIPTS_DIR, { withFileTypes: true })
  .filter((e) => e.isFile())
  .map((e) => e.name)
  .filter((name) => !ALLOWLIST.has(name) && name !== SELF);

const guarded = [];
const already = [];
const skippedNoDanger = [];

for (const name of entries) {
  const rel = path.join(SCRIPTS_DIR, name).replace(/\\/g, '/');
  const abs = path.join(SCRIPTS_DIR, name);
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch {
    continue;
  }
  if (text.includes(MARKER)) {
    already.push(name);
    continue;
  }
  const hits = DANGER_PATTERNS.filter((p) => text.includes(p));
  if (!hits.length) {
    skippedNoDanger.push(name);
    continue;
  }
  const guard = buildGuard(rel, hits);
  let offset = 0;
  if (text.startsWith('#!')) {
    const nl = text.indexOf('\n');
    offset = nl === -1 ? text.length : nl + 1;
  }
  const next = text.slice(0, offset) + guard + text.slice(offset);
  if (!dryRun) fs.writeFileSync(abs, next, 'utf8');
  guarded.push({ name, hits });
}

console.log(JSON.stringify({
  dryRun,
  allowlist: ALLOWLIST.size,
  scanned: entries.length,
  guarded: guarded.map((g) => `${g.name} <- ${g.hits.join('|')}`),
  alreadyGuarded: already,
  noDangerSkipped: skippedNoDanger.length
}, null, 2));
