#!/usr/bin/env node
/**
 * 静态服务器 —— 只服务 web/ 目录，给浏览器打开用。
 * 用法: node serve.js [端口]
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const ROOT = process.cwd();
const PORT = Number(process.argv[2] || 8123);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ktx2': 'image/ktx2',
  '.wasm': 'application/wasm',
};

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    // 防目录穿越
    const full = normalize(join(ROOT, p));
    if (!full.startsWith(ROOT + sep) && full !== ROOT) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const st = await stat(full);
    if (st.isDirectory()) { res.writeHead(404).end('not found'); return; }
    const buf = await readFile(full);
    res.writeHead(200, {
      'Content-Type': MIME[extname(full).toLowerCase()] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 ' + req.url);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[serve] http://127.0.0.1:${PORT}/`);
});
