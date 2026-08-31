'use strict';

/*
 * 北辰 · AI relay（腾讯云函数 Web 函数版）
 *
 * Secrets are read only from the function environment.  In particular,
 * Qianfan uses the Token Plan personal Mini API key with the standard
 * /v2/chat/completions API;
 * this file deliberately does not implement the Coding Plan endpoint.
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');

const MAX_BODY_BYTES = 128 * 1024;
const MAX_MESSAGE_COUNT = 24;
const MAX_MESSAGE_CHARS = 16000;
const MAX_PROMPT_CHARS = 72000;
const MAX_UPSTREAM_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 16 * 1024;
const CLOCK_SKEW_MS = 60 * 1000;
const DEFAULT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RUNS = 3;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 300 * 1000;
const DEFAULT_OPENCODE_URL = 'https://opencode.ai/zen/go/v1/chat/completions';
const DEFAULT_OPENCODE_MODEL = 'deepseek-v4-flash';
const DEFAULT_QIANFAN_BASE_URL = 'https://qianfan.baidubce.com/v2';
const QIANFAN_ALLOWED_HOSTS = new Set(['qianfan.baidubce.com']);

function envNumber(name, fallback, min, max) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
}

const TOKEN_TTL_MS = envNumber('GATE_TOKEN_TTL_MS', DEFAULT_TOKEN_TTL_MS, 5 * 60 * 1000, MAX_TOKEN_TTL_MS);
const UPSTREAM_TIMEOUT_MS = envNumber('UPSTREAM_TIMEOUT_MS', DEFAULT_UPSTREAM_TIMEOUT_MS, 5 * 1000, DEFAULT_UPSTREAM_TIMEOUT_MS);
const TRUST_PROXY = String(process.env.TRUST_PROXY || '').toLowerCase() === 'true';
const ALLOWED_ORIGINS = new Set(
  String(process.env.CORS_ALLOWED_ORIGINS || 'https://yusheng266186-beep.github.io')
    .split(',').map(value => value.trim()).filter(Boolean)
);

const attempts = new Map();
const requestLimits = new Map();
const sessions = new Map();
const usedTotp = new Map();

function httpError(status, code) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  return error;
}

function securityHeaders(req, extra = {}) {
  const headers = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Vary': 'Origin'
  };
  const origin = String(req?.headers?.origin || '').trim();
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'content-type, authorization, x-request-id';
    headers['Access-Control-Max-Age'] = '600';
  }
  return Object.assign(headers, extra);
}

function json(req, res, status, payload, extra = {}) {
  res.writeHead(status, securityHeaders(req, {'Content-Type': 'application/json; charset=utf-8', ...extra}));
  res.end(JSON.stringify(payload));
}

function text(req, res, status, value) {
  res.writeHead(status, securityHeaders(req, {'Content-Type': 'text/plain; charset=utf-8'}));
  res.end(value);
}

function allowedOrigin(req) {
  const origin = String(req.headers.origin || '').trim();
  return !origin || ALLOWED_ORIGINS.has(origin);
}

function requestInfo(req) {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    return {pathname: url.pathname, search: url.search};
  } catch (_) {
    return null;
  }
}

function isPath(req, pathname) {
  const info = requestInfo(req);
  return !!info && info.pathname === pathname && !info.search;
}

function clientKey(req) {
  if (TRUST_PROXY) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded.slice(0, 128);
  }
  return String(req.socket?.remoteAddress || 'unknown').slice(0, 128);
}

function pruneMap(map, maxEntries = 10000) {
  if (map.size <= maxEntries) return;
  const remove = Math.max(1, map.size - maxEntries);
  let count = 0;
  for (const key of map.keys()) {
    map.delete(key);
    if (++count >= remove) break;
  }
}

function allowRate(map, key, limit, windowMs) {
  const now = Date.now();
  let item = map.get(key);
  if (!item || now - item.start >= windowMs) item = {start: now, count: 0};
  item.count += 1;
  map.set(key, item);
  pruneMap(map);
  return item.count <= limit;
}

function readJson(req, maxBytes = MAX_BODY_BYTES) {
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') return Promise.reject(httpError(415, 'BEICHEN_CONTENT_TYPE_REQUIRED'));
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return Promise.reject(httpError(413, 'BEICHEN_BODY_TOO_LARGE'));
  return new Promise((resolve, reject) => {
    let raw = '';
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
      if (error.code === 'BEICHEN_BODY_TOO_LARGE') req.destroy();
    };
    req.on('data', chunk => {
      if (settled) return;
      raw += chunk.toString('utf8');
      if (Buffer.byteLength(raw, 'utf8') > maxBytes) fail(httpError(413, 'BEICHEN_BODY_TOO_LARGE'));
    });
    req.on('end', () => {
      if (settled) return;
      try {
        const value = raw ? JSON.parse(raw) : {};
        if (!value || Array.isArray(value) || typeof value !== 'object') throw httpError(400, 'BEICHEN_BAD_JSON');
        settled = true;
        resolve(value);
      } catch (error) {
        fail(error.status ? error : httpError(400, 'BEICHEN_BAD_JSON'));
      }
    });
    req.on('error', error => fail(error));
  });
}

function onlyKeys(value, allowed) {
  return Object.keys(value).every(key => allowed.includes(key));
}

function b64url(value) {
  return Buffer.from(value).toString('base64url');
}

function fromB64url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('bad base64url');
  return Buffer.from(value, 'base64url');
}

function constantTimeEqual(a, b) {
  const left = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
  const right = Buffer.isBuffer(b) ? b : Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function sessionSecretReady() {
  return Buffer.byteLength(String(process.env.GATE_SESSION_SECRET || ''), 'utf8') >= 32;
}

function signToken(payload) {
  const secret = String(process.env.GATE_SESSION_SECRET || '');
  const body = b64url(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return body + '.' + signature;
}

function decodeToken(token) {
  if (!sessionSecretReady() || typeof token !== 'string' || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{40,64}$/.test(parts[1])) return null;
  const expected = crypto.createHmac('sha256', String(process.env.GATE_SESSION_SECRET)).update(parts[0]).digest('base64url');
  if (!constantTimeEqual(parts[1], expected)) return null;
  try {
    const payload = JSON.parse(fromB64url(parts[0]).toString('utf8'));
    const now = Date.now();
    if (payload.v !== 1 || !/^[a-f0-9]{32}$/.test(payload.sid) || !/^[a-f0-9]{32}$/.test(payload.jti)) return null;
    if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.iat > now + CLOCK_SKEW_MS || payload.exp <= now) return null;
    if (payload.exp - payload.iat > TOKEN_TTL_MS + CLOCK_SKEW_MS || !Number.isInteger(payload.runs) || payload.runs < 0 || payload.runs > MAX_RUNS) return null;
    if (!Number.isInteger(payload.seq) || payload.seq < 0) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

function authenticate(req, allowStale = false) {
  if (!sessionSecretReady()) return {error: 'BEICHEN_AUTH_NOT_CONFIGURED'};
  const authorization = String(req.headers.authorization || '');
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  const payload = decodeToken(token);
  if (!payload) return {error: 'BEICHEN_AUTH_REQUIRED'};
  const state = sessions.get(payload.sid);
  if (!state || state.exp <= Date.now()) return {error: 'BEICHEN_AUTH_EXPIRED', payload};
  if (state.jti !== payload.jti || state.seq !== payload.seq || state.runs !== payload.runs) {
    return allowStale ? {error: 'BEICHEN_AUTH_REPLAY', payload, state} : {error: 'BEICHEN_AUTH_REPLAY', payload, state};
  }
  return {payload, state};
}

function requireSession(req, res) {
  const auth = authenticate(req);
  if (auth.error) {
    json(req, res, auth.error === 'BEICHEN_AUTH_NOT_CONFIGURED' ? 503 : 401, {error: {message: auth.error}});
    return null;
  }
  return auth;
}

function newToken(runs, sid, seq = 0, lastCompletion = null) {
  const now = Date.now();
  const sessionId = sid || crypto.randomBytes(16).toString('hex');
  const jti = crypto.randomBytes(16).toString('hex');
  const exp = now + TOKEN_TTL_MS;
  sessions.set(sessionId, {runs, seq, jti, exp, lastCompletion});
  pruneMap(sessions);
  return {token: signToken({v: 1, sid: sessionId, jti, seq, iat: now, exp, runs}), sid: sessionId, jti, seq, exp};
}

function base32Decode(value) {
  const clean = String(value || '').replace(/[\s-]/g, '').toUpperCase();
  if (clean.length < 16 || !/^[A-Z2-7]+$/.test(clean)) return Buffer.alloc(0);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let buffer = 0;
  const out = [];
  for (const ch of clean) {
    buffer = (buffer << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totpCode(counter, secretBytes) {
  const message = Buffer.alloc(8);
  let value = counter;
  for (let i = 7; i >= 0; i--) { message[i] = value & 0xff; value = Math.floor(value / 256); }
  const digest = crypto.createHmac('sha1', secretBytes).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const number = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(number % 1000000).padStart(6, '0');
}

function consumeTotp(code) {
  if (!/^\d{6}$/.test(code) || !process.env.GATE_TOTP_SECRET) return false;
  const secretBytes = base32Decode(process.env.GATE_TOTP_SECRET);
  if (secretBytes.length < 10) return false;
  const counter = Math.floor(Date.now() / 30000);
  for (const candidate of [counter - 1, counter, counter + 1]) {
    const expected = totpCode(candidate, secretBytes);
    if (!constantTimeEqual(code, expected)) continue;
    const key = candidate + ':' + code;
    const now = Date.now();
    if (usedTotp.has(key)) return false;
    usedTotp.set(key, now + 120000);
    for (const [oldKey, expires] of usedTotp) if (expires <= now) usedTotp.delete(oldKey);
    pruneMap(usedTotp);
    return true;
  }
  return false;
}

function validateChatBody(input) {
  const allowed = ['model', 'messages', 'max_tokens', 'temperature', 'stream', 'thinking'];
  if (!onlyKeys(input, allowed) || !Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > MAX_MESSAGE_COUNT) {
    throw httpError(400, 'BEICHEN_BAD_REQUEST');
  }
  let promptChars = 0;
  const messages = input.messages.map(message => {
    if (!message || typeof message !== 'object' || Array.isArray(message) || !onlyKeys(message, ['role', 'content'])) throw httpError(400, 'BEICHEN_BAD_REQUEST');
    if (!['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || message.content.length > MAX_MESSAGE_CHARS) throw httpError(400, 'BEICHEN_BAD_REQUEST');
    promptChars += message.content.length;
    return {role: message.role, content: message.content};
  });
  if (promptChars > MAX_PROMPT_CHARS) throw httpError(413, 'BEICHEN_PROMPT_TOO_LARGE');
  const maxTokens = input.max_tokens === undefined ? 3500 : input.max_tokens;
  const temperature = input.temperature === undefined ? 1 : input.temperature;
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 6000 || !Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw httpError(400, 'BEICHEN_BAD_REQUEST');
  if (input.stream !== undefined && input.stream !== true) throw httpError(400, 'BEICHEN_STREAM_REQUIRED');
  const body = {messages, max_tokens: maxTokens, temperature, stream: true};
  if (input.thinking !== undefined) {
    if (!input.thinking || typeof input.thinking !== 'object' || Array.isArray(input.thinking) || !onlyKeys(input.thinking, ['type']) || !['enabled', 'disabled'].includes(input.thinking.type)) throw httpError(400, 'BEICHEN_BAD_REQUEST');
    body.thinking = {type: input.thinking.type};
  }
  return body;
}

function providerConfig() {
  const name = String(process.env.AI_PROVIDER || 'opencode').trim().toLowerCase();
  if (name === 'opencode') {
    const key = String(process.env.OPENCODE_API_KEY || '').trim();
    if (!key) return null;
    return {name, key, model: String(process.env.OPENCODE_MODEL || DEFAULT_OPENCODE_MODEL).trim(), url: String(process.env.OPENCODE_BASE_URL || DEFAULT_OPENCODE_URL).trim()};
  }
  if (name === 'qianfan') {
    const key = String(process.env.QIANFAN_API_KEY || '').trim();
    const model = String(process.env.QIANFAN_MODEL || '').trim();
    if (!key || !model) return null;
    return {name, key, model, url: String(process.env.QIANFAN_BASE_URL || DEFAULT_QIANFAN_BASE_URL).trim()};
  }
  return null;
}

function upstreamUrl(config) {
  let url;
  try { url = new URL(config.url); } catch (_) { throw httpError(503, 'BEICHEN_PROVIDER_NOT_CONFIGURED'); }
  if (url.protocol !== 'https:' || url.search || url.hash || url.username || url.password) throw httpError(503, 'BEICHEN_PROVIDER_NOT_CONFIGURED');
  if (config.name === 'qianfan' && (!QIANFAN_ALLOWED_HOSTS.has(url.hostname.toLowerCase()) || (url.port && url.port !== '443'))) throw httpError(503, 'BEICHEN_QIANFAN_HOST_NOT_ALLOWED');
  let path = url.pathname.replace(/\/+$/, '');
  if (config.name === 'qianfan') {
    if (/coding/i.test(path)) throw httpError(503, 'BEICHEN_QIANFAN_STANDARD_ENDPOINT_REQUIRED');
    if (/\/chat\/completions$/i.test(path)) {
      /* Only the standard Qianfan v2 endpoint is accepted. */
      if (path !== '/v2/chat/completions') throw httpError(503, 'BEICHEN_QIANFAN_STANDARD_ENDPOINT_REQUIRED');
    } else if (!path || /\/v2$/i.test(path)) {
      path += path ? '/chat/completions' : '/v2/chat/completions';
    } else {
      throw httpError(503, 'BEICHEN_QIANFAN_STANDARD_ENDPOINT_REQUIRED');
    }
  } else if (!/\/chat\/completions$/i.test(path)) {
    throw httpError(503, 'BEICHEN_PROVIDER_NOT_CONFIGURED');
  }
  url.pathname = path;
  return url;
}

function proxyChat(req, res, auth, body, config) {
  const url = upstreamUrl(config);
  const payload = JSON.stringify(Object.assign({}, body, {model: config.model}));
  const upstream = https.request({
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname,
    method: 'POST',
    timeout: UPSTREAM_TIMEOUT_MS,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream, application/json',
      'Authorization': 'Bearer ' + config.key,
      'Content-Length': Buffer.byteLength(payload)
    }
  }, upstreamResponse => {
    const status = Number(upstreamResponse.statusCode || 502);
    if (status < 200 || status >= 300) {
      let bytes = 0;
      upstreamResponse.on('data', chunk => { bytes += chunk.length; });
      upstreamResponse.on('end', () => {
        if (!res.headersSent) json(req, res, status >= 400 && status < 500 ? status : 502, {error: {message: 'BEICHEN_UPSTREAM_ERROR'}});
      });
      return;
    }
    const contentType = String(upstreamResponse.headers['content-type'] || '').toLowerCase();
    const responseHeaders = securityHeaders(req, {
      'Content-Type': contentType.startsWith('text/event-stream') ? 'text/event-stream' : 'application/json; charset=utf-8',
      'X-Accel-Buffering': 'no'
    });
    res.writeHead(status, responseHeaders);
    let bytes = 0;
    upstreamResponse.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_UPSTREAM_BYTES) {
        upstream.destroy();
        res.destroy();
        return;
      }
      res.write(chunk);
    });
    upstreamResponse.on('end', () => res.end());
    upstreamResponse.on('error', () => { if (!res.destroyed) res.destroy(); });
  });
  const timeout = setTimeout(() => upstream.destroy(httpError(504, 'BEICHEN_UPSTREAM_TIMEOUT')), UPSTREAM_TIMEOUT_MS);
  const cleanup = () => clearTimeout(timeout);
  upstream.on('error', error => {
    cleanup();
    if (!res.headersSent) json(req, res, error.code === 'BEICHEN_UPSTREAM_TIMEOUT' ? 504 : 502, {error: {message: error.code || 'BEICHEN_UPSTREAM_ERROR'}});
  });
  upstream.on('close', cleanup);
  res.on('close', () => { if (!upstream.destroyed) upstream.destroy(); });
  upstream.end(payload);
}

function completeRun(req, res, auth) {
  const requestId = String(req.headers['x-request-id'] || '').trim();
  if (!/^[A-Za-z0-9._~-]{16,96}$/.test(requestId)) return json(req, res, 400, {error: {message: 'BEICHEN_REQUEST_ID_REQUIRED'}});
  const state = auth.state;
  const now = Date.now();
  if (state.lastCompletion && state.lastCompletion.requestId === requestId && state.lastCompletion.priorJti === auth.payload.jti) {
    return json(req, res, 200, state.lastCompletion.response);
  }
  if (auth.payload.runs >= MAX_RUNS) return json(req, res, 429, {error: {message: 'BEICHEN_AUTH_QUOTA_EXCEEDED'}});
  /* This block is synchronous: Node's event loop cannot interleave two updates. */
  const next = newToken(auth.payload.runs + 1, auth.payload.sid, auth.payload.seq + 1);
  const response = {ok: true, token: next.token, runs: auth.payload.runs + 1, remaining: MAX_RUNS - auth.payload.runs - 1, expiresIn: Math.max(0, next.exp - now)};
  const nextState = sessions.get(auth.payload.sid);
  nextState.lastCompletion = {requestId, priorJti: auth.payload.jti, response};
  return json(req, res, 200, response);
}

async function handle(req, res) {
  if (!allowedOrigin(req)) return json(req, res, 403, {error: {message: 'BEICHEN_ORIGIN_NOT_ALLOWED'}});
  const info = requestInfo(req);
  if (!info) return text(req, res, 400, 'bad request');
  const supported = ['/verify', '/run/complete', '/chat/completions'];
  if (req.method === 'OPTIONS') {
    if (!supported.includes(info.pathname) || info.search || String(req.headers['access-control-request-method'] || 'POST') !== 'POST') return text(req, res, 404, 'beichen relay');
    res.writeHead(204, securityHeaders(req));
    return res.end();
  }

  if (req.method === 'POST' && isPath(req, '/verify')) {
    if (!process.env.GATE_TOTP_SECRET || !sessionSecretReady()) return json(req, res, 503, {error: {message: 'BEICHEN_AUTH_NOT_CONFIGURED'}});
    if (!allowRate(attempts, 'verify:' + clientKey(req), 8, 60000)) return json(req, res, 429, {error: {message: 'BEICHEN_AUTH_RATE_LIMIT'}});
    try {
      const body = await readJson(req, 8 * 1024);
      if (!onlyKeys(body, ['code']) || typeof body.code !== 'string' || !consumeTotp(body.code)) return json(req, res, 401, {error: {message: 'BEICHEN_AUTH_INVALID_CODE'}});
      const token = newToken(0);
      return json(req, res, 200, {ok: true, token: token.token, runs: 0, maxRuns: MAX_RUNS, expiresIn: TOKEN_TTL_MS});
    } catch (error) {
      return json(req, res, error.status || 400, {error: {message: error.code || 'BEICHEN_BAD_JSON'}});
    }
  }

  if (req.method === 'POST' && isPath(req, '/run/complete')) {
    const auth = authenticate(req, true);
    if (auth.error && !auth.state) return json(req, res, auth.error === 'BEICHEN_AUTH_NOT_CONFIGURED' ? 503 : 401, {error: {message: auth.error}});
    if (!allowRate(requestLimits, 'run:' + clientKey(req) + ':' + auth.payload.sid, 6, 60000)) return json(req, res, 429, {error: {message: 'BEICHEN_RATE_LIMIT'}});
    try {
      const body = await readJson(req, 4 * 1024);
      if (Object.keys(body).length) return json(req, res, 400, {error: {message: 'BEICHEN_BAD_REQUEST'}});
    } catch (error) {
      return json(req, res, error.status || 400, {error: {message: error.code || 'BEICHEN_BAD_JSON'}});
    }
    if (auth.error === 'BEICHEN_AUTH_REPLAY') {
      const requestId = String(req.headers['x-request-id'] || '').trim();
      const prior = auth.state.lastCompletion;
      if (!prior || prior.requestId !== requestId || prior.priorJti !== auth.payload.jti) return json(req, res, 401, {error: {message: 'BEICHEN_AUTH_REPLAY'}});
      return json(req, res, 200, prior.response);
    }
    return completeRun(req, res, auth);
  }

  if (req.method === 'POST' && isPath(req, '/chat/completions')) {
    const auth = requireSession(req, res);
    if (!auth) return;
    if (!allowRate(requestLimits, 'chat:' + clientKey(req) + ':' + auth.payload.sid, 20, 60000)) return json(req, res, 429, {error: {message: 'BEICHEN_RATE_LIMIT'}});
    const config = providerConfig();
    if (!config) return json(req, res, 503, {error: {message: 'BEICHEN_PROVIDER_NOT_CONFIGURED'}});
    let body;
    try {
      body = validateChatBody(await readJson(req));
    } catch (error) {
      return json(req, res, error.status || 400, {error: {message: error.code || 'BEICHEN_BAD_REQUEST'}});
    }
    return proxyChat(req, res, auth, body, config);
  }

  return text(req, res, 404, 'beichen relay');
}

const server = http.createServer((req, res) => {
  /* Do not call req.setTimeout here: that socket also carries the response.
     server.requestTimeout below only bounds receiving the inbound request;
     it does not count idle time while the upstream response is streaming. */
  handle(req, res).catch(error => {
    if (!res.headersSent) json(req, res, error.status || 500, {error: {message: error.code || 'BEICHEN_INTERNAL_ERROR'}});
    else res.destroy();
  });
});
server.headersTimeout = 20000;
server.requestTimeout = 20000;
server.listen(Number(process.env.PORT || 9000), () => console.log('beichen relay listening'));
