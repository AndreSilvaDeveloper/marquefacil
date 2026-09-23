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

const OLD_KEY = 'agendaSalao.v1'; // dados da versão antiga (só no celular)
const COLLS = ['clients', 'services', 'products', 'appts', 'sales', 'expenses'];
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
const clientName = id => client(id)?.name || '(cliente apagada)';
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

const apptDue = a => a.status !== 'cancelado' && a.status !== 'pendente' && valueOf(a) > 0 && leftOf(a) > 0 && (a.status === 'feito' || isPast(a));
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
  agendar: vApptForm, agendamento: vAppt, pedidos: vPedidos, despesa: vExpenseForm, lembretes: vLembretes, venda: vSaleForm, financeiro: vFin, mais: vMore,
  itens: vItems, item: vItemForm, link: vLink, whatsapp: vWhats,
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
  if (a.status === 'cancelado') b.push('<span class="badge bad">Cancelado</span>');
  else if (a.status === 'feito') b.push('<span class="badge ok">✓ Feito</span>');
  if (a.status !== 'cancelado') {
    if (a.status !== 'pendente') b.push(payBadge(a, apptDue(a) ? 'Não pago' : 'A pagar'));
    if (conflictsFor(a.date, a.time, a.duration, a.id).length) b.push('<span class="badge warn">⚠️ Horário junto</span>');
    if (a.source === 'online') b.push('<span class="badge">🌐 Pelo link</span>');
    if (a.seriesId) b.push('<span class="badge">🔁 Fixa</span>');
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
const pendingAppts = () => db.appts.filter(a => a.status === 'pendente').sort(byWhen);

// Aceitar ou recusar um pedido do link (o servidor manda a mensagem para a cliente)
function decide(a, ok) {
  if (!ok && !confirm(`Recusar o pedido de ${clientName(a.clientId)}? Ela recebe um aviso para escolher outro horário.`)) return false;
  a.status = ok ? 'marcado' : 'cancelado';
  save();
  toast(ok ? `Confirmado ✓ ${clientName(a.clientId)} vai receber a confirmação` : 'Pedido recusado');
  return true;
}

const clientItems = () => [...db.clients].sort(byName).map(c => ({ id: c.id, label: c.name, sub: c.phone || '' }));
const serviceItems = () => [...db.services].sort(byName).map(s => ({
  id: s.id, label: s.name, sub: [fmtDur(s.duration), s.price ? brl(s.price) : ''].filter(Boolean).join(' · '),
}));
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
function vAgenda(_, q) {
  const d = q.d || today();
  const t = today();
  const list = db.appts.filter(a => a.date === d).sort(byWhen);
  const active = list.filter(a => a.status !== 'cancelado');
  const pend = pendingAppts();

  const week = [];
  for (let i = -3; i <= 3; i++) {
    const day = addDays(d, i);
    const n = db.appts.filter(a => a.date === day && a.status !== 'cancelado').length;
    week.push(`<a href="#/agenda?d=${day}" class="${day === d ? 'on' : ''} ${day === t ? 'today' : ''}">
      ${fmtDate(day, { weekday: 'short' }).replace('.', '')}<b>${toDate(day).getDate()}</b><i>${n || ''}</i></a>`);
  }

  return {
    title: 'Agenda', tab: 'agenda',
    html: `
      <div class="daynav">
        <button class="arrow" id="prev" aria-label="Dia anterior">‹</button>
        <div class="label"><b>${dayName(d)}</b><span>${fmtDate(d, { day: 'numeric', month: 'long', year: 'numeric' })}</span></div>
        <button class="arrow" id="next" aria-label="Próximo dia">›</button>
      </div>
      <div class="week">${week.join('')}</div>
      <div class="row" style="margin-bottom:1rem">
        ${d !== t ? '<a class="btn small" href="#/agenda">Voltar para hoje</a>' : ''}
        <label class="btn small" style="position:relative">📆 Escolher dia
          <input type="date" id="pick" value="${d}" style="position:absolute;inset:0;opacity:0;min-height:0"></label>
      </div>
      ${pend.length ? `<a class="card pending-banner" href="#/pedidos">⏳ <b>${pend.length} ${pend.length === 1 ? 'pedido esperando' : 'pedidos esperando'}</b> você confirmar ›</a>` : ''}
      ${d === t && tomorrowList().length ? `<a class="btn" href="#/lembretes" style="margin-bottom:1rem">💬 Lembrar clientes de amanhã (${tomorrowList().filter(x => !x.remindedAt).length} de ${tomorrowList().length})</a>` : ''}
      <div id="push-card"></div>
      <h2>${active.length ? `${active.length} ${active.length === 1 ? 'horário' : 'horários'}` : ''}</h2>
      <div class="list">
        ${list.length ? list.map(a => apptCard(a)).join('') : '<div class="empty">Nenhum horário marcado neste dia.<br>Toque em <b>Agendar</b> para marcar.</div>'}
      </div>
      <div class="fabs">
        <a class="fab sell" href="#/venda">🛍️ Vender</a>
        <a class="fab" href="#/agendar?d=${d}">📅 Agendar</a>
      </div>`,
    bind(el) {
      $('#prev', el).onclick = () => replaceTo(`#/agenda?d=${addDays(d, -1)}`);
      $('#next', el).onclick = () => replaceTo(`#/agenda?d=${addDays(d, 1)}`);
      $('#pick', el).onchange = e => e.target.value && replaceTo(`#/agenda?d=${e.target.value}`);
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
const seriesLabel = e => ({ 7: 'toda semana', 14: 'a cada 15 dias', m: 'todo mês' }[e] || 'repetindo');

function vApptForm(_, q) {
  const edit = q.id ? db.appts.find(a => a.id === q.id) : null;
  const a = edit || { date: q.d || today(), time: '', clientId: q.c || '', service: '', duration: null, price: null, paid: false, notes: '' };
  const cName = a.clientId ? clientName(a.clientId) : '';
  const durs = [30, 60, 90, 120, 180];
  let dur = a.duration || null;
  let paid = isPaid(a);
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
        </div>

        <div class="field">
          <label for="f-phone">Telefone / WhatsApp <span class="opt">(se quiser)</span></label>
          <input type="tel" id="f-phone" value="${esc(client(a.clientId)?.phone || '')}" placeholder="(11) 99999-9999">
        </div>

        <div class="field">
          <label for="f-date">Dia <em>*</em></label>
          <input type="date" id="f-date" value="${a.date}">
          <div class="chips" style="margin-top:.5rem">
            <button type="button" class="chip" data-day="${today()}">Hoje</button>
            <button type="button" class="chip" data-day="${addDays(today(), 1)}">Amanhã</button>
          </div>
        </div>

        <div class="field">
          <label for="f-time">Horário <em>*</em></label>
          <input type="text" id="f-time" inputmode="numeric" maxlength="5" value="${a.time}" placeholder="Ex.: 12:10" style="font-size:1.3rem;font-weight:700;max-width:10rem">
          <div id="busy">${busyList(a.date, a.id)}</div>
          <div id="conflict"></div>
        </div>

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
          <label for="f-service">Serviço <span class="opt">(se quiser)</span></label>
          <div class="ac"><input type="text" id="f-service" value="${esc(a.service || '')}" placeholder="Ex.: Escova, Unha, Corte…" autocapitalize="sentences"><div class="sug" hidden></div></div>
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
          <label for="f-price">Valor <span class="opt">(se quiser)</span></label>
          <div class="money"><input type="text" id="f-price" inputmode="decimal" placeholder="0,00" value="${moneyVal(a.price)}"></div>
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

        <button class="btn main" id="save" type="submit">${edit ? 'Salvar alterações' : '✓ Agendar'}</button>
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
      const refreshTimes = () => { $('#busy', el).innerHTML = busyList(iDate.value, a.id); checkConflict(); paintRep(); };

      // Repetição: datas que vão ser marcadas
      let every = '';
      const repDates = () => every ? seriesDates(iDate.value, every, +($('#rep-months', el)?.value || 3)) : [iDate.value];
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
        if (s?.duration && !dur) { dur = s.duration; paintDur(); checkConflict(); }
        if (s?.price && !iPrice.value) iPrice.value = moneyVal(s.price);
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
        paintDur(); checkConflict();
      });
      iDur.addEventListener('input', () => { const n = parseInt(iDur.value, 10); dur = n > 0 ? n : null; paintDur(); checkConflict(); });

      $$('[data-day]', el).forEach(b => b.onclick = () => { iDate.value = b.dataset.day; refreshTimes(); });
      iDate.addEventListener('change', refreshTimes);
      maskTime(iTime);
      iTime.addEventListener('input', checkConflict);
      bindToggle2($('#f-paid', el), v => { paid = v; $('#f-method', el).hidden = !v; });
      $('#f-method', el).onclick = e => {
        const b = e.target.closest('[data-m]');
        if (!b) return;
        method = b.dataset.m;
        el.querySelectorAll('#f-method button').forEach(x => x.classList.toggle('on', x === b));
      };

      paintDur(); checkConflict();
      if (cName) iClient.dispatchEvent(new Event('change'));
      if (a.service) onService();
      if (!cName) setTimeout(() => iClient.focus(), 50);

      f.addEventListener('submit', e => {
        e.preventDefault();
        const err = msg => { $('#err', el).innerHTML = `<div class="error">${msg}</div>`; window.scrollTo(0, 0); };
        const name = iClient.value.trim();
        if (!name) { err('Escreva o nome da cliente.'); iClient.focus(); return; }
        if (!iDate.value) { err('Escolha o dia.'); return; }
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
          const s = findOrCreate(db.services, svcName, { duration: dur, price });
          if (!s.duration && dur) s.duration = dur;
          if (!s.price && price) s.price = price;
        }
        const data = {
          clientId: c.id, date: iDate.value, time,
          service: svcName ? findByName(db.services, svcName).name : '',
          duration: dur, price, notes: $('#f-notes', el).value.trim(),
        };
        // pagamento: "Já pagou" lança o que falta; "Ainda não" desfaz
        const setPay = x => {
          if (!paid) { if (isPaid(x) || x.paid) clearPayments(x); return; }
          if (!(x.price > 0)) { x.paid = true; return; }
          refreshPaid(x);
          if (!isPaid(x)) addPayment(x, leftOf(x) || x.price, method);
        };
        if (edit) { Object.assign(edit, data); setPay(edit); }
        else {
          const dates = repDates();
          const seriesId = dates.length > 1 ? uid() : null;
          let clash = 0;
          dates.forEach((date, i) => {
            if (conflictsFor(date, time, dur, null).length) clash++;
            const n = { id: uid(), status: 'marcado', createdAt: Date.now(), ...data, date, paid: false };
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
        ${a.seriesId ? `<p>🔁 Cliente fixa · ${seriesLabel(a.seriesEvery)}</p>` : ''}
        <div class="badges">${badgesFor(a)}</div>
        ${conflicts.length ? `<div class="conflict-box">⚠️ Junto com: ${conflicts.map(x => `<b>${esc(clientName(x.clientId))}</b> ${x.time}`).join(', ')}</div>` : ''}
      </div>

      ${a.status === 'pendente' ? `
      <div class="stack">
        <p style="margin:0">Esta cliente pediu o horário pelo link. ${c?.phone ? 'Ao confirmar, ela recebe a confirmação no WhatsApp.' : ''}</p>
        <button class="btn ok" id="accept">✓ Confirmar agendamento</button>
        <button class="btn danger" id="decline">✗ Recusar</button>
      </div>` : ''}

      ${a.status !== 'cancelado' && a.status !== 'pendente' ? `
      <div class="stack">
        <div class="form">
          <label for="price">Valor do serviço</label>
          <div class="quickprice"><div class="money"><input type="text" id="price" inputmode="decimal" placeholder="0,00" value="${moneyVal(a.price)}"></div>
          <button class="btn small main" id="save-price">Salvar</button></div>
        </div>
        <div class="card">
          <span class="lbl" style="font-weight:700;display:block;margin-bottom:.35rem">Pagamento</span>
          ${payBadge(a, 'Não pagou') || '<span class="muted">Coloque o valor para lançar o pagamento.</span>'}
          ${paymentsOf(a).length ? `<ul class="paylist">${paymentsOf(a).map(p => `<li>${brl(p.v)}${PAY[p.m] ? ' · ' + PAY[p.m] : ''} · ${fmtShort(p.d)}</li>`).join('')}</ul>` : ''}
          ${valueOf(a) > 0 && leftOf(a) > 0 ? `<button class="btn ok" id="receive" style="margin-top:.6rem">💰 Receber ${brl(leftOf(a))}</button>` : ''}
          ${paymentsOf(a).length ? '<button class="btn small" id="unpay" style="margin-top:.6rem">Desfazer pagamento</button>' : ''}
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
          : `<button class="btn danger" id="cancel">Cliente desmarcou (cancelar ${a.seriesId ? 'só este' : ''})</button>`}
        ${a.seriesId && nextInSeries(a).length ? `<button class="btn danger" id="cancel-next">Cancelar este e os próximos (${nextInSeries(a).length + 1})</button>` : ''}
        <button class="btn danger" id="del">🗑️ Apagar de vez${a.seriesId ? ' (só este)' : ''}</button>
        ${a.seriesId && nextInSeries(a).length ? `<button class="btn danger" id="del-next">🗑️ Apagar este e os próximos (${nextInSeries(a).length + 1})</button>` : ''}
      </div>`,
    bind(el) {
      const upd = (fn, msg) => { fn(); save(); toast(msg); render(); };
      $('#save-price', el) && ($('#save-price', el).onclick = () => {
        const v = $('#price', el).value;
        const p = parseMoney(v);
        if (v.trim() && p == null) { alert('O valor não está certo. Exemplo: 50,00'); return; }
        upd(() => { a.price = p; refreshPaid(a); }, 'Valor salvo ✓');
      });
      $('#receive', el) && ($('#receive', el).onclick = () => paySheet(a, `${clientName(a.clientId)} — ${a.service || 'Serviço'}`, (v, m) =>
        upd(() => addPayment(a, v, m), isPaid(a) ? `Pago ✓ (${PAY[m]})` : `Recebido ${brl(v)} ✓`)));
      $('#unpay', el) && ($('#unpay', el).onclick = () => confirm('Apagar os pagamentos lançados neste horário?') && upd(() => clearPayments(a), 'Pagamento desfeito'));
      $('#accept', el) && ($('#accept', el).onclick = () => { decide(a, true); render(); });
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
        if (a && decide(a, !!b.dataset.ok)) render();
      });
    },
  };
}

/* =====================================================================
   BUSCAR
   ===================================================================== */
function vBuscar(_, q) {
  return {
    title: 'Buscar', tab: 'buscar',
    html: `
      <div class="search"><input type="search" id="s" placeholder="Nome, serviço, produto ou data (ex.: 15/09)" value="${esc(q.q || '')}"></div>
      <div id="res"></div>`,
    bind(el) {
      const s = $('#s', el);
      const run = () => {
        const n = norm(s.value);
        history.replaceState(null, '', `#/buscar${s.value ? '?q=' + encodeURIComponent(s.value) : ''}`);
        stack[stack.length - 1] = lastHash = curHash();
        if (!n) {
          const next = db.appts.filter(a => !isPast(a) && a.status !== 'cancelado').sort(byWhen).slice(0, 15);
          $('#res', el).innerHTML = `<h2>Próximos horários</h2><div class="list">${next.length ? next.map(a => apptCard(a, { showDate: true })).join('') : '<div class="empty">Nada marcado para os próximos dias.</div>'}</div>`;
          return;
        }
        const match = (...xs) => xs.some(x => norm(x).includes(n));
        const cs = db.clients.filter(c => match(c.name, c.phone)).sort(byName).slice(0, 10);
        const as = db.appts.filter(a => match(clientName(a.clientId), a.service, a.notes, fmtShort(a.date))).sort(byWhen);
        const fut = as.filter(a => !isPast(a));
        const past = as.filter(a => isPast(a)).reverse().slice(0, 40);
        const ss = db.sales.filter(x => match(clientName(x.clientId), x.product, fmtShort(x.date))).sort(byWhen).reverse().slice(0, 30);
        $('#res', el).innerHTML = `
          ${cs.length ? `<h2>Clientes</h2><div class="list">${cs.map(clientRow).join('')}</div>` : ''}
          ${fut.length ? `<h2>Horários marcados</h2><div class="list">${fut.map(a => apptCard(a, { showDate: true })).join('')}</div>` : ''}
          ${past.length ? `<h2>Horários que já passaram</h2><div class="list">${past.map(a => apptCard(a, { showDate: true })).join('')}</div>` : ''}
          ${ss.length ? `<h2>Vendas de produtos</h2><div class="list">${ss.map(x => saleCard(x)).join('')}</div>` : ''}
          ${!cs.length && !as.length && !ss.length ? '<div class="empty">Nada encontrado.</div>' : ''}`;
      };
      s.addEventListener('input', run);
      run();
      if (!q.q) s.focus();
    },
  };
}

/* =====================================================================
   CLIENTES
   ===================================================================== */
function clientRow(c) {
  const owes = clientOwes(c.id);
  const next = db.appts.filter(a => a.clientId === c.id && !isPast(a) && a.status !== 'cancelado').sort(byWhen)[0];
  return `<a class="card line" href="#/cliente/${c.id}" data-name="${esc(norm(c.name + ' ' + (c.phone || '')))}">
    <div class="grow"><b>${esc(c.name)}</b>
      <span>${[c.phone, next ? `Próximo: ${fmtShort(next.date)} ${next.time}` : ''].filter(Boolean).map(esc).join(' · ') || '&nbsp;'}</span></div>
    ${owes > 0 ? `<span class="badge warn">Deve ${brl(owes)}</span>` : ''}
  </a>`;
}

function vClients() {
  const list = [...db.clients].sort(byName);
  return {
    title: 'Clientes', tab: 'clientes',
    html: `
      <div class="search"><input type="search" id="s" placeholder="Procurar cliente…"></div>
      <a class="btn main" href="#/cliente-editar" style="margin-bottom:1rem">+ Nova cliente</a>
      <div class="list" id="list">${list.length ? list.map(clientRow).join('') : '<div class="empty">Nenhuma cliente ainda.<br>Elas aparecem aqui sozinhas quando você agenda.</div>'}</div>
      <div class="empty" id="none" hidden>Nenhuma cliente com esse nome.</div>`,
    bind(el) {
      $('#s', el).addEventListener('input', e => {
        const n = norm(e.target.value);
        let shown = 0;
        $$('#list > a', el).forEach(a => { const ok = a.dataset.name.includes(n); a.hidden = !ok; shown += ok; });
        $('#none', el).hidden = !!shown || !list.length;
      });
    },
  };
}

function vClient(id) {
  const c = client(id);
  if (!c) return { title: 'Cliente', back: true, html: '<div class="empty">Cliente não encontrada.</div>' };
  const appts = db.appts.filter(a => a.clientId === id);
  const next = appts.filter(a => !isPast(a) && a.status !== 'cancelado').sort(byWhen);
  const history = [
    ...appts.filter(a => isPast(a) || a.status === 'cancelado').map(a => ({ k: 'a', when: a.date + a.time, it: a })),
    ...db.sales.filter(s => s.clientId === id).map(s => ({ k: 's', when: s.date + '99', it: s })),
  ].sort((x, y) => y.when.localeCompare(x.when));
  const owes = clientOwes(id);

  return {
    title: c.name, tab: 'clientes', back: true,
    html: `
      <div class="hero">
        <p class="big">${esc(c.name)}</p>
        ${c.phone ? `<p>📞 ${esc(c.phone)}</p>` : '<p class="muted">Sem telefone</p>'}
        ${c.notes ? `<p class="muted">📝 ${esc(c.notes)}</p>` : ''}
        <div class="row" style="margin-top:.7rem">
          ${c.phone ? `<a class="btn small" target="_blank" rel="noopener" href="${waLink(c.phone)}">💬 WhatsApp</a>` : ''}
          <a class="btn small" href="#/cliente-editar?id=${c.id}">✏️ Editar dados</a>
        </div>
      </div>

      <div class="totals">
        <div class="total ok"><span>Já pagou (total)</span><b>${brl(clientPaid(id))}</b></div>
        <div class="total ${owes > 0 ? 'warn' : ''}"><span>Falta pagar</span><b>${brl(owes)}</b></div>
      </div>

      <div class="row">
        <a class="btn main" href="#/agendar?c=${c.id}">📅 Agendar</a>
        <a class="btn main" href="#/venda?c=${c.id}">🛍️ Vender produto</a>
      </div>

      <h2>Próximos horários</h2>
      <div class="list">${next.length ? next.map(a => apptCard(a, { showDate: true, showClient: false })).join('') : '<div class="muted">Nenhum horário marcado.</div>'}</div>

      <h2>Histórico (serviços e produtos)</h2>
      <div class="list">${history.length ? history.map(h => historyRow(h)).join('') : '<div class="muted">Ainda não tem histórico.</div>'}</div>`,
    bind(el) { bindQuickPay(el); },
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
function vSaleForm(_, q) {
  const edit = q.id ? db.sales.find(s => s.id === q.id) : null;
  const s = edit || { clientId: q.c || '', product: '', qty: 1, unitPrice: null, date: today(), paid: false, notes: '' };
  let qty = s.qty || 1;
  let paid = isPaid(s);
  let method = paymentsOf(s).at(-1)?.m || '';

  return {
    title: edit ? 'Venda de produto' : 'Vender produto', tab: 'clientes', back: true,
    html: `
      <form class="form" id="f" autocomplete="off" novalidate>
        <div id="err"></div>
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
        if (paid && data.total > 0 && !method && !isPaid({ ...s, ...data })) { err('Toque em Pix, Dinheiro ou Cartão (como pagou).'); return; }
        const setPay = x => {
          if (!paid) { if (isPaid(x) || x.paid) clearPayments(x); return; }
          if (!(x.total > 0)) { x.paid = true; return; }
          refreshPaid(x);
          if (!isPaid(x)) addPayment(x, leftOf(x) || x.total, method, x.date);
        };
        if (edit) moveStock(edit.product, +edit.qty); // devolve o da venda antiga…
        moveStock(data.product, -qty);                 // …e tira o da venda nova
        if (edit) { Object.assign(edit, data); setPay(edit); }
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
  const [y, mo] = m.split('-').map(Number);
  const shift = n => { const d = new Date(y, mo - 1 + n, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
  const monthLabel = new Date(y, mo - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  const sumBy = (xs, f) => round2(xs.reduce((t, x) => t + (f(x) || 0), 0));

  // Dinheiro que ENTROU no mês (pelo dia do pagamento), separado por serviço/produto e forma
  const received = [];
  for (const a of db.appts) if (a.status !== 'cancelado') for (const p of paymentsOf(a)) if (p.d?.startsWith(m)) received.push({ ...p, k: 'a' });
  for (const x of db.sales) for (const p of paymentsOf(x)) if (p.d?.startsWith(m)) received.push({ ...p, k: 's' });
  const recTotal = sumBy(received, p => p.v);
  const recServ = sumBy(received.filter(p => p.k === 'a'), p => p.v);
  const recProd = sumBy(received.filter(p => p.k === 's'), p => p.v);
  const byMethod = Object.entries(PAY).map(([k, n]) => [n, sumBy(received.filter(p => p.m === k), p => p.v)]).filter(([, v]) => v > 0);
  const noMethod = sumBy(received.filter(p => !PAY[p.m]), p => p.v);

  // Despesas do mês e lucro
  const expenses = db.expenses.filter(e => e.date?.startsWith(m)).sort((a, b) => b.date.localeCompare(a.date));
  const spent = sumBy(expenses, e => e.amount);
  const profit = round2(recTotal - spent);

  // O que é deste mês e ainda não foi pago
  const appts = db.appts.filter(a => a.date.startsWith(m) && a.status !== 'cancelado' && a.status !== 'pendente');
  const sales = db.sales.filter(x => x.date.startsWith(m));
  const owed = sumBy([...appts.filter(apptDue), ...sales.filter(saleDue)], leftOf);
  const expected = sumBy(appts.filter(a => !apptDue(a) && !isPast(a) && a.status === 'marcado'), leftOf);

  // Quem está devendo (de qualquer mês)
  const dueAll = [...db.appts.filter(apptDue).map(a => ({ k: 'a', when: a.date + a.time, it: a })),
                  ...db.sales.filter(saleDue).map(x => ({ k: 's', when: x.date + '99', it: x }))]
    .sort((a, b) => a.when.localeCompare(b.when));
  const noPrice = appts.filter(a => isPast(a) && !(a.price > 0)).sort(byWhen);

  const dueRow = ({ k, it }) => `
    <div class="card">
      <div class="line">
        <a class="grow" href="${k === 'a' ? '#/agendamento/' + it.id : '#/venda?id=' + it.id}">
          <b>${esc(clientName(it.clientId))}</b>
          <span>${fmtShort(it.date)} · ${esc(k === 'a' ? (it.service || 'Serviço') : '🛍️ ' + it.product)}${paidOf(it) > 0 ? ` · já pagou ${brl(paidOf(it))}` : ''}</span></a>
        <span class="amount" style="color:var(--warn)">${brl(leftOf(it))}</span>
      </div>
      <div class="quickprice"><button class="btn small ok" style="flex:1" data-pay="${k}:${it.id}">💰 Receber</button></div>
    </div>`;

  const moves = [...appts.filter(a => valueOf(a) > 0).map(a => ({ k: 'a', it: a })), ...sales.filter(x => valueOf(x) > 0).map(x => ({ k: 's', it: x }))]
    .sort((a, b) => (b.it.date + (b.it.time || '')).localeCompare(a.it.date + (a.it.time || '')));

  return {
    title: 'Dinheiro', tab: 'financeiro',
    html: `
      <div class="monthnav">
        <a class="btn small" href="#/financeiro?m=${shift(-1)}">‹</a>
        <b>${monthLabel}</b>
        <a class="btn small" href="#/financeiro?m=${shift(1)}">›</a>
      </div>
      <div class="totals">
        <div class="total ok full"><span>Entrou no mês</span><b style="font-size:1.8rem">${brl(recTotal)}</b>
          <span>Serviços ${brl(recServ)} · Produtos ${brl(recProd)}</span>
          ${byMethod.length ? `<span>${byMethod.map(([n, v]) => `${n} ${brl(v)}`).join(' · ')}${noMethod ? ` · Sem forma ${brl(noMethod)}` : ''}</span>` : ''}</div>
        <div class="total bad"><span>Saiu (despesas)</span><b>${brl(spent)}</b></div>
        <div class="total ${profit >= 0 ? 'ok' : 'bad'}"><span>Lucro do mês</span><b>${brl(profit)}</b></div>
        <div class="total warn"><span>Falta receber</span><b>${brl(owed)}</b></div>
        <div class="total"><span>Ainda vai entrar</span><b>${brl(expected)}</b></div>
      </div>
      <a class="btn" href="#/despesa">➖ Lançar despesa</a>

      <h2>💸 Quem está devendo ${dueAll.length ? `(${dueAll.length})` : ''}</h2>
      <div class="list">${dueAll.length ? dueAll.map(dueRow).join('') : '<div class="muted">Ninguém devendo. 🎉</div>'}</div>

      ${noPrice.length ? `<h2>Atendimentos sem valor (${noPrice.length})</h2>
        <p class="muted" style="margin-top:-.3rem">Coloque quanto foi cobrado:</p>
        <div class="list">${noPrice.map(a => `<div class="card">
          <a class="line" style="text-decoration:none" href="#/agendamento/${a.id}"><div class="grow"><b>${esc(clientName(a.clientId))}</b>
          <span>${fmtShort(a.date)} ${a.time}${a.service ? ' · ' + esc(a.service) : ''}</span></div></a>
          <div class="quickprice"><div class="money"><input type="text" inputmode="decimal" placeholder="0,00" data-price="${a.id}"></div>
          <button class="btn small main" data-saveprice="${a.id}">Salvar</button></div></div>`).join('')}</div>` : ''}

      <h2>Despesas do mês</h2>
      <div class="list">${expenses.length ? expenses.map(e => `
        <a class="card line" href="#/despesa?id=${e.id}">
          <div class="grow"><b>${esc(e.desc || e.cat || 'Despesa')}</b><span>${fmtShort(e.date)}${e.cat && e.desc ? ' · ' + esc(e.cat) : ''}</span></div>
          <span class="amount" style="color:var(--bad)">− ${brl(e.amount)}</span></a>`).join('') : '<div class="muted">Nenhuma despesa lançada.</div>'}</div>

      <h2>Serviços e vendas do mês</h2>
      <div class="list">${moves.length ? moves.map(({ k, it }) => `
        <a class="card line" href="${k === 'a' ? '#/agendamento/' + it.id : '#/venda?id=' + it.id}">
          <div class="grow"><b>${esc(clientName(it.clientId))}</b>
          <span>${fmtShort(it.date)} · ${esc(k === 'a' ? (it.service || 'Serviço') : '🛍️ ' + it.product)}</span></div>
          <div style="text-align:right"><div class="amount">${brl(valueOf(it))}</div>${
            isPaid(it) ? '<span class="badge ok">Pago</span>'
            : paidOf(it) > 0 ? `<span class="badge warn">Falta ${brl(leftOf(it))}</span>`
            : `<span class="badge warn">${k === 'a' && !apptDue(it) ? 'A pagar' : 'Não pago'}</span>`}</div>
        </a>`).join('') : '<div class="muted">Nenhum valor lançado neste mês.</div>'}</div>`,
    bind(el) { bindQuickPay(el); },
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
function vMore() {
  return {
    title: 'Mais', tab: 'mais',
    html: `
      <div class="stack">
        <a class="btn" href="#/itens/services">💇 Meus serviços (${db.services.length})</a>
        <a class="btn" href="#/itens/products">🛍️ Meus produtos (${db.products.length})${lowProducts().length ? ` · ⚠️ ${lowProducts().length} acabando` : ''}</a>
        <a class="btn" href="#/link">🔗 Link para as clientes agendarem</a>
        <a class="btn" href="#/whatsapp">💬 WhatsApp automático</a>
      </div>

      <h2>Avisos neste aparelho</h2>
      <div id="push-card"></div>

      <h2>Tamanho da letra</h2>
      ${toggle2('big', !!db.settings.big, 'A+ Grande', 'A Normal', true)}

      <h2>Minha conta</h2>
      <div class="card">
        <b>${esc(session.tenant.name)}</b>
        <div class="muted">${esc(session.user.name)} · ${esc(session.user.email)}</div>
        <div id="sync" class="sync"></div>
      </div>
      <button class="btn danger" id="logout" style="margin-top:.7rem">Sair da conta</button>

      <h2>Cópia de segurança</h2>
      <p class="muted" style="margin-top:0">Seus dados ficam guardados na internet, na sua conta. Se quiser, também pode guardar uma cópia no celular ou mandar para o seu WhatsApp/e-mail.</p>
      <div class="stack">
        <button class="btn main" id="exp">📤 Fazer cópia de segurança</button>
        <label class="btn">📥 Recuperar de uma cópia
          <input type="file" id="imp" accept=".json,application/json" hidden></label>
      </div>
      ${db.settings.lastBackup ? `<p class="muted">Última cópia: ${new Date(db.settings.lastBackup).toLocaleString('pt-BR')}</p>` : ''}

      <p class="muted" style="margin-top:2rem;font-size:.85rem;text-align:center">
        ${db.clients.length} clientes · ${db.appts.length} horários · ${db.sales.length} vendas</p>`,
    bind(el) {
      bindToggle2($('#big', el), v => { db.settings.big = v; save(); applySettings(); });
      paintPushCard($('#push-card', el), true);
      $('#exp', el).onclick = exportBackup;
      $('#imp', el).onchange = e => importBackup(e.target.files[0]);
      $('#logout', el).onclick = async () => {
        const n = pendingChanges().length;
        if (!confirm(n ? `Ainda tem ${n} alteração(ões) sem enviar (sem internet). Se sair agora, elas se perdem. Sair mesmo assim?` : 'Sair da conta neste celular?')) return;
        await api('POST', '/api/logout').catch(() => {});
        localStorage.removeItem(cacheKey());
        logoutLocal();
      };
      paintSync();
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
          <div class="grow"><b>${esc(it.name)}</b><span>${[K.withDur ? fmtDur(it.duration) : '', it.price ? brl(it.price) : ''].filter(Boolean).join(' · ') || 'Sem valor definido'}</span></div>
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
        ${K.withDur ? `<div class="field"><label for="d">Duração em minutos <span class="opt">(se quiser)</span></label>
          <input type="number" id="d" inputmode="numeric" min="5" step="5" value="${it?.duration || ''}" placeholder="Ex.: 60"></div>` : ''}
        ${K.withDur ? `<div class="field"><span class="lbl">Aparece no link de agendamento?</span>
          ${toggle2('online', it?.online !== false, '✓ Sim', 'Não')}</div>` : ''}
        <div class="field"><label for="p">Valor <span class="opt">(se quiser)</span></label>
          <div class="money"><input type="text" id="p" inputmode="decimal" placeholder="0,00" value="${moneyVal(it?.price)}"></div></div>
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
        const pv = $('#p', el).value, price = parseMoney(pv);
        if (pv.trim() && price == null) { $('#err', el).innerHTML = '<div class="error">O valor não está certo. Exemplo: 50,00</div>'; return; }
        const data = { name, price };
        if (K.withDur) {
          const d = parseInt($('#d', el).value, 10);
          data.duration = d > 0 ? d : null;
          data.online = $('#online .yes', el).classList.contains('on');
        } else {
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
        await api('PUT', '/api/settings', { booking });
        toast(enabled ? 'Salvo ✓ O link está ligado' : 'Salvo ✓');
        $('#err', box).innerHTML = '';
      } catch (e) {
        $('#err', box).innerHTML = `<div class="error">${esc(e.offline ? 'Precisa de internet para salvar.' : e.message)}</div>`;
      } finally { btn.disabled = false; }
    };
  });
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
      const kinds = { confirm: 'Confirmação', reminder: 'Lembrete', owner: 'Aviso para você', decline: 'Pedido recusado', test: 'Teste' };
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
          <div class="field"><span class="lbl">Confirmação quando eu agendo no app</span>${toggle2('confirmManual', w.confirmManual, '✓ Mandar', 'Não')}</div>
          <div class="field"><label for="rem">Lembrete antes do horário</label>
            <select id="rem">${opts([0, 2, 3, 6, 12, 24, 48], w.reminderHours, v => +v ? (+v === 24 ? '1 dia antes' : +v === 48 ? '2 dias antes' : `${v} horas antes`) : 'Não mandar lembrete')}</select></div>
          <div class="field"><span class="lbl">Também me avisar pelo WhatsApp quando chegar pedido</span>${toggle2('notifyOwner', w.notifyOwner, '✓ Avisar', 'Não')}</div>
          <div class="field"><label for="own">Número que recebe o aviso <span class="opt">(vazio = o próprio WhatsApp conectado)</span></label>
            <input type="tel" id="own" placeholder="(11) 99999-9999" value="${esc(w.ownerPhone || '')}"></div>

          <details><summary class="btn">✏️ Mudar o texto das mensagens</summary>
            <p class="muted">Pode usar: {nome}, {dia}, {hora}, {servico}, {salao}, {telefone}, {link}. Linha com campo vazio (ex.: sem serviço) some sozinha.</p>
            <div class="field"><label for="t-confirm">Confirmação</label><textarea id="t-confirm" rows="6">${esc(w.templates.confirm)}</textarea></div>
            <div class="field"><label for="t-reminder">Lembrete</label><textarea id="t-reminder" rows="6">${esc(w.templates.reminder)}</textarea></div>
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

      const flags = { confirmOnline: w.confirmOnline, confirmManual: w.confirmManual, notifyOwner: w.notifyOwner, declineMessage: w.declineMessage };
      for (const k of Object.keys(flags)) bindToggle2($('#' + k, box), v => (flags[k] = v));

      const err = e => { $('#err', box).innerHTML = `<div class="error">${esc(e.offline ? 'Precisa de internet.' : e.message)}</div>`; };
      $('#save', box).onclick = async () => {
        try {
          await api('PUT', '/api/settings', { whatsapp: {
            ...flags, reminderHours: +$('#rem', box).value, ownerPhone: $('#own', box).value.trim(),
            templates: { confirm: $('#t-confirm', box).value, reminder: $('#t-reminder', box).value, owner: $('#t-owner', box).value, decline: $('#t-decline', box).value },
          } });
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

// Manda uma cópia inteira para a conta (recuperar cópia / trazer dados antigos)
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
  await syncNow();
  await offerOldData();
}

// Traz os dados da versão antiga do app (que ficavam só no celular)
async function offerOldData() {
  const code = sessionStorage.getItem('mf.handoff');
  if (code) {
    try {
      const r = await api('POST', '/api/handoff/claim', { code });
      sessionStorage.removeItem('mf.handoff');
      await resetFromServer();
      toast(`${r.imported} registros trazidos do app antigo ✓`);
    } catch (e) {
      if (!e.offline) { sessionStorage.removeItem('mf.handoff'); alert(e.message); }
    }
    return;
  }
  const old = readLS(OLD_KEY);
  if (!old || localStorage.getItem('mf.oldImported')) return;
  const d = migrate(old);
  const n = COLLS.reduce((t, k) => t + d[k].length, 0);
  if (!n) return;
  if (confirm(`Encontramos dados da versão antiga neste celular (${d.clients.length} clientes, ${d.appts.length} horários).\n\nLevar para a sua conta?`)) {
    if (await uploadAll(d, false)) localStorage.setItem('mf.oldImported', '1');
  } else localStorage.setItem('mf.oldImported', 'no');
}

/* ---------------------------- início ---------------------------- */
function applySettings() { document.documentElement.classList.toggle('big', !!db.settings.big); }

// Link vindo do app antigo: #/migrar?code=...
function catchHandoff() {
  const { parts, q } = parseHash();
  if (parts[0] !== 'migrar') return false;
  if (q.code) sessionStorage.setItem('mf.handoff', q.code);
  history.replaceState(null, '', '#/agenda');
  return true;
}
catchHandoff();
window.addEventListener('hashchange', () => { if (catchHandoff() && session) { render(); offerOldData(); } });
stack.push(curHash());
if (session) {
  loadCache();
  applySettings();
  render();
  // confere se a sessão ainda vale (sem internet, segue com a cópia do celular)
  api('GET', '/api/me').then(me => { session = me; writeLS('mf.session', me); refreshPush(); return syncNow(); })
    .then(offerOldData)
    .catch(e => { if (e.status === 401) logoutLocal(); else { syncState = 'offline'; paintSync(); } });
} else showLogin();

// Pede ao navegador para não apagar os dados sozinho
navigator.storage?.persist?.();
// Funciona sem internet depois de aberto uma vez
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
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
