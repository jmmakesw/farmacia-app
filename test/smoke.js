'use strict';
// Testes ponta a ponta: arranca o servidor numa base de dados temporária e percorre os fluxos principais.
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'farmacia-test-'));
const STAFF = { email: 'staff@teste.pt', password: 'staff-pass-123' };

// PNG 1x1 válido
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, { json, form, headers = {}, raw } = {}) {
    const opt = { method, headers: { ...headers }, redirect: 'manual' };
    if (this.cookie) opt.headers.Cookie = this.cookie;
    if (json !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(json); }
    if (form) opt.body = form;
    if (raw) { opt.body = raw.body; opt.headers['Content-Type'] = raw.type; }
    const res = await fetch(BASE + url, opt);
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of set) {
      const pair = c.split(';')[0];
      this.cookie = pair.endsWith('=') ? '' : pair;
    }
    const type = res.headers.get('content-type') || '';
    const body = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, body, headers: res.headers, setCookie: set };
  }
}

function orderForm(items, extra = {}, file) {
  const fd = new FormData();
  fd.append('items', JSON.stringify(items));
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  if (file) fd.append('file', new Blob([file.data], { type: file.type || 'application/octet-stream' }), file.name || 'receita');
  return fd;
}

const results = [];
async function test(name, fn) {
  try { await fn(); results.push([true, name]); console.log(`  ✓ ${name}`); }
  catch (err) { results.push([false, name]); console.log(`  ✗ ${name}\n      ${err.message.split('\n')[0]}`); }
}

async function waitForServer(child) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('O servidor terminou ao arrancar.');
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return; } catch { /* ainda a arrancar */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('O servidor não arrancou a tempo.');
}

(async () => {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env, PORT: String(PORT), DATA_DIR, HOST: '127.0.0.1',
      STAFF_EMAIL: STAFF.email, STAFF_PASSWORD: STAFF.password, LOGIN_RATE_MAX: '1000', REGISTER_RATE_MAX: '1000',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  child.stdout.on('data', () => {});

  try {
    await waitForServer(child);
    console.log('\nTestes da app da farmácia\n');

    const ana = new Client();
    const rui = new Client();
    const staff = new Client();
    let otcId; let rxId;

    console.log('Ficheiros da app');
    await test('página inicial e ficheiros PWA são servidos', async () => {
      const c = new Client();
      const home = await c.req('GET', '/');
      assert.equal(home.status, 200);
      assert.match(home.headers.get('content-type'), /text\/html/);
      assert.ok(home.headers.get('content-security-policy'));
      for (const f of ['/manifest.webmanifest', '/sw.js', '/app.js', '/styles.css', '/icons/icon-192.png',
        '/icons/icon-512.png', '/icons/apple-touch-icon.png']) {
        assert.equal((await c.req('GET', f)).status, 200, f);
      }
      const manifest = (await c.req('GET', '/manifest.webmanifest')).body; // já vem lido como JSON
      assert.equal(manifest.display, 'standalone');
      assert.ok(manifest.icons.length >= 3);
    });
    await test('não permite sair da pasta pública', async () => {
      const c = new Client();
      for (const p of ['/..%2fserver.js', '/%2e%2e/server.js', '/..%2fsrc%2fdb.js', '/%00']) {
        const r = await c.req('GET', p);
        assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
      }
    });

    console.log('Contas e sessões');
    await test('registo valida os dados', async () => {
      const base = { name: 'Ana Silva', email: 'ana@teste.pt', phone: '912345678', password: 'segredo-123', consent: true };
      assert.equal((await ana.req('POST', '/api/auth/register', { json: { ...base, consent: false } })).status, 400);
      assert.equal((await ana.req('POST', '/api/auth/register', { json: { ...base, password: '123' } })).status, 400);
      assert.equal((await ana.req('POST', '/api/auth/register', { json: { ...base, email: 'invalido' } })).status, 400);
      assert.equal((await ana.req('POST', '/api/auth/register', { json: { ...base, name: 'A' } })).status, 400);
    });
    await test('registo cria conta e sessão segura', async () => {
      const r = await ana.req('POST', '/api/auth/register', {
        json: { name: 'Ana Silva', email: 'ANA@teste.pt', phone: '912345678', password: 'segredo-123', consent: true } });
      assert.equal(r.status, 201);
      assert.equal(r.body.user.role, 'customer');
      assert.equal(r.body.user.email, 'ana@teste.pt');
      assert.ok(!('password_hash' in r.body.user));
      assert.match(r.setCookie[0], /HttpOnly/);
      assert.match(r.setCookie[0], /SameSite=Strict/);
    });
    await test('email repetido é recusado', async () => {
      const r = await new Client().req('POST', '/api/auth/register', {
        json: { name: 'Outra Ana', email: 'ana@teste.pt', password: 'segredo-123', consent: true } });
      assert.equal(r.status, 409);
    });
    await test('/me devolve o utilizador e termina sessão', async () => {
      assert.equal((await ana.req('GET', '/api/auth/me')).body.user.name, 'Ana Silva');
      const old = ana.cookie;
      await ana.req('POST', '/api/auth/logout', { json: {} });
      assert.equal((await ana.req('GET', '/api/auth/me')).body.user, null);
      const replay = new Client(); replay.cookie = old; // a sessão antiga deixa de funcionar
      assert.equal((await replay.req('GET', '/api/auth/me')).body.user, null);
    });
    await test('login recusa credenciais erradas e aceita as certas', async () => {
      assert.equal((await ana.req('POST', '/api/auth/login', { json: { email: 'ana@teste.pt', password: 'errada-123' } })).status, 401);
      assert.equal((await ana.req('POST', '/api/auth/login', { json: { email: 'nao@existe.pt', password: 'errada-123' } })).status, 401);
      assert.equal((await ana.req('POST', '/api/auth/login', { json: { email: 'ana@teste.pt', password: 'segredo-123' } })).status, 200);
    });
    await test('pedidos de outro site (Origin) são bloqueados', async () => {
      const r = await new Client().req('POST', '/api/auth/login', {
        json: { email: 'ana@teste.pt', password: 'segredo-123' }, headers: { Origin: 'https://site-mau.example' } });
      assert.equal(r.status, 403);
    });
    await rui.req('POST', '/api/auth/register', {
      json: { name: 'Rui Costa', email: 'rui@teste.pt', password: 'segredo-456', consent: true } });
    await staff.req('POST', '/api/auth/login', { json: STAFF });

    console.log('Montra');
    await test('lista produtos sem login e filtra', async () => {
      const all = (await ana.req('GET', '/api/products')).body;
      assert.ok(all.products.length >= 20);
      assert.ok(all.categories.length >= 5);
      otcId = all.products.find((p) => !p.requires_prescription).id;
      rxId = all.products.find((p) => p.requires_prescription).id;
      const anon = await new Client().req('GET', '/api/products?q=paracetamol');
      assert.equal(anon.status, 200);
      assert.ok(anon.body.products.some((p) => /paracetamol/i.test(p.name)));
      assert.ok((await ana.req('GET', '/api/products?q=acido')).body.products.some((p) => /Antiácido/.test(p.name)));
      assert.ok((await ana.req('GET', '/api/products?type=rx')).body.products.every((p) => p.requires_prescription));
      assert.ok((await ana.req('GET', '/api/products?type=otc')).body.products.every((p) => !p.requires_prescription));
    });

    console.log('Pedidos');
    let otcOrder;
    await test('pedido exige login', async () => {
      const r = await new Client().req('POST', '/api/orders', { form: orderForm([{ product_id: otcId, quantity: 1 }]) });
      assert.equal(r.status, 401);
    });
    await test('pedido de venda livre não pede receita e usa preços do servidor', async () => {
      const r = await ana.req('POST', '/api/orders', {
        form: orderForm([{ product_id: otcId, quantity: 2 }, { product_id: otcId, quantity: 1 }], { notes: 'Levanto à tarde', price_cents: '1' }) });
      assert.equal(r.status, 201);
      otcOrder = r.body.id;
      const d = (await ana.req('GET', `/api/orders/${otcOrder}`)).body;
      assert.equal(d.items.length, 1);
      assert.equal(d.items[0].quantity, 3);
      const price = (await ana.req('GET', '/api/products')).body.products.find((p) => p.id === otcId).price_cents;
      assert.equal(d.order.total_cents, price * 3);
      assert.equal(d.order.status, 'novo');
      assert.equal(d.prescription, null);
    });
    await test('pedidos inválidos são recusados', async () => {
      for (const items of [[], [{ product_id: otcId, quantity: 0 }], [{ product_id: otcId, quantity: 21 }],
        [{ product_id: 99999, quantity: 1 }], [{ product_id: 'x', quantity: 1 }]]) {
        assert.equal((await ana.req('POST', '/api/orders', { form: orderForm(items) })).status, 400);
      }
    });
    await test('medicamento com receita exige receita válida', async () => {
      const item = [{ product_id: rxId, quantity: 1 }];
      assert.equal((await ana.req('POST', '/api/orders', { form: orderForm(item) })).status, 400);
      assert.equal((await ana.req('POST', '/api/orders', { form: orderForm(item, { rx_kind: 'numero', rx_number: '123', rx_access_code: '123456' }) })).status, 400);
      assert.equal((await ana.req('POST', '/api/orders', { form: orderForm(item, { rx_kind: 'numero', rx_number: '1234567890123456789' }) })).status, 400);
      assert.equal((await ana.req('POST', '/api/orders', { form: orderForm(item, { rx_kind: 'foto' }) })).status, 400);
    });
    let rxNumOrder; let rxPhotoOrder;
    await test('receita por número é guardada', async () => {
      const r = await ana.req('POST', '/api/orders', {
        form: orderForm([{ product_id: rxId, quantity: 1 }, { product_id: otcId, quantity: 1 }],
          { rx_kind: 'numero', rx_number: '1234 5678 9012 3456 789', rx_access_code: '123456', rx_option_code: '1234' }) });
      assert.equal(r.status, 201);
      rxNumOrder = r.body.id;
      const d = (await ana.req('GET', `/api/orders/${rxNumOrder}`)).body;
      assert.equal(d.prescription.kind, 'numero');
      assert.equal(d.prescription.number, '1234567890123456789');
      assert.equal(d.prescription.access_code, '123456');
    });
    await test('receita por foto: guarda, valida o formato e protege o ficheiro', async () => {
      const item = [{ product_id: rxId, quantity: 1 }];
      const bad = await ana.req('POST', '/api/orders', {
        form: orderForm(item, { rx_kind: 'foto' }, { data: Buffer.from('isto não é uma imagem, é texto'), type: 'image/png', name: 'x.png' }) });
      assert.equal(bad.status, 400);
      const r = await ana.req('POST', '/api/orders', {
        form: orderForm(item, { rx_kind: 'foto' }, { data: PNG, type: 'image/png', name: 'receita.png' }) });
      assert.equal(r.status, 201);
      rxPhotoOrder = r.body.id;
      const url = `/api/orders/${rxPhotoOrder}/prescription/file`;
      const own = await ana.req('GET', url);
      assert.equal(own.status, 200);
      assert.equal(own.headers.get('content-type'), 'image/png');
      assert.ok(own.body.equals(PNG));
      assert.equal((await staff.req('GET', url)).status, 200);
      assert.equal((await rui.req('GET', url)).status, 404);
      assert.equal((await new Client().req('GET', url)).status, 401);
      const files = fs.readdirSync(path.join(DATA_DIR, 'uploads'));
      assert.equal(files.length, 1);
      assert.match(files[0], /^[0-9a-f]{32}\.png$/);
    });
    await test('ficheiro demasiado grande é recusado', async () => {
      const big = Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024)]);
      const r = await ana.req('POST', '/api/orders', {
        form: orderForm([{ product_id: rxId, quantity: 1 }], { rx_kind: 'foto' }, { data: big, type: 'image/png', name: 'g.png' }) });
      assert.equal(r.status, 413);
    });

    console.log('Privacidade e permissões');
    await test('cada cliente só vê os seus pedidos', async () => {
      const mine = (await ana.req('GET', '/api/orders')).body.orders;
      assert.ok(mine.length >= 3);
      assert.equal((await rui.req('GET', '/api/orders')).body.orders.length, 0);
      assert.equal((await rui.req('GET', `/api/orders/${otcOrder}`)).status, 404);
      assert.equal((await rui.req('PATCH', `/api/orders/${otcOrder}/status`, { json: { status: 'cancelado' } })).status, 404);
    });
    await test('painel só para a farmácia', async () => {
      assert.ok(!('customer' in (await ana.req('GET', '/api/orders')).body.orders[0]));
      const list = (await staff.req('GET', '/api/orders?status=active')).body.orders;
      assert.ok(list.length >= 3);
      assert.ok(list.every((o) => o.customer && o.customer.name));
      assert.equal((await staff.req('GET', '/api/orders?status=active')).body.orders[0].id, Math.min(...list.map((o) => o.id)));
    });

    console.log('Estados do pedido');
    await test('farmácia avança o pedido e não salta etapas', async () => {
      const set = (c, id, status) => c.req('PATCH', `/api/orders/${id}/status`, { json: { status } });
      assert.equal((await set(staff, rxNumOrder, 'levantado')).status, 409);
      assert.equal((await set(staff, rxNumOrder, 'em_preparacao')).status, 200);
      assert.equal((await set(staff, rxNumOrder, 'pronto')).status, 200);
      assert.equal((await ana.req('GET', `/api/orders/${rxNumOrder}`)).body.order.status, 'pronto');
      assert.equal((await set(staff, rxNumOrder, 'levantado')).status, 200);
      assert.equal((await set(staff, rxNumOrder, 'cancelado')).status, 409);
      assert.equal((await set(staff, rxNumOrder, 'invalido')).status, 400);
      const done = (await staff.req('GET', '/api/orders?status=done')).body.orders;
      assert.ok(done.some((o) => o.id === rxNumOrder));
    });
    await test('cliente só cancela enquanto o pedido é novo', async () => {
      const set = (c, id, status) => c.req('PATCH', `/api/orders/${id}/status`, { json: { status } });
      assert.equal((await set(ana, rxPhotoOrder, 'pronto')).status, 403);
      assert.equal((await set(staff, otcOrder, 'em_preparacao')).status, 200);
      assert.equal((await set(ana, otcOrder, 'cancelado')).status, 403);
      assert.equal((await set(ana, rxPhotoOrder, 'cancelado')).status, 200);
      assert.equal((await ana.req('GET', `/api/orders/${rxPhotoOrder}`)).body.order.status, 'cancelado');
    });
  } catch (err) {
    console.error('Erro nos testes:', err);
    results.push([false, 'preparação']);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  const failed = results.filter(([ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} testes passaram.`);
  process.exit(failed ? 1 : 0);
})();
