'use strict';
// Palavras-passe, sessões, cookies, limitação de tentativas e verificação de origem.
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { db, nowIso } = require('./db');

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 5, keylen: 64 };
const SESSION_DAYS = 14;
const COOKIE_NAME = 'sid';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- Palavras-passe (scrypt) ----------
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

const DUMMY_SALT = crypto.randomBytes(16);

async function verifyPassword(password, stored) {
  // Se o utilizador não existe, gasta o mesmo tempo para não revelar contas.
  if (!stored) {
    await scrypt(password, DUMMY_SALT, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
    return false;
  }
  const [scheme, N, r, p, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p),
  });
  return crypto.timingSafeEqual(actual, expected);
}

// ---------- Sessões (guardadas na base de dados, revogáveis) ----------
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), userId, expires);
  return token;
}

function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

function purgeExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
}

function userFromToken(token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.name, u.email, u.phone, u.role
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha256(token), new Date().toISOString());
  return row || null;
}

// ---------- Cookies ----------
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && !(k in out)) {
      try { out[k] = decodeURIComponent(v); } catch { /* ignora cookie inválido */ }
    }
  }
  return out;
}

const TRUST_PROXY = process.env.TRUST_PROXY === '1';

function isHttps(req) {
  if (process.env.COOKIE_SECURE === '1') return true;
  if (TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https') return true;
  return false;
}

function sessionCookie(req, token) {
  const parts = [`${COOKIE_NAME}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict',
    `Max-Age=${SESSION_DAYS * 86400}`];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

function clearCookie(req) {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

function getToken(req) {
  return parseCookies(req.headers.cookie)[COOKIE_NAME] || null;
}

// ---------- IP do cliente ----------
function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress || 'unknown';
}

// ---------- Limitação de tentativas (em memória) ----------
function createRateLimiter({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, 60_000).unref();
  return function check(key) {
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      const wait = Math.ceil((entry.resetAt - now) / 60000);
      throw new HttpError(429, `Demasiadas tentativas. Tente novamente dentro de ${wait} min.`);
    }
  };
}

// ---------- Proteção contra pedidos de outros sites ----------
function assertSameOrigin(req) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
  const origin = req.headers.origin;
  if (!origin) return;
  let host;
  try { host = new URL(origin).host; } catch { throw new HttpError(403, 'Origem não permitida.'); }
  if (host !== req.headers.host) throw new HttpError(403, 'Origem não permitida.');
}

module.exports = {
  HttpError, hashPassword, verifyPassword,
  createSession, destroySession, purgeExpiredSessions, userFromToken,
  sessionCookie, clearCookie, getToken, clientIp,
  createRateLimiter, assertSameOrigin, nowIso,
};
