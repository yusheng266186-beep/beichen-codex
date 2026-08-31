import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const root = new URL('..', import.meta.url);
const rootPath = decodeURIComponent(new URL(root).pathname).replace(/^\/(\w:)/, '$1');
const files = (await readdir(join(rootPath, 'tests')))
  .filter(name => name.endsWith('.test.js'))
  .sort()
  .map(name => join(rootPath, 'tests', name));
if (!files.length) throw new Error('no test files found');
const child = spawn(process.execPath, ['--test', ...files], { stdio: 'inherit' });
child.once('error', error => { throw error; });
child.once('exit', code => { process.exitCode = code ?? 1; });
