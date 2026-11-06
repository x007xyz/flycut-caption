// 一次性静态服务器：支持 Range（视频拖动进度条需要），带 COOP/COEP（JASSUB 的 SharedArrayBuffer 需要）。
// 用法：node serve.mjs [port]，根目录是本实验目录；/media/* 映射到仓库的 tests/media。
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const mediaRoot = fileURLToPath(new URL('../../tests/media/', import.meta.url));
const port = Number(process.argv[2] ?? 4716);
const TYPES = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.otf': 'font/otf', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.wasm': 'application/wasm', '.ass': 'text/plain; charset=utf-8', '.css': 'text/css' };

createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let path = decodeURIComponent(url.pathname);
  if (path === '/') path = '/harness/index.html';
  const file = path.startsWith('/media/') ? join(mediaRoot, normalize(path.slice(7))) : join(root, normalize(path));
  let st;
  try { st = statSync(file); if (st.isDirectory()) throw new Error('dir'); } catch { res.writeHead(404); res.end('not found'); return; }
  const headers = {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-store',
  };
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Number(range[2]) : st.size - 1;
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    createReadStream(file).pipe(res);
  }
}).listen(port, '127.0.0.1', () => console.log(`serving ${root} on http://127.0.0.1:${port}`));
