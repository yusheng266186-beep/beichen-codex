import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url);
const rootPath = decodeURIComponent(new URL(root).pathname).replace(/^\/(\w:)/, '$1');
const ignoredDirs = new Set(['.git', 'node_modules', 'dist']);
const suspicious = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bAKID[a-z0-9]{12,}\b/i,
  /\bsk-[a-z0-9]{20,}\b/i,
  /https?:\/\/\d{6,}-[a-z0-9]+\.ap-[a-z0-9-]+\.tencentscf\.com/i
];
const secretAssignments = /\b(QIANFAN_API_KEY|GATE_TOTP_SECRET|GATE_SESSION_SECRET)[ \t]*=[ \t]*([^\r\n]*)/gim;
const safeAssignment = /^(?:$|<[^>]*>$|your(?:[-_ ]|$)|你的|动态验证码使用|随机生成|至少|test[-_]|placeholder|process\.env\.)/i;
const hits = [];

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) await walk(join(dir, entry.name));
      continue;
    }
    const file = join(dir, entry.name);
    let data;
    try { data = await readFile(file); } catch { continue; }
    if (data.includes(0)) continue;
    const text = data.toString('utf8');
    for (const pattern of suspicious) {
      if (pattern.test(text)) {
        hits.push(`${relative(rootPath, file)} :: ${pattern}`);
        break;
      }
    }
    const extension = entry.name.toLowerCase().includes('.') ? entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase() : '';
    const relativeFile = relative(rootPath, file).replaceAll('\\', '/');
    if (!relativeFile.startsWith('tests/') && !['.md', '.markdown', '.txt'].includes(extension) && secretAssignments.test(text)) {
      secretAssignments.lastIndex = 0;
      let match;
      while ((match = secretAssignments.exec(text))) {
        const value = match[2].trim().replace(/^['"]|['"]$/g, '');
        if (value && !safeAssignment.test(value)) {
          hits.push(`${relative(rootPath, file)} :: ${match[1]} has a non-placeholder value`);
          break;
        }
      }
      secretAssignments.lastIndex = 0;
    }
  }
}

await walk(rootPath);
if (hits.length) {
  console.error('secret scan failed:');
  for (const hit of hits) console.error('  ' + hit);
  process.exitCode = 1;
} else {
  console.log('secret scan passed');
}
