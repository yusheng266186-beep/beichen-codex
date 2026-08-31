import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const root = new URL('..', import.meta.url);
const rootPath = decodeURIComponent(new URL(root).pathname).replace(/^\/(\w:)/, '$1');
const dist = join(rootPath, 'dist');
const placeholder = 'https://__RELAY_ORIGIN__';
const rawOrigin = String(process.env.RELAY_ORIGIN || '').trim();
let origin = placeholder;
if (rawOrigin) {
  let parsed;
  try { parsed = new URL(rawOrigin); } catch { throw new Error('RELAY_ORIGIN must be an absolute URL'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error('RELAY_ORIGIN must be an origin without path, query, or credentials');
  }
  origin = parsed.origin;
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
const indexSource = await readFile(join(rootPath, 'index.html'), 'utf8');
const runtimeSource = await readFile(join(rootPath, 'runtime-config.js'), 'utf8');
if (indexSource.includes(placeholder) !== runtimeSource.includes(placeholder)) throw new Error('CSP/runtime relay placeholders are out of sync');
const index = indexSource.replaceAll(placeholder, origin);
const runtime = runtimeSource.replaceAll(placeholder, origin);
await writeFile(join(dist, 'index.html'), index, 'utf8');
await writeFile(join(dist, 'runtime-config.js'), runtime, 'utf8');
await cp(join(rootPath, 'fonts'), join(dist, 'fonts'), { recursive: true });
await cp(join(rootPath, 'vendor'), join(dist, 'vendor'), { recursive: true });
await writeFile(join(dist, '.nojekyll'), '', 'utf8');
/* A static 404 keeps GitHub Pages from exposing source directories while
   preserving the same usable entry point for deep links. */
await writeFile(join(dist, '404.html'), index, 'utf8');
await writeFile(join(dist, 'build-manifest.json'), JSON.stringify({
  appVersion: 'v3.0.0-codex',
  gitSha: process.env.GITHUB_SHA || 'local',
  relayOrigin: origin === placeholder ? 'UNCONFIGURED' : origin,
  source: 'beichen-codex'
}, null, 2) + '\n', 'utf8');
console.log(`Pages artifact ready: ${dist} (relay ${origin === placeholder ? 'placeholder' : origin})`);
