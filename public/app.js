'use strict';
(() => {
  // ====================================================================
  //  Configuração
  // ====================================================================
  const PHARMACY = 'Farmácia';
  const MAX_UPLOAD = 8 * 1024 * 1024;
  const POLL_MS = 30_000;

  const STATUS = {
    novo: { label: 'Recebido', staffLabel: 'Novo', tone: 'info' },
    em_preparacao: { label: 'Em preparação', staffLabel: 'Em preparação', tone: 'warn' },
    pronto: { label: 'Pronto para levantar', staffLabel: 'Pronto', tone: 'ok' },
    levantado: { label: 'Levantado', staffLabel: 'Levantado', tone: 'muted' },
    cancelado: { label: 'Cancelado', staffLabel: 'Cancelado', tone: 'bad' },
  };
  const STEPS = ['novo', 'em_preparacao', 'pronto', 'levantado'];
  const STAFF_ACTIONS = {
    novo: [['em_preparacao', 'Começar a preparar']],
    em_preparacao: [['pronto', 'Marcar como pronto']],
    pronto: [['levantado', 'Marcar como levantado']],
  };

  // ====================================================================
  //  Utilitários
  // ====================================================================
  const eur = (cents) => new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' }).format(cents / 100);
  const fmtDate = (iso) => new Date(iso).toLocaleString('pt-PT', { dateStyle: 'short', timeStyle: 'short' });
  const orderNo = (id) => '#' + String(id).padStart(4, '0');
  const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.ceil(n / 1024) + ' kB');

  function ago(iso) {
    const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (min < 1) return 'agora mesmo';
    if (min < 60) return `há ${min} min`;
    if (min < 24 * 60) return `há ${Math.floor(min / 60)} h`;
    return fmtDate(iso);
  }

  function append(el, children) {
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
  }

  // Cria elementos DOM. Todo o texto entra como texto (nunca como HTML), o que evita XSS.
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'hidden') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    append(el, children);
    return el;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    shop: '<path d="M5 8h14l-1 12H6L5 8Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
    cart: '<circle cx="9" cy="20" r="1.4"/><circle cx="17" cy="20" r="1.4"/><path d="M3 4h2.2l2.1 10.2a1 1 0 0 0 1 .8h8.2a1 1 0 0 0 1-.8L19 8H6.2"/>',
    list: '<path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 20c1-4 4-6 8-6s7 2 8 6"/>',
    panel: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4h6v3H9z"/><path d="m9 14 2 2 4-4"/>',
  };
  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = ICONS[name]; // markup estático, definido acima
    return svg;
  }

  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
    },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* sem armazenamento */ } },
    remove(key) { try { localStorage.removeItem(key); } catch { /* sem armazenamento */ } },
  };

  let toastTimer;
  function toast(message) {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  // ====================================================================
  //  Estado, API e carrinho
  // ====================================================================
  const state = { user: null, installEvent: null, next: null };

  class ApiError extends Error {
    constructor(message, status) { super(message); this.status = status; }
  }

  async function api(path, { method = 'GET', body, form } = {}) {
    const opt = { method, headers: {}, credentials: 'same-origin' };
    if (form) opt.body = form;
    else if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    let res;
    try { res = await fetch('/api' + path, opt); } catch {
      throw new ApiError('Sem ligação à internet. Verifique a rede e tente novamente.', 0);
    }
    let data = null;
    try { data = await res.json(); } catch { /* resposta sem JSON */ }
    if (!res.ok) {
      if (res.status === 401 && state.user) {
        state.user = null;
        updateTabs();
        toast('A sua sessão terminou. Inicie sessão novamente.');
        goTo('#/entrar');
      }
      throw new ApiError((data && data.error) || 'Ocorreu um erro. Tente novamente.', res.status);
    }
    return data;
  }

  const cart = {
    items: [],
    load() {
      const raw = store.get('cart.v1', []);
      this.items = Array.isArray(raw) ? raw.filter((i) => i && Number.isInteger(i.id) && Number.isInteger(i.quantity)
        && i.quantity > 0 && typeof i.name === 'string' && Number.isInteger(i.price_cents)).slice(0, 30) : [];
    },
    save() { store.set('cart.v1', this.items); },
    qty(id) { const i = this.items.find((x) => x.id === id); return i ? i.quantity : 0; },
    add(p) {
      const found = this.items.find((x) => x.id === p.id);
      if (found) found.quantity = Math.min(20, found.quantity + 1);
      else {
        this.items.push({ id: p.id, name: p.name, pack: p.pack, icon: p.icon, price_cents: p.price_cents,
          rx: !!p.requires_prescription, quantity: 1 });
      }
      this.save();
    },
    setQty(id, q) {
      if (q < 1) { this.remove(id); return; }
      const found = this.items.find((x) => x.id === id);
      if (found) found.quantity = Math.min(20, q);
      this.save();
    },
    remove(id) { this.items = this.items.filter((x) => x.id !== id); this.save(); },
    clear() { this.items = []; store.remove('cart.v1'); },
    count() { return this.items.reduce((n, i) => n + i.quantity, 0); },
    total() { return this.items.reduce((n, i) => n + i.quantity * i.price_cents, 0); },
    needsRx() { return this.items.some((i) => i.rx); },
  };

  // ====================================================================
  //  Componentes pequenos
  // ====================================================================
  let fieldSeq = 0;
  function field(label, control, hint) {
    const id = `f${++fieldSeq}`;
    control.id = id;
    const parts = [h('label', { for: id }, label), control];
    if (hint) {
      control.setAttribute('aria-describedby', `${id}-hint`);
      parts.push(h('small', { id: `${id}-hint` }, hint));
    }
    return h('div', { class: 'field' }, parts);
  }

  function statusBadge(status, staff) {
    const s = STATUS[status] || STATUS.novo;
    return h('span', { class: `badge ${s.tone}` }, staff ? s.staffLabel : s.label);
  }

  function errorBox(message, retry) {
    return h('div', { class: 'error', role: 'alert' }, message,
      retry && [' ', h('button', { class: 'linktxt', type: 'button', onclick: retry }, 'Tentar de novo')]);
  }

  function emptyState(emoji, text, action) {
    return h('div', { class: 'empty' }, h('span', { class: 'big', 'aria-hidden': 'true' }, emoji), h('p', {}, text), action);
  }

  function segmented(options, current, onChange) {
    const el = h('div', { class: 'seg', role: 'group' });
    const buttons = options.map(([value, label]) => h('button', {
      type: 'button', 'aria-pressed': String(value === current),
      onclick: () => { buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(options[i][0] === value))); onChange(value); },
    }, label));
    append(el, buttons);
    return el;
  }

  function backLink(href, text) { return h('a', { class: 'back', href }, '← ' + text); }

  function copyButton(value, label) {
    return h('button', {
      class: 'btn secondary small', type: 'button',
      onclick: async () => {
        try { await navigator.clipboard.writeText(value); toast('Copiado.'); } catch { toast('Não foi possível copiar.'); }
      },
    }, label);
  }

  // ====================================================================
  //  Estrutura (topo, separadores, rotas)
  // ====================================================================
  const app = document.getElementById('app');
  let mainEl; let tabbarEl; let offlineEl;
  let cleanup = null;
  let routeSeq = 0;

  function buildShell() {
    offlineEl = h('div', { class: 'offline', role: 'status', hidden: navigator.onLine },
      'Sem ligação à internet. Algumas funções podem não estar disponíveis.');
    mainEl = h('main', { id: 'main', tabindex: '-1' });
    tabbarEl = h('nav', { class: 'tabbar', 'aria-label': 'Navegação principal' });
    app.replaceChildren(
      h('header', { class: 'topbar' }, h('img', { src: '/icons/icon-192.png', alt: '', width: 30, height: 30 }),
        h('span', { class: 'brand' }, PHARMACY)),
      offlineEl, mainEl, tabbarEl);
    window.addEventListener('online', () => { offlineEl.hidden = true; });
    window.addEventListener('offline', () => { offlineEl.hidden = false; });
  }

  function tabsFor() {
    const staff = state.user && state.user.role === 'staff';
    return [
      { href: '#/', icon: 'shop', label: 'Montra', match: /^#\/?$/ },
      staff
        ? { href: '#/painel', icon: 'panel', label: 'Painel', match: /^#\/painel/ }
        : { href: '#/pedido', icon: 'cart', label: 'Pedido', match: /^#\/pedido$/, badge: cart.count() },
      !staff && { href: '#/pedidos', icon: 'list', label: 'Histórico', match: /^#\/pedidos/ },
      { href: state.user ? '#/conta' : '#/entrar', icon: 'user', label: state.user ? 'Conta' : 'Entrar', match: /^#\/(conta|entrar)/ },
    ].filter(Boolean);
  }

  function updateTabs() {
    if (!tabbarEl) return;
    const hash = location.hash || '#/';
    tabbarEl.replaceChildren(...tabsFor().map((t) => h('a', {
      class: 'tab', href: t.href, 'aria-current': t.match.test(hash) ? 'page' : false,
    }, icon(t.icon), t.label, t.badge ? h('span', { class: 'count', 'aria-label': `${t.badge} artigos` }, t.badge) : null)));
  }

  function goTo(hash) {
    if (location.hash === hash) route(); else location.hash = hash;
  }

  const routes = [
    [/^#\/?$/, 'Montra', renderShop, 'public'],
    [/^#\/pedido$/, 'O meu pedido', renderCart, 'public'],
    [/^#\/pedidos$/, 'Histórico de pedidos', renderOrders, 'user'],
    [/^#\/pedidos\/(\d+)$/, 'Pedido', renderOrderDetail, 'user'],
    [/^#\/painel$/, 'Painel da farmácia', renderStaff, 'staff'],
    [/^#\/painel\/(\d+)$/, 'Pedido', renderStaffOrder, 'staff'],
    [/^#\/conta$/, 'Conta', renderAccount, 'public'],
    [/^#\/entrar$/, 'Entrar', renderAuth, 'public'],
  ];

  async function route() {
    const mine = ++routeSeq;
    if (cleanup) { cleanup(); cleanup = null; }
    const hash = location.hash || '#/';
    const match = routes.map(([re, title, fn, access]) => ({ m: re.exec(hash), title, fn, access })).find((r) => r.m);
    updateTabs();

    if (!match) { goTo('#/'); return; }
    if (match.access !== 'public' && !state.user) { state.next = hash; goTo('#/entrar'); return; }
    if (match.access === 'staff' && state.user.role !== 'staff') { goTo('#/'); return; }
    if (match.access === 'user' && state.user.role === 'staff') { goTo('#/painel'); return; }

    document.title = `${match.title} · ${PHARMACY}`;
    window.scrollTo(0, 0);
    const result = await match.fn(mainEl, ...match.m.slice(1).map(Number));
    if (mine !== routeSeq) { if (typeof result === 'function') result(); return; }
    cleanup = typeof result === 'function' ? result : null;
    mainEl.focus({ preventScroll: true });
  }

  function poll(fn) {
    const id = setInterval(() => { if (!document.hidden && navigator.onLine) fn(); }, POLL_MS);
    return () => clearInterval(id);
  }

  // ====================================================================
  //  Montra
  // ====================================================================
  const shopState = { q: '', type: 'all', category: '' };

  function productCard(p) {
    const btn = h('button', { class: 'btn small', type: 'button', 'aria-label': `Adicionar ${p.name} ao pedido` });
    const sync = () => { const q = cart.qty(p.id); btn.textContent = q ? `✓ ${q} no pedido · +1` : 'Adicionar'; };
    btn.addEventListener('click', () => {
      cart.add(p); sync(); updateTabs();
      toast(p.requires_prescription ? 'Adicionado. Este medicamento exige receita.' : 'Adicionado ao pedido.');
    });
    sync();
    return h('article', { class: 'card product' },
      h('div', { class: 'tile', 'aria-hidden': 'true' }, p.icon),
      h('div', {}, h('h3', {}, p.name), h('p', { class: 'muted small' }, p.pack), h('p', { class: 'desc' }, p.description)),
      h('div', { class: 'foot' },
        h('div', {}, h('span', { class: 'price' }, eur(p.price_cents)), ' ',
          p.requires_prescription ? h('span', { class: 'badge rx' }, 'Receita') : h('span', { class: 'badge ok' }, 'Venda livre')),
        btn));
  }

  async function renderShop(main) {
    const search = h('input', {
      type: 'search', placeholder: 'Pesquisar produtos…', 'aria-label': 'Pesquisar produtos',
      autocomplete: 'off', enterkeyhint: 'search', value: shopState.q,
    });
    const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Categorias' });
    const grid = h('div', { class: 'grid', 'aria-live': 'polite' });
    const types = segmented([['all', 'Todos'], ['otc', 'Venda livre'], ['rx', 'Com receita']], shopState.type, (v) => {
      shopState.type = v; load();
    });

    let timer; let seq = 0;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { shopState.q = search.value.trim(); load(); }, 250);
    });

    function drawChips(categories) {
      const all = [['', 'Todas'], ...categories.map((c) => [c, c])];
      chips.replaceChildren(...all.map(([value, label]) => h('button', {
        class: 'chip', type: 'button', 'aria-pressed': String(shopState.category === value),
        onclick: () => { shopState.category = value; load(); },
      }, label)));
    }

    async function load() {
      const mine = ++seq;
      const params = new URLSearchParams();
      if (shopState.q) params.set('q', shopState.q);
      if (shopState.type !== 'all') params.set('type', shopState.type);
      if (shopState.category) params.set('category', shopState.category);
      try {
        const data = await api('/products?' + params);
        if (mine !== seq) return;
        if (shopState.category && !data.categories.includes(shopState.category)) shopState.category = '';
        drawChips(data.categories);
        grid.replaceChildren(...(data.products.length
          ? data.products.map(productCard)
          : [emptyState('🔍', 'Não encontrámos produtos com esses filtros.')]));
      } catch (err) {
        if (mine !== seq) return;
        grid.replaceChildren(errorBox(err.message, load));
      }
    }

    main.replaceChildren(
      h('div', { class: 'page-head' }, h('h1', {}, 'Montra')),
      h('div', { class: 'stack' }, search, types, chips),
      grid);
    grid.replaceChildren(h('p', { class: 'muted' }, 'A carregar…'));
    await load();
  }

  // ====================================================================
  //  Pedido (carrinho + receita)
  // ====================================================================
  const checkout = { kind: 'numero', number: '', access: '', option: '', file: null, notes: '' };
  let filePreviewUrl = null;

  function resetCheckout() {
    Object.assign(checkout, { kind: 'numero', number: '', access: '', option: '', file: null, notes: '' });
    if (filePreviewUrl) { URL.revokeObjectURL(filePreviewUrl); filePreviewUrl = null; }
  }

  const digitsOnly = (s) => String(s).replace(/[\s-]/g, '');

  function validateCheckout() {
    if (!cart.needsRx()) return null;
    if (checkout.kind === 'numero') {
      if (!/^\d{10,25}$/.test(digitsOnly(checkout.number))) return 'Indique o número da receita (apenas dígitos).';
      if (!/^\d{4,8}$/.test(digitsOnly(checkout.access))) return 'Indique o código de acesso e dispensa da receita.';
      if (checkout.option && !/^\d{3,4}$/.test(digitsOnly(checkout.option))) return 'O código de direito de opção é inválido.';
    } else if (!checkout.file) {
      return 'Anexe a fotografia ou o PDF da receita.';
    }
    return null;
  }

  function buildRxCard() {
    const numberInputs = {
      number: h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', value: checkout.number, maxlength: '30',
        oninput: (e) => { checkout.number = e.target.value; } }),
      access: h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', value: checkout.access, maxlength: '10',
        oninput: (e) => { checkout.access = e.target.value; } }),
      option: h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'off', value: checkout.option, maxlength: '6',
        oninput: (e) => { checkout.option = e.target.value; } }),
    };
    const numberBox = h('div', { class: 'stack' },
      field('Número da receita', numberInputs.number, 'Consta da mensagem (SMS/email) ou da guia de tratamento.'),
      field('Código de acesso e dispensa', numberInputs.access),
      field('Código de direito de opção (se tiver)', numberInputs.option));

    const fileInfo = h('p', { class: 'muted small' });
    const preview = h('img', { class: 'rx-img', alt: 'Pré-visualização da receita', hidden: true });
    const fileInput = h('input', {
      type: 'file', accept: 'image/jpeg,image/png,image/webp,application/pdf',
      onchange: (e) => {
        const f = e.target.files && e.target.files[0];
        if (filePreviewUrl) { URL.revokeObjectURL(filePreviewUrl); filePreviewUrl = null; }
        preview.hidden = true;
        checkout.file = null;
        fileInfo.textContent = '';
        if (!f) return;
        const okType = /^(image\/(jpeg|png|webp)|application\/pdf)$/.test(f.type);
        if (!okType) { e.target.value = ''; toast('Formato não suportado. Use JPG, PNG, WebP ou PDF.'); return; }
        if (f.size > MAX_UPLOAD) { e.target.value = ''; toast('O ficheiro é demasiado grande (máximo 8 MB).'); return; }
        checkout.file = f;
        fileInfo.textContent = `${f.name} · ${fmtSize(f.size)}`;
        if (f.type.startsWith('image/')) { filePreviewUrl = URL.createObjectURL(f); preview.src = filePreviewUrl; preview.hidden = false; }
      },
    });
    if (checkout.file) fileInfo.textContent = `${checkout.file.name} · ${fmtSize(checkout.file.size)}`;
    const photoBox = h('div', { class: 'stack' },
      field('Fotografia ou PDF da receita', fileInput, 'Tire uma fotografia nítida, com todos os dados visíveis.'),
      fileInfo, preview);

    const radio = (value, label) => h('label', { class: 'radio-card' },
      h('input', { type: 'radio', name: 'rx_kind', value, checked: checkout.kind === value,
        onchange: () => { checkout.kind = value; sync(); } }),
      h('span', {}, label));
    const sync = () => { numberBox.hidden = checkout.kind !== 'numero'; photoBox.hidden = checkout.kind !== 'foto'; };
    sync();

    return h('section', { class: 'card stack', 'aria-labelledby': 'rx-title' },
      h('h2', { id: 'rx-title' }, 'Receita médica'),
      h('p', { class: 'muted small' }, 'Há medicamentos no pedido que exigem receita. Indique-a de uma destas formas:'),
      radio('numero', 'Número da receita eletrónica'),
      radio('foto', 'Fotografia ou PDF da receita'),
      numberBox, photoBox);
  }

  async function renderCart(main) {
    const rxCard = buildRxCard();
    const notes = h('textarea', { maxlength: '500', placeholder: 'Ex.: levanto ao fim da tarde', value: checkout.notes,
      oninput: (e) => { checkout.notes = e.target.value; } });
    const notesField = field('Observações (opcional)', notes);
    const errBox = h('div', { class: 'error', role: 'alert', hidden: true });
    const submit = h('button', { class: 'btn block', type: 'button' });

    function showError(msg) { errBox.textContent = msg; errBox.hidden = false; errBox.scrollIntoView({ block: 'nearest' }); }

    function syncSubmit() {
      submit.textContent = state.user ? 'Enviar pedido' : 'Entrar para enviar o pedido';
    }

    submit.addEventListener('click', async () => {
      errBox.hidden = true;
      if (!state.user) { state.next = '#/pedido'; goTo('#/entrar'); return; }
      const problem = validateCheckout();
      if (problem) { showError(problem); return; }
      const fd = new FormData();
      fd.append('items', JSON.stringify(cart.items.map((i) => ({ product_id: i.id, quantity: i.quantity }))));
      fd.append('notes', checkout.notes);
      if (cart.needsRx()) {
        fd.append('rx_kind', checkout.kind);
        if (checkout.kind === 'numero') {
          fd.append('rx_number', digitsOnly(checkout.number));
          fd.append('rx_access_code', digitsOnly(checkout.access));
          if (checkout.option) fd.append('rx_option_code', digitsOnly(checkout.option));
        } else {
          fd.append('file', checkout.file, checkout.file.name);
        }
      }
      submit.disabled = true;
      submit.textContent = 'A enviar…';
      try {
        const res = await api('/orders', { method: 'POST', form: fd });
        cart.clear(); resetCheckout(); updateTabs();
        toast('Pedido enviado. Acompanhe o estado aqui.');
        goTo('#/pedidos/' + res.id);
      } catch (err) {
        showError(err.message);
        submit.disabled = false;
        syncSubmit();
      }
    });

    function linesCard() {
      return h('section', { class: 'card', 'aria-label': 'Artigos do pedido' },
        cart.items.map((i) => h('div', { class: 'line' },
          h('div', {}, h('strong', {}, `${i.icon || '💊'} ${i.name}`), ' ',
            i.rx ? h('span', { class: 'badge rx' }, 'Receita') : null,
            h('div', { class: 'muted small' }, `${i.pack} · ${eur(i.price_cents)} cada`)),
          h('div', { class: 'qty' },
            h('button', { type: 'button', 'aria-label': `Menos um ${i.name}`, onclick: () => { cart.setQty(i.id, i.quantity - 1); draw(); } }, '−'),
            h('output', { 'aria-label': 'Quantidade' }, String(i.quantity)),
            h('button', { type: 'button', 'aria-label': `Mais um ${i.name}`, disabled: i.quantity >= 20,
              onclick: () => { cart.setQty(i.id, i.quantity + 1); draw(); } }, '+')),
          h('button', { class: 'linktxt', type: 'button', onclick: () => { cart.remove(i.id); draw(); } }, 'Remover')),
        ),
        h('div', { class: 'total' }, h('span', {}, 'Total estimado'), h('span', {}, eur(cart.total()))));
    }

    function draw() {
      updateTabs();
      if (cart.items.length === 0) {
        main.replaceChildren(h('div', { class: 'page-head' }, h('h1', {}, 'O meu pedido')),
          emptyState('🛍️', 'O seu pedido está vazio.', h('a', { class: 'btn', href: '#/' }, 'Ver a montra')));
        return;
      }
      rxCard.hidden = !cart.needsRx();
      syncSubmit();
      main.replaceChildren(
        h('div', { class: 'page-head' }, h('h1', {}, 'O meu pedido')),
        h('div', { class: 'stack-lg' },
          linesCard(), rxCard, notesField,
          h('p', { class: 'notice' }, 'O pagamento e o levantamento são feitos na farmácia. O pedido só fica confirmado depois de validado pela nossa equipa.'),
          errBox, submit));
    }
    draw();
  }

  // ====================================================================
  //  Histórico e detalhe do pedido (cliente)
  // ====================================================================
  async function renderOrders(main) {
    main.replaceChildren(h('div', { class: 'page-head' }, h('h1', {}, 'Histórico de pedidos')), h('p', { class: 'muted' }, 'A carregar…'));
    const list = h('div', { class: 'stack' });

    async function load() {
      try {
        const { orders } = await api('/orders');
        list.replaceChildren(...(orders.length
          ? orders.map((o) => h('a', { class: 'card order-row', href: `#/pedidos/${o.id}` },
            h('strong', {}, `Pedido ${orderNo(o.id)}`), statusBadge(o.status),
            h('span', { class: 'sub' }, `${fmtDate(o.created_at)} · ${o.item_count} ${o.item_count === 1 ? 'artigo' : 'artigos'} · ${eur(o.total_cents)}`)))
          : [emptyState('📋', 'Ainda não fez nenhum pedido.', h('a', { class: 'btn', href: '#/' }, 'Ver a montra'))]));
      } catch (err) {
        list.replaceChildren(errorBox(err.message, load));
      }
    }
    main.replaceChildren(h('div', { class: 'page-head' }, h('h1', {}, 'Histórico de pedidos')), list);
    await load();
    return poll(load);
  }

  function rxSummary(id, rx, staff) {
    if (!rx) return null;
    const fileUrl = `/api/orders/${id}/prescription/file`;
    const rows = [];
    if (rx.kind === 'numero') {
      rows.push(h('dl', { class: 'kv' },
        h('dt', {}, 'Número'), h('dd', { class: 'mono' }, rx.number),
        h('dt', {}, 'Código de acesso'), h('dd', { class: 'mono' }, rx.access_code),
        rx.option_code ? [h('dt', {}, 'Direito de opção'), h('dd', { class: 'mono' }, rx.option_code)] : null));
      if (staff) {
        rows.push(h('div', { class: 'actions' }, copyButton(rx.number, 'Copiar número'), copyButton(rx.access_code, 'Copiar código')));
      }
    } else if (rx.file_mime && rx.file_mime.startsWith('image/')) {
      rows.push(h('a', { href: fileUrl, target: '_blank', rel: 'noopener' }, h('img', { class: 'rx-img', src: fileUrl, alt: 'Fotografia da receita' })));
    } else {
      rows.push(h('a', { class: 'btn secondary', href: fileUrl, target: '_blank', rel: 'noopener' }, 'Abrir PDF da receita'));
    }
    return h('section', { class: 'card stack' }, h('h2', {}, 'Receita'), rows);
  }

  function itemsCard(items, total) {
    return h('section', { class: 'card' },
      items.map((i) => h('div', { class: 'line' },
        h('div', {}, h('strong', {}, i.name), h('div', { class: 'muted small' }, `${i.quantity} × ${eur(i.price_cents)}`)),
        h('strong', {}, eur(i.quantity * i.price_cents)))),
      h('div', { class: 'total' }, h('span', {}, 'Total'), h('span', {}, eur(total))));
  }

  function stepper(status) {
    if (status === 'cancelado') return null;
    const at = STEPS.indexOf(status);
    return h('ol', { class: 'steps', 'aria-label': 'Progresso do pedido' },
      STEPS.map((s, i) => h('li', { class: i < at ? 'done' : (i === at ? 'done now' : ''), 'aria-current': i === at ? 'step' : false },
        STATUS[s].label)));
  }

  async function renderOrderDetail(main, id) {
    main.replaceChildren(backLink('#/pedidos', 'Histórico'), h('p', { class: 'muted' }, 'A carregar…'));
    async function load() {
      try {
        const { order, items, prescription } = await api(`/orders/${id}`);
        const cancel = order.status === 'novo' ? h('button', {
          class: 'btn danger block', type: 'button',
          onclick: async () => {
            if (!confirm('Cancelar este pedido?')) return;
            try { await api(`/orders/${id}/status`, { method: 'PATCH', body: { status: 'cancelado' } }); toast('Pedido cancelado.'); load(); }
            catch (err) { toast(err.message); }
          },
        }, 'Cancelar pedido') : null;
        main.replaceChildren(
          backLink('#/pedidos', 'Histórico'),
          h('div', { class: 'page-head' }, h('h1', {}, `Pedido ${orderNo(order.id)}`), statusBadge(order.status)),
          h('div', { class: 'stack-lg' },
            order.status === 'pronto' ? h('p', { class: 'notice' }, 'O seu pedido está pronto. Pode levantá-lo na farmácia.') : null,
            h('section', { class: 'card stack' }, stepper(order.status),
              h('p', { class: 'muted small' }, `Feito em ${fmtDate(order.created_at)}`)),
            itemsCard(items, order.total_cents),
            rxSummary(order.id, prescription, false),
            order.notes ? h('section', { class: 'card' }, h('h2', {}, 'Observações'), h('p', {}, order.notes)) : null,
            cancel));
      } catch (err) {
        main.replaceChildren(backLink('#/pedidos', 'Histórico'), errorBox(err.message, load));
      }
    }
    await load();
    return poll(load);
  }

  // ====================================================================
  //  Painel da farmácia (pessoal)
  // ====================================================================
  const staffState = { filter: 'active' };

  async function renderStaff(main) {
    const list = h('div', { class: 'stack' });
    const seg = segmented([['active', 'Por tratar'], ['done', 'Concluídos']], staffState.filter, (v) => { staffState.filter = v; load(); });

    async function load() {
      try {
        const { orders } = await api('/orders?status=' + staffState.filter);
        list.replaceChildren(...(orders.length
          ? orders.map((o) => h('a', { class: 'card order-row', href: `#/painel/${o.id}` },
            h('strong', {}, `${orderNo(o.id)} · ${o.customer.name}`), statusBadge(o.status, true),
            h('span', { class: 'sub' },
              `${ago(o.created_at)} · ${o.item_count} ${o.item_count === 1 ? 'artigo' : 'artigos'} · ${eur(o.total_cents)}`,
              o.has_prescription ? [' · ', h('span', { class: 'badge rx' }, 'Receita')] : null)))
          : [emptyState('✅', staffState.filter === 'active' ? 'Não há pedidos por tratar.' : 'Ainda não há pedidos concluídos.')]));
      } catch (err) {
        list.replaceChildren(errorBox(err.message, load));
      }
    }
    main.replaceChildren(h('div', { class: 'page-head' }, h('h1', {}, 'Painel da farmácia')), h('div', { class: 'stack' }, seg, list));
    await load();
    return poll(load);
  }

  async function renderStaffOrder(main, id) {
    main.replaceChildren(backLink('#/painel', 'Painel'), h('p', { class: 'muted' }, 'A carregar…'));
    async function load() {
      try {
        const { order, items, prescription } = await api(`/orders/${id}`);
        const c = order.customer;
        const act = async (status, question) => {
          if (question && !confirm(question)) return;
          try { await api(`/orders/${id}/status`, { method: 'PATCH', body: { status } }); toast('Estado atualizado.'); load(); }
          catch (err) { toast(err.message); load(); }
        };
        const next = (STAFF_ACTIONS[order.status] || []).map(([status, label]) =>
          h('button', { class: 'btn', type: 'button', onclick: () => act(status) }, label));
        const canCancel = ['novo', 'em_preparacao', 'pronto'].includes(order.status);
        main.replaceChildren(
          backLink('#/painel', 'Painel'),
          h('div', { class: 'page-head' }, h('h1', {}, `Pedido ${orderNo(order.id)}`), statusBadge(order.status, true)),
          h('div', { class: 'stack-lg' },
            h('section', { class: 'card stack' }, h('h2', {}, 'Cliente'),
              h('dl', { class: 'kv' },
                h('dt', {}, 'Nome'), h('dd', {}, c.name),
                h('dt', {}, 'Telemóvel'), h('dd', {}, c.phone ? h('a', { href: `tel:${c.phone.replace(/\s/g, '')}` }, c.phone) : '—'),
                h('dt', {}, 'Email'), h('dd', {}, h('a', { href: `mailto:${c.email}` }, c.email)),
                h('dt', {}, 'Pedido feito'), h('dd', {}, `${fmtDate(order.created_at)} (${ago(order.created_at)})`))),
            itemsCard(items, order.total_cents),
            rxSummary(order.id, prescription, true),
            order.notes ? h('section', { class: 'card' }, h('h2', {}, 'Observações do cliente'), h('p', {}, order.notes)) : null,
            (next.length || canCancel) ? h('div', { class: 'actions' }, next,
              canCancel ? h('button', { class: 'btn danger', type: 'button', onclick: () => act('cancelado', 'Cancelar este pedido?') }, 'Cancelar pedido') : null) : null));
      } catch (err) {
        main.replaceChildren(backLink('#/painel', 'Painel'), errorBox(err.message, load));
      }
    }
    await load();
  }

  // ====================================================================
  //  Entrar / criar conta
  // ====================================================================
  async function renderAuth(main) {
    if (state.user) { goTo(state.user.role === 'staff' ? '#/painel' : '#/'); return; }
    let mode = 'login';
    const box = h('div', { class: 'auth stack-lg' });

    function finish(user) {
      state.user = user;
      const next = state.next || (user.role === 'staff' ? '#/painel' : '#/');
      state.next = null;
      updateTabs();
      goTo(next);
    }

    function draw() {
      const err = h('div', { class: 'error', role: 'alert', hidden: true });
      const isRegister = mode === 'register';
      const f = {
        name: h('input', { type: 'text', autocomplete: 'name', required: true, maxlength: '80' }),
        email: h('input', { type: 'email', autocomplete: 'email', required: true, maxlength: '120', inputmode: 'email', autocapitalize: 'none' }),
        phone: h('input', { type: 'tel', autocomplete: 'tel', maxlength: '20', inputmode: 'tel' }),
        password: h('input', { type: 'password', autocomplete: isRegister ? 'new-password' : 'current-password', required: true,
          minlength: isRegister ? '8' : false, maxlength: '128' }),
        consent: h('input', { type: 'checkbox', required: true }),
      };
      const button = h('button', { class: 'btn block', type: 'submit' }, isRegister ? 'Criar conta' : 'Entrar');
      const form = h('form', {
        class: 'stack',
        onsubmit: async (e) => {
          e.preventDefault();
          err.hidden = true;
          button.disabled = true;
          try {
            const body = isRegister
              ? { name: f.name.value, email: f.email.value, phone: f.phone.value, password: f.password.value, consent: f.consent.checked }
              : { email: f.email.value, password: f.password.value };
            const res = await api(isRegister ? '/auth/register' : '/auth/login', { method: 'POST', body });
            finish(res.user);
          } catch (error) {
            err.textContent = error.message; err.hidden = false; button.disabled = false;
          }
        },
      },
      isRegister ? field('Nome', f.name) : null,
      field('Email', f.email),
      isRegister ? field('Telemóvel (opcional)', f.phone, 'Para a farmácia o contactar sobre o pedido.') : null,
      field('Palavra-passe', f.password, isRegister ? 'Mínimo de 8 caracteres.' : null),
      isRegister ? h('label', { class: 'check' }, f.consent,
        h('span', {}, 'Aceito que a farmácia trate os meus dados pessoais (incluindo dados de saúde, como receitas) para preparar os meus pedidos.')) : null,
      err, button);

      box.replaceChildren(
        h('div', {}, h('h1', {}, isRegister ? 'Criar conta' : 'Entrar'),
          h('p', { class: 'muted' }, 'Precisa de conta para enviar pedidos. Pode ver a montra sem entrar.')),
        segmented([['login', 'Entrar'], ['register', 'Criar conta']], mode, (v) => { mode = v; draw(); }),
        form);
    }
    draw();
    main.replaceChildren(h('div', { class: 'stack-lg' }, box, installCard()));
  }

  // ====================================================================
  //  Conta
  // ====================================================================
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  function installCard() {
    if (isStandalone()) return h('section', { class: 'card' }, h('h2', {}, 'Aplicação instalada'), h('p', { class: 'muted' }, 'Está a usar a app instalada. ✓'));
    const body = [h('h2', {}, 'Instalar a app no telemóvel')];
    if (state.installEvent) {
      body.push(h('p', { class: 'muted' }, 'Tenha a farmácia no ecrã inicial, como qualquer outra app.'),
        h('button', {
          class: 'btn block', type: 'button',
          onclick: async () => {
            const ev = state.installEvent;
            state.installEvent = null;
            ev.prompt();
            await ev.userChoice.catch(() => {});
            route();
          },
        }, 'Instalar app'));
    } else if (isIos()) {
      body.push(h('p', { class: 'muted' }, 'No iPhone ou iPad, abra esta página no Safari e:'),
        h('ol', {}, h('li', {}, 'toque no botão Partilhar (o quadrado com a seta para cima);'),
          h('li', {}, 'escolha «Adicionar ao ecrã principal»;'), h('li', {}, 'toque em «Adicionar».')));
    } else {
      body.push(h('p', { class: 'muted' },
        'No Android, abra o menu do Chrome (⋮) e escolha «Instalar aplicação» ou «Adicionar ao ecrã principal». No computador, use o ícone de instalação na barra de endereço.'));
    }
    return h('section', { class: 'card stack' }, body);
  }

  async function renderAccount(main) {
    const u = state.user;
    const blocks = [];
    if (u) {
      blocks.push(h('section', { class: 'card stack' }, h('h2', {}, u.name),
        h('dl', { class: 'kv' },
          h('dt', {}, 'Email'), h('dd', {}, u.email),
          u.phone ? [h('dt', {}, 'Telemóvel'), h('dd', {}, u.phone)] : null,
          u.role === 'staff' ? [h('dt', {}, 'Tipo de conta'), h('dd', {}, 'Equipa da farmácia')] : null)));
    } else {
      blocks.push(h('section', { class: 'card stack' }, h('h2', {}, 'Ainda não entrou'),
        h('p', { class: 'muted' }, 'Entre ou crie uma conta para enviar pedidos e acompanhá-los.'),
        h('a', { class: 'btn block', href: '#/entrar' }, 'Entrar ou criar conta')));
    }
    blocks.push(installCard());
    if (u) {
      blocks.push(h('button', {
        class: 'btn secondary block', type: 'button',
        onclick: async () => {
          try { await api('/auth/logout', { method: 'POST', body: {} }); } catch { /* termina na mesma */ }
          state.user = null; cart.clear(); resetCheckout(); updateTabs();
          toast('Sessão terminada.');
          goTo('#/');
        },
      }, 'Terminar sessão'));
    }
    main.replaceChildren(h('div', { class: 'page-head' }, h('h1', {}, 'Conta')), h('div', { class: 'stack-lg' }, blocks));
  }

  // ====================================================================
  //  Arranque
  // ====================================================================
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installEvent = e;
    if ((location.hash || '#/') === '#/conta') route();
  });
  window.addEventListener('appinstalled', () => { state.installEvent = null; toast('App instalada.'); });

  async function boot() {
    cart.load();
    buildShell();
    try { state.user = (await api('/auth/me')).user; } catch { state.user = null; }
    window.addEventListener('hashchange', route);
    await route();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => { /* a app funciona sem service worker */ });
    }
  }

  boot();
})();
