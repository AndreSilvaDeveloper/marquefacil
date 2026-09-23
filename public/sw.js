// Guarda os arquivos do app para abrir mesmo sem internet.
// Ao mudar qualquer arquivo, aumente a versão abaixo.
const CACHE = 'agenda-v40';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'manifest.json', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Tenta a internet primeiro (pega atualizações); sem internet, usa a cópia guardada.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // A API nunca vem do cache: os dados precisam ser sempre os de verdade
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});

/* ---------------- Avisos (push) ---------------- */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Marque Fácil', body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Marque Fácil', {
    body: d.body || '',
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    tag: d.tag || d.apptId || undefined, // o mesmo pedido não aparece duas vezes
    renotify: !!(d.tag || d.apptId),
    requireInteraction: !!d.pending,     // pedido fica na tela até ela responder
    data: { url: d.url || '/#/agenda', apptId: d.apptId, pending: !!d.pending },
    actions: d.pending ? [{ action: 'confirm', title: '✓ Confirmar' }, { action: 'open', title: 'Ver pedido' }] : [],
  }));
});

// Abre o app (ou traz para a frente) na tela certa
async function openApp(url) {
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const win = wins.find(w => new URL(w.url).origin === location.origin);
  if (win) { win.postMessage({ type: 'open', url }); return win.focus(); }
  return self.clients.openWindow(url);
}

self.addEventListener('notificationclick', e => {
  const { url, apptId } = e.notification.data || {};
  e.notification.close();
  if (e.action === 'confirm' && apptId) {
    e.waitUntil((async () => {
      try {
        const r = await fetch(`/api/appts/${encodeURIComponent(apptId)}/decision`, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'confirm' }),
        });
        if (!r.ok) throw new Error();
        await self.registration.showNotification('✓ Agendamento confirmado', { body: 'A cliente vai receber a confirmação no WhatsApp.', icon: 'icon-192.png', tag: apptId });
        (await self.clients.matchAll({ type: 'window' })).forEach(w => w.postMessage({ type: 'changed' }));
      } catch {
        await openApp(url); // sem internet ou sessão expirada: abre o pedido no app
      }
    })());
    return;
  }
  e.waitUntil(openApp(url || '/#/agenda'));
});
