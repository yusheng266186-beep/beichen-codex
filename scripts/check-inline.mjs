import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const root = new URL('..', import.meta.url);
const html = await readFile(new URL('index.html', root), 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  .map(match => match[1].replace(/^\s*\/\/# sourceURL=.*$/gm, '').trim())
  .filter(Boolean);
if (!scripts.length) throw new Error('index.html has no inline script to check');

const folder = await mkdtemp(join(tmpdir(), 'beichen-inline-'));
const file = join(folder, 'index-inline.js');
await writeFile(file, scripts.join('\n\n'), 'utf8');
try {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--check', file], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`inline script check failed (${code})`)));
  });
} finally {
  await rm(folder, { recursive: true, force: true });
}
console.log(`inline script syntax passed (${scripts.length} block${scripts.length === 1 ? '' : 's'})`);
