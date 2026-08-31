/*
 * 北辰 · AI relay Worker
 *
 * Put all secrets in Worker Secrets. Qianfan intentionally uses the ordinary
 * OpenAI-compatible /v2/chat/completions endpoint and the Token Plan
 * personal Mini QIANFAN_API_KEY; the
 * Coding Plan key and endpoint are not accepted by this adapter.
 */

const MAX_BODY_BYTES = 128 * 1024;
const MAX_MESSAGE_COUNT = 24;
const MAX_MESSAGE_CHARS = 16000;
const MAX_PROMPT_CHARS = 72000;
const MAX_UPSTREAM_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 16 * 1024;
const CLOCK_SKEW_MS = 60 * 1000;
const DEFAULT_TOKEN_TTL = 24 * 60 * 60 * 1000;
const MAX_TOKEN_TTL = 7 * 24 * 60 * 60 * 1000;
const MAX_RUNS = 3;
const DEFAULT_UPSTREAM_TIMEOUT = 300 * 1000;
const DEFAULT_OPENCODE_URL = 'https://opencode.ai/zen/go/v1/chat/completions';
const DEFAULT_OPENCODE_MODEL = 'deepseek-v4-flash';
const DEFAULT_QIANFAN_BASE_URL = 'https://qianfan.baidubce.com/v2';
const QIANFAN_ALLOWED_HOSTS = new Set(['qianfan.baidubce.com']);
const enc = new TextEncoder();

const attempts = new Map();
const requestLimits = new Map();
const sessions = new Map();
const usedTotp = new Map();
/* Promise mutex: an isolate has one JS event loop, so quota rotation is one-at-a-time. */
let stateLock = Promise.resolve();

function httpError(status, code) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  return error;
}

function withStateLock(task) {
  const result = stateLock.then(task, task);
  stateLock = result.catch(() => {});
  return result;
}

function envNumber(env, name, fallback, min, max) {
  const value = Number(env[name]);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
}

function tokenTtl(env) {
  return envNumber(env, 'GATE_TOKEN_TTL_MS', DEFAULT_TOKEN_TTL, 5 * 60 * 1000, MAX_TOKEN_TTL);
}

function upstreamTimeout(env) {
  return envNumber(env, 'UPSTREAM_TIMEOUT_MS', DEFAULT_UPSTREAM_TIMEOUT, 5 * 1000, DEFAULT_UPSTREAM_TIMEOUT);
}

function allowedOrigins(env) {
  return new Set(String(env.CORS_ALLOWED_ORIGINS || 'https://yusheng266186-beep.github.io').split(',').map(value => value.trim()).filter(Boolean));
}

function securityHeaders(request, env, extra = {}) {
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
  /* The trailing comma in CSP is invalid; set the canonical value explicitly. */
  headers['Content-Security-Policy'] = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";
  const origin = String(request.headers.get('Origin') || '').trim();
  if (origin && allowedOrigins(env).has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'content-type, authorization, x-request-id';
    headers['Access-Control-Max-Age'] = '600';
  }
  return {...headers, ...extra};
}

function json(request, env, data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: securityHeaders(request, env, {'Content-Type': 'application/json; charset=utf-8', ...(init.headers || {})})
  });
}

function text(request, env, status, value) {
  return new Response(value, {status, headers: securityHeaders(request, env, {'Content-Type': 'text/plain; charset=utf-8'})});
}

function exactPath(url, pathname) {
  return url.pathname === pathname && !url.search;
}

function originAllowed(request, env) {
  const origin = String(request.headers.get('Origin') || '').trim();
  return !origin || allowedOrigins(env).has(origin);
}

function clientKey(request) {
  return String(request.headers.get('CF-Connecting-IP') || 'unknown').slice(0, 128);
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

function byteLength(text) { return enc.encode(text).byteLength; }

async function readJson(request, maxBytes = MAX_BODY_BYTES) {
  const contentType = String(request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw httpError(415, 'BEICHEN_CONTENT_TYPE_REQUIRED');
  const declaredLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw httpError(413, 'BEICHEN_BODY_TOO_LARGE');
  const raw = await request.text();
  if (byteLength(raw) > maxBytes) throw httpError(413, 'BEICHEN_BODY_TOO_LARGE');
  try {
    const value = raw ? JSON.parse(raw) : {};
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('bad json');
    return value;
  } catch (_) {
    throw httpError(400, 'BEICHEN_BAD_JSON');
  }
}

function onlyKeys(value, allowed) { return Object.keys(value).every(key => allowed.includes(key)); }

function b64urlBytes(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlText(text) { return b64urlBytes(enc.encode(text)); }

function fromB64url(text) {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('bad base64url');
  const raw = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4));
  return Uint8Array.from(raw, ch => ch.charCodeAt(0));
}

function constantTimeEqualText(left, right) {
  const a = enc.encode(String(left));
  const b = enc.encode(String(right));
  let result = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) result |= (a[i % (a.length || 1)] || 0) ^ (b[i % (b.length || 1)] || 0);
  return result === 0;
}

async function hmac(secret, text, hash = 'SHA-256') {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), {name: 'HMAC', hash}, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}

function sessionSecretReady(secret) { return byteLength(String(secret || '')) >= 32; }

async function signToken(payload, secret) {
  const body = b64urlText(JSON.stringify(payload));
  return body + '.' + b64urlBytes(await hmac(secret, body));
}

async function decodeToken(token, secret, ttl) {
  if (!sessionSecretReady(secret) || typeof token !== 'string' || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{40,64}$/.test(parts[1])) return null;
  const expected = b64urlBytes(await hmac(secret, parts[0]));
  if (!constantTimeEqualText(parts[1], expected)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
    const now = Date.now();
    if (payload.v !== 1 || !/^[a-f0-9-]{32,36}$/.test(payload.sid) || !/^[a-f0-9-]{32,36}$/.test(payload.jti)) return null;
    if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.iat > now + CLOCK_SKEW_MS || payload.exp <= now) return null;
    if (payload.exp - payload.iat > ttl + CLOCK_SKEW_MS || !Number.isInteger(payload.runs) || payload.runs < 0 || payload.runs > MAX_RUNS || !Number.isInteger(payload.seq) || payload.seq < 0) return null;
    return payload;
  } catch (_) { return null; }
}

async function authenticate(request, env, allowStale = false) {
  const secret = String(env.GATE_SESSION_SECRET || '');
  if (!sessionSecretReady(secret)) return {error: 'BEICHEN_AUTH_NOT_CONFIGURED'};
  const authorization = String(request.headers.get('Authorization') || '');
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  const payload = await decodeToken(token, secret, tokenTtl(env));
  if (!payload) return {error: 'BEICHEN_AUTH_REQUIRED'};
  const state = sessions.get(payload.sid);
  if (!state || state.exp <= Date.now()) return {error: 'BEICHEN_AUTH_EXPIRED', payload};
  if (state.jti !== payload.jti || state.seq !== payload.seq || state.runs !== payload.runs) return {error: 'BEICHEN_AUTH_REPLAY', payload, state};
  return {payload, state};
}

async function requireSession(request, env) {
  const auth = await authenticate(request, env);
  return auth;
}

async function newToken(env, runs, sid, seq = 0, lastCompletion = null) {
  const now = Date.now();
  const sessionId = sid || crypto.randomUUID();
  const jti = crypto.randomUUID();
  const exp = now + tokenTtl(env);
  sessions.set(sessionId, {runs, seq, jti, exp, lastCompletion});
  pruneMap(sessions);
  return {token: await signToken({v: 1, sid: sessionId, jti, seq, iat: now, exp, runs}, String(env.GATE_SESSION_SECRET)), sid: sessionId, jti, seq, exp};
}

function base32Decode(value) {
  const clean = String(value || '').replace(/[\s-]/g, '').toUpperCase();
  if (clean.length < 16 || !/^[A-Z2-7]+$/.test(clean)) return new Uint8Array();
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, buffer = 0;
  const out = [];
  for (const ch of clean) {
    buffer = (buffer << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((buffer >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

async function totpCode(counter, secret) {
  const message = new Uint8Array(8);
  let value = counter;
  for (let i = 7; i >= 0; i--) { message[i] = value & 255; value = Math.floor(value / 256); }
  const key = await crypto.subtle.importKey('raw', base32Decode(secret), {name: 'HMAC', hash: 'SHA-1'}, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
  const offset = digest[digest.length - 1] & 15;
  const number = ((digest[offset] & 127) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(number % 1000000).padStart(6, '0');
}

async function consumeTotp(code, secret) {
  if (!/^\d{6}$/.test(code) || !secret || base32Decode(secret).length < 10) return false;
  const counter = Math.floor(Date.now() / 30000);
  for (const candidate of [counter - 1, counter, counter + 1]) {
    if (!constantTimeEqualText(code, await totpCode(candidate, secret))) continue;
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
  if (!onlyKeys(input, allowed) || !Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > MAX_MESSAGE_COUNT) throw httpError(400, 'BEICHEN_BAD_REQUEST');
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

function providerConfig(env) {
  const name = String(env.AI_PROVIDER || 'opencode').trim().toLowerCase();
  if (name === 'opencode') {
    const key = String(env.OPENCODE_API_KEY || '').trim();
    if (!key) return null;
    return {name, key, model: String(env.OPENCODE_MODEL || DEFAULT_OPENCODE_MODEL).trim(), url: String(env.OPENCODE_BASE_URL || DEFAULT_OPENCODE_URL).trim()};
  }
  if (name === 'qianfan') {
    const key = String(env.QIANFAN_API_KEY || '').trim();
    const model = String(env.QIANFAN_MODEL || '').trim();
    if (!key || !model) return null;
    return {name, key, model, url: String(env.QIANFAN_BASE_URL || DEFAULT_QIANFAN_BASE_URL).trim()};
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
  } else if (!/\/chat\/completions$/i.test(path)) throw httpError(503, 'BEICHEN_PROVIDER_NOT_CONFIGURED');
  url.pathname = path;
  return url;
}

function limitedStream(body, controller, onDone) {
  const reader = body.getReader();
  let bytes = 0;
  return new ReadableStream({
    async pull(streamController) {
      try {
        const {done, value} = await reader.read();
        if (done) { onDone(); streamController.close(); return; }
        bytes += value.byteLength;
        if (bytes > MAX_UPSTREAM_BYTES) {
          controller.abort();
          onDone();
          streamController.error(httpError(502, 'BEICHEN_UPSTREAM_OUTPUT_TOO_LARGE'));
          return;
        }
        streamController.enqueue(value);
      } catch (error) {
        onDone();
        streamController.error(error);
      }
    },
    cancel(reason) { onDone(); controller.abort(); return reader.cancel(reason); }
  });
}

async function readSmallBody(response) {
  if (!response.body) return;
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_ERROR_BYTES) break;
    }
  } finally { try { await reader.cancel(); } catch (_) {} }
}

async function proxyChat(request, env, body, config) {
  const url = upstreamUrl(config);
  const payload = JSON.stringify({...body, model: config.model});
  const controller = new AbortController();
  let timer;
  const clear = () => { if (timer) clearTimeout(timer); };
  timer = setTimeout(() => controller.abort(), upstreamTimeout(env));
  let upstream;
  try {
    upstream = await fetch(url.toString(), {
      method: 'POST',
      signal: controller.signal,
      headers: {'Content-Type': 'application/json', 'Accept': 'text/event-stream, application/json', 'Authorization': 'Bearer ' + config.key},
      body: payload
    });
  } catch (_) {
    clear();
    return json(request, env, {error: {message: 'BEICHEN_UPSTREAM_ERROR'}}, {status: 502});
  }
  if (!upstream.ok) {
    await readSmallBody(upstream);
    clear();
    return json(request, env, {error: {message: 'BEICHEN_UPSTREAM_ERROR'}}, {status: upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502});
  }
  if (!upstream.body) {
    clear();
    return json(request, env, {error: {message: 'BEICHEN_UPSTREAM_EMPTY'}}, {status: 502});
  }
  const contentType = String(upstream.headers.get('Content-Type') || '').toLowerCase();
  const stream = limitedStream(upstream.body, controller, clear);
  return new Response(stream, {status: upstream.status, headers: securityHeaders(request, env, {
    'Content-Type': contentType.startsWith('text/event-stream') ? 'text/event-stream' : 'application/json; charset=utf-8',
    'X-Accel-Buffering': 'no'
  })});
}

async function completeRun(request, env, auth) {
  const requestId = String(request.headers.get('X-Request-ID') || '').trim();
  if (!/^[A-Za-z0-9._~-]{16,96}$/.test(requestId)) return json(request, env, {error: {message: 'BEICHEN_REQUEST_ID_REQUIRED'}}, {status: 400});
  const current = await authenticate(request, env, true);
  if (current.error && !current.state) return json(request, env, {error: {message: current.error}}, {status: current.error === 'BEICHEN_AUTH_NOT_CONFIGURED' ? 503 : 401});
  if (current.error === 'BEICHEN_AUTH_REPLAY') {
    const requestId = String(request.headers.get('X-Request-ID') || '').trim();
    const prior = current.state.lastCompletion;
    if (!prior || prior.requestId !== requestId || prior.priorJti !== current.payload.jti) return json(request, env, {error: {message: 'BEICHEN_AUTH_REPLAY'}}, {status: 401});
    return json(request, env, prior.response, {status: 200});
  }
  const state = current.state;
  if (state.lastCompletion && state.lastCompletion.requestId === requestId && state.lastCompletion.priorJti === current.payload.jti) return json(request, env, state.lastCompletion.response, {status: 200});
  if (current.payload.runs >= MAX_RUNS) return json(request, env, {error: {message: 'BEICHEN_AUTH_QUOTA_EXCEEDED'}}, {status: 429});
  const next = await newToken(env, current.payload.runs + 1, current.payload.sid, current.payload.seq + 1);
  const response = {ok: true, token: next.token, runs: current.payload.runs + 1, remaining: MAX_RUNS - current.payload.runs - 1, expiresIn: Math.max(0, next.exp - Date.now())};
  const nextState = sessions.get(current.payload.sid);
  nextState.lastCompletion = {requestId, priorJti: current.payload.jti, response};
  return json(request, env, response, {status: 200});
}

export default {
  async fetch(request, env) {
    if (!originAllowed(request, env)) return json(request, env, {error: {message: 'BEICHEN_ORIGIN_NOT_ALLOWED'}}, {status: 403});
    let url;
    try { url = new URL(request.url); } catch (_) { return text(request, env, 400, 'bad request'); }
    const supported = ['/verify', '/run/complete', '/chat/completions'];
    if (request.method === 'OPTIONS') {
      if (!supported.includes(url.pathname) || url.search || String(request.headers.get('Access-Control-Request-Method') || 'POST') !== 'POST') return text(request, env, 404, 'beichen relay');
      return new Response(null, {status: 204, headers: securityHeaders(request, env)});
    }

    if (request.method === 'POST' && exactPath(url, '/verify')) {
      if (!env.GATE_TOTP_SECRET || !sessionSecretReady(env.GATE_SESSION_SECRET)) return json(request, env, {error: {message: 'BEICHEN_AUTH_NOT_CONFIGURED'}}, {status: 503});
      if (!allowRate(attempts, 'verify:' + clientKey(request), 8, 60000)) return json(request, env, {error: {message: 'BEICHEN_AUTH_RATE_LIMIT'}}, {status: 429});
      try {
        const body = await readJson(request, 8 * 1024);
        if (!onlyKeys(body, ['code']) || typeof body.code !== 'string') return json(request, env, {error: {message: 'BEICHEN_AUTH_INVALID_CODE'}}, {status: 401});
        return await withStateLock(async () => {
          if (!await consumeTotp(body.code, String(env.GATE_TOTP_SECRET))) return json(request, env, {error: {message: 'BEICHEN_AUTH_INVALID_CODE'}}, {status: 401});
          const token = await newToken(env, 0);
          return json(request, env, {ok: true, token: token.token, runs: 0, maxRuns: MAX_RUNS, expiresIn: tokenTtl(env)}, {status: 200});
        });
      } catch (error) {
        return json(request, env, {error: {message: error.code || 'BEICHEN_BAD_JSON'}}, {status: error.status || 400});
      }
    }

    if (request.method === 'POST' && exactPath(url, '/run/complete')) {
      const auth = await authenticate(request, env, true);
      if (auth.error && !auth.state) return json(request, env, {error: {message: auth.error}}, {status: auth.error === 'BEICHEN_AUTH_NOT_CONFIGURED' ? 503 : 401});
      if (!allowRate(requestLimits, 'run:' + clientKey(request) + ':' + auth.payload.sid, 6, 60000)) return json(request, env, {error: {message: 'BEICHEN_RATE_LIMIT'}}, {status: 429});
      try {
        const body = await readJson(request, 4 * 1024);
        if (Object.keys(body).length) return json(request, env, {error: {message: 'BEICHEN_BAD_REQUEST'}}, {status: 400});
      } catch (error) {
        return json(request, env, {error: {message: error.code || 'BEICHEN_BAD_JSON'}}, {status: error.status || 400});
      }
      return withStateLock(() => completeRun(request, env, auth));
    }

    if (request.method === 'POST' && exactPath(url, '/chat/completions')) {
      const auth = await requireSession(request, env);
      if (auth.error) return json(request, env, {error: {message: auth.error}}, {status: auth.error === 'BEICHEN_AUTH_NOT_CONFIGURED' ? 503 : 401});
      if (!allowRate(requestLimits, 'chat:' + clientKey(request) + ':' + auth.payload.sid, 20, 60000)) return json(request, env, {error: {message: 'BEICHEN_RATE_LIMIT'}}, {status: 429});
      const config = providerConfig(env);
      if (!config) return json(request, env, {error: {message: 'BEICHEN_PROVIDER_NOT_CONFIGURED'}}, {status: 503});
      try {
        const body = validateChatBody(await readJson(request));
        return proxyChat(request, env, body, config);
      } catch (error) {
        return json(request, env, {error: {message: error.code || 'BEICHEN_BAD_REQUEST'}}, {status: error.status || 400});
      }
    }

    return text(request, env, 404, 'beichen relay');
  }
};
