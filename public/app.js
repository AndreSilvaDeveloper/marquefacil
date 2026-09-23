'use strict';

/* =====================================================================
   Marque Fácil — app simples para salão de beleza.
   Tudo fica salvo no próprio aparelho (localStorage).
   ===================================================================== */

// Marca do domínio (o servidor coloca window.BRAND no HTML)
const BRAND = window.BRAND || { name: 'Marque Fácil', logo: null, colors: null };
(function applyBrand() {
  const c = BRAND.colors;
  if (!c) return;
  const r = document.documentElement.style;
  if (c.brand) r.setProperty('--brand', c.brand);
  if (c.brandSoft) r.setProperty('--brand-soft', c.brandSoft);
  if (c.header) r.setProperty('--header', c.header);
  if (c.bg) r.setProperty('--bg', c.bg);
  if (c.line) r.setProperty('--line', c.line);
  document.body.classList.add('branded');
})();

const COLLS = ['clients', 'services', 'products', 'appts', 'sales', 'expenses', 'packages'];
const DEFAULT_SLOT = 30; // minutos considerados quando o horário não tem duração

/* ---------------------------- utilidades ---------------------------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const brl = v => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
function parseMoney(s) {
  s = String(s ?? '').replace(/[R$\s]/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}
const moneyVal = v => (v == null ? '' : Number(v).toFixed(2).replace('.', ','));

const pad = n => String(n).padStart(2, '0');
const dstr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => dstr(new Date());
const toDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = toDate(s); d.setDate(d.getDate() + n); return dstr(d); };
const fmtDate = (s, o) => toDate(s).toLocaleDateString('pt-BR', o);
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const fmtShort = s => fmtDate(s, { day: '2-digit', month: '2-digit', year: 'numeric' });
const weekday = s => fmtDate(s, { weekday: 'long' });
function dayName(s) {
  const t = today();
  if (s === t) return 'Hoje';
  if (s === addDays(t, 1)) return 'Amanhã';
  if (s === addDays(t, -1)) return 'Ontem';
  return weekday(s);
}
const mins = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const hhmm = m => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const nowMins = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const fmtDur = m => !m ? '' : m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${m % 60 ? pad(m % 60) : ''}`;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ---------------------------- dados ---------------------------- */
// Os dados ficam no servidor e também guardados no celular (para abrir rápido e
// funcionar sem internet). `snap` guarda como cada registro está no servidor;
// o que for diferente em `db` ainda precisa ser enviado.
function migrate(d) {
  d = d && typeof d === 'object' ? d : {};
  for (const k of COLLS) if (!Array.isArray(d[k])) d[k] = [];
  d.settings = d.settings || {};
  return d;
}
const readLS = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const writeLS = (k, v) => localStorage.setItem(k, JSON.stringify(v));

let session = readLS('mf.session'); // { user, tenant }
let db = migrate({});
let snap = {};   // "coll/id" -> JSON do registro como está no servidor
let seq = 0;     // até onde já buscamos mudanças do servidor
const cacheKey = () => `mf.data.${session.tenant.id}`;

function loadCache() {
  const c = readLS(cacheKey()) || {};
  db = migrate(c.db);
  snap = c.snap || {};
  seq = c.seq || 0;
  db.settings = { ...readLS('mf.settings'), ...db.settings };
}
function persist() {
  try {
    writeLS(cacheKey(), { db, snap, seq });
    writeLS('mf.settings', db.settings);
  } catch { alert('Não foi possível salvar! O armazenamento do celular pode estar cheio.'); }
}
function save() {
  persist();
  scheduleSync();
}

// O que mudou no celular e ainda não foi para o servidor
function pendingChanges() {
  const out = [], seen = new Set();
  for (const coll of COLLS) for (const it of db[coll]) {
    const k = coll + '/' + it.id, json = JSON.stringify(it);
    seen.add(k);
    if (snap[k] !== json) out.push({ coll, id: it.id, data: it, json });
  }
  for (const k of Object.keys(snap)) if (!seen.has(k)) {
    const [coll, id] = k.split('/');
    out.push({ coll, id, deleted: true });
  }
  return out;
}

/* ---------------------------- servidor ---------------------------- */
async function api(method, url, body) {
  let r;
  try {
    r = await fetch(url, {
      method, credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    const e = new Error('Sem internet agora.'); e.offline = true; throw e;
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || 'Algo deu errado.'); e.status = r.status; throw e; }
  return j;
}

let syncState = 'ok'; // ok | pending | offline
let syncing = null, syncTimer = null;
function scheduleSync(ms = 400) { clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, ms); }

async function syncNow() {
  if (!session) return;
  if (syncing) return syncing;
  syncing = (async () => {
    try {
      // 1) envia o que mudou aqui
      const out = pendingChanges();
      if (out.length) {
        await api('POST', '/api/sync', { changes: out.map(({ json, ...c }) => c) });
        for (const c of out) { const k = c.coll + '/' + c.id; if (c.deleted) delete snap[k]; else snap[k] = c.json; }
      }
      // 2) busca o que mudou no servidor (ex.: agendamento feito pelo link)
      const r = await api('GET', `/api/changes?since=${seq}`);
      let changed = false;
      const fromLink = [];
      for (const c of r.changes) {
        const k = c.coll + '/' + c.id, list = db[c.coll];
        if (!list) continue;
        const i = list.findIndex(x => x.id === c.id);
        const localJson = i >= 0 ? JSON.stringify(list[i]) : undefined;
        const hasLocalEdit = localJson !== snap[k];
        if (c.deleted) { delete snap[k]; if (!hasLocalEdit && i >= 0) { list.splice(i, 1); changed = true; } continue; }
        snap[k] = JSON.stringify(c.data);
        if (hasLocalEdit) continue; // a mudança feita aqui vale; vai no próximo envio
        if (i >= 0) list[i] = c.data; else list.push(c.data);
        if (i < 0 && c.coll === 'appts' && c.data.source === 'online' && seq > 0) fromLink.push(c.data);
        changed = true;
      }
      seq = r.seq;
      persist();
      syncState = pendingChanges().length ? 'pending' : 'ok';
      if (changed && !$('#app form')) render();
      if (fromLink.length) {
        const a = fromLink[fromLink.length - 1];
        const what = a.status === 'pendente' ? 'pedido' : 'agendamento';
        toast(fromLink.length > 1 ? `🌐 ${fromLink.length} ${what}s novos pelo link` : `🌐 Novo ${what} pelo link: ${clientName(a.clientId)}, ${dayName(a.date).toLowerCase()} ${a.time}`);
      }
    } catch (e) {
      if (e.status === 401) { logoutLocal(); return; }
      syncState = e.offline ? 'offline' : 'pending';
    } finally {
      syncing = null;
      paintSync();
    }
  })();
  return syncing;
}
function paintSync() {
  const el = $('#sync');
  if (!el) return;
  el.className = 'sync ' + syncState;
  el.textContent = { ok: '✓ Tudo salvo', pending: '⏳ Salvando…', offline: '📵 Sem internet — salvo no celular' }[syncState];
}

function logoutLocal() {
  session = null;
  localStorage.removeItem('mf.session');
  showLogin();
}

const client = id => db.clients.find(c => c.id === id);
const clientName = id => (id ? client(id)?.name || '(cliente apagada)' : '🧍 Balcão'); // venda sem cliente = balcão
const byName = (a, b) => a.name.localeCompare(b.name, 'pt-BR');
const byWhen = (a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || ''));

// "maria da silva" -> "Maria da Silva" (só quando foi digitado tudo minúsculo)
function niceName(name) {
  name = name.trim().replace(/\s+/g, ' ');
  if (name !== name.toLowerCase()) return name;
  return name.replace(/\S+/g, (w, i) => (i > 0 && /^(da|de|do|das|dos|e)$/.test(w)) ? w : w[0].toUpperCase() + w.slice(1));
}

// Procura pelo nome (sem ligar pra acento/maiúscula); se não existir, cria.
function findOrCreate(list, name, extra = {}) {
  const n = norm(name);
  let it = list.find(x => norm(x.name) === n);
  if (it) return it;
  it = { id: uid(), name: niceName(name), ...extra, createdAt: Date.now() };
  list.push(it);
  return it;
}
const findByName = (list, name) => list.find(x => norm(x.name) === norm(name));

function apptEnd(a) { return mins(a.time) + (a.duration || DEFAULT_SLOT); }
function isPast(a) {
  const t = today();
  return a.date < t || (a.date === t && apptEnd(a) <= nowMins());
}
function conflictsFor(date, time, duration, exceptId) {
  if (!date || !time) return [];
  const s = mins(time), e = s + (duration || DEFAULT_SLOT);
  return db.appts.filter(x => x.id !== exceptId && x.status !== 'cancelado' && x.date === date &&
    mins(x.time) < e && s < apptEnd(x)).sort(byWhen);
}

// Um valor "está devendo" quando tem preço, não foi pago e o serviço já passou/foi feito.
/* Pagamentos: cada horário/venda guarda payments = [{ v: valor, m: 'pix'|'dinheiro'|'cartao', d: 'AAAA-MM-DD' }].
   Registros antigos só têm paid: true/false — continuam valendo (pago = valor inteiro no dia do horário). */
const PAY = { pix: 'Pix', dinheiro: 'Dinheiro', cartao: 'Cartão' };
const round2 = n => Math.round(n * 100) / 100;
const valueOf = x => ('total' in x ? x.total : x.price) || 0;
function paymentsOf(x) {
  if (x.payments?.length) return x.payments;
  return x.paid && valueOf(x) > 0 ? [{ v: valueOf(x), m: x.payMethod || '', d: x.date }] : [];
}
const paidOf = x => round2(paymentsOf(x).reduce((t, p) => t + (p.v || 0), 0));
const leftOf = x => Math.max(0, round2(valueOf(x) - paidOf(x)));
const isPaid = x => (valueOf(x) > 0 ? leftOf(x) === 0 && paidOf(x) > 0 : !!x.paid);
function addPayment(x, v, m, d = today()) {
  x.payments = [...paymentsOf(x), { v: round2(v), m, d }];
  x.paid = isPaid(x);
}
function clearPayments(x) { x.payments = []; x.paid = false; }
function refreshPaid(x) { if (x.payments?.length) x.paid = leftOf(x) === 0; } // depois de mudar o valor
const methodsOf = x => [...new Set(paymentsOf(x).map(p => PAY[p.m]).filter(Boolean))].join(' + ');

const apptDue = a => a.status !== 'cancelado' && a.status !== 'pendente' && a.status !== 'prereserva' && valueOf(a) > 0 && leftOf(a) > 0 && (a.status === 'feito' || isPast(a));
const saleDue = s => valueOf(s) > 0 && leftOf(s) > 0;
function clientOwes(id) {
  return round2(db.appts.filter(a => a.clientId === id && apptDue(a)).reduce((t, a) => t + leftOf(a), 0) +
    db.sales.filter(s => s.clientId === id && saleDue(s)).reduce((t, s) => t + leftOf(s), 0));
}
function clientPaid(id) {
  return round2(db.appts.filter(a => a.clientId === id && a.status !== 'cancelado').reduce((t, a) => t + paidOf(a), 0) +
    db.sales.filter(s => s.clientId === id).reduce((t, s) => t + paidOf(s), 0));
}
// Selo de pagamento: "Pago R$ 60 (Pix)", "Pagou R$ 30 · falta R$ 30", "Não pago R$ 60"
function payBadge(x, dueWord = 'Não pago') {
  const v = valueOf(x), p = paidOf(x), how = methodsOf(x);
  if (v > 0 && isPaid(x)) return `<span class="badge ok">Pago ${brl(v)}${how ? ' · ' + how : ''}</span>`;
  if (p > 0) return `<span class="badge warn">Pagou ${brl(p)} · falta ${brl(leftOf(x))}</span>`;
  if (v > 0) return `<span class="badge warn">${dueWord} ${brl(v)}</span>`;
  return x.paid ? '<span class="badge ok">Pago</span>' : '';
}

// Janela "Receber pagamento": quanto recebeu agora e como
function paySheet(x, title, onDone) {
  const total = valueOf(x), left = leftOf(x) || total;
  let method = '';
  const bg = document.createElement('div');
  bg.className = 'sheet-bg';
  bg.innerHTML = `<div class="sheet form" role="dialog" aria-modal="true">
    <h2>💰 Receber pagamento</h2>
    <p class="muted" style="margin-top:-.3rem">${esc(title)}</p>
    ${paidOf(x) > 0 ? `<p>Valor ${brl(total)} · já pagou ${brl(paidOf(x))} · <b>falta ${brl(leftOf(x))}</b></p>` : ''}
    <div class="field"><label for="ps-v">Quanto recebeu agora?</label>
      <div class="money"><input type="text" id="ps-v" inputmode="decimal" value="${moneyVal(left)}"></div>
      <small class="hint">Se ela pagou só uma parte, troque o valor.</small></div>
    <div class="field"><span class="lbl">Como pagou?</span>
      <div class="paygrid" id="ps-m">${Object.entries(PAY).map(([k, n]) => `<button type="button" data-m="${k}">${n}</button>`).join('')}</div></div>
    <div id="ps-err"></div>
    <button class="btn ok" id="ps-ok">✓ Confirmar</button>
    <button class="btn" id="ps-no" style="margin-top:.6rem">Cancelar</button>
  </div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  const err = m => { $('#ps-err', bg).innerHTML = `<div class="error">${m}</div>`; };
  $('#ps-m', bg).onclick = e => {
    const b = e.target.closest('[data-m]');
    if (!b) return;
    method = b.dataset.m;
    bg.querySelectorAll('#ps-m button').forEach(x => x.classList.toggle('on', x === b));
  };
  $('#ps-no', bg).onclick = close;
  bg.onclick = e => { if (e.target === bg) close(); };
  $('#ps-ok', bg).onclick = () => {
    const v = parseMoney($('#ps-v', bg).value);
    if (!(v > 0)) return err('Escreva quanto recebeu. Exemplo: 50,00');
    if (total > 0 && v > left + 0.004) return err(`É mais do que falta (${brl(left)}).`);
    if (!method) return err('Toque em Pix, Dinheiro ou Cartão.');
    close();
    onDone(v, method);
  };
}

function waLink(phone, text = '') {
  let d = String(phone || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length <= 11) d = '55' + d;
  return `https://wa.me/${d}${text ? '?text=' + encodeURIComponent(text) : ''}`;
}

/* ---------------------------- navegação ---------------------------- */
// Pilha própria para o botão "Voltar" saber para onde ir.
const stack = [];
let replacing = false;
const curHash = () => location.hash || '#/agenda';
function replaceTo(hash) { replacing = true; location.replace(hash); }
function back(fallback = '#/agenda') {
  if (stack.length > 1) history.back(); else replaceTo(fallback);
}
function parseHash() {
  const h = location.hash.slice(1) || '/agenda';
  const [path, qs] = h.split('?');
  return { parts: path.split('/').filter(Boolean), q: Object.fromEntries(new URLSearchParams(qs || '')) };
}

const routes = {
  agenda: vAgenda, buscar: vBuscar, clientes: vClients, cliente: vClient, 'cliente-editar': vClientForm,
  agendar: vApptForm, agendamento: vAppt, pedidos: vPedidos, despesa: vExpenseForm, lembretes: vLembretes, venda: (id, q) => (q.id ? vSaleForm(id, q) : vSell(id, q)), financeiro: vFin, mais: vMore,
  itens: vItems, item: vItemForm, link: vLink, whatsapp: vWhats, conta: vConta, pacote: vPackageForm,
};

let lastHash = '';
function render() {
  if (!session) return showLogin();
  const { parts, q } = parseHash();
  const view = routes[parts[0]] || vAgenda;
  const v = view(parts[1], q) || {};
  $('#title').textContent = v.title || BRAND.name;
  $('#btn-back').hidden = !v.back;
  // Troca o <main> por um novo, para não acumular eventos da tela anterior
  const main = $('#app').cloneNode(false);
  main.innerHTML = v.html || '';
  $('#app').replaceWith(main);
  $$('#tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === v.tab));
  if (curHash() !== lastHash) window.scrollTo(0, 0);
  lastHash = curHash();
  v.bind?.($('#app'));
}

window.addEventListener('hashchange', () => {
  const h = curHash();
  if (replacing) { stack[stack.length - 1] = h; replacing = false; }
  else if (stack.length > 1 && stack[stack.length - 2] === h) stack.pop();
  else stack.push(h);
  render();
});
$('#btn-back').addEventListener('click', () => back());

/* ---------------------------- componentes ---------------------------- */
function badgesFor(a) {
  const b = [];
  if (a.status === 'pendente') b.push('<span class="badge warn">⏳ Aguardando você confirmar</span>');
  if (a.status === PRE) b.push(`<span class="badge pre">💳 Pré-reserva · sinal${a.price > 0 ? ' ' + brl(depositOf(a)) : ''}</span>`);
  const pos = pkgPos(a);
  if (pos && a.status !== 'cancelado') b.push(`<span class="badge">📦 ${pos.n}ª de ${pos.total}</span>`);
  if (a.serviceCustom && a.status === 'pendente') b.push('<span class="badge">✏️ Serviço escrito pela cliente</span>');
  if (a.replaces && a.status === 'pendente') {
    const old = db.appts.find(x => x.id === a.replaces);
    b.push(`<span class="badge warn">🔁 Quer remarcar${old ? ` (era ${fmtShort(old.date).slice(0, 5)} ${old.time})` : ''}</span>`);
  }
  if (a.status === 'cancelado') b.push(`<span class="badge bad">${a.cancelledBy === 'cliente' ? 'Cancelado pela cliente' : a.cancelledBy === 'remarcado' ? '🔁 Remarcado' : 'Cancelado'}</span>`);
  else if (a.status === 'feito') b.push('<span class="badge ok">✓ Feito</span>');
  if (a.status !== 'cancelado') {
    if (a.status !== 'pendente') b.push(payBadge(a, apptDue(a) ? 'Não pago' : 'A pagar'));
    if (a.priceLater && !(a.price > 0) && a.status !== 'cancelado') b.push('<span class="badge">🔎 Valor na hora</span>');
    if (conflictsFor(a.date, a.time, a.duration, a.id).length) b.push('<span class="badge warn">⚠️ Horário junto</span>');
    if (a.source === 'online') b.push('<span class="badge">🌐 Pelo link</span>');
    if (a.seriesId && !a.packageId) b.push('<span class="badge">🔁 Fixa</span>');
    const sold = salesOfAppt(a).reduce((t, x) => t + (x.qty || 1), 0);
    if (sold) b.push(`<span class="badge">🛍️ +${sold} produto${sold > 1 ? 's' : ''}</span>`);
  }
  return b.join('');
}

function apptCard(a, { showDate = false, showClient = true } = {}) {
  const conflict = a.status !== 'cancelado' && conflictsFor(a.date, a.time, a.duration, a.id).length;
  return `<a class="card appt ${a.status} ${conflict ? 'conflict' : ''}" href="#/agendamento/${a.id}">
    <div class="time">${a.time}${a.duration ? `<small>até ${hhmm(apptEnd(a))}</small>` : ''}</div>
    <div class="info">
      ${showDate ? `<b>${fmtShort(a.date)}</b>` : ''}
      ${showClient ? (showDate ? `<span>${esc(clientName(a.clientId))}</span>` : `<b>${esc(clientName(a.clientId))}</b>`) : ''}
      ${a.service ? `<span>${esc(a.service)}${a.duration ? ' · ' + fmtDur(a.duration) : ''}</span>` : ''}
      <div class="badges">${badgesFor(a)}</div>
    </div></a>`;
}

function saleCard(s, { showClient = true } = {}) {
  return `<a class="card appt" href="#/venda?id=${s.id}">
    <div class="time" style="font-size:1.6rem">🛍️</div>
    <div class="info">
      <b>${esc(s.product)}${s.qty > 1 ? ` (${s.qty}x)` : ''}</b>
      <span>${fmtShort(s.date)}${showClient ? ' · ' + esc(clientName(s.clientId)) : ''}</span>
      <div class="badges">${payBadge(s)}</div>
    </div></a>`;
}

// Autocompletar: mostra sugestões enquanto digita
function suggest(input, getItems, onPick, { showOnEmpty = false } = {}) {
  const box = input.parentElement.querySelector('.sug');
  let items = [];
  const show = () => {
    const n = norm(input.value);
    if (!n && !showOnEmpty) { box.hidden = true; return; }
    items = getItems().filter(i => norm(i.label).includes(n)).slice(0, 6);
    if (!items.length || (items.length === 1 && norm(items[0].label) === n)) { box.hidden = true; return; }
    box.innerHTML = items.map((i, k) => `<button type="button" data-k="${k}"><b>${esc(i.label)}</b>${i.sub ? `<small>${esc(i.sub)}</small>` : ''}</button>`).join('');
    box.hidden = false;
  };
  box.addEventListener('click', e => {
    const b = e.target.closest('button[data-k]');
    if (!b) return;
    const it = items[+b.dataset.k];
    input.value = it.label;
    box.hidden = true;
    onPick(it);
    input.dispatchEvent(new Event('change'));
  });
  input.addEventListener('input', show);
  input.addEventListener('focus', show);
  input.addEventListener('blur', () => setTimeout(() => (box.hidden = true), 250));
}

// Estoque: product.stock = quantidade (null = não controla); product.minStock = avisar quando chegar nisso
const hasStock = p => p && p.stock !== null && p.stock !== undefined && p.stock !== '';
const lowStock = p => hasStock(p) && p.stock <= (p.minStock ?? 2);
const lowProducts = () => db.products.filter(lowStock);
function moveStock(productName, delta) {
  const p = findByName(db.products, productName);
  if (hasStock(p)) p.stock = Math.max(0, p.stock + delta);
}
const stockLabel = p => !hasStock(p) ? '' : p.stock <= 0 ? '⚠️ Sem estoque' : lowStock(p) ? `⚠️ Acabando: ${p.stock}` : `Estoque: ${p.stock}`;

const nextInSeries = a => db.appts.filter(x => x.seriesId && x.seriesId === a.seriesId && x.id !== a.id &&
  (x.date + x.time) > (a.date + a.time) && x.status !== 'cancelado').sort(byWhen);
// Produtos vendidos junto com um atendimento (sale.apptId)
const salesOfAppt = a => db.sales.filter(x => x.apptId === a.id);
const visitTotal = a => round2(valueOf(a) + salesOfAppt(a).reduce((t, x) => t + valueOf(x), 0));
const visitLeft = a => round2(leftOf(a) + salesOfAppt(a).reduce((t, x) => t + leftOf(x), 0));

/* Pré-reserva: horário segurado esperando o sinal (status 'prereserva') */
const PRE = 'prereserva';
const depositPct = () => salonHours()?.deposit ?? 50;
const depositOf = a => (a.price > 0 ? round2(a.price * depositPct() / 100) : 0);
const preAppts = () => db.appts.filter(a => a.status === PRE && !isPast(a)).sort(byWhen);

/* Pacotes (cronogramas): várias sessões; a posição de cada horário vem da ordem das datas */
const pkgOf = id => db.packages.find(p => p.id === id);
const pkgAppts = p => db.appts.filter(a => a.packageId === p.id && a.status !== 'cancelado').sort(byWhen);
const pkgDone = p => pkgAppts(p).filter(a => a.status === 'feito' || (a.status === 'marcado' && isPast(a))).length;
const pkgLeftToBook = p => Math.max(0, p.total - pkgAppts(p).length);
const pkgActive = p => pkgDone(p) < p.total;
function pkgPos(a) {
  const p = a.packageId && pkgOf(a.packageId);
  if (!p) return null;
  const n = pkgAppts(p).findIndex(x => x.id === a.id) + 1;
  return n ? { p, n, total: p.total } : null;
}
const clientPackages = cid => db.packages.filter(p => p.clientId === cid).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

const pendingAppts = () => db.appts.filter(a => a.status === 'pendente').sort(byWhen);

// Aceitar ou recusar um pedido do link (o servidor manda a mensagem para a cliente)
function decide(a, ok, value = {}) {
  if (!ok && !confirm(`Recusar o pedido de ${clientName(a.clientId)}? Ela recebe um aviso para escolher outro horário.`)) return false;
  if (ok) {
    if (value.price > 0) { a.price = value.price; a.priceLater = false; }
    else if (value.later) a.priceLater = true;
  }
  a.status = ok ? 'marcado' : 'cancelado';
  save();
  toast(ok ? `Confirmado ✓ ${clientName(a.clientId)} vai receber a confirmação` : 'Pedido recusado');
  return true;
}

// Janela "Confirmar pedido": valor deste atendimento (se quiser) ou avaliar na hora
function confirmSheet(a, onDone) {
  let later = !!a.priceLater;
  const bg = document.createElement('div');
  bg.className = 'sheet-bg';
  bg.innerHTML = `<div class="sheet form" role="dialog" aria-modal="true">
    <h2>✓ Confirmar pedido</h2>
    <p class="muted" style="margin-top:-.3rem">${esc(clientName(a.clientId))} — ${esc(a.service || 'Serviço')}<br>${esc(dayName(a.date))}, ${fmtShort(a.date)} às ${a.time}</p>
    ${a.replaces && db.appts.find(x => x.id === a.replaces) ? `<p class="summary">🔁 Remarcação: o horário de ${fmtShort(db.appts.find(x => x.id === a.replaces).date)} às ${db.appts.find(x => x.id === a.replaces).time} será cancelado.</p>` : ''}
    <div class="field"><label for="cs-v">Valor deste atendimento <span class="opt">(se quiser)</span></label>
      <div class="money"><input type="text" id="cs-v" inputmode="decimal" placeholder="0,00" value="${moneyVal(a.price)}"></div></div>
    <button type="button" class="chip ${later ? 'on' : ''}" id="cs-later" style="width:100%">🔎 Avaliar o valor na hora do atendimento</button>
    <small class="hint">A cliente recebe a confirmação no WhatsApp com o valor (ou "avaliado na hora"). Pode deixar em branco e colocar depois.</small>
    <div id="cs-err" style="margin-top:.6rem"></div>
    <button class="btn ok" id="cs-ok" style="margin-top:.6rem">✓ Confirmar agendamento</button>
    <button class="btn" id="cs-no" style="margin-top:.6rem">Cancelar</button>
  </div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  const inp = $('#cs-v', bg), lat = $('#cs-later', bg);
  lat.onclick = () => { later = !later; lat.classList.toggle('on', later); if (later) inp.value = ''; };
  inp.oninput = () => { if (inp.value.trim()) { later = false; lat.classList.remove('on'); } };
  $('#cs-no', bg).onclick = close;
  bg.onclick = e => { if (e.target === bg) close(); };
  $('#cs-ok', bg).onclick = () => {
    const v = inp.value.trim() ? parseMoney(inp.value) : null;
    if (inp.value.trim() && v == null) { $('#cs-err', bg).innerHTML = '<div class="error">O valor não está certo. Exemplo: 80,00</div>'; return; }
    close();
    onDone({ price: v, later: !v && later });
  };
}

const clientItems = () => [...db.clients].sort(byName).map(c => ({ id: c.id, label: c.name, sub: c.phone || '' }));
const serviceItems = () => [...db.services].sort(byName).map(s => ({ id: s.id, label: s.name, sub: s.description || '' }));
const productItems = () => [...db.products].sort(byName).map(p => ({ id: p.id, label: p.name, sub: p.price ? brl(p.price) : '' }));

function nameHint(el, list, name, newMsg, okMsg) {
  if (!name.trim()) { el.textContent = ''; el.className = 'hint'; return; }
  const found = findByName(list, name);
  el.textContent = found ? okMsg : newMsg;
  el.className = 'hint ' + (found ? 'ok' : 'new');
}

// Mostra se a cliente é nova e já preenche o telefone de quem está cadastrada
function bindClientPhone(el, iClient, iPhone) {
  let auto = '';
  const upd = () => {
    nameHint($('#h-client', el), db.clients, iClient.value, '✨ Cliente nova — vai ser cadastrada sozinha', '✓ Cliente já cadastrada');
    const c = findByName(db.clients, iClient.value);
    if (!iPhone.value || iPhone.value === auto) iPhone.value = auto = c?.phone || '';
  };
  iClient.addEventListener('input', upd);
  iClient.addEventListener('change', upd);
  if (iClient.value) upd();
}

function toggle2(id, yes, labelYes, labelNo, neutral = false) {
  return `<div class="toggle2 ${neutral ? 'neutral' : ''}" id="${id}">
    <button type="button" class="yes ${yes ? 'on' : ''}" data-v="1">${labelYes}</button>
    <button type="button" class="no ${!yes ? 'on' : ''}" data-v="0">${labelNo}</button></div>`;
}
function bindToggle2(el, onChange) {
  el.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    $$('button', el).forEach(x => x.classList.toggle('on', x === b));
    onChange(b.dataset.v === '1');
  });
}

/* =====================================================================
   AGENDA DO DIA
   ===================================================================== */
// Linha do tempo de um dia: horários + espaços livres + "agora"
function dayTimeline(d, active) {
  const hours = salonHours();
  const open = hours?.days?.[toDate(d).getDay()];
  const closedDay = hours && hours.days && open === null;
  const isToday = d === today(), now = nowMins();
  const busy = active.map(a => [mins(a.time), apptEnd(a)]);
  if (open && hours.lunch) busy.push([mins(hours.lunch[0]), mins(hours.lunch[1])]);

  // espaços livres (dentro do horário de atendimento; sem ele, só entre um horário e outro)
  const gaps = [];
  let cursor = open ? mins(open[0]) : (active.length ? apptEnd(active[0]) : null);
  const limit = open ? mins(open[1]) : (active.length ? mins(active.at(-1).time) : null);
  if (cursor !== null) {
    for (const [st, en] of [...busy].sort((a, b) => a[0] - b[0])) {
      if (st > cursor) gaps.push([cursor, Math.min(st, limit)]);
      cursor = Math.max(cursor, en);
    }
    if (limit > cursor) gaps.push([cursor, limit]);
  }
  const freeGaps = gaps
    .map(([a, b]) => [isToday ? Math.max(a, Math.ceil(now / 5) * 5) : a, b])
    .filter(([a, b]) => b - a >= 30 && (!isToday || b > now) && (d >= today()));

  const items = [
    ...active.map(a => ({ t: mins(a.time), html: apptRow(a) })),
    ...freeGaps.map(([a, b]) => ({ t: a, html: `<a class="gap" href="#/agendar?d=${d}&t=${hhmm(a)}">
      <span>🟢 Livre das <b>${hhmm(a)}</b> às <b>${hhmm(b)}</b> · ${fmtDur(b - a)}</span><em>+ Agendar</em></a>` })),
  ];
  if (open && hours.lunch && !(isToday && mins(hours.lunch[1]) <= now)) items.push({ t: mins(hours.lunch[0]), html: `<div class="lunch">🍽️ Almoço ${hours.lunch[0]}–${hours.lunch[1]}</div>` });
  if (isToday && active.length) items.push({ t: now + 0.5, html: `<div class="nowline"><span>agora ${hhmm(now)}</span></div>` });
  items.sort((a, b) => a.t - b.t);
  return { html: items.map(x => x.html).join(''), closedDay, open };
}

// Cartão do horário + botão rápido "Feito" quando já passou
function apptRow(a) {
  const quick = a.status === 'marcado' && isPast(a) ? `<button class="quick-done" data-done="${a.id}">✓ Feito</button>` : '';
  return quick ? `<div class="appt-wrap">${apptCard(a)}${quick}</div>` : apptCard(a);
}

function weekStart(d) { const x = toDate(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return dstr(x); } // segunda-feira

function vAgenda(_, q) {
  const d = q.d || today();
  const t = today();
  const view = q.v === 'semana' ? 'semana' : 'dia';
  const pend = pendingAppts();
  const url = o => `#/agenda?${Object.entries({ d, v: view === 'semana' ? 'semana' : '', ...o }).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('&')}`;
  const step = view === 'semana' ? 7 : 1;

  const week = [];
  for (let i = -3; i <= 3; i++) {
    const day = addDays(d, i);
    const n = db.appts.filter(a => a.date === day && a.status !== 'cancelado').length;
    week.push(`<a href="${url({ d: day })}" data-nav class="${day === d ? 'on' : ''} ${day === t ? 'today' : ''}">
      ${fmtDate(day, { weekday: 'short' }).replace('.', '')}<b>${toDate(day).getDate()}</b><i>${n || ''}</i></a>`);
  }

  let body = '', title = '';
  if (view === 'dia') {
    const list = db.appts.filter(a => a.date === d).sort(byWhen);
    const active = list.filter(a => a.status !== 'cancelado');
    const cancelled = list.filter(a => a.status === 'cancelado');
    const done = active.filter(a => a.status === 'feito').length;
    const expectedDay = round2(active.filter(a => a.status !== 'pendente').reduce((s, a) => s + valueOf(a), 0));
    const tl = dayTimeline(d, active);
    title = `<div class="label"><b>${dayName(d)}</b><span>${fmtDate(d, { day: 'numeric', month: 'long', year: 'numeric' })}</span></div>`;
    body = `
      ${active.length ? `<div class="daysum">
        <span><b>${active.length}</b> ${active.length === 1 ? 'horário' : 'horários'}</span>
        ${done ? `<span><b>${done}</b> ${done === 1 ? 'feito' : 'feitos'}</span>` : ''}
        ${expectedDay ? `<span>💰 <b>${brl(expectedDay)}</b></span>` : ''}
      </div>` : ''}
      ${tl.closedDay ? '<div class="muted" style="text-align:center;margin:.5rem 0">🔒 Dia fechado no seu horário de atendimento.</div>' : ''}
      <div class="list timeline">
        ${tl.html || `<div class="empty">Nenhum horário marcado neste dia.${d >= t ? `<br><a class="btn main" href="#/agendar?d=${d}" style="margin-top:1rem">📅 Agendar neste dia</a>` : ''}</div>`}
      </div>
      ${!salonHours() && active.length ? '<p class="muted" style="font-size:.85rem">Dica: configure seus dias e horários em Mais → Link para ver aqui os horários livres do dia todo.</p>' : ''}
      ${cancelled.length ? `<details class="cancelled"><summary>Cancelados (${cancelled.length})</summary><div class="list">${cancelled.map(a => apptCard(a)).join('')}</div></details>` : ''}`;
  } else {
    const ws = weekStart(d);
    const hours = salonHours();
    const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
    title = `<div class="label"><b>Semana</b><span>${fmtDate(ws, { day: 'numeric', month: 'short' }).replace('.', '')} a ${fmtDate(days[6], { day: 'numeric', month: 'short' }).replace('.', '')}</span></div>`;
    body = `<div class="weeklist">${days.map(day => {
      const list = db.appts.filter(a => a.date === day && a.status !== 'cancelado').sort(byWhen);
      const closed = hours?.days && hours.days[toDate(day).getDay()] === null;
      return `<div class="wday ${day === t ? 'today' : ''}">
        <a class="wday-head" href="${url({ d: day, v: '' })}" data-nav>
          <b>${cap(fmtDate(day, { weekday: 'long' }))}</b> <span>${fmtShort(day).slice(0, 5)}</span>
          <em>${list.length ? `${list.length} ${list.length === 1 ? 'horário' : 'horários'}` : closed ? 'Fechado' : 'Livre'} ›</em></a>
        ${list.map(a => `<a class="wrow ${a.status}" href="#/agendamento/${a.id}"><b>${a.time}</b> ${esc(clientName(a.clientId))}${a.service ? ` <span>· ${esc(a.service)}</span>` : ''}${a.status === 'pendente' ? ' <span class="badge warn">⏳</span>' : ''}</a>`).join('')}
      </div>`;
    }).join('')}</div>`;
  }

  return {
    title: 'Agenda', tab: 'agenda',
    html: `
      <div class="viewtoggle">
        <a href="${url({ v: '' })}" data-nav class="${view === 'dia' ? 'on' : ''}">Dia</a>
        <a href="${url({ v: 'semana' })}" data-nav class="${view === 'semana' ? 'on' : ''}">Semana</a>
      </div>
      <div class="daynav">
        <button class="arrow" id="prev" aria-label="Anterior">‹</button>
        ${title}
        <button class="arrow" id="next" aria-label="Próximo">›</button>
      </div>
      ${view === 'dia' ? `<div class="week">${week.join('')}</div>` : ''}
      <div class="row" style="margin-bottom:1rem">
        ${(view === 'dia' ? d !== t : weekStart(d) !== weekStart(t)) ? `<a class="btn small" href="${url({ d: t })}" data-nav>Voltar para hoje</a>` : ''}
        <label class="btn small" style="position:relative">📆 Escolher dia
          <input type="date" id="pick" value="${d}" style="position:absolute;inset:0;opacity:0;min-height:0"></label>
      </div>
      ${preAppts().length ? `<a class="card pending-banner pre" href="#/buscar?k=prereservas">💳 <b>${preAppts().length} ${preAppts().length === 1 ? 'pré-reserva' : 'pré-reservas'}</b> esperando o sinal ›</a>` : ''}
      ${pend.length ? `<a class="card pending-banner" href="#/pedidos">⏳ <b>${pend.length} ${pend.length === 1 ? 'pedido esperando' : 'pedidos esperando'}</b> você confirmar ›</a>` : ''}
      ${d === t && view === 'dia' && tomorrowList().length ? `<a class="btn" href="#/lembretes" style="margin-bottom:1rem">💬 Lembrar clientes de amanhã (${tomorrowList().filter(x => !x.remindedAt).length} de ${tomorrowList().length})</a>` : ''}
      <div id="push-card"></div>
      ${body}
      <div class="fabs">
        <a class="fab sell" href="#/venda">🛍️ Vender</a>
        <a class="fab" href="#/agendar?d=${d}">📅 Agendar</a>
      </div>`,
    bind(el) {
      const goDay = n => replaceTo(url({ d: addDays(d, n * step) }));
      $('#prev', el).onclick = () => goDay(-1);
      $('#next', el).onclick = () => goDay(1);
      $('#pick', el).onchange = e => e.target.value && replaceTo(url({ d: e.target.value }));
      el.addEventListener('click', e => {
        const nav = e.target.closest('a[data-nav]');
        if (nav) { e.preventDefault(); replaceTo(nav.getAttribute('href')); return; }
        const done = e.target.closest('[data-done]');
        if (done) {
          const a = db.appts.find(x => x.id === done.dataset.done);
          if (a) { a.status = 'feito'; save(); toast(`${clientName(a.clientId)}: atendimento feito ✓`); render(); }
        }
      });
      // arrastar para o lado troca de dia (ou de semana)
      let x0 = null, y0 = null;
      el.addEventListener('touchstart', e => { if (e.target.closest('.week, input, .sheet')) return; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
      el.addEventListener('touchend', e => {
        if (x0 === null) return;
        const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
        x0 = null;
        if (Math.abs(dx) > 70 && Math.abs(dy) < 50) goDay(dx < 0 ? 1 : -1);
      }, { passive: true });
      paintPushCard($('#push-card', el));
    },
  };
}

/* =====================================================================
   NOVO AGENDAMENTO / EDITAR
   ===================================================================== */
// Aceita "12:10", "1210", "930", "9", "12h10" -> "12:10" (ou null se inválido)
function parseTime(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (!d || d.length > 4) return null;
  const h = +(d.length <= 2 ? d : d.slice(0, -2)), m = +(d.length <= 2 ? 0 : d.slice(-2));
  return h < 24 && m < 60 ? hhmm(h * 60 + m) : null;
}
// Enquanto digita: "1210" vira "12:10"
function maskTime(input) {
  input.addEventListener('input', () => {
    const d = input.value.replace(/\D/g, '').slice(0, 4);
    input.value = d.length >= 3 ? d.slice(0, -2) + ':' + d.slice(-2) : d;
  });
  input.addEventListener('blur', () => { const t = parseTime(input.value); if (t) input.value = t; });
}
function busyList(date, exceptId) {
  const list = db.appts.filter(a => a.date === date && a.status !== 'cancelado' && a.id !== exceptId).sort(byWhen);
  if (!list.length) return '<small class="hint">Nenhum horário ocupado neste dia.</small>';
  return `<small class="hint">Já ocupados neste dia: ${list.map(a =>
    `<b>${a.time}${a.duration ? '–' + hhmm(apptEnd(a)) : ''}</b> ${esc(clientName(a.clientId))}`).join(' · ')}</small>`;
}

// Horários livres de um dia para um serviço de `duration` minutos (usa o horário de atendimento guardado)
function freeStarts(date, duration, exceptId, step = 30) {
  const hours = salonHours();
  const open = hours?.days?.[toDate(date).getDay()];
  if (!open || date < today()) return [];
  const busy = db.appts.filter(a => a.date === date && a.status !== 'cancelado' && a.id !== exceptId).map(a => [mins(a.time), apptEnd(a)]);
  if (hours.lunch) busy.push([mins(hours.lunch[0]), mins(hours.lunch[1])]);
  const earliest = date === today() ? Math.ceil((nowMins() + 1) / step) * step : 0;
  const out = [];
  for (let t = mins(open[0]); t + duration <= mins(open[1]); t += step) {
    if (t < earliest) continue;
    if (!busy.some(([a, b]) => t < b && a < t + duration)) out.push(hhmm(t));
  }
  return out;
}
// Clientes usadas por último (para um toque)
function recentClients(n = 6) {
  const seen = new Set(), out = [];
  for (const a of [...db.appts].sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0))) {
    if (seen.has(a.clientId) || !client(a.clientId)) continue;
    seen.add(a.clientId); out.push(client(a.clientId));
    if (out.length === n) break;
  }
  return out;
}
// Serviços mais usados
function topServices(n = 6) {
  const count = {};
  for (const a of db.appts) if (a.service) count[norm(a.service)] = (count[norm(a.service)] || 0) + 1;
  return [...db.services].sort((a, b) => (count[norm(b.name)] || 0) - (count[norm(a.name)] || 0) || byName(a, b)).slice(0, n);
}

// Datas de uma cliente fixa: every = 7, 14 (dias) ou 'm' (todo mês), por `months` meses
function seriesDates(start, every, months) {
  if (!start) return [];
  const end = toDate(start); end.setMonth(end.getMonth() + months);
  const out = [];
  if (every === 'm') {
    const s0 = toDate(start);
    for (let i = 0; i <= months; i++) {
      const d = new Date(s0.getFullYear(), s0.getMonth() + i, 1);
      d.setDate(Math.min(s0.getDate(), new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
      if (d <= end) out.push(dstr(d));
    }
  } else {
    for (let d = start; toDate(d) <= end; d = addDays(d, +every)) out.push(d);
  }
  return out;
}
// Datas até completar `count` sessões (pacote)
function seriesByCount(start, every, count) {
  if (!start || count < 1) return [];
  const out = [start];
  const s0 = toDate(start);
  for (let i = 1; out.length < count; i++) {
    if (every === 'm') {
      const d = new Date(s0.getFullYear(), s0.getMonth() + i, 1);
      d.setDate(Math.min(s0.getDate(), new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
      out.push(dstr(d));
    } else out.push(addDays(start, i * +every));
  }
  return out;
}
const seriesLabel = e => ({ 7: 'toda semana', 14: 'a cada 15 dias', m: 'todo mês' }[e] || 'repetindo');

function vApptForm(_, q) {
  const edit = q.id ? db.appts.find(a => a.id === q.id) : null;
  const a = edit || { date: q.d || today(), time: TIME_RE.test(q.t || '') ? q.t : '', clientId: q.c || '', service: '', duration: null, price: null, paid: false, notes: '' };
  const cName = a.clientId ? clientName(a.clientId) : '';
  const durs = [30, 60, 90, 120, 180];
  let dur = a.duration || null;
  let paid = isPaid(a);
  let pre = a.status === PRE;
  let pkgId = a.packageId || (q.pk && pkgOf(q.pk) ? q.pk : '');
  let method = paymentsOf(a).at(-1)?.m || '';

  return {
    title: edit ? 'Editar horário' : 'Novo horário', tab: 'agenda', back: true,
    html: `
      <form class="form" id="f" autocomplete="off" novalidate>
        <div id="err"></div>

        <div class="field">
          <label for="f-client">Nome da cliente <em>*</em></label>
          <div class="ac"><input type="text" id="f-client" value="${esc(cName)}" placeholder="Digite o nome" autocapitalize="words"><div class="sug" hidden></div></div>
          <small id="h-client" class="hint"></small>
          ${!cName && recentClients().length ? `<div class="chips mini" id="recent" style="margin-top:.5rem"><span class="muted">Recentes:</span>
            ${recentClients().map(c => `<button type="button" class="chip" data-cid="${c.id}">${esc(c.name.split(' ').slice(0, 2).join(' '))}</button>`).join('')}</div>` : ''}
          <div id="c-info"></div>
        </div>

        <div class="field">
          <label for="f-phone">Telefone / WhatsApp <span class="opt">(se quiser)</span></label>
          <input type="tel" id="f-phone" value="${esc(client(a.clientId)?.phone || '')}" placeholder="(11) 99999-9999">
        </div>

        <div class="field">
          <span class="lbl">Dia <em>*</em></span>
          <div class="daychips" id="days">
            ${Array.from({ length: 7 }, (_, i) => addDays(today(), i)).map((d, i) => `<button type="button" data-day="${d}">
              <small>${i === 0 ? 'Hoje' : i === 1 ? 'Amanhã' : fmtDate(d, { weekday: 'short' }).replace('.', '')}</small><b>${toDate(d).getDate()}</b></button>`).join('')}
            <label class="other-day"><small>Outro</small><b>📆</b><input type="date" id="f-date" value="${a.date}"></label>
          </div>
          <small class="hint" id="date-label"></small>
        </div>

        <div class="field">
          <label for="f-time">Horário <em>*</em></label>
          <div id="free"></div>
          <input type="text" id="f-time" inputmode="numeric" maxlength="5" value="${a.time}" placeholder="Ou digite: 12:10" style="font-size:1.3rem;font-weight:700;max-width:12rem">
          <div id="busy">${busyList(a.date, a.id)}</div>
          <div id="conflict"></div>
        </div>

        <div class="field">
          <label for="f-service">Serviço <span class="opt">(se quiser)</span></label>
          ${topServices().length ? `<div class="chips mini" id="svc-chips" style="margin-bottom:.5rem">${topServices().map(sv => `<button type="button" class="chip" data-svc="${esc(sv.name)}">${esc(sv.name)}</button>`).join('')}</div>` : ''}
          <div class="ac"><input type="text" id="f-service" value="${esc(a.service || '')}" placeholder="Ou escreva: Escova, Unha, Corte…" autocapitalize="sentences"><div class="sug" hidden></div></div>
          <small id="h-service" class="hint"></small>
        </div>

        <div class="field">
          <span class="lbl">Quanto tempo demora? <span class="opt">(se quiser)</span></span>
          <div class="chips" id="durs">
            ${durs.map(m => `<button type="button" class="chip" data-m="${m}">${fmtDur(m)}</button>`).join('')}
            <span class="chip" id="dur-other">Outro: <input type="number" id="f-dur" inputmode="numeric" min="5" step="5" placeholder="min"> min</span>
          </div>
        </div>

        <div class="field">
          <span class="lbl">Como fica este horário?</span>
          ${toggle2('f-kind', a.status !== PRE, '✅ Confirmado', '💳 Pré-reserva')}
          <small class="hint" id="kind-hint"></small>
        </div>

        <div id="pkgbox"></div>

        <details class="more" ${edit && (a.price > 0 || a.priceLater || a.notes || paid) ? 'open' : ''}>
          <summary>➕ Mais detalhes <small>${edit ? 'valor, pagamento, observação' : 'repetir, valor, pagamento, observação'}</small></summary>

        ${edit ? '' : `<div class="field">
          <span class="lbl">Cliente fixa? Repetir este horário <span class="opt">(se quiser)</span></span>
          <div class="chips" id="rep">
            <button type="button" class="chip on" data-r="">Não</button>
            <button type="button" class="chip" data-r="7">Toda semana</button>
            <button type="button" class="chip" data-r="14">A cada 15 dias</button>
            <button type="button" class="chip" data-r="m">Todo mês</button>
          </div>
          <div id="rep-for" hidden style="margin-top:.6rem">
            <label for="rep-months">Por quanto tempo?</label>
            <select id="rep-months">${[1, 2, 3, 6, 12].map(n => `<option value="${n}" ${n === 3 ? 'selected' : ''}>${n === 12 ? '1 ano' : n + (n === 1 ? ' mês' : ' meses')}</option>`).join('')}</select>
            <small class="hint" id="rep-hint"></small>
          </div>
        </div>`}

        <div class="field">
          <label for="f-price">Valor deste atendimento <span class="opt">(se quiser)</span></label>
          <div class="money"><input type="text" id="f-price" inputmode="decimal" placeholder="0,00" value="${moneyVal(a.price)}"></div>
          <button type="button" class="chip ${a.priceLater && !(a.price > 0) ? 'on' : ''}" id="f-later" style="margin-top:.5rem">🔎 Avaliar na hora</button>
        </div>

        <div class="field">
          <span class="lbl">Já está pago?</span>
          ${toggle2('f-paid', paid, '✓ Já pagou', 'Ainda não')}
          <div class="paygrid" id="f-method" style="margin-top:.5rem" ${paid ? '' : 'hidden'}>
            ${Object.entries(PAY).map(([k, n]) => `<button type="button" data-m="${k}" class="${method === k ? 'on' : ''}">${n}</button>`).join('')}</div>
        </div>

        <div class="field">
          <label for="f-notes">Observação <span class="opt">(se quiser)</span></label>
          <textarea id="f-notes" placeholder="Algo para lembrar…">${esc(a.notes || '')}</textarea>
        </div>
        </details>

        <div class="savebar">
          <div id="sum" class="sum"></div>
          <button class="btn main" id="save" type="submit">${edit ? 'Salvar alterações' : '✓ Agendar'}</button>
        </div>
      </form>`,
    bind(el) {
      const f = $('#f', el);
      const iClient = $('#f-client', el), iDate = $('#f-date', el), iTime = $('#f-time', el);
      const iService = $('#f-service', el), iPrice = $('#f-price', el), iDur = $('#f-dur', el);
      const saveBtn = $('#save', el);

      const paintDur = () => {
        $$('#durs .chip[data-m]', el).forEach(c => c.classList.toggle('on', +c.dataset.m === dur));
        const other = dur && !durs.includes(dur);
        $('#dur-other', el).classList.toggle('on', !!other);
        if (other) iDur.value = dur;
        else if (document.activeElement !== iDur) iDur.value = '';
      };
      const checkConflict = () => {
        const list = conflictsFor(iDate.value, parseTime(iTime.value), dur, a.id);
        $('#conflict', el).innerHTML = list.length ? `<div class="conflict-box">⚠️ Atenção: nesse horário já tem
          ${list.map(x => `<b>${esc(clientName(x.clientId))}</b> (${x.time}${x.duration ? '–' + hhmm(apptEnd(x)) : ''})`).join(', ')}.
          <br>Você pode agendar mesmo assim, se quiser.</div>` : '';
        saveBtn.textContent = list.length ? '⚠️ Agendar mesmo assim' : (edit ? 'Salvar alterações' : '✓ Agendar');
        saveBtn.classList.toggle('warn', !!list.length);
        saveBtn.classList.toggle('main', !list.length);
      };
      // Resumo embaixo, junto do botão de salvar
      const paintSum = () => {
        const t = parseTime(iTime.value), d = iDate.value;
        const ask = w => `<span class="muted">${w}?</span>`;
        const parts = [
          iClient.value.trim() ? esc(iClient.value.trim()) : ask('cliente'),
          d ? esc(cap(fmtDate(d, { weekday: 'short', day: '2-digit', month: '2-digit' }).replace('.,', ''))) : ask('dia'),
          t ? `${t}${dur ? '–' + hhmm(mins(t) + dur) : ''}` : ask('hora'),
        ];
        if (iService.value.trim()) parts.push(esc(iService.value.trim()));
        $('#sum', el).innerHTML = parts.join(' · ');
      };
      // Horários livres do dia (botões)
      const paintFree = () => {
        const list = iDate.value ? freeStarts(iDate.value, dur || 30, a.id) : [];
        const cur = parseTime(iTime.value);
        iTime.placeholder = list.length ? 'Ou digite: 12:10' : 'Ex.: 12:10';
        $('#free', el).innerHTML = list.length ? `<div class="chips mini" style="margin-bottom:.5rem"><span class="muted">Livres:</span>
          ${list.slice(0, 16).map(t => `<button type="button" class="chip ${t === cur ? 'on' : ''}" data-t="${t}">${t}</button>`).join('')}</div>`
          : (salonHours()?.days && iDate.value >= today() && !salonHours().days[toDate(iDate.value).getDay()] ? '<small class="hint">Dia fechado no seu horário de atendimento (pode agendar mesmo assim).</small>' : '');
      };
      const paintDay = () => {
        el.querySelectorAll('#days [data-day]').forEach(b => b.classList.toggle('on', b.dataset.day === iDate.value));
        const inWeek = [...el.querySelectorAll('#days [data-day]')].some(b => b.dataset.day === iDate.value);
        $('.other-day', el).classList.toggle('on', !inWeek && !!iDate.value);
        $('#date-label', el).textContent = iDate.value ? cap(fmtDate(iDate.value, { weekday: 'long', day: 'numeric', month: 'long' })) : '';
      };
      const refreshTimes = () => { $('#busy', el).innerHTML = busyList(iDate.value, a.id); checkConflict(); paintRep(); paintFree(); paintDay(); paintSum(); };

      // Repetição: datas que vão ser marcadas
      let every = '';
      // pacote escolhido: "repetir" marca exatamente as sessões que faltam
      const pkgLeft = () => { const p = pkgId && pkgOf(pkgId); return p ? pkgLeftToBook(p) : 0; };
      const repDates = () => {
        if (!every) return [iDate.value];
        if (pkgId && pkgLeft() > 0) return seriesByCount(iDate.value, every, pkgLeft());
        return seriesDates(iDate.value, every, +($('#rep-months', el)?.value || 3));
      };
      const paintRep = () => {
        if (!$('#rep', el)) return;
        $('#rep-for', el).hidden = !every;
        if (!every || !iDate.value) return;
        const ds = repDates();
        $('#rep-hint', el).textContent = `Vai marcar ${ds.length} horários, de ${fmtShort(ds[0])} até ${fmtShort(ds.at(-1))}.`;
      };
      $('#rep', el)?.addEventListener('click', e => {
        const b = e.target.closest('[data-r]');
        if (!b) return;
        every = b.dataset.r;
        el.querySelectorAll('#rep .chip').forEach(x => x.classList.toggle('on', x === b));
        paintRep();
      });
      $('#rep-months', el)?.addEventListener('change', paintRep);

      suggest(iClient, clientItems, () => {});
      bindClientPhone(el, iClient, $('#f-phone', el));

      // Serviço já conhecido: completa tempo e valor (sem apagar o que ela já escreveu)
      const fillFromService = s => {
        if (s?.duration && !dur) { dur = s.duration; paintDur(); checkConflict(); paintFree(); }
        paintSum();
      };
      const onService = () => {
        nameHint($('#h-service', el), db.services, iService.value, '✨ Serviço novo — vai ficar salvo na lista', '✓ Serviço da sua lista');
      };
      suggest(iService, serviceItems, it => {
        const s = db.services.find(x => x.id === it.id);
        if (s?.duration) dur = null; // escolheu da lista: usa o tempo do serviço
        fillFromService(s);
      }, { showOnEmpty: true });
      iService.addEventListener('input', onService);
      iService.addEventListener('change', () => { onService(); fillFromService(findByName(db.services, iService.value)); });

      $('#durs', el).addEventListener('click', e => {
        const c = e.target.closest('.chip[data-m]');
        if (!c) return;
        dur = dur === +c.dataset.m ? null : +c.dataset.m;
        paintDur(); checkConflict(); paintFree(); paintSum();
      });
      iDur.addEventListener('input', () => { const n = parseInt(iDur.value, 10); dur = n > 0 ? n : null; paintDur(); checkConflict(); paintFree(); paintSum(); });

      $$('[data-day]', el).forEach(b => b.onclick = () => { iDate.value = b.dataset.day; refreshTimes(); });
      iDate.addEventListener('change', refreshTimes);
      maskTime(iTime);
      iTime.addEventListener('input', () => { checkConflict(); paintFree(); paintSum(); });
      $('#free', el).addEventListener('click', e => {
        const b = e.target.closest('[data-t]');
        if (!b) return;
        iTime.value = b.dataset.t;
        checkConflict(); paintFree(); paintSum();
      });
      // Clientes recentes e informações da cliente
      const paintClient = () => {
        const c = findByName(db.clients, iClient.value);
        if (!c) { $('#c-info', el).innerHTML = ''; return; }
        const st = clientStats(c);
        const bits = [];
        if (c.notes) bits.push(`<div class="note" style="margin:.5rem 0 0">📝 ${esc(c.notes)}</div>`);
        const line = [st.last ? `Última vez ${daysAgo(st.last.date)}${st.last.service ? ' · ' + esc(st.last.service) : ''}` : 'Primeira vez',
          st.owes > 0 ? `<b style="color:var(--warn)">deve ${brl(st.owes)}</b>` : ''].filter(Boolean).join(' · ');
        bits.unshift(`<small class="hint">${line}</small>`);
        $('#c-info', el).innerHTML = bits.join('');
      };
      $('#recent', el)?.addEventListener('click', e => {
        const b = e.target.closest('[data-cid]');
        const c = b && client(b.dataset.cid);
        if (!c) return;
        iClient.value = c.name;
        iClient.dispatchEvent(new Event('change'));
        $('#recent', el).remove();
      });
      iClient.addEventListener('input', () => { paintClient(); paintSum(); });
      iClient.addEventListener('change', () => { paintClient(); paintSum(); });
      $('#svc-chips', el)?.addEventListener('click', e => {
        const b = e.target.closest('[data-svc]');
        if (!b) return;
        iService.value = b.dataset.svc;
        const sv = findByName(db.services, b.dataset.svc);
        if (sv?.duration) dur = null;
        iService.dispatchEvent(new Event('change'));
        el.querySelectorAll('#svc-chips .chip').forEach(x => x.classList.toggle('on', x === b));
      });
      iService.addEventListener('input', paintSum);
      bindToggle2($('#f-paid', el), v => { paid = v; $('#f-method', el).hidden = !v; });
      $('#f-method', el).onclick = e => {
        const b = e.target.closest('[data-m]');
        if (!b) return;
        method = b.dataset.m;
        el.querySelectorAll('#f-method button').forEach(x => x.classList.toggle('on', x === b));
      };
      // Confirmado ou pré-reserva
      const paintKind = () => {
        $('#kind-hint', el).textContent = pre
          ? `O horário fica segurado e a cliente recebe a mensagem de pré-reserva pedindo o sinal (${depositPct()}%). Sem lembrete até confirmar.`
          : 'A cliente recebe a confirmação no WhatsApp (se tiver telefone).';
      };
      bindToggle2($('#f-kind', el), v => { pre = !v; paintKind(); });
      paintKind();
      // Pacote da cliente
      const paintPkg = () => {
        const c = findByName(db.clients, iClient.value);
        const list = c ? clientPackages(c.id).filter(p => pkgActive(p) || p.id === pkgId) : [];
        if (pkgId && !list.some(p => p.id === pkgId)) pkgId = '';
        if (!list.length) { $('#pkgbox', el).innerHTML = c ? `<p class="muted" style="margin:-.4rem 0 1rem;font-size:.9rem">📦 Faz cronograma? <a href="#/pacote?c=${c.id}">Criar um pacote</a></p>` : ''; return; }
        const nextN = p => (edit?.packageId === p.id ? (pkgPos(edit)?.n || 1) : pkgAppts(p).length + 1);
        $('#pkgbox', el).innerHTML = `<div class="field"><span class="lbl">📦 Faz parte de um pacote?</span>
          <div class="pick" id="pkgs">${list.map(p => `<button type="button" data-pk="${p.id}" class="${p.id === pkgId ? 'on' : ''}">${esc(p.name)}
            <small>Esta será a <b>${Math.min(nextN(p), p.total)}ª de ${p.total}</b> · ${pkgDone(p)} ${pkgDone(p) === 1 ? 'feita' : 'feitas'}</small></button>`).join('')}
            <button type="button" data-pk="" class="${!pkgId ? 'on' : ''}">Não, horário avulso</button></div>
          ${pkgId && !edit && pkgLeft() > 1 ? `<div class="chips mini" id="pkg-rep" style="margin-top:.6rem"><span class="muted">Marcar as ${pkgLeft()} sessões que faltam:</span>
            ${[['', 'Só esta'], ['7', 'Toda semana'], ['14', 'A cada 15 dias'], ['m', 'Todo mês']].map(([r, n]) => `<button type="button" class="chip ${every === r ? 'on' : ''}" data-r="${r}">${n}</button>`).join('')}</div>
            ${every ? `<small class="hint">Vai marcar ${repDates().length} horários, de ${fmtShort(repDates()[0])} até ${fmtShort(repDates().at(-1))}.</small>` : ''}` : ''}</div>`;
      };
      $('#pkgbox', el).addEventListener('click', e => {
        const b = e.target.closest('[data-pk]');
        if (b) {
          pkgId = b.dataset.pk;
          const p = pkgOf(pkgId);
          if (p && !iService.value.trim()) { iService.value = p.service || p.name; iService.dispatchEvent(new Event('change')); }
          if (!pkgId) every = '';
          paintPkg(); paintSum();
          return;
        }
        const r = e.target.closest('#pkg-rep [data-r]');
        if (r) { every = r.dataset.r; paintPkg(); paintRep(); }
      });
      iClient.addEventListener('change', paintPkg);
      iClient.addEventListener('input', paintPkg);
      paintPkg();
      // veio de "marcar a próxima sessão": o serviço é o do pacote
      if (pkgId && !edit && !iService.value.trim()) { const p0 = pkgOf(pkgId); iService.value = p0.service || p0.name; iService.dispatchEvent(new Event('change')); }
      $('#f-later', el).onclick = e => { const on = !e.currentTarget.classList.contains('on'); e.currentTarget.classList.toggle('on', on); if (on) iPrice.value = ''; };
      iPrice.addEventListener('input', () => { if (iPrice.value.trim()) $('#f-later', el).classList.remove('on'); });

      paintDur(); checkConflict(); paintFree(); paintDay(); paintSum();
      if (cName) iClient.dispatchEvent(new Event('change'));
      if (a.service) onService();
      if (!cName) setTimeout(() => iClient.focus(), 50);

      f.addEventListener('submit', e => {
        e.preventDefault();
        const err = msg => { $('#err', el).innerHTML = `<div class="error">${msg}</div>`; window.scrollTo(0, 0); };
        const name = iClient.value.trim();
        if (!name) { err('Escreva o nome da cliente.'); iClient.focus(); return; }
        if (!iDate.value) { err('Escolha o dia.'); return; }
        if (paid && !method && parseMoney(iPrice.value) > 0) $('details.more', el).open = true;
        const time = parseTime(iTime.value);
        if (!time) { err(iTime.value.trim() ? 'O horário não está certo. Exemplo: 12:10' : 'Escreva o horário. Exemplo: 12:10'); iTime.focus(); return; }
        const price = parseMoney(iPrice.value);
        if (iPrice.value.trim() && price == null) { err('O valor não está certo. Exemplo: 50,00'); iPrice.focus(); return; }
        if (paid && price > 0 && !isPaid({ ...a, price }) && !method) { err('Toque em Pix, Dinheiro ou Cartão (como pagou).'); return; }

        const c = findOrCreate(db.clients, name, { phone: '', notes: '' });
        const phone = $('#f-phone', el).value.trim();
        if (phone) c.phone = phone;
        const svcName = iService.value.trim();
        if (svcName) {
          const s = findOrCreate(db.services, svcName, { duration: dur, description: '' });
          if (!s.duration && dur) s.duration = dur;
        }
        const data = {
          clientId: c.id, date: iDate.value, time,
          service: svcName ? findByName(db.services, svcName).name : '',
          duration: dur, price, notes: $('#f-notes', el).value.trim(),
          priceLater: !(price > 0) && $('#f-later', el).classList.contains('on'),
          packageId: pkgId || undefined,
        };
        if (!data.packageId) delete data.packageId;
        // pagamento: "Já pagou" lança o que falta; "Ainda não" desfaz
        const setPay = x => {
          if (!paid) { if (isPaid(x) || x.paid) clearPayments(x); return; }
          if (!(x.price > 0)) { x.paid = true; return; }
          refreshPaid(x);
          if (!isPaid(x)) addPayment(x, leftOf(x) || x.price, method);
        };
        if (edit) {
          Object.assign(edit, data);
          if (!pkgId) delete edit.packageId;
          if (edit.status === 'marcado' && pre) edit.status = PRE;
          else if (edit.status === PRE && !pre) edit.status = 'marcado';
          setPay(edit);
        }
        else {
          const dates = repDates();
          const seriesId = dates.length > 1 ? uid() : null;
          let clash = 0;
          dates.forEach((date, i) => {
            if (conflictsFor(date, time, dur, null).length) clash++;
            const n = { id: uid(), status: pre ? PRE : 'marcado', createdAt: Date.now(), ...data, date, paid: false };
            if (seriesId) Object.assign(n, { seriesId, seriesIndex: i, seriesEvery: every });
            if (i === 0) setPay(n); // pagamento só vale para o primeiro
            db.appts.push(n);
          });
          save();
          toast(dates.length > 1 ? `${dates.length} horários marcados ✓${clash ? ` (${clash} junto com outro horário)` : ''}` : 'Horário marcado ✓');
          replaceTo(`#/agenda?d=${data.date}`);
          return;
        }
        save();
        toast('Alterações salvas ✓');
        back();
      });
    },
  };
}

/* =====================================================================
   DETALHE DO AGENDAMENTO
   ===================================================================== */
function vAppt(id) {
  const a = db.appts.find(x => x.id === id);
  if (!a) return { title: 'Horário', back: true, html: '<div class="empty">Esse horário não existe mais.</div>' };
  const c = client(a.clientId);
  const conflicts = a.status !== 'cancelado' ? conflictsFor(a.date, a.time, a.duration, a.id) : [];
  const msg = `Olá ${c?.name?.split(' ')[0] || ''}! Passando para lembrar do seu horário ${dayName(a.date) === 'Hoje' ? 'hoje' : dayName(a.date) === 'Amanhã' ? 'amanhã' : 'dia ' + fmtShort(a.date)} às ${a.time}${a.service ? ' (' + a.service + ')' : ''}. Até lá! 💖`;

  return {
    title: 'Horário', tab: 'agenda', back: true,
    html: `
      <div class="hero">
        <p class="big"><a href="#/cliente/${a.clientId}">${esc(clientName(a.clientId))} ›</a></p>
        <p style="font-size:1.15rem"><b style="text-transform:capitalize">${dayName(a.date)}</b>, ${fmtShort(a.date)} às <b>${a.time}</b>${a.duration ? ` até ${hhmm(apptEnd(a))}` : ''}</p>
        ${a.service ? `<p>💇 ${esc(a.service)}${a.duration ? ' · ' + fmtDur(a.duration) : ''}</p>` : ''}
        ${a.notes ? `<p class="muted">📝 ${esc(a.notes)}</p>` : ''}
        ${a.seriesId && !a.packageId ? `<p>🔁 Cliente fixa · ${seriesLabel(a.seriesEvery)}</p>` : ''}
        ${pkgPos(a) ? `<p>📦 ${esc(pkgPos(a).p.name)} · <b>${pkgPos(a).n}ª de ${pkgPos(a).total}</b> · <a href="#/cliente/${a.clientId}">ver pacote</a></p>` : ''}
        <div class="badges">${badgesFor(a)}</div>
        ${conflicts.length ? `<div class="conflict-box">⚠️ Junto com: ${conflicts.map(x => `<b>${esc(clientName(x.clientId))}</b> ${x.time}`).join(', ')}</div>` : ''}
      </div>

      ${a.status === PRE ? `
      <div class="stack prebox">
        <p style="margin:0">💳 <b>Pré-reserva</b> — o horário está segurado esperando o sinal${a.price > 0 ? ` de <b>${brl(depositOf(a))}</b> (${depositPct()}% de ${brl(a.price)})` : ''}.</p>
        <button class="btn ok" id="pre-pay">💰 Recebi o sinal — confirmar horário</button>
        <button class="btn" id="pre-ok">✓ Confirmar sem sinal</button>
        ${c?.phone ? `<a class="btn" target="_blank" rel="noopener" href="${waLink(c.phone, `Olá, ${c.name.split(' ')[0]}! Para confirmar o seu horário de ${dayName(a.date).toLowerCase()} (${fmtShort(a.date)}) às ${a.time}, falta o sinal${a.price > 0 ? ' de ' + brl(depositOf(a)) : ''}. 😊`)}">💬 Lembrar do sinal pelo WhatsApp</a>` : ''}
      </div>` : ''}

      ${a.status === 'pendente' ? `
      <div class="stack">
        <p style="margin:0">Esta cliente pediu o horário pelo link. ${c?.phone ? 'Ao confirmar, ela recebe a confirmação no WhatsApp.' : ''}</p>
        <button class="btn ok" id="accept">✓ Confirmar agendamento</button>
        <button class="btn danger" id="decline">✗ Recusar</button>
      </div>` : ''}

      ${a.status !== 'cancelado' && a.status !== 'pendente' ? `
      <div class="stack">
        <div class="form">
          <label for="price">Valor deste atendimento</label>
          <div class="quickprice"><div class="money"><input type="text" id="price" inputmode="decimal" placeholder="${a.priceLater ? 'Avaliar na hora' : '0,00'}" value="${moneyVal(a.price)}"></div>
          <button class="btn small main" id="save-price">Salvar</button></div>
          ${!(a.price > 0) ? `<button type="button" class="chip ${a.priceLater ? 'on' : ''}" id="later" style="margin-top:.5rem">🔎 Avaliar na hora</button>` : ''}
        </div>
        <div class="card">
          <span class="lbl" style="font-weight:700;display:block;margin-bottom:.35rem">Pagamento</span>
          ${payBadge(a, 'Não pagou') || '<span class="muted">Coloque o valor para lançar o pagamento.</span>'}
          ${paymentsOf(a).length ? `<ul class="paylist">${paymentsOf(a).map(p => `<li>${brl(p.v)}${PAY[p.m] ? ' · ' + PAY[p.m] : ''} · ${fmtShort(p.d)}</li>`).join('')}</ul>` : ''}
          ${valueOf(a) > 0 && leftOf(a) > 0 ? `<button class="btn ok" id="receive" style="margin-top:.6rem">💰 Receber ${brl(leftOf(a))}</button>` : ''}
          ${paymentsOf(a).length ? '<button class="btn small" id="unpay" style="margin-top:.6rem">Desfazer pagamento</button>' : ''}
        </div>
        <div class="card">
          <span class="lbl" style="font-weight:700;display:block;margin-bottom:.35rem">🛍️ Produtos deste atendimento</span>
          ${salesOfAppt(a).length ? `<div class="list">${salesOfAppt(a).map(x => saleCard(x, { showClient: false })).join('')}</div>` : '<span class="muted">Nenhum produto vendido.</span>'}
          <a class="btn" href="#/venda?c=${a.clientId}&a=${a.id}" style="margin-top:.6rem">🛍️ Vender produto para ${esc(clientName(a.clientId).split(' ')[0])}</a>
          ${salesOfAppt(a).length ? `<div class="line" style="margin-top:.8rem;font-size:1.1rem"><b class="grow">Total do atendimento</b><b>${brl(visitTotal(a))}</b></div>
            ${visitLeft(a) > 0 ? `<button class="btn ok" id="receive-all" style="margin-top:.6rem">💰 Receber tudo (${brl(visitLeft(a))})</button>` : '<span class="badge ok">✓ Tudo pago</span>'}` : ''}
        </div>
        ${a.status === 'feito'
          ? '<button class="btn" id="undo-done">Desmarcar "feito"</button>'
          : '<button class="btn ok" id="done">✓ Atendimento feito</button>'}
      </div>` : ''}

      <h2>Outras opções</h2>
      <div class="stack">
        ${c?.phone ? `<a class="btn" target="_blank" rel="noopener" href="${waLink(c.phone, msg)}">💬 Lembrar pelo WhatsApp</a>` : ''}
        <a class="btn" href="#/agendar?id=${a.id}">✏️ Mudar dia, horário ou serviço</a>
        ${a.status === 'cancelado'
          ? '<button class="btn" id="uncancel">Desfazer cancelamento</button>'
          : `<button class="btn danger" id="cancel">Cliente desmarcou (cancelar${a.seriesId ? ' só este' : ''})</button>`}
        ${a.seriesId && nextInSeries(a).length ? `<button class="btn danger" id="cancel-next">Cancelar este e os próximos (${nextInSeries(a).length + 1})</button>` : ''}
        <button class="btn danger" id="del">🗑️ Apagar de vez${a.seriesId ? ' (só este)' : ''}</button>
        ${a.seriesId && nextInSeries(a).length ? `<button class="btn danger" id="del-next">🗑️ Apagar este e os próximos (${nextInSeries(a).length + 1})</button>` : ''}
      </div>`,
    bind(el) {
      // msg pode ser uma função: assim a mensagem mostra os valores DEPOIS da mudança
      const upd = (fn, msg) => { fn(); save(); toast(typeof msg === 'function' ? msg() : msg); render(); };
      $('#save-price', el) && ($('#save-price', el).onclick = () => {
        const v = $('#price', el).value;
        const p = parseMoney(v);
        if (v.trim() && p == null) { alert('O valor não está certo. Exemplo: 50,00'); return; }
        upd(() => { a.price = p; if (p > 0) a.priceLater = false; refreshPaid(a); }, 'Valor salvo ✓');
      });
      $('#later', el) && ($('#later', el).onclick = () => upd(() => (a.priceLater = !a.priceLater), () => (a.priceLater ? 'Valor fica para avaliar na hora' : 'Pronto')));
      $('#receive', el) && ($('#receive', el).onclick = () => paySheet(a, `${clientName(a.clientId)} — ${a.service || 'Serviço'}`, (v, m) =>
        upd(() => addPayment(a, v, m), () => (isPaid(a) ? `Pago ✓ (${PAY[m]})` : `Recebido ${brl(v)} ✓ Falta ${brl(leftOf(a))}`))));
      // Receber serviço + produtos de uma vez: o valor quita primeiro o serviço, depois os produtos
      $('#receive-all', el) && ($('#receive-all', el).onclick = () => {
        const items = [a, ...salesOfAppt(a)].filter(x => leftOf(x) > 0);
        paySheet({ total: visitLeft(a) }, `${clientName(a.clientId)} — serviço e produtos`, (v, m) => upd(() => {
          let rest = v;
          for (const x of items) {
            const part = Math.min(rest, leftOf(x));
            if (part > 0) { addPayment(x, part, m); rest = round2(rest - part); }
          }
        }, () => (visitLeft(a) === 0 ? `Tudo pago ✓ (${PAY[m]})` : `Recebido ${brl(v)} ✓ Falta ${brl(visitLeft(a))}`)));
      });
      $('#unpay', el) && ($('#unpay', el).onclick = () => confirm('Apagar os pagamentos lançados neste horário?') && upd(() => clearPayments(a), 'Pagamento desfeito'));
      // pré-reserva: recebeu o sinal (ou confirma sem) → vira confirmado; o servidor manda a confirmação
      $('#pre-pay', el) && ($('#pre-pay', el).onclick = () => paySheet({ total: depositOf(a) || 0 }, `Sinal — ${clientName(a.clientId)}${a.service ? ' · ' + a.service : ''}`, (v, m) =>
        upd(() => { addPayment(a, v, m); a.status = 'marcado'; }, () => `Sinal recebido ✓ Horário confirmado${client(a.clientId)?.phone ? ' — ela recebe a confirmação' : ''}`)));
      $('#pre-ok', el) && ($('#pre-ok', el).onclick = () => confirm('Confirmar o horário sem o sinal?') && upd(() => (a.status = 'marcado'), 'Horário confirmado ✓'));
      $('#accept', el) && ($('#accept', el).onclick = () => confirmSheet(a, v => { decide(a, true, v); render(); }));
      $('#decline', el) && ($('#decline', el).onclick = () => { if (decide(a, false)) render(); });
      $('#done', el) && ($('#done', el).onclick = () => upd(() => (a.status = 'feito'), 'Atendimento feito ✓'));
      $('#undo-done', el) && ($('#undo-done', el).onclick = () => upd(() => (a.status = 'marcado'), 'Pronto'));
      $('#cancel', el) && ($('#cancel', el).onclick = () => confirm('Marcar este horário como cancelado?') && upd(() => (a.status = 'cancelado'), 'Horário cancelado'));
      $('#uncancel', el) && ($('#uncancel', el).onclick = () => upd(() => (a.status = 'marcado'), 'Horário de volta ✓'));
      $('#cancel-next', el) && ($('#cancel-next', el).onclick = () => {
        const list = [a, ...nextInSeries(a)];
        if (!confirm(`Cancelar ${list.length} horários (este e os próximos da repetição)?`)) return;
        list.forEach(x => (x.status = 'cancelado'));
        save(); toast(`${list.length} horários cancelados`); render();
      });
      $('#del-next', el) && ($('#del-next', el).onclick = () => {
        const ids = new Set([a, ...nextInSeries(a)].map(x => x.id));
        if (!confirm(`Apagar ${ids.size} horários (este e os próximos da repetição) para sempre?`)) return;
        db.appts = db.appts.filter(x => !ids.has(x.id));
        save(); toast(`${ids.size} horários apagados`); back();
      });
      $('#del', el).onclick = () => {
        if (!confirm('Apagar este horário para sempre?')) return;
        db.appts = db.appts.filter(x => x.id !== a.id);
        save(); toast('Horário apagado'); back();
      };
    },
  };
}

/* =====================================================================
   LEMBRAR CLIENTES DE AMANHÃ (pelo WhatsApp dela, uma por uma)
   ===================================================================== */
const tomorrowList = () => db.appts.filter(a => a.date === addDays(today(), 1) && a.status === 'marcado').sort(byWhen);
function reminderText(a) {
  const c = client(a.clientId);
  return `Olá, ${(c?.name || '').split(' ')[0]}! Passando para lembrar do seu horário amanhã (${fmtDate(a.date, { weekday: 'long' })}) às ${a.time}${a.service ? ' — ' + a.service : ''}. Te esperamos! 💖`;
}
function vLembretes() {
  const list = tomorrowList();
  return {
    title: 'Lembrar amanhã', tab: 'agenda', back: true,
    html: list.length ? `<p class="muted" style="margin-top:0">Toque no botão verde: o WhatsApp abre com a mensagem pronta. É só enviar e voltar aqui.</p>
      <div class="list">${list.map(a => {
        const c = client(a.clientId);
        return `<div class="card">
          <div class="line"><div class="grow"><b>${a.time} · ${esc(clientName(a.clientId))}</b><span>${esc(a.service || '')}</span></div>
            ${a.remindedAt ? '<span class="badge ok">✓ Lembrada</span>' : ''}</div>
          ${c?.phone
            ? `<a class="btn ${a.remindedAt ? '' : 'ok'}" style="margin-top:.6rem" target="_blank" rel="noopener" data-rem="${a.id}" href="${waLink(c.phone, reminderText(a))}">💬 ${a.remindedAt ? 'Mandar de novo' : 'Lembrar pelo WhatsApp'}</a>`
            : `<p class="muted" style="margin:.4rem 0 0">Sem telefone. <a href="#/cliente-editar?id=${a.clientId}">Colocar telefone</a></p>`}
        </div>`;
      }).join('')}</div>`
      : '<div class="empty">Ninguém marcado para amanhã.</div>',
    bind(el) {
      el.addEventListener('click', e => {
        const b = e.target.closest('[data-rem]');
        const a = b && db.appts.find(x => x.id === b.dataset.rem);
        if (!a) return;
        a.remindedAt = Date.now();
        save();
        setTimeout(render, 800); // atualiza quando ela voltar do WhatsApp
      });
    },
  };
}

/* =====================================================================
   PEDIDOS DO LINK (esperando confirmação)
   ===================================================================== */
function vPedidos() {
  const list = pendingAppts();
  return {
    title: 'Pedidos', tab: 'agenda', back: true,
    html: list.length ? `<p class="muted" style="margin-top:0">Clientes que pediram horário pelo link. Confirme ou recuse:</p>
      <div class="list">${list.map(a => `<div>${apptCard(a, { showDate: true })}
        <div class="row" style="margin-top:.4rem">
          <button class="btn small ok" data-ok="${a.id}">✓ Confirmar</button>
          <button class="btn small danger" data-no="${a.id}">✗ Recusar</button>
        </div></div>`).join('')}</div>`
      : '<div class="empty">Nenhum pedido esperando. 🎉</div>',
    bind(el) {
      el.addEventListener('click', e => {
        const b = e.target.closest('[data-ok],[data-no]');
        if (!b) return;
        const a = db.appts.find(x => x.id === (b.dataset.ok || b.dataset.no));
        if (!a) return;
        if (b.dataset.ok) confirmSheet(a, v => { decide(a, true, v); render(); });
        else if (decide(a, false)) render();
      });
    },
  };
}

/* =====================================================================
   BUSCAR
   ===================================================================== */
/* Busca: várias palavras juntas ("maria escova"), telefone, dia (15/09), dia da semana, mês,
   situação (cancelado, pendente, feito, devendo), valor. Atalhos prontos quando está vazia. */
const SEARCH_SHORTCUTS = {
  hoje: ['📅 Hoje', () => db.appts.filter(a => a.date === today() && a.status !== 'cancelado').sort(byWhen)],
  amanha: ['📆 Amanhã', () => db.appts.filter(a => a.date === addDays(today(), 1) && a.status !== 'cancelado').sort(byWhen)],
  semana: ['🗓️ Próximos 7 dias', () => db.appts.filter(a => a.date >= today() && a.date <= addDays(today(), 7) && a.status !== 'cancelado' && !isPast(a)).sort(byWhen)],
  pedidos: ['⏳ Pedidos', () => pendingAppts()],
  devendo: ['💸 Quem deve', null],
  prereservas: ['💳 Pré-reservas', () => preAppts()],
  semvalor: ['✏️ Sem valor', () => db.appts.filter(a => isPast(a) && a.status !== 'cancelado' && a.status !== 'pendente' && a.status !== PRE && !a.packageId && !(a.price > 0) && !a.paid).sort(byWhen).reverse()],
  cancelados: ['❌ Cancelados', () => db.appts.filter(a => a.status === 'cancelado').sort(byWhen).reverse()],
};
const recentKey = () => `mf.buscas.${session.tenant.id}`;
function rememberSearch(text) {
  const t = text.trim();
  if (t.length < 2) return;
  const list = [t, ...(readLS(recentKey()) || []).filter(x => norm(x) !== norm(t))].slice(0, 6);
  try { writeLS(recentKey(), list); } catch { /* ok */ }
}
// Texto onde cada coisa é procurada (sem acento, minúsculo)
function dateWords(d) {
  const x = toDate(d);
  return [fmtShort(d), `${x.getDate()}/${x.getMonth() + 1}`, `${pad(x.getDate())}/${pad(x.getMonth() + 1)}`,
    fmtDate(d, { weekday: 'long' }), fmtDate(d, { month: 'long' })].join(' ');
}
const moneyWords = v => (v > 0 ? `${moneyVal(v)} ${Math.round(v)} ${brl(v)}` : '');
function searchText(kind, x) {
  if (kind === 'c') return norm(`${x.name} ${x.phone || ''} ${(x.phone || '').replace(/\D/g, '')} ${x.notes || ''}`);
  if (kind === 'a') {
    const status = { marcado: 'marcado', feito: 'feito', cancelado: 'cancelado cancelada desmarcou', pendente: 'pendente pedido' }[x.status || 'marcado'];
    return norm(`${clientName(x.clientId)} ${client(x.clientId)?.phone?.replace(/\D/g, '') || ''} ${x.service || ''} ${x.notes || ''} ${dateWords(x.date)} ${x.time} ${status}
      ${apptDue(x) ? 'devendo deve nao pago' : isPaid(x) ? 'pago' : ''} ${moneyWords(x.price)} ${x.seriesId ? 'fixa' : ''} ${x.source === 'online' ? 'link online' : ''}`);
  }
  if (kind === 's') return norm(`${clientName(x.clientId)} ${x.product} ${dateWords(x.date)} ${saleDue(x) ? 'devendo deve nao pago' : 'pago'} ${moneyWords(x.total)} venda produto`);
  return norm(`${x.desc || ''} ${x.cat || ''} ${dateWords(x.date)} ${moneyWords(x.amount)} despesa gasto`);
}

function vBuscar(_, q) {
  const text = q.q || '';
  const type = q.t || '';
  const k = SEARCH_SHORTCUTS[q.k] ? q.k : '';
  const url = o => '#/buscar?' + Object.entries({ q: text, t: type, k, ...o }).filter(([, v]) => v).map(([a, b]) => `${a}=${encodeURIComponent(b)}`).join('&');

  const expenseRow = e => `<a class="card line" href="#/despesa?id=${e.id}"><div class="grow"><b>➖ ${esc(e.desc || e.cat || 'Despesa')}</b>
    <span>${fmtShort(e.date)}${e.cat && e.desc ? ' · ' + esc(e.cat) : ''}</span></div><span class="amount" style="color:var(--bad)">− ${brl(e.amount)}</span></a>`;

  function results() {
    // atalho escolhido
    if (k) {
      const [label, fn] = SEARCH_SHORTCUTS[k];
      if (k === 'devendo') {
        const cs = db.clients.map(c => ({ c, owes: clientOwes(c.id) })).filter(x => x.owes > 0).sort((a, b) => b.owes - a.owes);
        return `<h2>${label} · ${cs.length}</h2><div class="list">${cs.length ? cs.map(x => clientRow(x.c)).join('') : '<div class="empty">Ninguém devendo. 🎉</div>'}</div>`;
      }
      const list = fn();
      return `<h2>${label} · ${list.length}</h2><div class="list">${list.length ? list.map(a => apptCard(a, { showDate: true })).join('') : '<div class="empty">Nada por aqui.</div>'}</div>`;
    }
    const words = norm(text).split(/\s+/).filter(Boolean);
    if (!words.length) return '';
    const hit = str => words.every(w => str.includes(w));
    const groups = {
      c: ['👩 Clientes', db.clients.filter(x => hit(searchText('c', x))).sort(byName), clientRow],
      a: ['📅 Horários', db.appts.filter(x => hit(searchText('a', x))).sort((a, b) => {
        const fa = !isPast(a), fb = !isPast(b);           // próximos primeiro, depois os mais recentes
        return fa !== fb ? (fa ? -1 : 1) : fa ? byWhen(a, b) : byWhen(b, a);
      }), a => apptCard(a, { showDate: true })],
      s: ['🛍️ Vendas', db.sales.filter(x => hit(searchText('s', x))).sort(byWhen).reverse(), x => saleCard(x)],
      e: ['➖ Despesas', db.expenses.filter(x => hit(searchText('e', x))).sort((a, b) => b.date.localeCompare(a.date)), expenseRow],
    };
    const total = Object.values(groups).reduce((t, g) => t + g[1].length, 0);
    if (!total) return `<div class="empty">Nada encontrado para "<b>${esc(text)}</b>".<br><small>Tente só uma parte do nome, ou um dia como 15/09.</small></div>`;
    const chips = `<div class="chips filters">${[['', 'Tudo', total], ...Object.entries(groups).map(([key, g]) => [key, g[0], g[1].length])]
      .filter(([key, , n]) => !key || n).map(([key, n, c]) => `<a class="chip ${type === key ? 'on' : ''}" href="${url({ t: key })}" data-go>${n} <small>${c}</small></a>`).join('')}</div>`;
    const show = Object.entries(groups).filter(([key, g]) => g[1].length && (!type || type === key)).map(([key, [label, list, row]]) => {
      const lim = type ? 200 : 8;
      return `<h2>${label} · ${list.length}</h2><div class="list">${list.slice(0, lim).map(row).join('')}</div>
        ${list.length > lim ? `<a class="btn small" href="${url({ t: key })}" data-go style="margin-top:.6rem">Ver todos (${list.length})</a>` : ''}`;
    }).join('');
    return chips + show;
  }

  function idle() {
    const recent = readLS(recentKey()) || [];
    const next = db.appts.filter(a => !isPast(a) && a.status !== 'cancelado').sort(byWhen).slice(0, 5);
    return `
      <h2>Atalhos</h2>
      <div class="shortcuts">${Object.entries(SEARCH_SHORTCUTS).map(([key, [label]]) => `<a class="chip" href="${url({ k: key, q: '', t: '' })}" data-go>${label}</a>`).join('')}</div>
      ${recent.length ? `<h2>Buscas recentes</h2><div class="chips">${recent.map(r => `<a class="chip" href="${url({ q: r, k: '', t: '' })}" data-go>🕘 ${esc(r)}</a>`).join('')}</div>` : ''}
      <h2>Próximos horários</h2>
      <div class="list">${next.length ? next.map(a => apptCard(a, { showDate: true })).join('') : '<div class="muted">Nada marcado para os próximos dias.</div>'}</div>
      <p class="muted" style="margin-top:1.5rem;font-size:.9rem">💡 Dá para buscar por nome, telefone, serviço, produto, dia (<b>15/09</b>), dia da semana (<b>sexta</b>), mês (<b>setembro</b>), <b>cancelado</b>, <b>devendo</b> ou valor (<b>60</b>). Juntar palavras também funciona: <b>maria escova</b>.</p>`;
  }

  return {
    title: 'Buscar', tab: 'buscar',
    html: `
      <div class="search"><input type="search" id="s" placeholder="🔍 Nome, telefone, serviço, dia…" value="${esc(text)}" enterkeyhint="search"></div>
      ${k ? `<a class="btn small" href="#/buscar" data-go style="margin-bottom:.8rem">✕ Limpar atalho</a>` : ''}
      <div id="res">${k || text ? results() : idle()}</div>`,
    bind(el) {
      const s = $('#s', el);
      let timer;
      s.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const v = s.value;
          history.replaceState(null, '', v ? `#/buscar?q=${encodeURIComponent(v)}` : '#/buscar');
          stack[stack.length - 1] = lastHash = curHash();
          const qq = parseHash().q;
          const view = vBuscar(null, qq);
          const tmp = document.createElement('div');
          tmp.innerHTML = view.html;
          $('#res', el).innerHTML = $('#res', tmp).innerHTML;
          el.querySelector('a[href="#/buscar"][data-go]')?.remove();
        }, 180);
      });
      s.addEventListener('change', () => rememberSearch(s.value));
      s.addEventListener('keydown', e => { if (e.key === 'Enter') { rememberSearch(s.value); s.blur(); } });
      el.addEventListener('click', e => {
        const a = e.target.closest('a[data-go]');
        if (a) { e.preventDefault(); replaceTo(a.getAttribute('href')); return; }
        // abriu um resultado: guarda a busca nas recentes
        if (s.value.trim() && e.target.closest('#res a')) rememberSearch(s.value);
      });
    },
  };
}

/* =====================================================================
   CLIENTES
   ===================================================================== */
// Resumo de uma cliente: visitas, última vez, serviço preferido…
function clientStats(c) {
  const appts = db.appts.filter(a => a.clientId === c.id);
  const visits = appts.filter(a => a.status === 'feito' || (a.status === 'marcado' && isPast(a))).sort(byWhen);
  const next = appts.filter(a => !isPast(a) && (a.status === 'marcado' || a.status === 'pendente')).sort(byWhen)[0];
  const count = {};
  for (const a of visits) if (a.service) count[a.service] = (count[a.service] || 0) + 1;
  const fav = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
  const firstDate = [...appts.map(a => a.date), ...db.sales.filter(x => x.clientId === c.id).map(x => x.date)].sort()[0];
  return {
    visits: visits.length, last: visits.at(-1), next, fav: fav?.[0] || '',
    since: firstDate || (c.createdAt ? dstr(new Date(c.createdAt)) : ''),
    owes: clientOwes(c.id), paid: clientPaid(c.id),
    online: c.source === 'online' || appts.some(a => a.source === 'online'),
  };
}
function daysAgo(date) {
  const n = Math.round((toDate(today()) - toDate(date)) / 86400000);
  if (n <= 0) return 'hoje';
  if (n === 1) return 'ontem';
  if (n < 30) return `há ${n} dias`;
  if (n < 365) { const m = Math.round(n / 30); return `há ${m} ${m === 1 ? 'mês' : 'meses'}`; }
  const y = Math.round(n / 365); return `há ${y} ${y === 1 ? 'ano' : 'anos'}`;
}
const initials = name => String(name || '?').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
function avatar(name, big = false) {
  const hue = [...norm(name)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 7);
  return `<span class="avatar ${big ? 'big' : ''}" style="background:hsl(${hue} 45% 88%);color:hsl(${hue} 45% 28%)" aria-hidden="true">${esc(initials(name))}</span>`;
}

function clientRow(c, st = clientStats(c)) {
  const lines = [];
  lines.push(st.last ? `Última vez ${daysAgo(st.last.date)}${st.last.service ? ' · ' + esc(st.last.service) : ''}` : 'Ainda não veio');
  if (st.next) lines.push(`📅 ${st.next.status === 'pendente' ? 'Pedido' : 'Próximo'}: ${esc(fmtDate(st.next.date, { weekday: 'short', day: '2-digit', month: '2-digit' }).replace('.,', ''))} ${st.next.time}`);
  return `<a class="card line client-row" href="#/cliente/${c.id}" data-name="${esc(norm(c.name + ' ' + (c.phone || '').replace(/\D/g, '') + ' ' + (c.phone || '')))}">
    ${avatar(c.name)}
    <div class="grow"><b>${esc(c.name)}</b>${lines.map(l => `<span>${l}</span>`).join('')}</div>
    ${st.owes > 0 ? `<span class="badge warn">Deve ${brl(st.owes)}</span>` : ''}
  </a>`;
}

let clientsSearch = '';
const CLIENT_FILTERS = {
  '': ['Todas', () => true],
  devendo: ['💸 Devendo', st => st.owes > 0],
  marcado: ['📅 Com horário', st => !!st.next],
  sumidas: ['😴 Sumidas', st => st.last && !st.next && st.last.date < addDays(today(), -60)],
  link: ['🌐 Pelo link', st => st.online],
};
function vClients(_, q) {
  const f = CLIENT_FILTERS[q.f] ? q.f : '';
  const order = q.o || 'nome';
  const all = db.clients.map(c => ({ c, st: clientStats(c) }));
  const list = all.filter(x => CLIENT_FILTERS[f][1](x.st));
  const sorters = {
    nome: (a, b) => byName(a.c, b.c),
    ultima: (a, b) => (b.st.last ? b.st.last.date + b.st.last.time : '').localeCompare(a.st.last ? a.st.last.date + a.st.last.time : '') || byName(a.c, b.c),
    visitas: (a, b) => b.st.visits - a.st.visits || byName(a.c, b.c),
  };
  list.sort(sorters[order] || sorters.nome);
  const url = o => '#/clientes?' + Object.entries({ f, o: order, ...o }).filter(([, v]) => v && v !== 'nome').map(([k, v]) => `${k}=${v}`).join('&');
  const owing = all.filter(x => x.st.owes > 0);

  // Letras separando a lista (quando está em ordem de nome)
  let letter = '';
  const rows = list.map(({ c, st }) => {
    let head = '';
    if (order === 'nome') {
      const L = norm(c.name)[0]?.toUpperCase() || '#';
      if (L !== letter) { letter = L; head = `<div class="letter" data-letter>${esc(L)}</div>`; }
    }
    return head + clientRow(c, st);
  }).join('');

  return {
    title: 'Clientes', tab: 'clientes',
    html: `
      <div class="search"><input type="search" id="s" placeholder="🔍 Nome ou telefone" value="${esc(clientsSearch)}"></div>
      <div class="row" style="margin-bottom:.8rem">
        <a class="btn main" href="#/cliente-editar">+ Nova cliente</a>
      </div>
      ${all.length ? `<p class="muted" style="margin:.2rem 0 .6rem">${all.length} ${all.length === 1 ? 'cliente' : 'clientes'}${owing.length ? ` · <b style="color:var(--warn)">${owing.length} devendo ${brl(owing.reduce((t, x) => t + x.st.owes, 0))}</b>` : ''}</p>` : ''}
      ${all.length ? `<div class="chips filters">${Object.entries(CLIENT_FILTERS).map(([k, [n, fn]]) =>
        `<a class="chip ${f === k ? 'on' : ''}" href="${url({ f: k })}" data-f>${n} <small>${all.filter(x => fn(x.st)).length}</small></a>`).join('')}</div>
      <div class="sortrow"><label for="ord">Ordenar:</label>
        <select id="ord">${[['nome', 'Nome (A–Z)'], ['ultima', 'Última visita'], ['visitas', 'Quem mais vem']].map(([k, n]) => `<option value="${k}" ${order === k ? 'selected' : ''}>${n}</option>`).join('')}</select></div>` : ''}
      <div class="list" id="list">${rows || (all.length ? '<div class="empty">Nenhuma cliente neste filtro.</div>' : '<div class="empty">Nenhuma cliente ainda.<br>Elas aparecem aqui sozinhas quando você agenda.</div>')}</div>
      <div class="empty" id="none" hidden>Nenhuma cliente com esse nome.</div>`,
    bind(el) {
      const search = () => {
        const n = norm($('#s', el).value);
        const digits = $('#s', el).value.replace(/\D/g, '');
        clientsSearch = $('#s', el).value;
        let shown = 0;
        $$('#list > a', el).forEach(a => { const ok = a.dataset.name.includes(n) || (digits.length > 2 && a.dataset.name.includes(digits)); a.hidden = !ok; shown += ok; });
        $$('#list > .letter', el).forEach(h => (h.hidden = !!n));
        $('#none', el).hidden = !!shown || !list.length;
      };
      $('#s', el).addEventListener('input', search);
      if (clientsSearch) search();
      el.addEventListener('click', e => {
        const a = e.target.closest('a[data-f]');
        if (!a) return;
        e.preventDefault();
        replaceTo(a.getAttribute('href'));
      });
      $('#ord', el)?.addEventListener('change', e => replaceTo(url({ o: e.target.value })));
    },
  };
}

// Cartão de um pacote: progresso e cada sessão (feita, marcada ou a marcar)
function packageCard(p) {
  const list = pkgAppts(p);
  const done = pkgDone(p);
  const rows = Array.from({ length: Math.max(p.total, list.length) }, (_, i) => {
    const a = list[i];
    if (!a) return `<li class="todo"><b>${i + 1}ª</b> <span>a marcar</span></li>`;
    const ok = a.status === 'feito' || (a.status === 'marcado' && isPast(a));
    return `<li class="${ok ? 'ok' : ''}"><a href="#/agendamento/${a.id}"><b>${i + 1}ª</b> ${ok ? '✓' : a.status === PRE ? '💳' : '📅'} ${fmtShort(a.date).slice(0, 5)} ${a.time}</a></li>`;
  }).join('');
  return `<div class="card pkg">
    <div class="line"><div class="grow"><b>📦 ${esc(p.name)}</b><span>${done} de ${p.total} ${done === 1 ? 'feita' : 'feitas'}${pkgLeftToBook(p) ? ` · faltam marcar ${pkgLeftToBook(p)}` : ''}</span></div>
      <a class="btn small" href="#/pacote?id=${p.id}">✏️</a></div>
    <div class="bar"><i style="width:${Math.round(done / p.total * 100)}%"></i></div>
    <ol class="sessions">${rows}</ol>
    ${pkgLeftToBook(p) ? `<a class="btn main" href="#/agendar?c=${p.clientId}&pk=${p.id}">📅 Marcar a ${list.length + 1}ª sessão</a>` : ''}
  </div>`;
}

function vClient(id, q) {
  const c = client(id);
  if (!c) return { title: 'Cliente', back: true, html: '<div class="empty">Cliente não encontrada.</div>' };
  const st = clientStats(c);
  const hf = q.h || '';
  const appts = db.appts.filter(a => a.clientId === id);
  const next = appts.filter(a => !isPast(a) && a.status !== 'cancelado').sort(byWhen);
  const pres = next.filter(a => a.status === PRE);
  const pkgs = clientPackages(id);
  const activePkgs = pkgs.filter(pkgActive), donePkgs = pkgs.filter(p => !pkgActive(p));
  const allHistory = [
    ...appts.filter(a => isPast(a) || a.status === 'cancelado').map(a => ({ k: 'a', when: a.date + a.time, it: a })),
    ...db.sales.filter(x => x.clientId === id).map(x => ({ k: 's', when: x.date + '99', it: x })),
  ].sort((x, y) => y.when.localeCompare(x.when));
  const hFilters = {
    '': ['Tudo', () => true],
    a: ['💇 Serviços', h => h.k === 'a'],
    s: ['🛍️ Produtos', h => h.k === 's'],
    deve: ['💸 Devendo', h => (h.k === 'a' ? apptDue(h.it) : saleDue(h.it))],
  };
  const history = allHistory.filter(hFilters[hf]?.[1] || (() => true));
  const due = allHistory.filter(hFilters.deve[1]).reverse(); // mais antigo primeiro
  const url = h => `#/cliente/${id}${h ? '?h=' + h : ''}`;
  const first = c.name.split(' ')[0];

  let month = '';
  const historyHtml = history.map(h => {
    const mk = h.it.date.slice(0, 7);
    let head = '';
    if (mk !== month) { month = mk; head = `<div class="letter">${esc(cap(toDate(mk + '-01').toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })))}</div>`; }
    return head + historyRow(h);
  }).join('');

  const stat = (label, value) => `<div class="stat"><span>${label}</span><b>${value}</b></div>`;
  const phoneDigits = (c.phone || '').replace(/\D/g, '');
  const jump = [next.length && ['#c-next', `📅 Próximos (${next.length})`], pkgs.length && ['#c-pkgs', `📦 Pacotes (${activePkgs.length})`], allHistory.length && ['#hist', `🕘 Histórico (${allHistory.length})`]].filter(Boolean);

  return {
    title: c.name, tab: 'clientes', back: true,
    html: `
      <div class="hero client-hero">
        ${avatar(c.name, true)}
        <div class="grow">
          <p class="big">${esc(c.name)}</p>
          ${c.phone ? `<p>📞 ${esc(c.phone)}</p>` : '<p class="muted">Sem telefone · <a href="#/cliente-editar?id=' + c.id + '">colocar</a></p>'}
          <div class="badges">${st.online ? '<span class="badge">🌐 Veio pelo link</span>' : ''}${appts.some(a => a.seriesId && !a.packageId && !isPast(a) && a.status !== 'cancelado') ? '<span class="badge">🔁 Cliente fixa</span>' : ''}${activePkgs.length ? '<span class="badge">📦 Pacote</span>' : ''}</div>
        </div>
      </div>
      <div class="actions3">
        ${c.phone ? `<a class="btn" target="_blank" rel="noopener" href="${waLink(c.phone)}">💬<small>WhatsApp</small></a>
        <a class="btn" href="tel:${phoneDigits}">📞<small>Ligar</small></a>` : ''}
        <a class="btn" href="#/agendar?c=${c.id}">📅<small>Agendar</small></a>
        <a class="btn" href="#/venda?c=${c.id}">🛍️<small>Vender</small></a>
      </div>

      <div class="note ${c.notes ? '' : 'empty-note'}" id="note">📝 ${c.notes ? `<b>Observação:</b> ${esc(c.notes)}` : '<span class="muted">Sem observação (alergias, preferências…)</span>'}
        <button type="button" class="btn small" id="edit-note">${c.notes ? '✏️' : '+ Escrever'}</button></div>

      <div class="stats">
        ${stat('Visitas', st.visits)}
        ${stat('Última vez', st.last ? daysAgo(st.last.date) : '—')}
        ${stat('Cliente desde', st.since ? fmtDate(st.since, { month: 'short', year: 'numeric' }).replace('.', '') : '—')}
        ${stat('Serviço preferido', st.fav ? esc(st.fav) : '—')}
      </div>
      <div class="totals">
        <div class="total ok"><span>Já pagou (total)</span><b>${brl(st.paid)}</b></div>
        <a class="total fcard ${st.owes > 0 ? 'warn' : ''} ${hf === 'deve' ? 'on' : ''}" href="${url(hf === 'deve' ? '' : 'deve')}" data-f>
          <span>Falta pagar</span><b>${brl(st.owes)}</b><small>${st.owes > 0 ? (hf === 'deve' ? '▲ mostrando abaixo' : 'Toque para ver') : 'Tudo pago'}</small></a>
      </div>
      ${st.owes > 0 ? `<div class="row" style="margin-bottom:.7rem">
        <button class="btn ok" id="pay-all">💰 Receber ${brl(st.owes)}</button>
        ${c.phone ? `<a class="btn" target="_blank" rel="noopener" href="${waLink(c.phone, `Olá, ${first}! Tudo bem? 😊 Passando para lembrar que ficou um valor em aberto de ${brl(st.owes)} aqui no ${session.tenant.name}. Pode ser por Pix, dinheiro ou cartão. Obrigada! 💖`)}">💸 Cobrar</a>` : ''}
      </div>` : ''}

      ${jump.length > 1 ? `<div class="chips mini jump">${jump.map(([h, n]) => `<a class="chip" href="${h}" data-jump>${n}</a>`).join('')}</div>` : ''}

      ${pres.length ? `<h2>💳 Pré-reservas esperando o sinal</h2>
        <div class="list">${pres.map(a => apptCard(a, { showDate: true, showClient: false })).join('')}</div>` : ''}

      <h2 id="c-next">Próximos horários</h2>
      <div class="list">${next.filter(a => a.status !== PRE).length ? next.filter(a => a.status !== PRE).map(a => apptCard(a, { showDate: true, showClient: false })).join('') : '<div class="muted">Nenhum horário marcado.</div>'}</div>

      <h2 id="c-pkgs">📦 Pacotes</h2>
      <div class="list">${activePkgs.map(packageCard).join('') || '<p class="muted" style="margin:0">Faz cronograma ou vende sessões em pacote? Crie um pacote e cada horário mostra "2ª de 4".</p>'}</div>
      <a class="btn" href="#/pacote?c=${c.id}" style="margin-top:.6rem">+ Novo pacote</a>
      ${donePkgs.length ? `<details class="cancelled"><summary>Pacotes concluídos (${donePkgs.length})</summary><div class="list">${donePkgs.map(packageCard).join('')}</div></details>` : ''}

      <h2 id="hist">Histórico</h2>
      ${allHistory.length ? `<div class="chips filters">${Object.entries(hFilters).map(([k, [n, fn]]) =>
        `<a class="chip ${hf === k ? 'on' : ''}" href="${url(k)}" data-f>${n} <small>${allHistory.filter(fn).length}</small></a>`).join('')}</div>` : ''}
      <div class="list">${historyHtml || `<div class="muted">${allHistory.length ? 'Nada neste filtro.' : 'Ainda não tem histórico.'}</div>`}</div>`,
    bind(el) {
      bindQuickPay(el);
      el.addEventListener('click', e => {
        const j = e.target.closest('a[data-jump]');
        if (j) { e.preventDefault(); $(j.getAttribute('href'))?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
        const a = e.target.closest('a[data-f]');
        if (!a) return;
        e.preventDefault();
        replaceTo(a.getAttribute('href'));
        setTimeout(() => $('#hist')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
      });
      $('#edit-note', el).onclick = () => {
        const v = prompt('Observação da cliente (alergias, preferências…):', c.notes || '');
        if (v === null) return;
        c.notes = v.trim(); save(); toast('Observação salva ✓'); render();
      };
      $('#pay-all', el) && ($('#pay-all', el).onclick = () => paySheet({ total: st.owes }, `${c.name} — tudo que está devendo`, (v, m) => {
        let rest = v;
        for (const { it } of due) {
          const part = Math.min(rest, leftOf(it));
          if (part > 0) { addPayment(it, part, m); rest = round2(rest - part); }
          if (it.status === 'marcado' && isPaid(it) && isPast(it)) it.status = 'feito';
        }
        save();
        const left = clientOwes(id);
        toast(left > 0 ? `Recebido ${brl(v)} ✓ Falta ${brl(left)}` : `Tudo pago ✓ (${PAY[m]})`);
        render();
      }));
    },
  };
}

// Novo pacote / editar pacote
function vPackageForm(_, q) {
  const p = q.id ? pkgOf(q.id) : null;
  const cid = p?.clientId || q.c;
  const c = client(cid);
  if (!c) return { title: 'Pacote', back: true, html: '<div class="empty">Cliente não encontrada.</div>' };
  let total = p?.total || 4;
  let paid = true, method = '';
  const counts = [2, 3, 4, 5, 6, 8, 10, 12];
  return {
    title: p ? 'Editar pacote' : 'Novo pacote', tab: 'clientes', back: true,
    html: `
      <form class="form" id="f" autocomplete="off" novalidate>
        <div id="err"></div>
        <p class="muted" style="margin-top:0">Cliente: <b>${esc(c.name)}</b></p>
        <div class="field"><label for="pn">Nome do pacote</label>
          ${!p && topServices().length ? `<div class="chips mini" id="svc-chips" style="margin-bottom:.5rem">${topServices().map(sv => `<button type="button" class="chip" data-svc="${esc(sv.name)}">${esc(sv.name)}</button>`).join('')}</div>` : ''}
          <input type="text" id="pn" value="${esc(p?.name || '')}" placeholder="Ex.: Cronograma capilar" autocapitalize="sentences"></div>
        <div class="field"><span class="lbl">Quantas sessões?</span>
          <div class="chips" id="counts">${counts.map(n => `<button type="button" class="chip ${n === total ? 'on' : ''}" data-n="${n}">${n}</button>`).join('')}
            <span class="chip ${counts.includes(total) ? '' : 'on'}">Outro: <input type="number" id="pt" min="1" max="60" style="width:4rem" value="${counts.includes(total) ? '' : total}"></span></div>
          ${p ? `<small class="hint">Já tem ${pkgAppts(p).length} marcadas.</small>` : ''}</div>
        ${p ? '' : `
        <div class="field"><label for="pv">Valor do pacote <span class="opt">(se quiser — entra como venda)</span></label>
          <div class="money"><input type="text" id="pv" inputmode="decimal" placeholder="0,00"></div></div>
        <div class="field" id="pay-f" hidden><span class="lbl">Já pagou o pacote?</span>
          ${toggle2('pp', true, '✓ Já pagou', 'Vai pagar depois')}
          <div class="paygrid" id="pm" style="margin-top:.5rem">${Object.entries(PAY).map(([k, n]) => `<button type="button" data-m="${k}">${n}</button>`).join('')}</div></div>`}
        <div class="field"><label for="pnote">Observação <span class="opt">(se quiser)</span></label>
          <textarea id="pnote" placeholder="Ex.: 1 hidratação, 2 nutrições e 1 reconstrução">${esc(p?.notes || '')}</textarea></div>
        <button class="btn main" type="submit">${p ? '✓ Salvar' : '✓ Criar pacote e marcar a 1ª sessão'}</button>
        ${p ? '<button class="btn danger" type="button" id="del" style="margin-top:2rem">🗑️ Apagar pacote</button>' : ''}
      </form>`,
    bind(el) {
      $('#counts', el).addEventListener('click', e => {
        const b = e.target.closest('[data-n]');
        if (!b) return;
        total = +b.dataset.n; $('#pt', el).value = '';
        el.querySelectorAll('#counts .chip').forEach(x => x.classList.toggle('on', x === b));
      });
      $('#pt', el).addEventListener('input', e => {
        const n = parseInt(e.target.value, 10);
        if (n > 0) { total = n; el.querySelectorAll('#counts .chip').forEach(x => x.classList.toggle('on', !x.dataset.n)); }
      });
      $('#svc-chips', el)?.addEventListener('click', e => { const b = e.target.closest('[data-svc]'); if (b) $('#pn', el).value = b.dataset.svc; });
      $('#pv', el)?.addEventListener('input', () => { $('#pay-f', el).hidden = !(parseMoney($('#pv', el).value) > 0); });
      $('#pp', el) && bindToggle2($('#pp', el), v => { paid = v; $('#pm', el).hidden = !v; });
      $('#pm', el)?.addEventListener('click', e => { const b = e.target.closest('[data-m]'); if (!b) return; method = b.dataset.m; el.querySelectorAll('#pm button').forEach(x => x.classList.toggle('on', x === b)); });
      $('#f', el).addEventListener('submit', e => {
        e.preventDefault();
        const err = m => { $('#err', el).innerHTML = `<div class="error">${m}</div>`; window.scrollTo(0, 0); };
        const name = niceName($('#pn', el).value);
        if (!name) return err('Escreva o nome do pacote. Exemplo: Cronograma capilar');
        if (!(total > 0)) return err('Escolha quantas sessões.');
        if (p && total < pkgAppts(p).length) return err(`Já tem ${pkgAppts(p).length} sessões marcadas: o total não pode ser menor.`);
        const notes = $('#pnote', el).value.trim();
        if (p) { Object.assign(p, { name, total, notes }); save(); toast('Pacote salvo ✓'); back(); return; }
        const price = $('#pv', el) ? parseMoney($('#pv', el).value) : null;
        if (price > 0 && paid && !method) return err('Toque em como pagou o pacote (Pix, Dinheiro ou Cartão).');
        const svc = findByName(db.services, name);
        const pkg = { id: uid(), clientId: c.id, name, total, notes, service: svc?.name || '', createdAt: Date.now() };
        db.packages.push(pkg);
        if (price > 0) {
          const sale = { id: uid(), createdAt: Date.now(), clientId: c.id, product: `📦 ${name} (${total} sessões)`, qty: 1, unitPrice: price, total: price, date: today(), paid: false, payments: [], packageId: pkg.id };
          if (paid) addPayment(sale, price, method);
          db.sales.push(sale);
        }
        save();
        toast('Pacote criado ✓ Agora marque a 1ª sessão');
        replaceTo(`#/agendar?c=${c.id}&pk=${pkg.id}`);
      });
      $('#del', el) && ($('#del', el).onclick = () => {
        if (!confirm(`Apagar o pacote "${p.name}"? Os horários continuam na agenda, só deixam de ser do pacote.`)) return;
        for (const a of db.appts) if (a.packageId === p.id) delete a.packageId;
        db.packages = db.packages.filter(x => x.id !== p.id);
        save(); toast('Pacote apagado'); back();
      });
    },
  };
}

// Linha do histórico com botões rápidos para lançar valor e marcar como pago
function historyRow({ k, it }) {
  const card = k === 'a' ? apptCard(it, { showDate: true, showClient: false }) : saleCard(it, { showClient: false });
  if (k === 'a' && it.status === 'cancelado') return card;
  const price = k === 'a' ? it.price : it.total;
  let extra = '';
  if (k === 'a' && !(price > 0)) {
    extra = `<div class="quickprice"><div class="money"><input type="text" inputmode="decimal" placeholder="Quanto custou?" data-price="${it.id}"></div>
      <button class="btn small main" data-saveprice="${it.id}">Salvar</button></div>`;
  } else if (leftOf(it) > 0) {
    extra = `<div class="quickprice"><button class="btn small ok" style="flex:1" data-pay="${k}:${it.id}">💰 Receber ${brl(leftOf(it))}</button></div>`;
  }
  return extra ? `<div>${card}${extra}</div>` : card;
}

function bindQuickPay(el) {
  el.addEventListener('click', e => {
    const pay = e.target.closest('[data-pay]');
    if (pay) {
      const [k, id] = pay.dataset.pay.split(':');
      const it = (k === 'a' ? db.appts : db.sales).find(x => x.id === id);
      if (it) {
        const what = `${clientName(it.clientId)} — ${k === 'a' ? (it.service || 'Serviço') : it.product} (${fmtShort(it.date)})`;
        paySheet(it, what, (v, m) => {
          addPayment(it, v, m);
          if (k === 'a' && it.status === 'marcado' && isPast(it)) it.status = 'feito';
          save(); toast(isPaid(it) ? `Pago ✓ (${PAY[m]})` : `Recebido ${brl(v)} ✓ Falta ${brl(leftOf(it))}`); render();
        });
      }
      return;
    }
    const sp = e.target.closest('[data-saveprice]');
    if (sp) {
      const id = sp.dataset.saveprice;
      const inp = el.querySelector(`[data-price="${id}"]`);
      const p = parseMoney(inp.value);
      if (p == null) { alert('Escreva o valor. Exemplo: 50,00'); inp.focus(); return; }
      const a = db.appts.find(x => x.id === id);
      if (a) { a.price = p; refreshPaid(a); if (a.status === 'marcado') a.status = 'feito'; save(); toast('Valor salvo ✓'); render(); }
    }
  });
}

function vClientForm(_, q) {
  const c = q.id ? client(q.id) : null;
  return {
    title: c ? 'Editar cliente' : 'Nova cliente', tab: 'clientes', back: true,
    html: `
      <form class="form" id="f" autocomplete="off" novalidate>
        <div id="err"></div>
        <div class="field"><label for="n">Nome <em>*</em></label>
          <input type="text" id="n" value="${esc(c?.name || '')}" autocapitalize="words"></div>
        <div class="field"><label for="p">Telefone / WhatsApp <span class="opt">(se quiser)</span></label>
          <input type="tel" id="p" value="${esc(c?.phone || '')}" placeholder="(11) 99999-9999"></div>
        <div class="field"><label for="o">Observação <span class="opt">(se quiser)</span></label>
          <textarea id="o" placeholder="Alergias, preferências…">${esc(c?.notes || '')}</textarea></div>
        <button class="btn main" type="submit">✓ Salvar</button>
        ${c ? '<button class="btn danger" type="button" id="del" style="margin-top:2rem">🗑️ Apagar cliente</button>' : ''}
      </form>`,
    bind(el) {
      if (!c) $('#n', el).focus();
      $('#f', el).addEventListener('submit', e => {
        e.preventDefault();
        const name = niceName($('#n', el).value);
        if (!name) { $('#err', el).innerHTML = '<div class="error">Escreva o nome.</div>'; return; }
        const same = findByName(db.clients, name);
        if (same && same !== c) {
          if (!confirm(`Já existe uma cliente chamada "${same.name}". Salvar mesmo assim?`)) return;
        }
        const data = { name, phone: $('#p', el).value.trim(), notes: $('#o', el).value.trim() };
        if (c) { Object.assign(c, data); save(); toast('Salvo ✓'); back(); }
        else {
          const n = { id: uid(), createdAt: Date.now(), ...data };
          db.clients.push(n); save(); toast('Cliente cadastrada ✓');
          replaceTo(`#/cliente/${n.id}`);
        }
      });
      $('#del', el) && ($('#del', el).onclick = () => {
        const n = db.appts.filter(a => a.clientId === c.id).length + db.sales.filter(s => s.clientId === c.id).length;
        if (!confirm(`Apagar ${c.name}${n ? ` e todo o histórico dela (${n} registros)` : ''}? Isso não tem volta.`)) return;
        db.clients = db.clients.filter(x => x.id !== c.id);
        db.appts = db.appts.filter(a => a.clientId !== c.id);
        db.sales = db.sales.filter(s => s.clientId !== c.id);
        save(); toast('Cliente apagada'); replaceTo('#/clientes');
      });
    },
  };
}

/* =====================================================================
   VENDA DE PRODUTO
   ===================================================================== */
/* =====================================================================
   VENDER (carrinho: vários produtos numa venda só)
   ===================================================================== */
function vSell(_, q) {
  const fromAppt = q.a ? db.appts.find(x => x.id === q.a) : null;
  const startClient = fromAppt?.clientId || q.c || '';
  const cart = [];          // { name, qty, price }
  let counter = !startClient && q.balcao === '1';
  let method = '';          // pix | dinheiro | cartao | depois
  const topProducts = () => {
    const sold = {};
    for (const x of db.sales) sold[norm(x.product)] = (sold[norm(x.product)] || 0) + (x.qty || 1);
    return [...db.products].sort((a, b) => (sold[norm(b.name)] || 0) - (sold[norm(a.name)] || 0) || byName(a, b)).slice(0, 12);
  };
  return {
    title: 'Vender', tab: 'clientes', back: true,
    html: `
      <form class="form" id="f" autocomplete="off" novalidate>
        <div id="err"></div>
        ${fromAppt ? `<div class="summary">🛍️ Junto com o atendimento de ${esc(dayName(fromAppt.date).toLowerCase())}, ${fmtShort(fromAppt.date)} às ${fromAppt.time}${fromAppt.service ? ' — ' + esc(fromAppt.service) : ''}</div>` : ''}

        <div class="field">
          <span class="lbl">Para quem?</span>
          <div id="who">
            <div class="ac"><input type="text" id="f-client" value="${esc(startClient ? clientName(startClient) : '')}" placeholder="Nome da cliente" autocapitalize="words"><div class="sug" hidden></div></div>
            <small id="h-client" class="hint"></small>
            <div class="chips mini" style="margin-top:.5rem">
              ${!startClient ? recentClients(5).map(c => `<button type="button" class="chip" data-cid="${c.id}">${esc(c.name.split(' ').slice(0, 2).join(' '))}</button>`).join('') : ''}
              ${fromAppt ? '' : '<button type="button" class="chip" id="counter">🧍 Balcão (sem nome)</button>'}
            </div>
            <input type="tel" id="f-phone" value="${esc(client(startClient)?.phone || '')}" placeholder="Telefone (se quiser)" style="margin-top:.5rem">
          </div>
          <div id="who-counter" hidden><div class="card line"><b class="grow">🧍 Venda de balcão</b><button type="button" class="btn small" id="uncounter">Trocar</button></div></div>
        </div>

        <div class="field">
          <span class="lbl">O que vendeu?</span>
          ${topProducts().length ? `<div class="prodgrid" id="prods">${topProducts().map(p => `<button type="button" data-p="${esc(p.name)}">
            <b>${esc(p.name)}</b><small>${p.price ? brl(p.price) : 'sem preço'}${hasStock(p) ? ` · ${p.stock <= 0 ? '⚠️ sem estoque' : `tem ${p.stock}`}` : ''}</small></button>`).join('')}</div>` : ''}
          <div class="row" style="margin-top:.5rem;align-items:flex-start">
            <div class="ac" style="flex:2"><input type="text" id="f-prod" placeholder="${db.products.length ? 'Outro produto…' : 'Nome do produto'}" autocapitalize="sentences"><div class="sug" hidden></div></div>
            <button type="button" class="btn small main" id="add" style="flex:0 0 auto;min-height:3.2rem">+ Pôr</button>
          </div>
        </div>

        <div id="cart"></div>

        <div class="field">
          <span class="lbl">Como pagou?</span>
          <div class="paygrid four" id="pay">
            ${Object.entries(PAY).map(([k, n]) => `<button type="button" data-m="${k}">${n}</button>`).join('')}
            <button type="button" data-m="depois">Vai pagar depois</button>
          </div>
        </div>

        <details class="more"><summary>➕ Mais detalhes <small>dia da venda</small></summary>
          <div class="field"><label for="f-date">Dia da venda</label><input type="date" id="f-date" value="${fromAppt?.date || today()}"></div>
        </details>

        <div class="savebar">
          <div class="sum" id="sum"></div>
          <button class="btn main" id="save" type="submit">✓ Lançar venda</button>
        </div>
      </form>`,
    bind(el) {
      const iClient = $('#f-client', el), iProd = $('#f-prod', el);
      suggest(iClient, clientItems, () => {});
      bindClientPhone(el, iClient, $('#f-phone', el));
      suggest(iProd, productItems, it => { addItem(it.label); iProd.value = ''; }, { showOnEmpty: false });

      const setCounter = on => {
        counter = on;
        $('#who', el).hidden = on;
        $('#who-counter', el).hidden = !on;
        paint();
      };
      $('#counter', el)?.addEventListener('click', () => setCounter(true));
      $('#uncounter', el)?.addEventListener('click', () => setCounter(false));
      el.querySelectorAll('[data-cid]').forEach(b => b.onclick = () => {
        iClient.value = client(b.dataset.cid).name;
        iClient.dispatchEvent(new Event('change'));
        paint();
      });

      function addItem(name) {
        name = name.trim();
        if (!name) return;
        const p = findByName(db.products, name);
        const line = cart.find(x => norm(x.name) === norm(name));
        if (line) line.qty++;
        else cart.push({ name: p?.name || niceName(name), qty: 1, price: p?.price ?? null });
        paint();
        toast(`+1 ${p?.name || name}`);
      }
      $('#prods', el)?.addEventListener('click', e => { const b = e.target.closest('[data-p]'); if (b) addItem(b.dataset.p); });
      $('#add', el).onclick = () => { addItem(iProd.value); iProd.value = ''; };
      iProd.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addItem(iProd.value); iProd.value = ''; } });

      const total = () => round2(cart.reduce((t, x) => t + (x.price || 0) * x.qty, 0));
      function paint() {
        $('#err', el).innerHTML = '';
        $('#cart', el).innerHTML = cart.length ? `<div class="cart">
          ${cart.map((x, i) => {
            const p = findByName(db.products, x.name);
            const warn = hasStock(p) && x.qty > p.stock ? `<small class="warnline">⚠️ ${p.stock <= 0 ? 'sem estoque' : `só tem ${p.stock} em estoque`}</small>` : '';
            return `<div class="cart-line">
              <div class="cl-top"><b>${esc(x.name)}</b><span class="line-total">${x.price ? brl(x.price * x.qty) : '—'}</span>
                <button type="button" class="rm" data-rm="${i}" aria-label="Tirar">✕</button></div>
              ${warn}
              <div class="cl-bottom">
                <div class="money small"><input type="text" inputmode="decimal" data-price="${i}" value="${moneyVal(x.price)}" placeholder="preço de cada"></div>
                <div class="qty"><button type="button" data-minus="${i}">−</button><b>${x.qty}</b><button type="button" data-plus="${i}">+</button></div>
              </div>
            </div>`;
          }).join('')}
          <div class="cart-total"><span>Total</span><b>${brl(total())}</b></div></div>`
          : '<p class="muted" style="text-align:center">Toque nos produtos acima para pôr na venda.</p>';
        el.querySelectorAll('#pay [data-m]').forEach(b => b.classList.toggle('on', b.dataset.m === method));
        const who = counter ? '🧍 Balcão' : iClient.value.trim() || '<span class="muted">cliente?</span>';
        const items = cart.reduce((t, x) => t + x.qty, 0);
        $('#sum', el).innerHTML = `${counter ? who : esc(iClient.value.trim()) || who} · ${items ? `${items} ${items === 1 ? 'item' : 'itens'}` : '<span class="muted">produtos?</span>'} · <b>${brl(total())}</b>`;
        $('#save', el).textContent = `✓ Lançar venda${total() ? ' · ' + brl(total()) : ''}`;
      }
      $('#cart', el).addEventListener('click', e => {
        const t = e.target;
        if (t.dataset.plus) cart[+t.dataset.plus].qty++;
        else if (t.dataset.minus) { const x = cart[+t.dataset.minus]; x.qty > 1 ? x.qty-- : cart.splice(+t.dataset.minus, 1); }
        else if (t.dataset.rm) cart.splice(+t.dataset.rm, 1);
        else return;
        paint();
      });
      $('#cart', el).addEventListener('change', e => {
        const i = e.target.dataset.price;
        if (i === undefined) return;
        cart[+i].price = parseMoney(e.target.value);
        paint();
      });
      $('#pay', el).onclick = e => { const b = e.target.closest('[data-m]'); if (b) { method = b.dataset.m; paint(); } };
      iClient.addEventListener('input', paint);
      iClient.addEventListener('change', paint);
      setCounter(counter);
      if (!startClient && !counter) setTimeout(() => iClient.focus(), 50);

      $('#f', el).addEventListener('submit', e => {
        e.preventDefault();
        const err = m => { $('#err', el).innerHTML = `<div class="error">${m}</div>`; window.scrollTo(0, 0); };
        const name = iClient.value.trim();
        if (!counter && !name) return err('Escreva o nome da cliente ou toque em "Balcão".');
        if (!cart.length) return err('Ponha pelo menos um produto.');
        if (cart.some(x => x.price == null)) return err('Coloque o preço de todos os produtos.');
        if (!method) return err('Toque em como pagou (Pix, Dinheiro, Cartão ou Vai pagar depois).');
        let clientId = '';
        if (!counter) {
          const c = findOrCreate(db.clients, name, { phone: '', notes: '' });
          const phone = $('#f-phone', el).value.trim();
          if (phone) c.phone = phone;
          clientId = c.id;
        }
        const date = $('#f-date', el).value || today();
        const orderId = cart.length > 1 ? uid() : null;
        for (const x of cart) {
          const p = findOrCreate(db.products, x.name, { price: x.price });
          if (!p.price && x.price) p.price = x.price;
          moveStock(p.name, -x.qty);
          const sale = { id: uid(), createdAt: Date.now(), clientId, product: p.name, qty: x.qty, unitPrice: x.price,
            total: round2(x.price * x.qty), date, paid: false, payments: [] };
          if (orderId) sale.orderId = orderId;
          if (fromAppt && fromAppt.clientId === clientId) sale.apptId = fromAppt.id;
          if (method !== 'depois' && sale.total > 0) addPayment(sale, sale.total, method, date);
          db.sales.push(sale);
        }
        save();
        const low = cart.map(x => findByName(db.products, x.name)).filter(lowStock);
        toast(`Venda lançada ✓ ${brl(total())}${method === 'depois' ? ' (a receber)' : ''}`);
        if (low.length) setTimeout(() => toast(`📦 Acabando: ${low.map(p => p.name).join(', ')}`), 2300);
        back();
      });
    },
  };
}

function vSaleForm(_, q) {
  const edit = q.id ? db.sales.find(s => s.id === q.id) : null;
  const fromAppt = q.a ? db.appts.find(x => x.id === q.a) : null; // vendendo durante um atendimento
  const s = edit || { clientId: fromAppt?.clientId || q.c || '', product: '', qty: 1, unitPrice: null, date: fromAppt?.date || today(), paid: false, notes: '' };
  let qty = s.qty || 1;
  let paid = isPaid(s);
  let method = paymentsOf(s).at(-1)?.m || '';

  return {
    title: edit ? 'Venda de produto' : 'Vender produto', tab: 'clientes', back: true,
    html: `
      <form class="form" id="f" autocomplete="off" novalidate>
        <div id="err"></div>
        ${(() => { const ap = fromAppt || (s.apptId && db.appts.find(x => x.id === s.apptId));
          return ap ? `<div class="summary">🛍️ Junto com o atendimento de ${esc(dayName(ap.date).toLowerCase())}, ${fmtShort(ap.date)} às ${ap.time}${ap.service ? ' — ' + esc(ap.service) : ''}</div>` : ''; })()}
        <div class="field">
          <label for="f-client">Nome da cliente <em>*</em></label>
          <div class="ac"><input type="text" id="f-client" value="${esc(s.clientId ? clientName(s.clientId) : '')}" placeholder="Digite o nome" autocapitalize="words"><div class="sug" hidden></div></div>
          <small id="h-client" class="hint"></small>
        </div>
        <div class="field">
          <label for="f-phone">Telefone / WhatsApp <span class="opt">(se quiser)</span></label>
          <input type="tel" id="f-phone" value="${esc(client(s.clientId)?.phone || '')}" placeholder="(11) 99999-9999">
        </div>
        <div class="field">
          <label for="f-prod">Produto <em>*</em></label>
          <div class="ac"><input type="text" id="f-prod" value="${esc(s.product)}" placeholder="Ex.: Shampoo, Esmalte…" autocapitalize="sentences"><div class="sug" hidden></div></div>
          <small id="h-prod" class="hint"></small>
        </div>
        <div class="field">
          <span class="lbl">Quantidade</span>
          <div class="row" style="align-items:center">
            <button type="button" class="btn" id="minus" style="flex:0 0 3.4rem">−</button>
            <b id="qty" style="text-align:center;font-size:1.5rem">${qty}</b>
            <button type="button" class="btn" id="plus" style="flex:0 0 3.4rem">+</button>
          </div>
        </div>
        <div class="field">
          <label for="f-price">Valor de cada um</label>
          <div class="money"><input type="text" id="f-price" inputmode="decimal" placeholder="0,00" value="${moneyVal(s.unitPrice)}"></div>
          <small class="hint" id="h-total"></small>
        </div>
        <div class="field">
          <label for="f-date">Dia da venda</label>
          <input type="date" id="f-date" value="${s.date}">
        </div>
        <div class="field">
          <span class="lbl">Já está pago?</span>
          ${edit && paidOf(s) > 0 && !isPaid(s) ? `<p style="margin:.2rem 0 .5rem">${payBadge(s)}</p>` : ''}
          ${toggle2('f-paid', paid, '✓ Já pagou', 'Ainda não')}
          <div class="paygrid" id="f-method" style="margin-top:.5rem" ${paid ? '' : 'hidden'}>
            ${Object.entries(PAY).map(([k, n]) => `<button type="button" data-m="${k}" class="${method === k ? 'on' : ''}">${n}</button>`).join('')}</div>
        </div>
        <button class="btn main" type="submit">✓ ${edit ? 'Salvar' : 'Lançar venda'}</button>
        ${edit ? '<button class="btn danger" type="button" id="del" style="margin-top:2rem">🗑️ Apagar venda</button>' : ''}
      </form>`,
    bind(el) {
      const iClient = $('#f-client', el), iProd = $('#f-prod', el), iPrice = $('#f-price', el);
      const total = () => {
        const p = parseMoney(iPrice.value);
        $('#h-total', el).innerHTML = p ? `Total: <b>${brl(p * qty)}</b>` : '';
      };
      suggest(iClient, clientItems, () => {});
      bindClientPhone(el, iClient, $('#f-phone', el));
      suggest(iProd, productItems, it => {
        const p = db.products.find(x => x.id === it.id);
        if (p?.price && !iPrice.value) { iPrice.value = moneyVal(p.price); total(); }
      }, { showOnEmpty: true });
      const hp = () => {
        nameHint($('#h-prod', el), db.products, iProd.value, '✨ Produto novo — vai ficar salvo na lista', '✓ Produto da sua lista');
        const p = findByName(db.products, iProd.value);
        if (hasStock(p)) {
          const have = p.stock + (edit && findByName(db.products, edit.product) === p ? edit.qty : 0);
          $('#h-prod', el).insertAdjacentHTML('beforeend', ` · ${have <= 0 ? '⚠️ sem estoque' : have < qty ? `⚠️ só tem ${have}` : `📦 tem ${have}`}`);
        }
      };
      iProd.addEventListener('input', hp);
      iProd.addEventListener('change', () => {
        hp();
        const p = findByName(db.products, iProd.value);
        if (p?.price && !iPrice.value) { iPrice.value = moneyVal(p.price); total(); }
      });
      iPrice.addEventListener('input', total);
      $('#minus', el).onclick = () => { qty = Math.max(1, qty - 1); $('#qty', el).textContent = qty; total(); hp(); };
      $('#plus', el).onclick = () => { qty++; $('#qty', el).textContent = qty; total(); hp(); };
      bindToggle2($('#f-paid', el), v => { paid = v; $('#f-method', el).hidden = !v; });
      $('#f-method', el).onclick = e => {
        const b = e.target.closest('[data-m]');
        if (!b) return;
        method = b.dataset.m;
        el.querySelectorAll('#f-method button').forEach(x => x.classList.toggle('on', x === b));
      };
      if (iProd.value) hp();
      total();
      (iClient.value ? iProd : iClient).focus();

      $('#f', el).addEventListener('submit', e => {
        e.preventDefault();
        const err = m => { $('#err', el).innerHTML = `<div class="error">${m}</div>`; window.scrollTo(0, 0); };
        const name = iClient.value.trim(), prod = iProd.value.trim();
        if (!name) { err('Escreva o nome da cliente.'); return; }
        if (!prod) { err('Escreva o nome do produto.'); return; }
        const unit = parseMoney(iPrice.value);
        if (iPrice.value.trim() && unit == null) { err('O valor não está certo. Exemplo: 35,00'); return; }
        const c = findOrCreate(db.clients, name, { phone: '', notes: '' });
        const phone = $('#f-phone', el).value.trim();
        if (phone) c.phone = phone;
        const p = findOrCreate(db.products, prod, { price: unit });
        if (!p.price && unit) p.price = unit;
        const data = { clientId: c.id, product: p.name, qty, unitPrice: unit, total: Math.round((unit || 0) * qty * 100) / 100, date: $('#f-date', el).value || today() };
        const apptId = edit ? edit.apptId : fromAppt?.id;
        if (apptId && db.appts.find(x => x.id === apptId)?.clientId === c.id) data.apptId = apptId; else delete data.apptId;
        if (paid && data.total > 0 && !method && !isPaid({ ...s, ...data })) { err('Toque em Pix, Dinheiro ou Cartão (como pagou).'); return; }
        const setPay = x => {
          if (!paid) { if (isPaid(x) || x.paid) clearPayments(x); return; }
          if (!(x.total > 0)) { x.paid = true; return; }
          refreshPaid(x);
          if (!isPaid(x)) addPayment(x, leftOf(x) || x.total, method, x.date);
        };
        if (edit) moveStock(edit.product, +edit.qty); // devolve o da venda antiga…
        moveStock(data.product, -qty);                 // …e tira o da venda nova
        if (edit) { Object.assign(edit, data); if (!data.apptId) delete edit.apptId; setPay(edit); }
        else { const n = { id: uid(), createdAt: Date.now(), ...data, paid: false }; setPay(n); db.sales.push(n); }
        const pr = findByName(db.products, data.product);
        if (lowStock(pr)) setTimeout(() => toast(`📦 ${pr.name}: ${pr.stock <= 0 ? 'acabou o estoque' : `só restam ${pr.stock}`}`), 2300);
        save();
        toast(edit ? 'Venda salva ✓' : `Venda lançada para ${c.name} ✓`);
        back(); // volta para onde estava (agenda ou ficha da cliente)
      });
      $('#del', el) && ($('#del', el).onclick = () => {
        if (!confirm('Apagar esta venda?')) return;
        db.sales = db.sales.filter(x => x.id !== edit.id);
        moveStock(edit.product, +edit.qty);
        save(); toast('Venda apagada'); back();
      });
    },
  };
}

/* =====================================================================
   FINANCEIRO
   ===================================================================== */
function vFin(_, q) {
  const m = q.m || today().slice(0, 7);
  const f = q.f || '';          // quadro escolhido (filtro)
  const pm = q.pm || '';        // filtro dentro de "Entrou": pix, dinheiro, cartao, a (serviços), s (produtos)
  const [y, mo] = m.split('-').map(Number);
  const shift = n => { const d = new Date(y, mo - 1 + n, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
  const monthLabel = new Date(y, mo - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  const sumBy = (xs, fn) => round2(xs.reduce((t, x) => t + (fn(x) || 0), 0));
  const link = (k, it) => (k === 'a' ? '#/agendamento/' + it.id : '#/venda?id=' + it.id);
  const what = (k, it) => (k === 'a' ? (it.service || 'Serviço') : `🛍️ ${it.product}${it.qty > 1 ? ` (${it.qty}x)` : ''}`);
  const url = (o = {}) => { const p = { m, f, pm, ...o }; return '#/financeiro?' + Object.entries(p).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('&'); };
  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

  // ENTROU: cada pagamento recebido no mês (pelo dia do pagamento)
  const received = [];
  for (const a of db.appts) if (a.status !== 'cancelado') for (const p of paymentsOf(a)) if (p.d?.startsWith(m)) received.push({ ...p, k: 'a', it: a });
  for (const x of db.sales) for (const p of paymentsOf(x)) if (p.d?.startsWith(m)) received.push({ ...p, k: 's', it: x });
  received.sort((a, b) => b.d.localeCompare(a.d));
  const recTotal = sumBy(received, p => p.v);
  const recServ = sumBy(received.filter(p => p.k === 'a'), p => p.v);
  const recProd = sumBy(received.filter(p => p.k === 's'), p => p.v);

  // SAIU: despesas do mês
  const expenses = db.expenses.filter(e => e.date?.startsWith(m)).sort((a, b) => b.date.localeCompare(a.date));
  const spent = sumBy(expenses, e => e.amount);
  const byCat = Object.entries(expenses.reduce((t, e) => { const c = e.cat || 'Outros'; t[c] = (t[c] || 0) + e.amount; return t; }, {}))
    .sort((a, b) => b[1] - a[1]);
  const profit = round2(recTotal - spent);

  // FALTA RECEBER (do mês) e de meses anteriores
  const monthAppts = db.appts.filter(a => a.date.startsWith(m) && a.status !== 'cancelado' && a.status !== 'pendente');
  const monthSales = db.sales.filter(x => x.date.startsWith(m));
  const dueOf = list => list.sort((a, b) => (a.it.date + (a.it.time || '')).localeCompare(b.it.date + (b.it.time || '')));
  const dueMonth = dueOf([...monthAppts.filter(apptDue).map(it => ({ k: 'a', it })), ...monthSales.filter(saleDue).map(it => ({ k: 's', it }))]);
  const dueOld = dueOf([...db.appts.filter(a => a.date < m + '-01' && apptDue(a)).map(it => ({ k: 'a', it })),
                        ...db.sales.filter(x => x.date < m + '-01' && saleDue(x)).map(it => ({ k: 's', it }))]);
  const owed = sumBy(dueMonth, d => leftOf(d.it));
  const owedOld = sumBy(dueOld, d => leftOf(d.it));

  // AINDA VAI ENTRAR: horários do mês que ainda vão acontecer
  const upcoming = monthAppts.filter(a => !isPast(a) && a.status === 'marcado' && !isPaid(a)).sort(byWhen);
  const expected = sumBy(upcoming, leftOf);
  const upcomingNoPrice = upcoming.filter(a => !(a.price > 0)).length;

  // SEM VALOR: atendimentos que já aconteceram sem valor lançado
  const noPrice = monthAppts.filter(a => isPast(a) && !(a.price > 0) && !a.paid && !a.packageId && a.status !== PRE).sort(byWhen);

  const card = (key, cls, label, value, hint, full = false) => `
    <a class="total fcard ${cls} ${full ? 'full' : ''} ${f === key ? 'on' : ''}" href="${url({ f: f === key ? '' : key, pm: '' })}" data-f>
      <span>${label}</span><b>${value}</b><small>${f === key ? '▲ mostrando abaixo' : hint}</small></a>`;

  const dueRow = ({ k, it }) => `
    <div class="card">
      <div class="line">
        <a class="grow" href="${link(k, it)}"><b>${esc(clientName(it.clientId))}</b>
          <span>${fmtShort(it.date)} · ${esc(what(k, it))}${paidOf(it) > 0 ? ` · já pagou ${brl(paidOf(it))}` : ''}</span></a>
        <span class="amount" style="color:var(--warn)">${brl(leftOf(it))}</span>
      </div>
      <div class="quickprice"><button class="btn small ok" style="flex:1" data-pay="${k}:${it.id}">💰 Receber</button></div>
    </div>`;

  // Conteúdo de cada quadro
  const views = {
    entrou: () => {
      const chips = [['', 'Tudo'], ...Object.entries(PAY), ['a', 'Serviços'], ['s', 'Produtos']];
      const list = received.filter(p => !pm || p.m === pm || p.k === pm);
      return `<h2>Entrou em ${monthLabel} ${list.length ? `· ${brl(sumBy(list, p => p.v))}` : ''}</h2>
        <div class="chips" style="margin-bottom:.8rem">${chips.map(([k, n]) => `<a class="chip ${pm === k ? 'on' : ''}" href="${url({ pm: k })}" data-f>${n}${k && k.length > 1 ? ' ' + brl(sumBy(received.filter(p => p.m === k), p => p.v)) : ''}</a>`).join('')}</div>
        <div class="list">${list.length ? list.map(p => `
          <a class="card line" href="${link(p.k, p.it)}">
            <div class="grow"><b>${esc(clientName(p.it.clientId))}</b><span>${fmtShort(p.d)} · ${esc(what(p.k, p.it))}${PAY[p.m] ? ' · ' + PAY[p.m] : ''}</span></div>
            <span class="amount" style="color:var(--ok)">+ ${brl(p.v)}</span></a>`).join('') : '<div class="muted">Nada recebido com esse filtro.</div>'}</div>`;
    },
    saiu: () => `<h2>Saiu em ${monthLabel} · ${brl(spent)}</h2>
      ${byCat.length ? `<div class="catbars">${byCat.map(([c, v]) => `<div><span>${esc(c)}</span><i style="width:${Math.max(4, Math.round(v / spent * 100))}%"></i><b>${brl(v)}</b></div>`).join('')}</div>` : ''}
      <a class="btn" href="#/despesa" style="margin:.8rem 0">➖ Lançar despesa</a>
      <div class="list">${expenses.length ? expenses.map(e => `
        <a class="card line" href="#/despesa?id=${e.id}">
          <div class="grow"><b>${esc(e.desc || e.cat || 'Despesa')}</b><span>${fmtShort(e.date)}${e.cat && e.desc ? ' · ' + esc(e.cat) : ''}</span></div>
          <span class="amount" style="color:var(--bad)">− ${brl(e.amount)}</span></a>`).join('') : '<div class="muted">Nenhuma despesa lançada neste mês.</div>'}</div>`,
    lucro: () => `<h2>Como chegou no lucro</h2>
      <div class="card statement">
        <div class="line"><span class="grow">Serviços recebidos</span><b style="color:var(--ok)">+ ${brl(recServ)}</b></div>
        <div class="line"><span class="grow">Produtos vendidos (recebido)</span><b style="color:var(--ok)">+ ${brl(recProd)}</b></div>
        ${byCat.map(([c, v]) => `<div class="line"><span class="grow">${esc(c)}</span><b style="color:var(--bad)">− ${brl(v)}</b></div>`).join('')}
        <div class="line sum"><b class="grow">Lucro do mês</b><b style="color:${profit >= 0 ? 'var(--ok)' : 'var(--bad)'}">${brl(profit)}</b></div>
      </div>
      <p class="muted">Conta só o dinheiro que já entrou. O que falta receber (${brl(owed)}) entra no lucro quando for pago.</p>`,
    falta: () => `<h2>Falta receber de ${monthLabel} · ${brl(owed)}</h2>
      <div class="list">${dueMonth.length ? dueMonth.map(dueRow).join('') : '<div class="muted">Ninguém devendo neste mês. 🎉</div>'}</div>
      ${dueOld.length ? `<h2>De meses anteriores · ${brl(owedOld)}</h2><div class="list">${dueOld.map(dueRow).join('')}</div>` : ''}`,
    vai: () => `<h2>Ainda vai entrar · ${brl(expected)}</h2>
      ${upcomingNoPrice ? `<p class="muted" style="margin-top:-.3rem">${plural(upcomingNoPrice, 'horário ainda sem valor', 'horários ainda sem valor')} (não entra na soma).</p>` : ''}
      <div class="list">${upcoming.length ? upcoming.map(a => apptCard(a, { showDate: true })).join('') : '<div class="muted">Nenhum horário para o resto do mês.</div>'}</div>`,
    semvalor: () => `<h2>Atendimentos sem valor</h2>
      <p class="muted" style="margin-top:-.3rem">Coloque quanto foi cobrado:</p>
      <div class="list">${noPrice.map(a => `<div class="card">
        <a class="line" style="text-decoration:none" href="#/agendamento/${a.id}"><div class="grow"><b>${esc(clientName(a.clientId))}</b>
        <span>${fmtShort(a.date)} ${a.time}${a.service ? ' · ' + esc(a.service) : ''}${a.priceLater ? ' · 🔎 avaliar na hora' : ''}</span></div></a>
        <div class="quickprice"><div class="money"><input type="text" inputmode="decimal" placeholder="0,00" data-price="${a.id}"></div>
        <button class="btn small main" data-saveprice="${a.id}">Salvar</button></div></div>`).join('') || '<div class="muted">Tudo com valor. 🎉</div>'}</div>`,
  };

  // Sem quadro escolhido: um resumo do que pede atenção
  const overview = () => {
    const tips = [];
    if (dueMonth.length + dueOld.length) tips.push(`<a class="card line" href="${url({ f: 'falta' })}" data-f><div class="grow"><b>💸 ${plural(dueMonth.length + dueOld.length, 'conta para receber', 'contas para receber')}</b><span>${brl(owed + owedOld)} no total</span></div><span class="muted">›</span></a>`);
    if (noPrice.length) tips.push(`<a class="card line" href="${url({ f: 'semvalor' })}" data-f><div class="grow"><b>✏️ ${plural(noPrice.length, 'atendimento sem valor', 'atendimentos sem valor')}</b><span>Coloque quanto foi cobrado</span></div><span class="muted">›</span></a>`);
    return `<p class="muted" style="text-align:center">👆 Toque em um quadro para ver os detalhes.</p>
      ${tips.length ? `<h2>Precisa de atenção</h2><div class="list">${tips.join('')}</div>` : '<div class="empty">Tudo em dia. 🎉</div>'}`;
  };

  return {
    title: 'Dinheiro', tab: 'financeiro',
    html: `
      <div class="monthnav">
        <a class="btn small" href="${url({ m: shift(-1) })}" data-f aria-label="Mês anterior">‹</a>
        <b>${monthLabel}</b>
        <a class="btn small" href="${url({ m: shift(1) })}" data-f aria-label="Próximo mês">›</a>
      </div>
      <div class="totals">
        ${card('entrou', 'ok', 'Entrou no mês', `<span class="bignum">${brl(recTotal)}</span>`,
          received.length ? `${plural(received.length, 'pagamento', 'pagamentos')} · Serviços ${brl(recServ)} · Produtos ${brl(recProd)}` : 'Nenhum pagamento ainda', true)}
        ${card('saiu', 'bad', 'Saiu (despesas)', brl(spent), expenses.length ? plural(expenses.length, 'despesa', 'despesas') : 'Toque para lançar')}
        ${card('lucro', profit >= 0 ? 'ok' : 'bad', 'Lucro do mês', brl(profit), 'Entrou − saiu')}
        ${card('falta', 'warn', 'Falta receber', brl(owed), dueMonth.length ? plural(new Set(dueMonth.map(d => d.it.clientId)).size, 'cliente', 'clientes') : 'Ninguém devendo')}
        ${card('vai', '', 'Ainda vai entrar', brl(expected), upcoming.length ? plural(upcoming.length, 'horário', 'horários') : 'Nada marcado')}
        ${noPrice.length ? card('semvalor', 'warn', 'Sem valor', String(noPrice.length), 'Atendimentos sem valor lançado', true) : ''}
      </div>
      <div id="fin-detail">${views[f] ? views[f]() : overview()}</div>`,
    bind(el) {
      bindQuickPay(el);
      // Filtros trocam a tela sem encher o histórico do "voltar"
      el.addEventListener('click', e => {
        const a = e.target.closest('a[data-f]');
        if (!a) return;
        e.preventDefault();
        replaceTo(a.getAttribute('href'));
        if (a.classList.contains('fcard')) setTimeout(() => $('#fin-detail')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
      });
    },
  };
}

// Despesa (o que saiu): aluguel, produtos, contas…
const EXP_CATS = ['Produtos', 'Aluguel', 'Contas (luz, água, internet)', 'Material', 'Outros'];
function vExpenseForm(_, q) {
  const e = q.id ? db.expenses.find(x => x.id === q.id) : null;
  let cat = e?.cat || '';
  return {
    title: e ? 'Despesa' : 'Lançar despesa', tab: 'financeiro', back: true,
    html: `
      <form class="form" id="f" autocomplete="off" novalidate>
        <div id="err"></div>
        <div class="field"><label for="v">Quanto saiu? <em>*</em></label>
          <div class="money"><input type="text" id="v" inputmode="decimal" placeholder="0,00" value="${moneyVal(e?.amount)}"></div></div>
        <div class="field"><span class="lbl">Com o quê?</span>
          <div class="chips" id="cats">${EXP_CATS.map(c => `<button type="button" class="chip ${cat === c ? 'on' : ''}" data-c="${esc(c)}">${esc(c)}</button>`).join('')}</div></div>
        <div class="field"><label for="d">Descrição <span class="opt">(se quiser)</span></label>
          <input type="text" id="d" value="${esc(e?.desc || '')}" placeholder="Ex.: Tinta de cabelo, conta de luz…" autocapitalize="sentences"></div>
        <div class="field"><label for="dt">Dia</label><input type="date" id="dt" value="${e?.date || today()}"></div>
        <button class="btn main" type="submit">✓ Salvar</button>
        ${e ? '<button class="btn danger" type="button" id="del" style="margin-top:2rem">🗑️ Apagar despesa</button>' : ''}
      </form>`,
    bind(el) {
      if (!e) $('#v', el).focus();
      $('#cats', el).onclick = ev => {
        const b = ev.target.closest('[data-c]');
        if (!b) return;
        cat = cat === b.dataset.c ? '' : b.dataset.c;
        el.querySelectorAll('#cats .chip').forEach(x => x.classList.toggle('on', x.dataset.c === cat));
      };
      $('#f', el).addEventListener('submit', ev => {
        ev.preventDefault();
        const amount = parseMoney($('#v', el).value);
        if (!(amount > 0)) { $('#err', el).innerHTML = '<div class="error">Escreva o valor. Exemplo: 120,00</div>'; return; }
        const data = { amount, cat, desc: $('#d', el).value.trim(), date: $('#dt', el).value || today() };
        if (e) Object.assign(e, data); else db.expenses.push({ id: uid(), createdAt: Date.now(), ...data });
        save(); toast('Despesa salva ✓'); back('#/financeiro');
      });
      $('#del', el) && ($('#del', el).onclick = () => {
        if (!confirm('Apagar esta despesa?')) return;
        db.expenses = db.expenses.filter(x => x.id !== e.id);
        save(); toast('Despesa apagada'); back('#/financeiro');
      });
    },
  };
}

/* =====================================================================
   MAIS: serviços, produtos, cópia de segurança, tamanho da letra
   ===================================================================== */
// "Seg a Sex 09:00–18:00 · Sáb 09:00–13:00 · Dom fechado"
function hoursSummary(days) {
  if (!days) return '';
  const names = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const order = [1, 2, 3, 4, 5, 6, 0];
  const txt = d => (days[d] ? `${days[d][0]}–${days[d][1]}` : 'fechado');
  const groups = [];
  for (const d of order) {
    const g = groups.at(-1);
    if (g && txt(g.last) === txt(d)) g.last = d; else groups.push({ first: d, last: d });
  }
  return groups.map(g => `${names[g.first]}${g.first !== g.last ? ' a ' + names[g.last] : ''} ${txt(g.first)}`).join(' · ');
}

// Instalar na tela inicial (Android/Chrome avisa quando dá; no iPhone é pelo Compartilhar)
let installPrompt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; });
const isInstalled = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

function vMore() {
  const salon = salonHours();
  const low = lowProducts().length;
  const pend = pendingAppts().length;
  const link = salon?.slug ? `${location.origin}/${salon.slug}` : '';
  const lastBk = db.settings.lastBackup ? daysAgo(dstr(new Date(db.settings.lastBackup))) : '';
  const item = (href, icon, title, sub, extra = '') => `
    <a class="menu-item" href="${href}"><span class="mi-icon">${icon}</span>
      <span class="mi-text"><b>${title}</b>${sub ? `<small>${sub}</small>` : ''}</span>${extra}<span class="mi-go">›</span></a>`;
  return {
    title: 'Mais', tab: 'mais',
    html: `
      <div class="card profile">
        ${avatar(session.tenant.name, true)}
        <div class="grow">
          <b style="font-size:1.15rem">${esc(session.tenant.name)}</b>
          <div class="muted">${esc(session.user.name)} · ${esc(session.user.email)}</div>
          <div id="sync" class="sync"></div>
        </div>
      </div>

      <h2>Meu salão</h2>
      <div class="menu">
        ${pend ? item('#/pedidos', '⏳', 'Pedidos esperando', `<span style="color:var(--warn);font-weight:700">${pend} para confirmar</span>`) : ''}
        ${item('#/itens/services', '💇', 'Serviços', `${db.services.length} ${db.services.length === 1 ? 'serviço' : 'serviços'}`)}
        ${item('#/itens/products', '🛍️', 'Produtos', `${db.products.length} ${db.products.length === 1 ? 'produto' : 'produtos'}${low ? ` · <span style="color:var(--bad)">⚠️ ${low} acabando</span>` : ''}`)}
        ${item('#/link', '🔗', 'Link para as clientes', salon ? (salon.enabled ? '<span style="color:var(--ok)">● Ligado</span> · clientes pedem horário por ele' : '○ Desligado') : 'Clientes pedem horário pela internet')}
        ${link && salon.enabled ? `<div class="menu-sub wide">
          <button type="button" class="btn small" id="copy-link">📋 Copiar link</button>
          <a class="btn small" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(`Agende seu horário no ${session.tenant.name} por aqui: ${link}`)}">💬 Mandar</a></div>` : ''}
        ${item('#/link', '🕐', 'Dias e horários de atendimento', salon?.days ? esc(hoursSummary(salon.days)) + (salon.lunch ? ` · almoço ${salon.lunch[0]}–${salon.lunch[1]}` : '') : 'Configure para ver os horários livres na agenda')}
        ${item('#/whatsapp', '💬', 'WhatsApp automático', '<span id="wa-status">…</span>')}
      </div>

      <h2>Neste aparelho</h2>
      <div class="menu">
        <div class="menu-item static"><span class="mi-icon">🔔</span><span class="mi-text"><b>Avisos de pedidos</b><small id="push-sub">…</small></span></div>
        <div class="menu-sub" id="push-card"></div>
        <div class="menu-item static"><span class="mi-icon">🔠</span><span class="mi-text"><b>Tamanho da letra</b></span></div>
        <div class="menu-sub">${toggle2('big', !!db.settings.big, 'A+ Grande', 'A Normal', true)}</div>
        ${isInstalled() ? '' : `<button type="button" class="menu-item" id="install"><span class="mi-icon">📲</span>
          <span class="mi-text"><b>Instalar na tela inicial</b><small>Abre como um aplicativo, com ícone próprio</small></span><span class="mi-go">›</span></button>
          <div class="menu-sub" id="install-help" hidden></div>`}
      </div>

      <h2>Seus dados</h2>
      <div class="menu">
        <button type="button" class="menu-item" id="exp"><span class="mi-icon">📤</span>
          <span class="mi-text"><b>Fazer cópia de segurança</b><small>${lastBk ? `Última cópia: ${lastBk}` : 'Nunca fez · os dados já ficam guardados na internet'}</small></span><span class="mi-go">›</span></button>
        <label class="menu-item"><span class="mi-icon">📥</span>
          <span class="mi-text"><b>Recuperar de uma cópia</b><small>Troca tudo pelo que está no arquivo</small></span><span class="mi-go">›</span>
          <input type="file" id="imp" accept=".json,application/json" hidden></label>
      </div>

      <h2>Conta</h2>
      <div class="menu">
        ${item('#/conta', '👤', 'Minha conta', 'Nome do salão, seu nome e senha')}
        <button type="button" class="menu-item danger" id="logout"><span class="mi-icon">🚪</span><span class="mi-text"><b>Sair da conta</b><small>Neste aparelho</small></span></button>
      </div>

      <p class="muted" style="margin:2rem 0 1rem;font-size:.85rem;text-align:center">
        ${db.clients.length} clientes · ${db.appts.length} horários · ${db.sales.length} vendas · ${db.expenses.length} despesas<br>
        ${esc(BRAND.name)}</p>`,
    bind(el) {
      bindToggle2($('#big', el), v => { db.settings.big = v; save(); applySettings(); });
      paintPushCard($('#push-card', el), true).then(() => {
        const ok = pushSupported() && Notification.permission === 'granted';
        $('#push-sub', el).innerHTML = ok ? '<span style="color:var(--ok)">● Ligados</span>' : 'Receba um aviso quando uma cliente pedir horário';
      });
      $('#copy-link', el) && ($('#copy-link', el).onclick = async () => {
        try { await navigator.clipboard.writeText(link); toast('Link copiado ✓'); } catch { prompt('Copie o link:', link); }
      });
      // estado do WhatsApp (precisa de internet)
      api('GET', '/api/whatsapp/status').then(st => {
        const w = $('#wa-status', el);
        if (!w) return;
        w.innerHTML = st.state === 'open' ? `<span style="color:var(--ok)">● Conectado</span>${st.number ? ' · +' + esc(st.number) : ''}`
          : st.available === false ? 'Ainda não disponível' : '○ Não conectado · confirmações e lembretes automáticos';
      }).catch(() => { const w = $('#wa-status', el); if (w) w.textContent = 'Confirmações e lembretes automáticos'; });
      $('#install', el) && ($('#install', el).onclick = async () => {
        if (installPrompt) {
          installPrompt.prompt();
          const r = await installPrompt.userChoice.catch(() => null);
          installPrompt = null;
          if (r?.outcome === 'accepted') toast('Instalado ✓ Procure o ícone na tela inicial');
          return;
        }
        const help = $('#install-help', el);
        help.hidden = false;
        help.innerHTML = isIOS()
          ? '<ol class="steps"><li>Toque em <b>Compartilhar</b> (o quadrado com a seta ⬆️) embaixo do Safari</li><li>Toque em <b>Adicionar à Tela de Início</b></li><li>Toque em <b>Adicionar</b></li></ol>'
          : '<ol class="steps"><li>Toque nos <b>três pontinhos ⋮</b> do navegador</li><li>Toque em <b>Instalar app</b> ou <b>Adicionar à tela inicial</b></li></ol>';
      });
      $('#exp', el).onclick = exportBackup;
      $('#imp', el).onchange = e => importBackup(e.target.files[0]);
      $('#logout', el).onclick = async () => {
        const n = pendingChanges().length;
        if (!confirm(n ? `Ainda tem ${n} alteração(ões) sem enviar (sem internet). Se sair agora, elas se perdem. Sair mesmo assim?` : 'Sair da conta neste aparelho?')) return;
        await api('POST', '/api/logout').catch(() => {});
        localStorage.removeItem(cacheKey());
        logoutLocal();
      };
      paintSync();
    },
  };
}

// Minha conta: nome do salão, seu nome, senha
function vConta() {
  return {
    title: 'Minha conta', tab: 'mais', back: true,
    html: `
      <form class="form" id="f1" novalidate>
        <h2 style="margin-top:0">Nomes</h2>
        <div id="err1"></div>
        <div class="field"><label for="salon">Nome do salão</label><input type="text" id="salon" value="${esc(session.tenant.name)}" autocapitalize="words"></div>
        <div class="field"><label for="name">Seu nome</label><input type="text" id="name" value="${esc(session.user.name)}" autocapitalize="words"></div>
        <p class="muted" style="margin-top:-.3rem">E-mail de entrada: <b>${esc(session.user.email)}</b></p>
        <button class="btn main" type="submit">✓ Salvar nomes</button>
      </form>
      <form class="form" id="f2" novalidate style="margin-top:2rem">
        <h2>Trocar senha</h2>
        <div id="err2"></div>
        <div class="field"><label for="cur">Senha atual</label><input type="password" id="cur" autocomplete="current-password"></div>
        <div class="field"><label for="new">Senha nova</label><input type="password" id="new" autocomplete="new-password">
          <small class="hint">Pelo menos 6 letras ou números. Os outros aparelhos vão precisar entrar de novo.</small></div>
        <button class="btn" type="submit">🔒 Trocar senha</button>
      </form>`,
    bind(el) {
      const done = (me, msg) => { session = me; writeLS('mf.session', me); toast(msg); };
      const err = (id, e) => { $(id, el).innerHTML = `<div class="error">${esc(e.offline ? 'Precisa de internet para isso.' : e.message)}</div>`; };
      $('#f1', el).addEventListener('submit', async e => {
        e.preventDefault();
        try { done(await api('PUT', '/api/account', { salonName: $('#salon', el).value, name: $('#name', el).value }), 'Nomes salvos ✓'); $('#err1', el).innerHTML = ''; }
        catch (x) { err('#err1', x); }
      });
      $('#f2', el).addEventListener('submit', async e => {
        e.preventDefault();
        try {
          done(await api('PUT', '/api/account', { currentPassword: $('#cur', el).value, newPassword: $('#new', el).value }), 'Senha trocada ✓');
          $('#cur', el).value = $('#new', el).value = ''; $('#err2', el).innerHTML = '';
        } catch (x) { err('#err2', x); }
      });
    },
  };
}

const KINDS = {
  services: { title: 'Meus serviços', one: 'serviço', list: () => db.services, withDur: true },
  products: { title: 'Meus produtos', one: 'produto', list: () => db.products, withDur: false },
};

function vItems(kind) {
  const K = KINDS[kind] || KINDS.services;
  const list = [...K.list()].sort((a, b) => (kind === 'products' ? lowStock(b) - lowStock(a) : 0) || byName(a, b));
  return {
    title: K.title, tab: 'mais', back: true,
    html: `
      <a class="btn main" href="#/item/${kind}" style="margin-bottom:1rem">+ Novo ${K.one}</a>
      <p class="muted">Eles também são salvos sozinhos quando você escreve um ${K.one} novo ${kind === 'services' ? 'ao agendar' : 'ao vender'}.</p>
      <div class="list">${list.length ? list.map(it => `
        <a class="card line" href="#/item/${kind}?id=${it.id}">
          <div class="grow"><b>${esc(it.name)}</b>${K.withDur
            ? (it.description ? `<span>${esc(it.description)}</span>` : '')
            : `<span>${it.price ? brl(it.price) : 'Sem valor definido'}</span>`}</div>
          ${!K.withDur && hasStock(it) ? `<span class="badge ${lowStock(it) ? 'bad' : ''}">${stockLabel(it)}</span>` : ''}
          <span class="muted">›</span></a>`).join('') : `<div class="empty">Nenhum ${K.one} ainda.</div>`}</div>`,
  };
}

function vItemForm(kind, q) {
  const K = KINDS[kind] || KINDS.services;
  const it = q.id ? K.list().find(x => x.id === q.id) : null;
  return {
    title: it ? `Editar ${K.one}` : `Novo ${K.one}`, tab: 'mais', back: true,
    html: `
      <form class="form" id="f" autocomplete="off" novalidate>
        <div id="err"></div>
        <div class="field"><label for="n">Nome <em>*</em></label><input type="text" id="n" value="${esc(it?.name || '')}"></div>
        ${K.withDur ? `<div class="field"><label for="ds">Descrição <span class="opt">(se quiser — a cliente vê no link)</span></label>
          <textarea id="ds" placeholder="Ex.: Lavagem, hidratação e escova modelada">${esc(it?.description || '')}</textarea></div>
        <div class="field"><label for="d">Quanto tempo costuma levar? <span class="opt">(minutos — só para reservar a agenda, a cliente não vê)</span></label>
          <input type="number" id="d" inputmode="numeric" min="5" step="5" value="${it?.duration || ''}" placeholder="Ex.: 60"></div>` : ''}
        ${K.withDur ? `<div class="field"><span class="lbl">Aparece no link de agendamento?</span>
          ${toggle2('online', it?.online !== false, '✓ Sim', 'Não')}</div>` : ''}
        ${!K.withDur ? `<div class="field"><label for="p">Valor <span class="opt">(se quiser)</span></label>
          <div class="money"><input type="text" id="p" inputmode="decimal" placeholder="0,00" value="${moneyVal(it?.price)}"></div></div>` : `
        <p class="muted">💰 O valor é colocado em cada atendimento (muda conforme o serviço e a cliente).</p>`}
        ${!K.withDur ? `
        <div class="field"><label for="st">Quantos tem em estoque? <span class="opt">(se quiser controlar)</span></label>
          <input type="number" id="st" inputmode="numeric" min="0" step="1" value="${hasStock(it) ? it.stock : ''}" placeholder="Deixe vazio para não controlar">
          <small class="hint">Diminui sozinho a cada venda. Quando chegar mercadoria, é só somar aqui.</small></div>
        ${it && hasStock(it) ? `<div class="row" style="margin:-.4rem 0 1rem"><button type="button" class="btn small" id="st-add">+ Chegou mercadoria</button></div>` : ''}
        <div class="field"><label for="ms">Me avisar quando tiver só</label>
          <input type="number" id="ms" inputmode="numeric" min="0" step="1" value="${it?.minStock ?? 2}"></div>` : ''}
        <button class="btn main" type="submit">✓ Salvar</button>
        ${it ? '<button class="btn danger" type="button" id="del" style="margin-top:2rem">🗑️ Apagar</button>' : ''}
      </form>`,
    bind(el) {
      if (!it) $('#n', el).focus();
      $('#online', el) && bindToggle2($('#online', el), () => {});
      $('#st-add', el) && ($('#st-add', el).onclick = () => {
        const n = parseInt(prompt('Quantos chegaram?', '1'), 10);
        if (n > 0) { const inp = $('#st', el); inp.value = (parseInt(inp.value, 10) || 0) + n; toast(`+${n} no estoque. Toque em Salvar.`); }
      });
      $('#f', el).addEventListener('submit', e => {
        e.preventDefault();
        const name = $('#n', el).value.trim().replace(/\s+/g, ' ');
        if (!name) { $('#err', el).innerHTML = '<div class="error">Escreva o nome.</div>'; return; }
        const same = findByName(K.list(), name);
        if (same && same !== it) { $('#err', el).innerHTML = `<div class="error">Já existe "${esc(same.name)}".</div>`; return; }
        const data = { name };
        if (K.withDur) {
          const d = parseInt($('#d', el).value, 10);
          data.duration = d > 0 ? d : null;
          data.online = $('#online .yes', el).classList.contains('on');
          data.description = $('#ds', el).value.trim();
          data.price = null; // valor é por atendimento
        } else {
          const pv = $('#p', el).value, price = parseMoney(pv);
          if (pv.trim() && price == null) { $('#err', el).innerHTML = '<div class="error">O valor não está certo. Exemplo: 50,00</div>'; return; }
          data.price = price;
          const st = $('#st', el).value.trim();
          data.stock = st === '' ? null : Math.max(0, parseInt(st, 10) || 0);
          data.minStock = Math.max(0, parseInt($('#ms', el).value, 10) || 0);
        }
        if (it) Object.assign(it, data); else K.list().push({ id: uid(), createdAt: Date.now(), ...data });
        save(); toast('Salvo ✓'); back(`#/itens/${kind}`);
      });
      $('#del', el) && ($('#del', el).onclick = () => {
        if (!confirm(`Apagar "${it.name}" da lista? (Os horários e vendas antigos continuam no histórico.)`)) return;
        db[kind] = db[kind].filter(x => x.id !== it.id);
        save(); toast('Apagado'); back(`#/itens/${kind}`);
      });
    },
  };
}

/* =====================================================================
   LINK DE AGENDAMENTO E WHATSAPP AUTOMÁTICO (precisam de internet)
   ===================================================================== */
const WEEKDAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const opts = (list, cur, label) => list.map(v => `<option value="${v}" ${+v === +cur ? 'selected' : ''}>${label(v)}</option>`).join('');

// Tela que carrega dados do servidor antes de mostrar o conteúdo
function onlineView(title, load, paint) {
  return {
    title, tab: 'mais', back: true,
    html: '<div id="box"><div class="empty">Carregando…</div></div>',
    async bind(el) {
      try { paint($('#box', el), await load()); }
      catch (e) { $('#box', el).innerHTML = `<div class="error">${esc(e.offline ? 'Precisa de internet para abrir esta tela.' : e.message)}</div>`; }
    },
  };
}

function vLink() {
  return onlineView('Link de agendamento', () => api('GET', '/api/settings'), (box, S) => {
    cacheSalon(S);
    const b = S.booking;
    const url = `${location.origin}/${S.slug}`;
    const share = `Agende seu horário no ${session.tenant.name} por aqui: ${url}`;
    box.innerHTML = `
      <div class="form">
        <span class="lbl">Clientes podem agendar pelo link?</span>
        ${toggle2('enabled', b.enabled, '✓ Sim, ligado', 'Desligado')}

        <div class="field" style="margin-top:1rem"><span class="lbl">Quando uma cliente pede um horário</span>
          ${toggle2('approval', b.requireApproval, '✓ Eu confirmo cada pedido', 'Confirma sozinho', true)}
          <small class="hint">Com "Eu confirmo", você recebe um aviso no celular e a cliente só recebe a confirmação depois que você aceitar.</small></div>

        <div class="card" style="margin-top:1rem">
          <div class="muted" style="font-size:.85rem">Seu link:</div>
          <b style="word-break:break-all">${esc(url)}</b>
          <div class="row" style="margin-top:.7rem;flex-wrap:wrap">
            <button type="button" class="btn small" id="copy">📋 Copiar</button>
            <a class="btn small" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(share)}">💬 Mandar</a>
            <a class="btn small" target="_blank" rel="noopener" href="${esc(url)}">👀 Ver</a>
          </div>
        </div>

        <h2>Dias e horários de atendimento</h2>
        <div class="list" id="days">${WEEKDAYS.map((name, d) => {
          const r = b.days[d];
          return `<div class="card daysrow" data-d="${d}">
            <button type="button" class="chip ${r ? 'on' : ''}" data-toggle>${r ? '✓ ' : ''}${name}</button>
            <div class="hours" ${r ? '' : 'hidden'}>
              <input type="text" inputmode="numeric" maxlength="5" data-a value="${r ? r[0] : '09:00'}"> até
              <input type="text" inputmode="numeric" maxlength="5" data-b value="${r ? r[1] : '18:00'}">
            </div>
            <span class="muted" ${r ? 'hidden' : ''}>Fechado</span>
          </div>`;
        }).join('')}</div>

        <h2>Almoço</h2>
        <div class="card daysrow" id="lunch">
          <button type="button" class="chip ${b.lunch ? 'on' : ''}" data-toggle>${b.lunch ? '✓ ' : ''}Parar para almoço</button>
          <div class="hours" ${b.lunch ? '' : 'hidden'}>
            <input type="text" inputmode="numeric" maxlength="5" data-a value="${b.lunch ? b.lunch[0] : '12:00'}"> até
            <input type="text" inputmode="numeric" maxlength="5" data-b value="${b.lunch ? b.lunch[1] : '13:00'}">
          </div>
        </div>

        <h2>Como aparecem os horários</h2>
        <div class="field"><label for="interval">Horários de quanto em quanto tempo</label>
          <select id="interval">${opts([15, 20, 30, 45, 60], b.interval, v => `A cada ${fmtDur(+v)}`)}</select></div>
        <div class="field"><label for="adv">Antecedência mínima</label>
          <select id="adv">${opts([0, 1, 2, 3, 6, 12, 24, 48], b.minAdvanceHours, v => +v ? `${v} hora${+v > 1 ? 's' : ''} antes` : 'Pode agendar em cima da hora')}</select></div>
        <div class="field"><label for="max">Até quanto tempo para frente</label>
          <select id="max">${opts([7, 14, 30, 60, 90], b.maxDays, v => `${v} dias`)}</select></div>
        <div class="field"><label for="dur">Tempo reservado quando a cliente não escolhe serviço</label>
          <select id="dur">${opts([30, 45, 60, 90, 120], b.defaultDuration, v => fmtDur(+v))}</select></div>
        <p class="muted">Os serviços que aparecem no link são escolhidos em <a href="#/itens/services">Meus serviços</a>.</p>

        <h2>Folgas e feriados</h2>
        <div id="closed" class="chips"></div>
        <div class="row" style="margin-top:.6rem"><input type="date" id="newclosed" min="${S.today}"><button type="button" class="btn small" id="addclosed" style="flex:0 0 auto">+ Adicionar</button></div>

        <h2>Recado no topo do link <span class="opt">(se quiser)</span></h2>
        <textarea id="msg" placeholder="Ex.: Chegue 5 minutos antes 😊">${esc(b.message)}</textarea>

        <div id="err" style="margin-top:1rem"></div>
        <button type="button" class="btn main" id="save" style="margin-top:1rem">✓ Salvar</button>
      </div>`;

    let enabled = b.enabled;
    let requireApproval = b.requireApproval;
    bindToggle2($('#approval', box), v => (requireApproval = v));
    let closed = [...b.closedDates];
    const paintClosed = () => {
      $('#closed', box).innerHTML = closed.length
        ? closed.map(d => `<button type="button" class="chip" data-del="${d}">${fmtShort(d)} ✕</button>`).join('')
        : '<span class="muted">Nenhuma.</span>';
    };
    paintClosed();
    bindToggle2($('#enabled', box), v => (enabled = v));
    $('#copy', box).onclick = async () => {
      try { await navigator.clipboard.writeText(url); toast('Link copiado ✓'); } catch { prompt('Copie o link:', url); }
    };
    box.querySelectorAll('.daysrow').forEach(row => {
      row.querySelectorAll('input').forEach(maskTime);
      $('[data-toggle]', row).onclick = e => {
        const on = !e.currentTarget.classList.contains('on');
        e.currentTarget.classList.toggle('on', on);
        e.currentTarget.textContent = (on ? '✓ ' : '') + e.currentTarget.textContent.replace('✓ ', '');
        $('.hours', row).hidden = !on;
        const closedLbl = row.querySelector('span.muted');
        if (closedLbl) closedLbl.hidden = on;
      };
    });
    $('#closed', box).onclick = e => { const d = e.target.closest('[data-del]')?.dataset.del; if (d) { closed = closed.filter(x => x !== d); paintClosed(); } };
    $('#addclosed', box).onclick = () => {
      const d = $('#newclosed', box).value;
      if (d && !closed.includes(d)) { closed = [...closed, d].sort(); paintClosed(); }
    };

    const readRange = row => {
      if (!$('[data-toggle]', row).classList.contains('on')) return null;
      const a = parseTime($('[data-a]', row).value), z = parseTime($('[data-b]', row).value);
      if (!a || !z || a >= z) throw new Error(`Confira os horários de ${$('[data-toggle]', row).textContent.replace('✓ ', '')}.`);
      return [a, z];
    };
    $('#save', box).onclick = async () => {
      const btn = $('#save', box);
      try {
        const days = {};
        box.querySelectorAll('#days .daysrow').forEach(row => { days[row.dataset.d] = readRange(row); });
        const booking = {
          enabled, requireApproval, days, lunch: readRange($('#lunch', box)),
          interval: +$('#interval', box).value, minAdvanceHours: +$('#adv', box).value,
          maxDays: +$('#max', box).value, defaultDuration: +$('#dur', box).value,
          closedDates: closed, message: $('#msg', box).value.trim(),
        };
        btn.disabled = true;
        cacheSalon(await api('PUT', '/api/settings', { booking }));
        toast(enabled ? 'Salvo ✓ O link está ligado' : 'Salvo ✓');
        $('#err', box).innerHTML = '';
      } catch (e) {
        $('#err', box).innerHTML = `<div class="error">${esc(e.offline ? 'Precisa de internet para salvar.' : e.message)}</div>`;
      } finally { btn.disabled = false; }
    };
  });
}

// Lembrete: minutos antes do horário
const REMINDER_OPTIONS = [0, 30, 60, 120, 180, 360, 720, 1440, 2880];
function reminderLabel(m) {
  if (!m) return 'Não mandar lembrete';
  if (m % 1440 === 0) return m === 1440 ? '1 dia antes' : `${m / 1440} dias antes`;
  if (m % 60 === 0) return m === 60 ? '1 hora antes' : `${m / 60} horas antes`;
  if (m > 60) return `${Math.floor(m / 60)}h${pad(m % 60)} antes`;
  return `${m} minutos antes`;
}

let waPoll = null;
function vWhats() {
  clearInterval(waPoll);
  return onlineView('WhatsApp automático',
    async () => {
      const S = await api('GET', '/api/settings');
      const st = S.whatsappAvailable ? await api('GET', '/api/whatsapp/status') : { state: 'off' };
      const msgs = S.whatsappAvailable ? await api('GET', '/api/messages') : [];
      return { S, st, msgs };
    },
    (box, { S, st, msgs }) => {
      if (!S.whatsappAvailable) {
        box.innerHTML = '<div class="empty">O WhatsApp automático ainda não está disponível.<br>Fale com o suporte do Marque Fácil.</div>';
        return;
      }
      const w = S.whatsapp;
      const connected = st.state === 'open';
      const kinds = { confirm: 'Confirmação', reminder: 'Lembrete', owner: 'Aviso para você', decline: 'Pedido recusado', prereserve: 'Pré-reserva', rescheduleNo: 'Remarcação recusada', access: 'Link "meus horários"', test: 'Teste' };
      const status = { sent: '<span class="badge ok">Enviada</span>', error: '<span class="badge bad">Falhou</span>', skipped: '<span class="badge warn">Sem telefone</span>', sending: '<span class="badge">Enviando</span>' };
      box.innerHTML = `
        <div class="card">
          ${connected
            ? `<b style="color:var(--ok)">✓ WhatsApp conectado</b>${st.number ? `<div class="muted">+${esc(st.number)}</div>` : ''}
               <div class="row" style="margin-top:.7rem"><button class="btn small" id="test">📨 Mandar teste</button><button class="btn small danger" id="disc">Desconectar</button></div>`
            : `<b>WhatsApp não conectado</b>
               <p class="muted">Conecte o WhatsApp do salão para as mensagens saírem sozinhas.</p>
               <div class="field form"><label for="ph">Número do WhatsApp do salão</label>
                 <input type="tel" id="ph" placeholder="(11) 99999-9999" value="${esc(w.ownerPhone || '')}"></div>
               <button class="btn main" id="code">🔢 Conectar com código</button>
               <button class="btn" id="qr" style="margin-top:.6rem">📷 Conectar com QR code (outro aparelho)</button>
               <div id="connect" style="margin-top:1rem"></div>`}
        </div>

        <div class="form">
          <h2>O que mandar</h2>
          <div class="field"><span class="lbl">Confirmação quando eu aceito um pedido do link</span>${toggle2('confirmOnline', w.confirmOnline, '✓ Mandar', 'Não')}</div>
          <div class="field"><span class="lbl">Aviso para a cliente quando eu recuso um pedido</span>${toggle2('declineMessage', w.declineMessage, '✓ Mandar', 'Não')}</div>
          <div class="field"><span class="lbl">Mensagem de pré-reserva (pede o sinal)</span>${toggle2('prereserveMessage', w.prereserveMessage, '✓ Mandar', 'Não')}</div>
          <div class="field"><label for="dep">Sinal da pré-reserva</label>
            <select id="dep">${opts([20, 30, 40, 50, 60, 100], w.depositPercent ?? 50, v => `${v}% do valor`)}</select></div>
          <div class="field"><span class="lbl">Confirmação quando eu agendo no app</span>${toggle2('confirmManual', w.confirmManual, '✓ Mandar', 'Não')}</div>
          <div class="field"><label for="rem">Lembrete antes do horário</label>
            <select id="rem">${(() => {
              const cur = w.reminderMinutes ?? 1440;
              const std = REMINDER_OPTIONS.map(m => `<option value="${m}" ${m === cur ? 'selected' : ''}>${reminderLabel(m)}</option>`).join('');
              const custom = !REMINDER_OPTIONS.includes(cur);
              return std + `<option value="outro" ${custom ? 'selected' : ''}>${custom ? `Outro: ${reminderLabel(cur)}` : 'Outro tempo…'}</option>`;
            })()}</select>
            <div class="row" id="rem-other" style="margin-top:.5rem;align-items:center" ${REMINDER_OPTIONS.includes(w.reminderMinutes ?? 1440) ? 'hidden' : ''}>
              <input type="number" id="rem-n" inputmode="numeric" min="1" step="1" style="max-width:6rem" value="${(() => { const m = w.reminderMinutes ?? 1440; return m % 1440 === 0 ? m / 1440 : m % 60 === 0 ? m / 60 : m; })()}">
              <select id="rem-u">${[['1', 'minutos'], ['60', 'horas'], ['1440', 'dias']].map(([u, n]) => {
                const m = w.reminderMinutes ?? 1440, unit = m % 1440 === 0 ? '1440' : m % 60 === 0 ? '60' : '1';
                return `<option value="${u}" ${u === unit ? 'selected' : ''}>${n} antes</option>`; }).join('')}</select>
            </div>
            <small class="hint">No máximo 3 dias antes.</small></div>
          <div class="field"><span class="lbl">Também me avisar pelo WhatsApp quando chegar pedido</span>${toggle2('notifyOwner', w.notifyOwner, '✓ Avisar', 'Não')}</div>
          <div class="field"><label for="own">Número que recebe o aviso <span class="opt">(vazio = o próprio WhatsApp conectado)</span></label>
            <input type="tel" id="own" placeholder="(11) 99999-9999" value="${esc(w.ownerPhone || '')}"></div>

          <details><summary class="btn">✏️ Mudar o texto das mensagens</summary>
            <p class="muted">Pode usar: {nome} (só o primeiro nome), {dia}, {hora}, {servico}, {valor}, {sinal}, {pacote}, {salao}, {telefone}, {meus_horarios}. Linha com campo vazio (ex.: sem serviço) some sozinha.</p>
            <div class="field"><label for="t-confirm">Confirmação</label><textarea id="t-confirm" rows="6">${esc(w.templates.confirm)}</textarea></div>
            <div class="field"><label for="t-reminder">Lembrete</label><textarea id="t-reminder" rows="6">${esc(w.templates.reminder)}</textarea></div>
            <div class="field"><label for="t-prereserve">Pré-reserva</label><textarea id="t-prereserve" rows="8">${esc(w.templates.prereserve)}</textarea></div>
            <div class="field"><label for="t-decline">Pedido recusado</label><textarea id="t-decline" rows="4">${esc(w.templates.decline)}</textarea></div>
            <div class="field"><label for="t-owner">Aviso para você</label><textarea id="t-owner" rows="5">${esc(w.templates.owner)}</textarea></div>
          </details>
          <div id="err" style="margin-top:1rem"></div>
          <button class="btn main" id="save" style="margin-top:1rem">✓ Salvar</button>
        </div>

        <h2>Últimas mensagens</h2>
        <div class="list">${msgs.length ? msgs.map(m => `<div class="card">
          <div class="line"><div class="grow"><b>${kinds[m.kind] || m.kind}${m.name ? ' — ' + esc(m.name) : ''}</b>
          <span>${new Date(m.createdAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}${m.error ? ' · ' + esc(m.error) : ''}</span></div>
          ${status[m.status] || ''}</div></div>`).join('') : '<div class="muted">Nenhuma mensagem ainda.</div>'}</div>`;

      const flags = { confirmOnline: w.confirmOnline, confirmManual: w.confirmManual, notifyOwner: w.notifyOwner, declineMessage: w.declineMessage, prereserveMessage: w.prereserveMessage };
      for (const k of Object.keys(flags)) bindToggle2($('#' + k, box), v => (flags[k] = v));

      const err = e => { $('#err', box).innerHTML = `<div class="error">${esc(e.offline ? 'Precisa de internet.' : e.message)}</div>`; };
      // lembrete: opção pronta ou "outro tempo" (número + minutos/horas/dias)
      const reminderValue = () => {
        const v = $('#rem', box).value;
        if (v !== 'outro') return +v;
        const n = Math.round(+$('#rem-n', box).value * +$('#rem-u', box).value);
        if (!(n > 0) || n > 3 * 1440) throw new Error('Escolha um tempo de lembrete entre 1 minuto e 3 dias.');
        return n;
      };
      $('#rem', box).onchange = e => { $('#rem-other', box).hidden = e.target.value !== 'outro'; if (e.target.value === 'outro') $('#rem-n', box).focus(); };
      $('#save', box).onclick = async () => {
        try {
          cacheSalon(await api('PUT', '/api/settings', { whatsapp: {
            ...flags, reminderMinutes: reminderValue(), ownerPhone: $('#own', box).value.trim(),
            depositPercent: +$('#dep', box).value,
            templates: { confirm: $('#t-confirm', box).value, reminder: $('#t-reminder', box).value, owner: $('#t-owner', box).value, decline: $('#t-decline', box).value, prereserve: $('#t-prereserve', box).value },
          } }));
          toast('Salvo ✓');
          $('#err', box).innerHTML = '';
        } catch (e) { err(e); }
      };

      // Espera o WhatsApp conectar e recarrega a tela
      const waitConnected = () => {
        clearInterval(waPoll);
        waPoll = setInterval(async () => {
          if (!$('#connect')) return clearInterval(waPoll);
          const s = await api('GET', '/api/whatsapp/status').catch(() => null);
          if (s?.state === 'open') { clearInterval(waPoll); toast('WhatsApp conectado ✓'); render(); }
        }, 3000);
      };
      const connect = async withCode => {
        const out = $('#connect', box);
        const phone = $('#ph', box).value.trim();
        if (withCode && !phone) { out.innerHTML = '<div class="error">Escreva o número do WhatsApp do salão.</div>'; return; }
        out.innerHTML = '<div class="muted">Preparando…</div>';
        try {
          const r = await api('POST', '/api/whatsapp/connect', withCode ? { phone } : {});
          if (r.state === 'open') { render(); return; }
          if (withCode && r.pairingCode) {
            out.innerHTML = `<div class="summary" style="text-align:center">
              <div class="muted">Seu código:</div>
              <div style="font-size:2rem;font-weight:800;letter-spacing:.2rem">${esc(r.pairingCode.replace(/(.{4})/, '$1-'))}</div></div>
              <ol class="steps"><li>Abra o <b>WhatsApp</b> do salão</li><li>Toque em <b>⋮</b> ou <b>Configurações</b> → <b>Aparelhos conectados</b></li>
              <li><b>Conectar aparelho</b> → <b>Conectar com número de telefone</b></li><li>Digite o código acima</li></ol>
              <p class="muted">Esta tela atualiza sozinha quando conectar.</p>`;
          } else if (r.qr) {
            out.innerHTML = `<img src="${esc(r.qr)}" alt="QR code" style="width:100%;max-width:280px;display:block;margin:0 auto">
              <ol class="steps"><li>Abra o <b>WhatsApp</b> do salão em <b>outro aparelho</b></li><li><b>Aparelhos conectados</b> → <b>Conectar aparelho</b></li><li>Aponte a câmera para o código</li></ol>`;
          } else {
            out.innerHTML = '<div class="error">Não veio o código. Tente de novo em alguns segundos.</div>';
            return;
          }
          waitConnected();
        } catch (e) { out.innerHTML = `<div class="error">${esc(e.offline ? 'Precisa de internet.' : e.message)}</div>`; }
      };
      $('#code', box) && ($('#code', box).onclick = () => connect(true));
      $('#qr', box) && ($('#qr', box).onclick = () => connect(false));
      $('#test', box) && ($('#test', box).onclick = async () => {
        try { await api('POST', '/api/whatsapp/test', {}); toast('Mensagem de teste enviada ✓'); render(); } catch (e) { err(e); }
      });
      $('#disc', box) && ($('#disc', box).onclick = async () => {
        if (!confirm('Desconectar o WhatsApp? As mensagens automáticas param.')) return;
        try { await api('POST', '/api/whatsapp/disconnect'); render(); } catch (e) { err(e); }
      });
    });
}

/* =====================================================================
   AVISOS NO APARELHO (notificação push)
   ===================================================================== */
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const b64ToBytes = b64 => {
  const s = atob((b64 + '='.repeat((4 - b64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, c => c.charCodeAt(0));
};

async function subscribePush() {
  const reg = await navigator.serviceWorker.ready;
  const { key } = await api('GET', '/api/push/key');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
  await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
}

// Cartão "ativar avisos". Na agenda só aparece enquanto não estiver ativado.
async function paintPushCard(el, full = false) {
  if (!el) return;
  if (!pushSupported()) {
    if (full) el.innerHTML = `<p class="muted">Este aparelho não recebe avisos pelo navegador.${/iPhone|iPad/.test(navigator.userAgent) ? ' No iPhone, primeiro adicione o app à Tela de Início (Compartilhar → Adicionar à Tela de Início) e abra por lá.' : ''}</p>`;
    return;
  }
  const perm = Notification.permission;
  const sub = await navigator.serviceWorker.ready.then(r => r.pushManager.getSubscription()).catch(() => null);
  if (perm === 'granted' && sub) {
    if (full) {
      el.innerHTML = `<div class="card"><b style="color:var(--ok)">✓ Avisos ligados neste aparelho</b>
        <p class="muted" style="margin:.3rem 0 .6rem">Você recebe um aviso quando uma cliente pedir horário pelo link.</p>
        <button class="btn small" id="push-test">🔔 Testar aviso</button></div>`;
      $('#push-test', el).onclick = () => api('POST', '/api/push/test').then(() => toast('Aviso enviado ✓')).catch(e => alert(e.message));
    }
    return;
  }
  if (perm === 'denied') {
    if (full) el.innerHTML = '<p class="muted">Os avisos estão bloqueados neste aparelho. Libere nas configurações do navegador (Notificações) e volte aqui.</p>';
    return;
  }
  el.innerHTML = `<div class="card push-card"><b>🔔 Receber avisos de pedidos</b>
    <p class="muted" style="margin:.3rem 0 .6rem">Quando uma cliente pedir horário pelo link, chega um aviso neste aparelho para você confirmar.</p>
    <button class="btn main" id="push-on">Ativar avisos</button></div>`;
  $('#push-on', el).onclick = async () => {
    try {
      if (await Notification.requestPermission() !== 'granted') { toast('Avisos não liberados'); paintPushCard(el, full); return; }
      await subscribePush();
      toast('Avisos ligados ✓');
      paintPushCard(el, full);
    } catch (e) { alert(e.offline ? 'Precisa de internet para ligar os avisos.' : 'Não foi possível ligar os avisos: ' + e.message); }
  };
}

async function exportBackup() {
  db.settings.lastBackup = Date.now();
  save();
  const name = `agenda-copia-${today()}.json`;
  const blob = new Blob([JSON.stringify(db, null, 1)], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Cópia da minha agenda' }); render(); return; }
    catch (e) { if (e.name === 'AbortError') { render(); return; } }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('Cópia salva em Downloads ✓');
  render();
}

function importBackup(f) {
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const d = migrate(JSON.parse(r.result));
      if (!confirm(`Essa cópia tem ${d.clients.length} clientes e ${d.appts.length} horários.\n\nTrocar TUDO o que está na sua conta por ela?`)) return;
      uploadAll(d, true);
    } catch { alert('Esse arquivo não é uma cópia válida da agenda.'); }
  };
  r.readAsText(f);
}

// Manda uma cópia inteira para a conta (recuperar cópia de segurança)
async function uploadAll(data, replace) {
  try {
    await syncNow();
    const r = await api('POST', '/api/import', { data, replace });
    await resetFromServer();
    toast(`${r.imported} registros recuperados ✓`);
    return true;
  } catch (e) {
    alert(e.offline ? 'Precisa de internet para isso.' : e.message);
    return false;
  }
}
// Joga fora a cópia do celular e baixa tudo de novo da conta
async function resetFromServer() {
  const settings = db.settings;
  db = migrate({ settings }); snap = {}; seq = 0;
  persist();
  await syncNow();
  render();
}

/* ---------------------------- entrar / criar conta ---------------------------- */
function showLogin(mode = 'entrar') {
  document.body.classList.add('logged-out');
  $('#title').textContent = BRAND.name;
  $('#btn-back').hidden = true;
  const signup = mode === 'criar';
  const main = $('#app').cloneNode(false);
  main.innerHTML = `
    <div class="login">
      ${BRAND.logo
        ? `<div class="brand-wrap"><img class="brand-logo" src="${esc(BRAND.logo)}" alt="${esc(BRAND.name)}"></div>`
        : '<img src="icon.svg" alt="" width="72" height="72">'}
      <h2>${signup ? 'Criar conta do salão' : 'Entrar'}</h2>
      <form class="form" id="f" novalidate>
        <div id="err"></div>
        ${signup ? `
        <div class="field"><label for="salon">Nome do salão</label><input type="text" id="salon" autocapitalize="words" placeholder="Ex.: Studio Ana Beleza"></div>
        <div class="field"><label for="name">Seu nome</label><input type="text" id="name" autocapitalize="words" autocomplete="name"></div>` : ''}
        <div class="field"><label for="email">E-mail</label><input type="email" id="email" autocomplete="email" inputmode="email" autocapitalize="off"></div>
        <div class="field"><label for="pass">Senha</label><input type="password" id="pass" autocomplete="${signup ? 'new-password' : 'current-password'}">
          ${signup ? '<small class="hint">Pelo menos 6 letras ou números.</small>' : ''}</div>
        <button class="btn main" type="submit">${signup ? 'Criar conta' : 'Entrar'}</button>
      </form>
      <button class="btn" id="switch" style="margin-top:1rem">${signup ? 'Já tenho conta — Entrar' : 'Ainda não tenho conta — Criar'}</button>
    </div>`;
  $('#app').replaceWith(main);
  $('#switch').onclick = () => showLogin(signup ? 'entrar' : 'criar');
  $('#f').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('#f button[type=submit]');
    btn.disabled = true;
    try {
      const body = { email: $('#email').value, password: $('#pass').value };
      if (signup) Object.assign(body, { salonName: $('#salon').value, name: $('#name').value });
      const me = await api('POST', signup ? '/api/signup' : '/api/login', body);
      await startSession(me);
    } catch (err) {
      $('#err').innerHTML = `<div class="error">${esc(err.message)}</div>`;
      btn.disabled = false;
    }
  });
}

// Horário de atendimento (dias, almoço) guardado no celular: a agenda usa para mostrar os horários livres
const salonKey = () => `mf.salon.${session.tenant.id}`;
const salonHours = () => readLS(salonKey());
function cacheSalon(S) { try { writeLS(salonKey(), { days: S.booking.days, lunch: S.booking.lunch, enabled: S.booking.enabled, slug: S.slug, deposit: S.whatsapp?.depositPercent ?? 50 }); } catch { /* ok */ } }
function refreshSalon() { api('GET', '/api/settings').then(S => { cacheSalon(S); if (!$('#app form') && parseHash().parts[0] === 'agenda') render(); }).catch(() => {}); }

function refreshPush() {
  if (pushSupported() && Notification.permission === 'granted') subscribePush().catch(() => {});
}

async function startSession(me) {
  session = me;
  writeLS('mf.session', me);
  document.body.classList.remove('logged-out');
  loadCache();
  applySettings();
  render();
  refreshPush();
  refreshSalon();
  await syncNow();
}

/* ---------------------------- início ---------------------------- */
function applySettings() { document.documentElement.classList.toggle('big', !!db.settings.big); }

stack.push(curHash());
if (session) {
  loadCache();
  applySettings();
  render();
  // confere se a sessão ainda vale (sem internet, segue com a cópia do celular)
  api('GET', '/api/me').then(me => { session = me; writeLS('mf.session', me); refreshPush(); refreshSalon(); return syncNow(); })
    .catch(e => { if (e.status === 401) logoutLocal(); else { syncState = 'offline'; paintSync(); } });
} else showLogin();

// Pede ao navegador para não apagar os dados sozinho
navigator.storage?.persist?.();
// Funciona sem internet depois de aberto uma vez
// Versão nova do app: confere de tempos em tempos e se atualiza sozinho
// (no meio de um formulário, mostra um aviso para não perder o que ela está digitando)
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').then(reg => {
    const check = () => reg.update().catch(() => {});
    setInterval(check, 10 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  }).catch(() => {});
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) { hadController = true; return; } // primeira instalação: nada a fazer
    if (!$('#app form')) { location.reload(); return; }
    if ($('#update-bar')) return;
    const bar = document.createElement('button');
    bar.id = 'update-bar';
    bar.textContent = '✨ Versão nova do app — toque para atualizar';
    bar.onclick = () => location.reload();
    document.body.appendChild(bar);
  });
}
// Atualiza a tela quando volta para o app (ex.: horário "passou")
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !session) return;
  syncNow();
  if (!$('#app form')) render();
});
window.addEventListener('online', () => syncNow());
navigator.serviceWorker?.addEventListener('message', e => {
  if (e.data?.type === 'open' && e.data.url) { syncNow().then(() => { location.hash = e.data.url.replace(/^\/?/, '').replace(/^#?/, '#'); }); }
  if (e.data?.type === 'changed') syncNow();
});
setInterval(() => { if (!document.hidden && session) syncNow(); }, 30_000);
