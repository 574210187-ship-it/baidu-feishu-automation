import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../scripts/runtime-config.mjs';
import { normalizeLarkFileArgs, runLarkCli } from '../scripts/lark-cli-utils.mjs';

process.env.WINLP_NO_MAIN = '1';
const { errorCodeFor } = await import(pathToFileURL('D:\\winlp_reporter\\bin\\batch_listener.mjs').href);

const repoPayload = path.join(REPO_ROOT, 'state', 'jiang', 'stage3-api-update-records.json');
const normalizedRepo = normalizeLarkFileArgs(
  ['base', '+record-batch-update', '--json', '@' + repoPayload],
  'C:\\Windows'
);
assert.equal(normalizedRepo.cwd, path.resolve(REPO_ROOT));
assert.equal(normalizedRepo.args[3], '@state/jiang/stage3-api-update-records.json');

const externalPayload = 'D:\\winlp_reporter\\state\\controlled-test.json';
const normalizedExternal = normalizeLarkFileArgs(
  ['base', '+record-batch-update', '--json', '@' + externalPayload],
  'D:\\winlp_reporter\\state'
);
assert.equal(normalizedExternal.cwd, path.resolve('D:\\winlp_reporter\\state'));
assert.equal(normalizedExternal.args[3], '@controlled-test.json');

const probe = runLarkCli([
  '--input-type=module', '-e',
  'console.log(JSON.stringify({cwd:process.cwd(), argv:process.argv.slice(1)}))',
  '--', '--json', '@' + repoPayload
], { cli: process.execPath, cwd: 'C:\\Windows' });
assert.equal(probe.ok, true);
const captured = JSON.parse(probe.stdout.trim());
assert.equal(captured.cwd, path.resolve(REPO_ROOT));
assert.equal(captured.argv.at(-1), '@state/jiang/stage3-api-update-records.json');

assert.equal(errorCodeFor(
  { status: 'complete-with-errors', timedOutCount: 0 },
  [{ timedOut: false, error: 'invalid JSON file path: --file must be a relative path' }]
), 'FEISHU_CLI_FILE_PATH_INVALID');

assert.equal(errorCodeFor(
  {
    status: 'complete-with-errors',
    timedOutCount: 0,
    tableResults: [{ phases: [{ stages: [{
      exitCode: 1,
      timedOut: false,
      stderrTail: '--json invalid JSON file path: --file must be a relative path'
    }] }] }]
  },
  [{ timedOut: false, error: 'exit code 1 不在 allowExitCodes [0,2] 内' }]
), 'FEISHU_CLI_FILE_PATH_INVALID');

assert.equal(errorCodeFor(
  { status: 'complete-with-errors', timedOutCount: 0 },
  [{ timedOut: false, error: 'exit code 1；字段写回失败；timedOut=false' }]
), 'BATCH_TASK_FAILED');

assert.equal(errorCodeFor(
  { status: 'complete-with-errors', timedOutCount: 1 },
  [{ timedOut: true, error: '阶段超时' }]
), 'TASK_EXEC_TIMEOUT');

console.log('LARK_CLI_PATH_FIX_TEST_PASS 8');
