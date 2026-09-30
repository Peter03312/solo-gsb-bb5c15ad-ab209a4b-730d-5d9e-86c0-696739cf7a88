import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  openDb,
  getState,
  createArtwork,
  updateArtwork,
  replaceSchedule,
  startSlot,
  finishSlot,
  ConflictError,
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 8080);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'light.db');

const db = openDb(DB_PATH);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) {
      throw new ConflictError(413, { error: '请求体过大' });
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ConflictError(400, { error: '请求体不是合法 JSON' });
  }
}

function withHandler(fn) {
  return async (req, res, params) => {
    try {
      await fn(req, res, params);
    } catch (err) {
      if (err instanceof ConflictError) return sendJson(res, err.status, err.body);
      console.error(err);
      sendJson(res, 500, { error: '服务器内部错误' });
    }
  };
}

async function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  // API
  const mSlot = p.match(/^\/api\/slots\/(\d+)\/(start|finish)$/);
  const mArt = p.match(/^\/api\/artworks\/(\d+)$/);

  if (p === '/api/state' && req.method === 'GET') {
    return sendJson(res, 200, getState(db));
  }
  if (p === '/api/artworks' && req.method === 'POST') {
    return withHandler(async (r, s) => {
      const body = await readBody(r);
      return sendJson(s, 200, createArtwork(db, body.version, body));
    })(req, res);
  }
  if (mArt && req.method === 'PATCH') {
    return withHandler(async (r, s, params) => {
      const body = await readBody(r);
      return sendJson(s, 200, updateArtwork(db, Number(params[1]), body.version, body));
    })(req, res, mArt);
  }
  if (p === '/api/schedule' && req.method === 'PUT') {
    return withHandler(async (r, s) => {
      const body = await readBody(r);
      return sendJson(s, 200, replaceSchedule(db, body.version, body));
    })(req, res);
  }
  if (mSlot && req.method === 'POST') {
    return withHandler(async (r, s, params) => {
      const body = await readBody(r);
      const id = Number(params[1]);
      if (params[2] === 'start') return sendJson(s, 200, startSlot(db, id, body.version));
      return sendJson(s, 200, finishSlot(db, id, body.version, body));
    })(req, res, mSlot);
  }
  if (p.startsWith('/api/')) {
    return sendJson(res, 404, { error: '接口不存在' });
  }

  // 静态页面
  if (req.method === 'GET') return serveStatic(req, res, p);
  sendJson(res, 405, { error: 'method not allowed' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`光照预算工作台已启动: http://localhost:${PORT}`);
  console.log(`数据库: ${DB_PATH}`);
});
