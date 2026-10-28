'use strict';
// Servidor HTTP: API em /api e ficheiros da app em /public. Sem dependências externas.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const sec = require('./src/security');
const { handleApi, sendJson } = require('./src/api');
const { seedProducts, ensureStaff } = require('./src/seed');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function securityHeaders(res) {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; " +
    "connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.COOKIE_SECURE === '1' || process.env.TRUST_PROXY === '1') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
}

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new sec.HttpError(405, 'Método não permitido.');
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { throw new sec.HttpError(400, 'Pedido inválido.'); }
  if (rel.includes('\0')) throw new sec.HttpError(400, 'Pedido inválido.');
  if (rel.endsWith('/')) rel += 'index.html';

  const full = path.join(PUBLIC_DIR, path.normalize(rel));
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) throw new sec.HttpError(404, 'Não encontrado.');

  let data;
  try { data = await fs.promises.readFile(full); } catch { throw new sec.HttpError(404, 'Não encontrado.'); }

  const ext = path.extname(full).toLowerCase();
  const noCache = ext === '.html' || path.basename(full) === 'sw.js' || ext === '.webmanifest';
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': noCache ? 'no-cache' : 'public, max-age=3600',
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

function sendError(req, res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  if (res.headersSent) { res.destroy(); return; }
  const message = status >= 500 ? 'Ocorreu um erro. Tente novamente.' : err.message;
  if (req.url && req.url.startsWith('/api/')) {
    sendJson(res, status, { error: message }, status === 413 ? { Connection: 'close' } : {});
  } else {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(message);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    securityHeaders(res);
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await serveStatic(req, res, url);
  } catch (err) {
    sendError(req, res, err instanceof TypeError && err.code === 'ERR_INVALID_URL'
      ? new sec.HttpError(400, 'Pedido inválido.') : err);
  }
});
server.requestTimeout = 60_000;
server.headersTimeout = 15_000;

async function main() {
  seedProducts();
  const staff = await ensureStaff();
  if (staff) {
    console.log('\nConta da farmácia criada:');
    console.log(`  email: ${staff.email}`);
    console.log(staff.password ? `  palavra-passe: ${staff.password}  (guarde-a; não volta a ser mostrada)\n`
      : '  palavra-passe: a definida em STAFF_PASSWORD\n');
  }
  sec.purgeExpiredSessions();
  setInterval(sec.purgeExpiredSessions, 3600_000).unref();

  server.listen(PORT, HOST, () => console.log(`Farmácia a correr em http://localhost:${PORT}`));
}

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

main().catch((err) => { console.error(err); process.exit(1); });
