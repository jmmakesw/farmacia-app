'use strict';
// Service worker: permite instalar a app e abri-la mesmo sem rede.
// Dados pessoais (pedidos, receitas, sessão) NUNCA são guardados em cache: só a "casca" da app e a montra.
const VERSION = 'v1';
const SHELL_CACHE = `farmacia-shell-${VERSION}`;
const DATA_CACHE = `farmacia-montra-${VERSION}`;
const SHELL = [
  '/',
  '/app.js',
  '/styles.css',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => k !== SHELL_CACHE && k !== DATA_CACHE)
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Montra: tenta a rede; sem rede, usa a última versão guardada.
  if (url.pathname === '/api/products') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(DATA_CACHE).then((c) => c.put(req, copy)); }
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || new Response(
          JSON.stringify({ error: 'Sem ligação à internet.' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }))),
    );
    return;
  }

  // Tudo o resto da API (sessão, pedidos, receitas) vai sempre à rede.
  if (url.pathname.startsWith('/api/')) return;

  // Abrir a app: rede primeiro, com a página guardada como reserva.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/')));
    return;
  }

  // Ficheiros da app: mostra o que está guardado e atualiza em segundo plano.
  event.respondWith(
    caches.open(SHELL_CACHE).then((cache) => cache.match(req).then((hit) => {
      const fresh = fetch(req).then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => hit);
      return hit || fresh;
    })),
  );
});
