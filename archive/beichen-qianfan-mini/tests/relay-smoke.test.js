'use strict';

/* Minimal local smoke test. It uses dummy secrets and never calls a real AI provider. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const {spawn, execFileSync} = require('child_process');

const root = path.resolve(__dirname, '..');
const scf = fs.readFileSync(path.join(root, 'scf-relay.js'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'relay-worker.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

assert.match(scf, /AI_PROVIDER/);
assert.match(scf, /QIANFAN_API_KEY/);
assert.match(scf, /QIANFAN_STANDARD_ENDPOINT_REQUIRED/);
assert.match(scf, /QIANFAN_ALLOWED_HOSTS/);
assert.match(scf, /info\.pathname === pathname/);
assert.doesNotMatch(scf, /Access-Control-Allow-Origin['"]\s*:\s*['"]\*['"]/);
assert.match(worker, /QIANFAN_API_KEY/);
assert.match(worker, /QIANFAN_STANDARD_ENDPOINT_REQUIRED/);
assert.match(worker, /QIANFAN_ALLOWED_HOSTS/);
assert.doesNotMatch(worker, /Access-Control-Allow-Origin['"]\s*:\s*['"]\*['"]/);
assert.doesNotMatch(index, /msgsEl\.innerHTML\s*=\s*s\.msgsHTML/);
assert.doesNotMatch(index, /msgsHTML\s*:/);
assert.doesNotMatch(index, /1459223409-li1fse2kqe\.ap-chengdu\.tencentscf\.com/);
assert.match(index, /REPLACE_WITH_YOUR_RELAY_ORIGIN/);
assert.match(index, /sessionStorage/);
assert.match(index, /integrity="sha384-/);
execFileSync(process.execPath, ['--check', path.join(root, 'scf-relay.js')], {stdio: 'inherit'});
execFileSync(process.execPath, ['--check', path.join(root, 'relay-worker.js')], {stdio: 'inherit'});

function base32Decode(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, buffer = 0;
  const out = [];
  for (const ch of value) {
    buffer = (buffer << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((buffer >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function totp(secret, counter = Math.floor(Date.now() / 30000)) {
  const message = Buffer.alloc(8);
  let value = counter;
  for (let i = 7; i >= 0; i--) { message[i] = value & 255; value = Math.floor(value / 256); }
  const digest = crypto.createHmac('sha1', base32Decode(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 15;
  const number = ((digest[offset] & 127) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(number % 1000000).padStart(6, '0');
}

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? '' : JSON.stringify(options.body);
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method: options.method || 'POST',
      headers: {'Content-Type': 'application/json', 'Origin': 'https://yusheng266186-beep.github.io', ...(options.headers || {})}
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let body = text;
        try { body = text ? JSON.parse(text) : null; } catch (_) {}
        resolve({status: res.statusCode, headers: res.headers, body});
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function waitForServer(port) {
  for (let i = 0; i < 40; i++) {
    try { await request(port, '/unknown'); return; } catch (_) { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  throw new Error('SCF smoke server did not start');
}

(async () => {
  const port = 19199;
  const secret = 'JBSWY3DPEHPK3PXP';
  const child = spawn(process.execPath, [path.join(root, 'scf-relay.js')], {
    cwd: root,
    env: {...process.env, PORT: String(port), AI_PROVIDER: 'qianfan', QIANFAN_API_KEY: 'dummy', QIANFAN_BASE_URL: 'https://qianfan.baidubce.com/foo/chat/completions', QIANFAN_MODEL: 'dummy-model', GATE_TOTP_SECRET: secret, GATE_SESSION_SECRET: '01234567890123456789012345678901', CORS_ALLOWED_ORIGINS: 'https://yusheng266186-beep.github.io'}
  });
  child.stdout.resume(); child.stderr.resume();
  try {
    await waitForServer(port);
    const unknownOrigin = await new Promise((resolve, reject) => {
      const req = http.request({hostname: '127.0.0.1', port, path: '/verify', method: 'POST', headers: {'Content-Type': 'application/json', Origin: 'https://evil.example'}}, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject); req.end(JSON.stringify({code: totp(secret)}));
    });
    assert.equal(unknownOrigin, 403);
    assert.equal((await request(port, '/anything/chat/completions')).status, 404);
    assert.equal((await request(port, '/verify?x=1', {body: {code: totp(secret)}})).status, 404);

    const verified = await request(port, '/verify', {body: {code: totp(secret)}});
    assert.equal(verified.status, 200);
    assert.ok(verified.body.token);
    assert.equal(verified.headers['access-control-allow-origin'], 'https://yusheng266186-beep.github.io');
    const badQianfanPath = await request(port, '/chat/completions', {headers: {'Authorization': 'Bearer ' + verified.body.token}, body: {model: 'ignored', messages: [{role: 'user', content: 'smoke'}], max_tokens: 1, temperature: 0, stream: true}});
    assert.equal(badQianfanPath.status, 503);
    const rid = 'smoke-request-id-000000000000';
    const first = await request(port, '/run/complete', {headers: {'Authorization': 'Bearer ' + verified.body.token, 'X-Request-ID': rid}, body: {}});
    assert.equal(first.status, 200);
    const duplicate = await request(port, '/run/complete', {headers: {'Authorization': 'Bearer ' + verified.body.token, 'X-Request-ID': rid}, body: {}});
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.token, first.body.token);
    const replay = await request(port, '/run/complete', {headers: {'Authorization': 'Bearer ' + verified.body.token, 'X-Request-ID': 'different-request-id-000000'}, body: {}});
    assert.equal(replay.status, 401);
    const missingId = await request(port, '/run/complete', {headers: {'Authorization': 'Bearer ' + first.body.token}, body: {}});
    assert.equal(missingId.status, 400);
    console.log('relay smoke tests passed');
  } finally {
    child.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
