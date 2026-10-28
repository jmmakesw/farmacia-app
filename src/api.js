'use strict';
// Rotas da API: autenticação, produtos e pedidos.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { db, tx, nowIso, UPLOAD_DIR } = require('./db');
const sec = require('./security');
const { readBody, parseMultipart } = require('./multipart');

const { HttpError } = sec;

const MAX_JSON_BYTES = 50_000;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[\d\s]{9,16}$/;

const loginLimiter = sec.createRateLimiter({
  windowMs: 15 * 60_000, max: Number(process.env.LOGIN_RATE_MAX) || 10,
});
const registerLimiter = sec.createRateLimiter({
  windowMs: 60 * 60_000, max: Number(process.env.REGISTER_RATE_MAX) || 10,
});

// ---------- Utilitários ----------
const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, handler });
}

function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

async function readJson(ctx) {
  const type = String(ctx.req.headers['content-type'] || '');
  if (!type.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Pedido inválido.');
  const buf = await readBody(ctx.req, MAX_JSON_BYTES);
  try {
    const data = JSON.parse(buf.toString('utf8'));
    if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('forma');
    return data;
  } catch {
    throw new HttpError(400, 'Pedido inválido.');
  }
}

function currentUser(ctx) {
  if (ctx.user === undefined) ctx.user = sec.userFromToken(sec.getToken(ctx.req));
  return ctx.user;
}
function requireUser(ctx) {
  const user = currentUser(ctx);
  if (!user) throw new HttpError(401, 'Inicie sessão para continuar.');
  return user;
}
function requireStaff(ctx) {
  const user = requireUser(ctx);
  if (user.role !== 'staff') throw new HttpError(403, 'Sem permissão para esta ação.');
  return user;
}

const normalize = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Deteta o tipo real do ficheiro pelos primeiros bytes (não confia no nome nem no tipo declarado).
function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  if (buf.toString('latin1', 0, 5) === '%PDF-') return { mime: 'application/pdf', ext: 'pdf' };
  return null;
}

// ---------- Autenticação ----------
route('POST', '/api/auth/register', async (ctx) => {
  registerLimiter(sec.clientIp(ctx.req));
  const b = await readJson(ctx);
  const name = clean(b.name, 80);
  const email = clean(b.email, 120).toLowerCase();
  const phone = clean(b.phone, 20);
  const password = typeof b.password === 'string' ? b.password : '';

  if (name.length < 2) throw new HttpError(400, 'Indique o seu nome.');
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Indique um email válido.');
  if (phone && !PHONE_RE.test(phone)) throw new HttpError(400, 'Indique um telemóvel válido.');
  if (password.length < 8 || password.length > 128) {
    throw new HttpError(400, 'A palavra-passe deve ter entre 8 e 128 caracteres.');
  }
  if (b.consent !== true) {
    throw new HttpError(400, 'É necessário aceitar o tratamento dos dados para criar conta.');
  }

  const hash = await sec.hashPassword(password);
  let userId;
  try {
    const r = db.prepare(
      'INSERT INTO users (name, email, phone, password_hash, consent_at) VALUES (?, ?, ?, ?, ?)',
    ).run(name, email, phone || null, hash, nowIso());
    userId = Number(r.lastInsertRowid);
  } catch (err) {
    if (/UNIQUE/i.test(String(err.message))) throw new HttpError(409, 'Já existe uma conta com este email.');
    throw err;
  }
  const token = sec.createSession(userId);
  sendJson(ctx.res, 201, { user: { id: userId, name, email, phone: phone || null, role: 'customer' } },
    { 'Set-Cookie': sec.sessionCookie(ctx.req, token) });
});

route('POST', '/api/auth/login', async (ctx) => {
  loginLimiter(sec.clientIp(ctx.req));
  const b = await readJson(ctx);
  const email = clean(b.email, 120).toLowerCase();
  const password = typeof b.password === 'string' ? b.password.slice(0, 128) : '';
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const ok = await sec.verifyPassword(password, row && row.password_hash);
  if (!row || !ok) throw new HttpError(401, 'Email ou palavra-passe incorretos.');
  const token = sec.createSession(row.id);
  sendJson(ctx.res, 200, {
    user: { id: row.id, name: row.name, email: row.email, phone: row.phone, role: row.role },
  }, { 'Set-Cookie': sec.sessionCookie(ctx.req, token) });
});

route('POST', '/api/auth/logout', async (ctx) => {
  sec.destroySession(sec.getToken(ctx.req));
  sendJson(ctx.res, 200, { ok: true }, { 'Set-Cookie': sec.clearCookie(ctx.req) });
});

route('GET', '/api/auth/me', async (ctx) => {
  sendJson(ctx.res, 200, { user: currentUser(ctx) });
});

// ---------- Produtos ----------
route('GET', '/api/products', async (ctx) => {
  const q = normalize(ctx.url.searchParams.get('q') || '').trim();
  const type = ctx.url.searchParams.get('type');
  const category = ctx.url.searchParams.get('category');

  const all = db.prepare(`SELECT id, name, description, pack, category, icon, price_cents, requires_prescription
    FROM products WHERE active = 1 ORDER BY requires_prescription, category, name`).all();

  const byType = all.filter((p) => !(type === 'rx' && !p.requires_prescription)
    && !(type === 'otc' && p.requires_prescription));
  const categories = [...new Set(byType.map((p) => p.category))];
  const products = byType.filter((p) => {
    if (category && p.category !== category) return false;
    if (q && !normalize(`${p.name} ${p.description} ${p.category}`).includes(q)) return false;
    return true;
  }).map((p) => ({ ...p, requires_prescription: !!p.requires_prescription }));

  sendJson(ctx.res, 200, { products, categories });
});

// ---------- Pedidos ----------
const ORDER_SELECT = `
  SELECT o.id, o.status, o.notes, o.created_at, o.updated_at, o.user_id,
    u.name AS customer_name, u.phone AS customer_phone, u.email AS customer_email,
    (SELECT COALESCE(SUM(quantity * price_cents), 0) FROM order_items WHERE order_id = o.id) AS total_cents,
    (SELECT COALESCE(SUM(quantity), 0) FROM order_items WHERE order_id = o.id) AS item_count,
    EXISTS (SELECT 1 FROM prescriptions WHERE order_id = o.id) AS has_prescription
  FROM orders o JOIN users u ON u.id = o.user_id`;

function mapOrder(r, staff) {
  const o = {
    id: r.id, status: r.status, notes: r.notes, created_at: r.created_at, updated_at: r.updated_at,
    total_cents: r.total_cents, item_count: r.item_count, has_prescription: !!r.has_prescription,
  };
  if (staff) o.customer = { name: r.customer_name, phone: r.customer_phone, email: r.customer_email };
  return o;
}

route('POST', '/api/orders', async (ctx) => {
  const user = requireUser(ctx);
  const type = String(ctx.req.headers['content-type'] || '');
  if (!/^multipart\/form-data/i.test(type)) throw new HttpError(415, 'Pedido inválido.');
  const raw = await readBody(ctx.req, MAX_UPLOAD_BYTES + 200_000);
  const { fields, file } = parseMultipart(raw, type);

  // Artigos
  let parsed;
  try { parsed = JSON.parse(fields.items || ''); } catch { parsed = null; }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 30) {
    throw new HttpError(400, 'O pedido está vazio.');
  }
  const wanted = new Map();
  for (const it of parsed) {
    const pid = Number(it && it.product_id);
    const qty = Number(it && it.quantity);
    if (!Number.isInteger(pid) || pid < 1 || !Number.isInteger(qty) || qty < 1 || qty > 20) {
      throw new HttpError(400, 'Artigo ou quantidade inválidos.');
    }
    wanted.set(pid, Math.min(20, (wanted.get(pid) || 0) + qty));
  }
  const lookup = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1');
  const lines = [];
  for (const [pid, qty] of wanted) {
    const p = lookup.get(pid);
    if (!p) throw new HttpError(400, 'Um dos produtos já não está disponível. Atualize o seu pedido.');
    lines.push({ product: p, qty });
  }
  const needsRx = lines.some((l) => l.product.requires_prescription === 1);
  const notes = clean(fields.notes, 500);

  // Receita
  let rx = null;
  let savedFile = null;
  if (needsRx) {
    const kind = fields.rx_kind;
    if (kind === 'numero') {
      const number = String(fields.rx_number || '').replace(/[\s-]/g, '');
      const access = String(fields.rx_access_code || '').replace(/[\s-]/g, '');
      const option = String(fields.rx_option_code || '').replace(/[\s-]/g, '');
      if (!/^\d{10,25}$/.test(number)) throw new HttpError(400, 'Indique o número da receita (apenas dígitos).');
      if (!/^\d{4,8}$/.test(access)) throw new HttpError(400, 'Indique o código de acesso e dispensa da receita.');
      if (option && !/^\d{3,4}$/.test(option)) throw new HttpError(400, 'O código de direito de opção é inválido.');
      rx = { kind: 'numero', number, access, option: option || null };
    } else if (kind === 'foto') {
      if (!file) throw new HttpError(400, 'Anexe a fotografia ou o PDF da receita.');
      const info = sniff(file.data);
      if (!info) throw new HttpError(400, 'Formato não suportado. Use JPG, PNG, WebP ou PDF.');
      rx = { kind: 'foto', mime: info.mime, ext: info.ext, data: file.data };
    } else {
      throw new HttpError(400, 'Indique como pretende enviar a receita.');
    }
  }

  if (rx && rx.kind === 'foto') {
    savedFile = `${crypto.randomBytes(16).toString('hex')}.${rx.ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, savedFile), rx.data, { mode: 0o600, flag: 'wx' });
  }

  let orderId;
  try {
    orderId = tx(() => {
      const r = db.prepare('INSERT INTO orders (user_id, notes) VALUES (?, ?)').run(user.id, notes);
      const id = Number(r.lastInsertRowid);
      const addItem = db.prepare(
        'INSERT INTO order_items (order_id, product_id, name, quantity, price_cents) VALUES (?, ?, ?, ?, ?)');
      for (const l of lines) addItem.run(id, l.product.id, l.product.name, l.qty, l.product.price_cents);
      if (rx) {
        db.prepare(`INSERT INTO prescriptions
          (order_id, kind, rx_number, access_code, option_code, file_name, file_mime)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          id, rx.kind, rx.number || null, rx.access || null, rx.option || null,
          savedFile, rx.mime || null);
      }
      return id;
    });
  } catch (err) {
    if (savedFile) fs.rmSync(path.join(UPLOAD_DIR, savedFile), { force: true });
    throw err;
  }
  sendJson(ctx.res, 201, { id: orderId });
});

route('GET', '/api/orders', async (ctx) => {
  const user = requireUser(ctx);
  const staff = user.role === 'staff';
  const where = [];
  const params = [];
  let order = 'o.id DESC';

  if (!staff) {
    where.push('o.user_id = ?');
    params.push(user.id);
  } else {
    const status = ctx.url.searchParams.get('status') || 'active';
    if (status === 'active') {
      where.push("o.status IN ('novo','em_preparacao','pronto')");
      order = 'o.id ASC';
    } else if (status === 'done') {
      where.push("o.status IN ('levantado','cancelado')");
    } else if (status !== 'all') {
      where.push('o.status = ?');
      params.push(status);
    }
  }
  const sql = `${ORDER_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT 200`;
  const rows = db.prepare(sql).all(...params);
  sendJson(ctx.res, 200, { orders: rows.map((r) => mapOrder(r, staff)) });
});

function loadOrderFor(ctx, id) {
  const user = requireUser(ctx);
  const row = db.prepare(`${ORDER_SELECT} WHERE o.id = ?`).get(id);
  // Para clientes, pedidos de outras pessoas aparecem como inexistentes.
  if (!row || (user.role !== 'staff' && row.user_id !== user.id)) throw new HttpError(404, 'Pedido não encontrado.');
  return { user, row };
}

route('GET', '/api/orders/:id', async (ctx) => {
  const { user, row } = loadOrderFor(ctx, Number(ctx.params.id));
  const staff = user.role === 'staff';
  const items = db.prepare(
    'SELECT product_id, name, quantity, price_cents FROM order_items WHERE order_id = ? ORDER BY id').all(row.id);
  const rx = db.prepare('SELECT kind, rx_number, access_code, option_code, file_mime FROM prescriptions WHERE order_id = ?')
    .get(row.id);
  sendJson(ctx.res, 200, {
    order: mapOrder(row, staff),
    items,
    prescription: rx ? {
      kind: rx.kind, number: rx.rx_number, access_code: rx.access_code, option_code: rx.option_code,
      file_mime: rx.file_mime,
    } : null,
  });
});

const FLOW = {
  novo: ['em_preparacao', 'cancelado'],
  em_preparacao: ['pronto', 'cancelado'],
  pronto: ['levantado', 'cancelado'],
  levantado: [],
  cancelado: [],
};

route('PATCH', '/api/orders/:id/status', async (ctx) => {
  const { user, row } = loadOrderFor(ctx, Number(ctx.params.id));
  const b = await readJson(ctx);
  const next = String(b.status || '');
  if (!(next in FLOW)) throw new HttpError(400, 'Estado inválido.');
  if (user.role === 'staff') {
    if (!FLOW[row.status].includes(next)) throw new HttpError(409, 'Esta alteração de estado não é possível.');
  } else if (!(row.status === 'novo' && next === 'cancelado')) {
    throw new HttpError(403, 'Só pode cancelar pedidos que ainda não começaram a ser preparados.');
  }
  db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(next, nowIso(), row.id);
  sendJson(ctx.res, 200, { ok: true, status: next });
});

route('GET', '/api/orders/:id/prescription/file', async (ctx) => {
  const { row } = loadOrderFor(ctx, Number(ctx.params.id));
  const rx = db.prepare('SELECT file_name, file_mime FROM prescriptions WHERE order_id = ?').get(row.id);
  if (!rx || !rx.file_name) throw new HttpError(404, 'Ficheiro não encontrado.');
  const full = path.join(UPLOAD_DIR, path.basename(rx.file_name));
  let stat;
  try { stat = fs.statSync(full); } catch { throw new HttpError(404, 'Ficheiro não encontrado.'); }
  ctx.res.writeHead(200, {
    'Content-Type': rx.file_mime,
    'Content-Length': stat.size,
    'Content-Disposition': 'inline',
    'Cache-Control': 'private, no-store',
  });
  fs.createReadStream(full).pipe(ctx.res);
});

route('GET', '/api/health', async (ctx) => {
  sendJson(ctx.res, 200, { ok: true });
});

// ---------- Entrada ----------
async function handleApi(req, res, url) {
  sec.assertSameOrigin(req);
  const ctx = { req, res, url, params: {}, user: undefined };
  let pathMatched = false;
  for (const r of routes) {
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== req.method) continue;
    r.keys.forEach((k, i) => { ctx.params[k] = decodeURIComponent(m[i + 1]); });
    await r.handler(ctx);
    return;
  }
  throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'Método não permitido.' : 'Não encontrado.');
}

module.exports = { handleApi, sendJson };
