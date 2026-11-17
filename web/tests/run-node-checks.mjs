/**
 * 纯 Node 自检总入口（2026-11-17 新增）
 *
 * 把 web/tests/ 下不需要浏览器的自检一次性跑完，避免「改了代码不知道该跑哪几个」。
 * 需要 8140 临时服务的浏览器验收不在这里自动跑——项目约定服务不常驻，
 * 要看画面时自己起服务再单独跑（见 tools/README.md）。
 *
 * 用法：cd web && node tests/run-node-checks.mjs
 *      cd web && npm test
 *
 * 判定方式：以子进程退出码为准，同时抓取输出里的「N/N 通过」与 FAIL 字样。
 * 不修改任何文件，不启动服务，不写入 out/。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const BROWSER_HINT = /puppeteer|127\.0\.0\.1|localhost/;

const files = readdirSync(HERE)
  .filter((f) => f.endsWith('.mjs') && f !== basename(fileURLToPath(import.meta.url)))
  .map((f) => join(HERE, f))
  .filter((f) => !BROWSER_HINT.test(readFileSync(f, 'utf8')))
  .sort();

console.log(`纯 Node 自检：共 ${files.length} 个（浏览器验收需自行起 8140 服务）\n`);
const rows = [];
for (const f of files) {
  const name = basename(f);
  const r = spawnSync(process.execPath, [f], { cwd: join(HERE, '..'), encoding: 'utf8', timeout: 180000 });
  const text = (r.stdout || '') + (r.stderr || '');
  const tally = text.match(/(\d+)\s*\/\s*(\d+)\s*通过/);
  const fails = (text.match(/^FAIL\b/gm) || []).length;
  const ok = r.status === 0 && fails === 0;
  rows.push({ name, ok, status: r.status, fails, tally: tally ? `${tally[1]}/${tally[2]}` : '—' });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(38)} 退出码=${r.status}  断言=${tally ? `${tally[1]}/${tally[2]}` : '—'}${fails ? `  FAIL行=${fails}` : ''}`);
  if (!ok) {
    const tail = text.trim().split('\n').slice(-8).join('\n');
    console.log('       ' + tail.replace(/\n/g, '\n       '));
  }
}
const bad = rows.filter((r) => !r.ok);
console.log(`\n${rows.length - bad.length}/${rows.length} 个自检通过`);
if (bad.length) {
  console.log('未通过：' + bad.map((r) => r.name).join('、'));
  process.exit(1);
}
