import assert from 'node:assert/strict';
import { classifyLarkFailure } from '../scripts/lark-cli-utils.mjs';

const networkTimeoutStdout = JSON.stringify({
  ok: false,
  identity: 'user',
  error: {
    type: 'network',
    subtype: 'timeout',
    message: 'API call failed: Get "https://open.feishu.cn/open-apis/base/v3/bases/MLKnbkdBCaQMWmssbvkcz80EnEd/tables/tblSWinblefT5efH/records?field_id=%E5%BD%95%E5%B1%8F%E5%90%8D%E7%A7%B0"'
  }
}, null, 2);

const verdict = classifyLarkFailure({ stdout: networkTimeoutStdout, status: 1 });
assert.equal(verdict.retryable, true, `expected retryable, got ${JSON.stringify(verdict)}`);
assert.match(verdict.reason, /transient:lark_json_network_timeout/);

const truncated = networkTimeoutStdout.slice(0, 280);
const truncatedVerdict = classifyLarkFailure({ stdout: truncated, status: 1 });
assert.equal(truncatedVerdict.retryable, true, `truncated JSON should still be retryable, got ${JSON.stringify(truncatedVerdict)}`);

const tls = classifyLarkFailure({ stdout: 'TLS handshake timeout', status: 1 });
assert.equal(tls.retryable, true);
assert.equal(tls.reason, 'transient:TLS handshake timeout');

const fatal = classifyLarkFailure({ stdout: JSON.stringify({ ok: false, error: { type: 'bad_request', message: 'FieldNameNotFound' } }), status: 1 });
assert.equal(fatal.retryable, false);

console.log('LARK_CLI_TIMEOUT_RETRY_TEST_PASS');
