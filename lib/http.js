import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  // The local DSH Web UI embeds ArcVista as a workspace panel. Keep the
  // frame-ancestor allowlist local-only so arbitrary remote pages cannot embed it.
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
};

function localOrigin(origin) {
  return typeof origin === 'string' && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin);
}

export class HttpError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function badRequest(message, code = 'bad_request') {
  return new HttpError(400, message, code);
}

export function notFound(message = '资源不存在') {
  return new HttpError(404, message, 'not_found');
}

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const segments = pattern.split('/').filter(Boolean);
    this.routes.push({ method, segments, handler, pattern });
    return this;
  }

  get(pattern, handler) {
    return this.add('GET', pattern, handler);
  }

  post(pattern, handler) {
    return this.add('POST', pattern, handler);
  }

  put(pattern, handler) {
    return this.add('PUT', pattern, handler);
  }

  delete(pattern, handler) {
    return this.add('DELETE', pattern, handler);
  }

  match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;
      const params = {};
      let matched = true;
      for (let i = 0; i < route.segments.length; i += 1) {
        const segment = route.segments[i];
        if (segment.startsWith(':')) params[segment.slice(1)] = parts[i];
        else if (segment !== parts[i]) {
          matched = false;
          break;
        }
      }
      if (matched) return { handler: route.handler, params };
    }
    return null;
  }
}

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...SECURITY_HEADERS,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function sendText(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    ...SECURITY_HEADERS,
  });
  res.end(body);
}

export function readJsonBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, '请求体过大', 'payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(badRequest('请求体不是合法 JSON', 'invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(req, res, publicDir, pathname) {
  let rel = pathname;
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.resolve(publicDir, `.${rel}`);
  if (!target.startsWith(path.resolve(publicDir) + path.sep) && target !== path.resolve(publicDir)) {
    return sendText(res, 403, 'Forbidden');
  }
  let stat;
  try {
    stat = await fsp.stat(target);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isFile()) {
    const acceptsHtml = String(req.headers.accept || '').includes('text/html');
    const looksLikeFile = /\.[a-z0-9]+$/i.test(pathname);
    if (!looksLikeFile || acceptsHtml) {
      const index = path.join(publicDir, 'index.html');
      if (fs.existsSync(index)) return serveStatic(req, res, publicDir, '/index.html');
    }
    return sendText(res, 404, 'Not Found');
  }
  const ext = path.extname(target).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    ...SECURITY_HEADERS,
    'Cache-Control': ext === '.html' ? 'no-store' : 'no-cache',
  });
  fs.createReadStream(target).pipe(res);
}

export async function handleRequest({ req, res, publicDir, router, logger = console }) {
  const startedAt = Date.now();
  const origin = req.headers.origin;
  if (localOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, SECURITY_HEADERS);
    res.end();
    return;
  }
  let pathname = '/';
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    pathname = url.pathname;
    if (pathname.startsWith('/api/')) {
      const matched = router.match(req.method, pathname);
      if (!matched) return sendJson(res, 404, { error: '接口不存在', code: 'not_found', path: pathname });
      const ctx = { params: matched.params, query: url.searchParams, req, res };
      const result = await matched.handler(ctx);
      if (res.writableEnded) return undefined;
      return sendJson(res, 200, result ?? { ok: true });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method Not Allowed');
    return await serveStatic(req, res, publicDir, pathname);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) logger.error(`[api] ${req.method} ${pathname} ${Date.now() - startedAt}ms`, error);
    if (!res.writableEnded) {
      sendJson(res, status, {
        error: error.message || '服务器内部错误',
        code: error.code || (status === 500 ? 'internal_error' : 'error'),
      });
    }
    return undefined;
  }
}

export function createServer({ publicDir, router, logger = console }) {
  return http.createServer((req, res) => handleRequest({ req, res, publicDir, router, logger }));
}
