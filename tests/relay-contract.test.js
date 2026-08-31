'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const path = require('node:path');

process.env.BEICHEN_NO_LISTEN = '1';
process.env.GATE_TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
process.env.GATE_SESSION_SECRET = 'codex-test-session-secret-'.repeat(3);
process.env.QIANFAN_API_KEY = 'test-provider-key';
process.env.CORS_ALLOWED_ORIGINS = 'http://127.0.0.1';

const relay = require(path.join(__dirname, '..', 'scf-relay.js'));

function fakeUpstreamRequester(options, callback) {
  const request = new EventEmitter();
  request.destroyed = false;
  request.write = () => {};
  request.end = () => {
    setImmediate(() => {
      if (request.destroyed) return;
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = {'content-type': 'text/event-stream'};
      callback(response);
      setImmediate(() => {
        if (request.destroyed) return;
        response.emit('data', Buffer.from('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'));
        response.emit('data', Buffer.from('data: [DONE]\n\n'));
        response.emit('end');
      });
    });
  };
  request.destroy = () => {
    request.destroyed = true;
    request.emit('close');
  };
  request.setTimeout = () => request;
  return request;
}

function request(server, method, url, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({
      host: address.address,
      port: address.port,
      method,
      path: url,
      headers: Object.assign({
        Origin: 'http://127.0.0.1',
        ...(body === undefined ? {} : {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload)})
      }, headers)
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8')}));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function jsonBody(response) {
  return JSON.parse(response.body || '{}');
}

function currentTotp() {
  const counter = Math.floor(Date.now() / 30000);
  return relay.totpCode(counter, relay.base32Decode(process.env.GATE_TOTP_SECRET));
}

/* Pure contract checks. */
const casual = relay.validateChatBody({
  messages: [{role: 'user', content: '你好'}], mode: 'open', max_tokens: 1200, stream: true
});
assert.equal(casual.max_tokens, 1200);
assert.equal(relay.buildUpstreamBody(casual, {name: 'qianfan', model: 'glm-5.2'}).thinking_budget, 2048);
const report = relay.validateChatBody({
  messages: [{role: 'user', content: '报告资料'}], mode: 'report', max_tokens: 16000, stream: true
}, {report: true});
assert.equal(report.max_tokens, relay.REPORT_MAX_TOKENS, 'report budget is server-owned');
assert.equal(relay.buildUpstreamBody(report, {name: 'qianfan', model: 'glm-5.2'}).thinking_budget, 4096);
assert.throws(() => relay.validateChatBody({messages: [{role: 'assistant', content: '先说'}], mode: 'open'}), /BEICHEN_BAD_REQUEST/);
assert.throws(() => relay.validateChatBody({messages: [{role: 'user', content: 'x'}], mode: 'report'}), /BEICHEN_BAD_REQUEST/);
assert.throws(() => relay.validateChatBody({messages: [{role: 'user', content: 'x'}], stream: false}), /BEICHEN_STREAM_REQUIRED/);
assert.throws(() => relay.upstreamUrl({url: 'https://evil.example/v2/chat/completions'}), /BEICHEN_QIANFAN_HOST_NOT_ALLOWED/);
assert.equal(relay.pickClientIp('203.0.113.7, 198.51.100.9', '10.0.0.1'), '10.0.0.1', 'XFF is ignored unless trusted');
assert.equal(relay.pickClientIp('203.0.113.7, 198.51.100.9', '10.0.0.1', true), '203.0.113.7');

/* HTTP flow checks use a fake upstream and never contact Qianfan. */
(async () => {
  relay.store.clear();
  relay.setUpstreamRequester(fakeUpstreamRequester);
  const server = relay.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const query = await request(server, 'POST', '/verify?unexpected=1', {}, {code: currentTotp()});
    assert.equal(query.status, 404, 'query variants must not consume authentication');

    const verified = await request(server, 'POST', '/verify', {}, {code: currentTotp()});
    assert.equal(verified.status, 200);
    const gate = jsonBody(verified);
    assert.match(gate.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.equal(gate.remaining, 3);

    const badAuth = await request(server, 'POST', '/report/intent', {Authorization: 'Bearer invalid-token'}, {evidenceHash: '0'.repeat(64)});
    assert.equal(badAuth.status, 401);

    const reportMessages = [{role: 'system', content: '格式'}, {role: 'user', content: '我喜欢拆解问题'}];
    const normalized = relay.validateChatBody({messages: reportMessages, mode: 'report'}, {report: true});
    const hash = relay.sha256(relay.canonicalMessages(normalized.messages));
    const intentResponse = await request(server, 'POST', '/report/intent', {Authorization: 'Bearer ' + gate.token}, {evidenceHash: hash});
    assert.equal(intentResponse.status, 200);
    const intent = jsonBody(intentResponse).intent;

    const reportResponse = await request(server, 'POST', '/chat/completions', {
      Authorization: 'Bearer ' + gate.token,
      'X-Report-Intent': intent
    }, {messages: reportMessages, mode: 'report', max_tokens: 16000, stream: true});
    assert.equal(reportResponse.status, 200);
    assert.match(reportResponse.body, /data: \[DONE\]/);

    const requestId = 'codex-report-001';
    const completed = await request(server, 'POST', '/run/complete', {
      Authorization: 'Bearer ' + gate.token,
      'X-Request-ID': requestId
    }, {intent});
    assert.equal(completed.status, 200);
    const completionBody = jsonBody(completed);
    assert.equal(completionBody.runs, 1);
    assert.equal(completionBody.remaining, 2);

    const oldTokenRetry = await request(server, 'POST', '/run/complete', {
      Authorization: 'Bearer ' + gate.token,
      'X-Request-ID': requestId
    }, {intent});
    assert.equal(oldTokenRetry.status, 200, 'old token + same request id is idempotent');
    assert.deepEqual(jsonBody(oldTokenRetry), completionBody);

    const newTokenRetry = await request(server, 'POST', '/run/complete', {
      Authorization: 'Bearer ' + completionBody.token,
      'X-Request-ID': requestId
    }, {intent});
    assert.equal(newTokenRetry.status, 200, 'new token + same request id replays same receipt');
    assert.deepEqual(jsonBody(newTokenRetry), completionBody);

    const differentId = await request(server, 'POST', '/run/complete', {
      Authorization: 'Bearer ' + gate.token,
      'X-Request-ID': 'codex-report-002'
    }, {intent});
    assert.equal(differentId.status, 401, 'stale token cannot create a second completion');

    const bypass = await request(server, 'POST', '/chat/completions', {
      Authorization: 'Bearer ' + completionBody.token
    }, {messages: [{role: 'user', content: '伪造报告'}], mode: 'report', max_tokens: 16000, stream: true});
    assert.equal(bypass.status, 400, 'report-scale mode requires a server intent');

    const normal = await request(server, 'POST', '/chat/completions', {
      Authorization: 'Bearer ' + completionBody.token
    }, {messages: [{role: 'user', content: '继续聊'}], mode: 'open', max_tokens: 1200, stream: true});
    assert.equal(normal.status, 200);

    const health = await request(server, 'GET', '/healthz');
    assert.equal(health.status, 200);
    assert.equal(jsonBody(health).version, relay.APP_VERSION);
    assert.equal((await request(server, 'GET', '/healthz?x=1')).status, 404);

    const huge = await request(server, 'POST', '/verify', {}, {code: '0'.repeat(9000)});
    assert.equal(huge.status, 413);
    console.log('relay vNext contract and HTTP tests passed');
  } finally {
    await new Promise(resolve => server.close(resolve));
    relay.setUpstreamRequester(undefined);
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
