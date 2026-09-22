'use strict';

/* =====================================================================
   Minha Agenda — app simples para salão de beleza.
   Tudo fica salvo no próprio aparelho (localStorage).
   ===================================================================== */

const KEY = 'agendaSalao.v1';
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
function migrate(d) {
  d = d && typeof d === 'object' ? d : {};
  for (const k of ['clients', 'services', 'products', 'appts', 'sales']) if (!Array.isArray(d[k])) d[k] = [];
  d.settings = d.settings || {};
  return d;
}
function load() {
  try { return migrate(JSON.parse(localStorage.getItem(KEY))); } catch { return migrate({}); }
}
let db = load();
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); }
  catch { alert('Não foi possível salvar! O armazenamento do celular pode estar cheio.'); }
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
const apptDue = a => a.status !== 'cancelado' && !a.paid && a.price > 0 && (a.status === 'feito' || isPast(a));
const saleDue = s => !s.paid && s.total > 0;
function clientOwes(id) {
  return db.appts.filter(a => a.clientId === id && apptDue(a)).reduce((t, a) => t + a.price, 0) +
    db.sales.filter(s => s.clientId === id && saleDue(s)).reduce((t, s) => t + s.total, 0);
}
function clientPaid(id) {
  return db.appts.filter(a => a.clientId === id && a.paid && a.status !== 'cancelado').reduce((t, a) => t + (a.price || 0), 0) +
    db.sales.filter(s => s.clientId === id && s.paid).reduce((t, s) => t + s.total, 0);
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
  agendar: vApptForm, agendamento: vAppt, venda: vSaleForm, financeiro: vFin, mais: vMore,
  itens: vItems, item: vItemForm,
};

let lastHash = '';
function render() {
  const { parts, q } = parseHash();
  const view = routes[parts[0]] || vAgenda;
  const v = view(parts[1], q) || {};
  $('#title').textContent = v.title || 'Minha Agenda';
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
  if (a.status === 'cancelado') b.push('<span class="badge bad">Cancelado</span>');
  else if (a.status === 'feito') b.push('<span class="badge ok">✓ Feito</span>');
  if (a.status !== 'cancelado') {
    if (a.price > 0) b.push(a.paid ? `<span class="badge ok">Pago ${brl(a.price)}</span>`
      : `<span class="badge warn">${apptDue(a) ? 'Não pago' : 'A pagar'} ${brl(a.price)}</span>`);
    else if (a.paid) b.push('<span class="badge ok">Pago</span>');
    if (conflictsFor(a.date, a.time, a.duration, a.id).length) b.push('<span class="badge warn">⚠️ Horário junto</span>');
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
      <div class="badges">${s.paid ? `<span class="badge ok">Pago ${brl(s.total)}</span>` : `<span class="badge warn">Não pago ${brl(s.total)}</span>`}</div>
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

function toggle2(id, yes, labelYes, labelNo) {
  return `<div class="toggle2" id="${id}">
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
      <h2>${active.length ? `${active.length} ${active.length === 1 ? 'horário' : 'horários'}` : ''}</h2>
      <div class="list">
        ${list.length ? list.map(a => apptCard(a)).join('') : '<div class="empty">Nenhum horário marcado neste dia.<br>Toque em <b>+ Agendar</b> para marcar.</div>'}
      </div>
      <a class="fab" href="#/agendar?d=${d}">+ Agendar</a>`,
    bind(el) {
      $('#prev', el).onclick = () => replaceTo(`#/agenda?d=${addDays(d, -1)}`);
      $('#next', el).onclick = () => replaceTo(`#/agenda?d=${addDays(d, 1)}`);
      $('#pick', el).onchange = e => e.target.value && replaceTo(`#/agenda?d=${e.target.value}`);
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

function vApptForm(_, q) {
  const edit = q.id ? db.appts.find(a => a.id === q.id) : null;
  const a = edit || { date: q.d || today(), time: '', clientId: q.c || '', service: '', duration: null, price: null, paid: false, notes: '' };
  const cName = a.clientId ? clientName(a.clientId) : '';
  const durs = [30, 60, 90, 120, 180];
  let dur = a.duration || null;
  let paid = !!a.paid;

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
      const refreshTimes = () => { $('#busy', el).innerHTML = busyList(iDate.value, a.id); checkConflict(); };

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
      bindToggle2($('#f-paid', el), v => (paid = v));

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
          duration: dur, price, paid, notes: $('#f-notes', el).value.trim(),
        };
        if (edit) Object.assign(edit, data);
        else db.appts.push({ id: uid(), status: 'marcado', createdAt: Date.now(), ...data });
        save();
        toast(edit ? 'Alterações salvas ✓' : 'Horário marcado ✓');
        if (edit) back(); else { replaceTo(`#/agenda?d=${data.date}`); }
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
        <div class="badges">${badgesFor(a)}</div>
        ${conflicts.length ? `<div class="conflict-box">⚠️ Junto com: ${conflicts.map(x => `<b>${esc(clientName(x.clientId))}</b> ${x.time}`).join(', ')}</div>` : ''}
      </div>

      ${a.status !== 'cancelado' ? `
      <div class="stack">
        <div class="form">
          <label for="price">Valor do serviço</label>
          <div class="quickprice"><div class="money"><input type="text" id="price" inputmode="decimal" placeholder="0,00" value="${moneyVal(a.price)}"></div>
          <button class="btn small main" id="save-price">Salvar</button></div>
        </div>
        <div><span class="lbl" style="font-weight:700;display:block;margin-bottom:.35rem">Pagamento</span>
          ${toggle2('paid', a.paid, '✓ Já pagou', 'Não pagou')}</div>
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
          : '<button class="btn danger" id="cancel">Cliente desmarcou (cancelar)</button>'}
        <button class="btn danger" id="del">🗑️ Apagar de vez</button>
      </div>`,
    bind(el) {
      const upd = (fn, msg) => { fn(); save(); toast(msg); render(); };
      $('#save-price', el) && ($('#save-price', el).onclick = () => {
        const v = $('#price', el).value;
        const p = parseMoney(v);
        if (v.trim() && p == null) { alert('O valor não está certo. Exemplo: 50,00'); return; }
        upd(() => (a.price = p), 'Valor salvo ✓');
      });
      $('#paid', el) && bindToggle2($('#paid', el), v => upd(() => (a.paid = v), v ? 'Marcado como pago ✓' : 'Marcado como não pago'));
      $('#done', el) && ($('#done', el).onclick = () => upd(() => (a.status = 'feito'), 'Atendimento feito ✓'));
      $('#undo-done', el) && ($('#undo-done', el).onclick = () => upd(() => (a.status = 'marcado'), 'Pronto'));
      $('#cancel', el) && ($('#cancel', el).onclick = () => confirm('Marcar este horário como cancelado?') && upd(() => (a.status = 'cancelado'), 'Horário cancelado'));
      $('#uncancel', el) && ($('#uncancel', el).onclick = () => upd(() => (a.status = 'marcado'), 'Horário de volta ✓'));
      $('#del', el).onclick = () => {
        if (!confirm('Apagar este horário para sempre?')) return;
        db.appts = db.appts.filter(x => x.id !== a.id);
        save(); toast('Horário apagado'); back();
      };
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
  } else if (!it.paid) {
    extra = `<div class="quickprice"><button class="btn small ok" style="flex:1" data-pay="${k}:${it.id}">✓ Recebi ${brl(price)}</button></div>`;
  }
  return extra ? `<div>${card}${extra}</div>` : card;
}

function bindQuickPay(el) {
  el.addEventListener('click', e => {
    const pay = e.target.closest('[data-pay]');
    if (pay) {
      const [k, id] = pay.dataset.pay.split(':');
      const it = (k === 'a' ? db.appts : db.sales).find(x => x.id === id);
      if (it) { it.paid = true; if (k === 'a' && it.status === 'marcado') it.status = 'feito'; save(); toast('Pagamento recebido ✓'); render(); }
      return;
    }
    const sp = e.target.closest('[data-saveprice]');
    if (sp) {
      const id = sp.dataset.saveprice;
      const inp = el.querySelector(`[data-price="${id}"]`);
      const p = parseMoney(inp.value);
      if (p == null) { alert('Escreva o valor. Exemplo: 50,00'); inp.focus(); return; }
      const a = db.appts.find(x => x.id === id);
      if (a) { a.price = p; if (a.status === 'marcado') a.status = 'feito'; save(); toast('Valor salvo ✓'); render(); }
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
  let paid = !!s.paid;

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
          ${toggle2('f-paid', paid, '✓ Já pagou', 'Ainda não')}
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
      const hp = () => nameHint($('#h-prod', el), db.products, iProd.value, '✨ Produto novo — vai ficar salvo na lista', '✓ Produto da sua lista');
      iProd.addEventListener('input', hp);
      iProd.addEventListener('change', () => {
        hp();
        const p = findByName(db.products, iProd.value);
        if (p?.price && !iPrice.value) { iPrice.value = moneyVal(p.price); total(); }
      });
      iPrice.addEventListener('input', total);
      $('#minus', el).onclick = () => { qty = Math.max(1, qty - 1); $('#qty', el).textContent = qty; total(); };
      $('#plus', el).onclick = () => { qty++; $('#qty', el).textContent = qty; total(); };
      bindToggle2($('#f-paid', el), v => (paid = v));
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
        const data = { clientId: c.id, product: p.name, qty, unitPrice: unit, total: Math.round((unit || 0) * qty * 100) / 100, date: $('#f-date', el).value || today(), paid };
        if (edit) Object.assign(edit, data);
        else db.sales.push({ id: uid(), createdAt: Date.now(), ...data });
        save();
        toast(edit ? 'Venda salva ✓' : 'Venda lançada ✓');
        if (edit) back(); else replaceTo(`#/cliente/${c.id}`);
      });
      $('#del', el) && ($('#del', el).onclick = () => {
        if (!confirm('Apagar esta venda?')) return;
        db.sales = db.sales.filter(x => x.id !== edit.id);
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

  const appts = db.appts.filter(a => a.date.startsWith(m) && a.status !== 'cancelado');
  const sales = db.sales.filter(s => s.date.startsWith(m));
  const sum = xs => xs.reduce((t, x) => t + (x.v || 0), 0);
  const items = [...appts.map(a => ({ v: a.price, paid: a.paid, due: apptDue(a), k: 'a', it: a })),
                 ...sales.map(s => ({ v: s.total, paid: s.paid, due: saleDue(s), k: 's', it: s }))];
  const received = sum(items.filter(i => i.paid));
  const owed = sum(items.filter(i => i.due));
  const expected = sum(items.filter(i => !i.paid && !i.due && i.k === 'a'));
  const recServ = sum(items.filter(i => i.paid && i.k === 'a'));
  const recProd = sum(items.filter(i => i.paid && i.k === 's'));

  // Tudo que falta receber (de qualquer mês)
  const dueAll = [...db.appts.filter(apptDue).map(a => ({ k: 'a', when: a.date + a.time, it: a })),
                  ...db.sales.filter(saleDue).map(s => ({ k: 's', when: s.date + '99', it: s }))]
    .sort((a, b) => a.when.localeCompare(b.when));
  const noPrice = appts.filter(a => isPast(a) && !(a.price > 0)).sort(byWhen);

  const dueRow = ({ k, it }) => `
    <div class="card">
      <div class="line">
        <a class="grow" href="${k === 'a' ? '#/agendamento/' + it.id : '#/venda?id=' + it.id}">
          <b>${esc(clientName(it.clientId))}</b>
          <span>${fmtShort(it.date)} · ${esc(k === 'a' ? (it.service || 'Serviço') : '🛍️ ' + it.product)}</span></a>
        <span class="amount" style="color:var(--warn)">${brl(k === 'a' ? it.price : it.total)}</span>
      </div>
      <div class="quickprice"><button class="btn small ok" style="flex:1" data-pay="${k}:${it.id}">✓ Recebi</button></div>
    </div>`;

  const moves = items.filter(i => i.v > 0).sort((a, b) => (b.it.date + (b.it.time || '')).localeCompare(a.it.date + (a.it.time || '')));

  return {
    title: 'Dinheiro', tab: 'financeiro',
    html: `
      <div class="monthnav">
        <a class="btn small" href="#/financeiro?m=${shift(-1)}">‹</a>
        <b>${monthLabel}</b>
        <a class="btn small" href="#/financeiro?m=${shift(1)}">›</a>
      </div>
      <div class="totals">
        <div class="total ok full"><span>Recebido no mês</span><b style="font-size:1.8rem">${brl(received)}</b>
          <span>Serviços ${brl(recServ)} · Produtos ${brl(recProd)}</span></div>
        <div class="total warn"><span>Falta receber</span><b>${brl(owed)}</b></div>
        <div class="total"><span>Ainda vai entrar (agendados)</span><b>${brl(expected)}</b></div>
      </div>

      <h2>💸 Quem está devendo ${dueAll.length ? `(${dueAll.length})` : ''}</h2>
      <div class="list">${dueAll.length ? dueAll.map(dueRow).join('') : '<div class="muted">Ninguém devendo. 🎉</div>'}</div>

      ${noPrice.length ? `<h2>Atendimentos sem valor (${noPrice.length})</h2>
        <p class="muted" style="margin-top:-.3rem">Coloque quanto foi cobrado:</p>
        <div class="list">${noPrice.map(a => `<div class="card">
          <a class="line" style="text-decoration:none" href="#/agendamento/${a.id}"><div class="grow"><b>${esc(clientName(a.clientId))}</b>
          <span>${fmtShort(a.date)} ${a.time}${a.service ? ' · ' + esc(a.service) : ''}</span></div></a>
          <div class="quickprice"><div class="money"><input type="text" inputmode="decimal" placeholder="0,00" data-price="${a.id}"></div>
          <button class="btn small main" data-saveprice="${a.id}">Salvar</button></div></div>`).join('')}</div>` : ''}

      <h2>Tudo do mês</h2>
      <div class="list">${moves.length ? moves.map(i => `
        <a class="card line" href="${i.k === 'a' ? '#/agendamento/' + i.it.id : '#/venda?id=' + i.it.id}">
          <div class="grow"><b>${esc(clientName(i.it.clientId))}</b>
          <span>${fmtShort(i.it.date)} · ${esc(i.k === 'a' ? (i.it.service || 'Serviço') : '🛍️ ' + i.it.product)}</span></div>
          <div style="text-align:right"><div class="amount">${brl(i.v)}</div>
          ${i.paid ? '<span class="badge ok">Pago</span>' : `<span class="badge warn">${i.due ? 'Não pago' : 'A pagar'}</span>`}</div>
        </a>`).join('') : '<div class="muted">Nenhum valor lançado neste mês.</div>'}</div>`,
    bind(el) { bindQuickPay(el); },
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
        <a class="btn" href="#/itens/products">🛍️ Meus produtos (${db.products.length})</a>
      </div>

      <h2>Tamanho da letra</h2>
      ${toggle2('big', !!db.settings.big, 'A+ Grande', 'A Normal')}

      <h2>Cópia de segurança</h2>
      <p class="muted" style="margin-top:0">Seus dados ficam guardados só neste celular. Faça uma cópia de vez em quando e mande para o seu WhatsApp ou e-mail — assim, se trocar de celular, não perde nada.</p>
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
      $('#exp', el).onclick = exportBackup;
      $('#imp', el).onchange = e => importBackup(e.target.files[0]);
    },
  };
}

const KINDS = {
  services: { title: 'Meus serviços', one: 'serviço', list: () => db.services, withDur: true },
  products: { title: 'Meus produtos', one: 'produto', list: () => db.products, withDur: false },
};

function vItems(kind) {
  const K = KINDS[kind] || KINDS.services;
  const list = [...K.list()].sort(byName);
  return {
    title: K.title, tab: 'mais', back: true,
    html: `
      <a class="btn main" href="#/item/${kind}" style="margin-bottom:1rem">+ Novo ${K.one}</a>
      <p class="muted">Eles também são salvos sozinhos quando você escreve um ${K.one} novo ${kind === 'services' ? 'ao agendar' : 'ao vender'}.</p>
      <div class="list">${list.length ? list.map(it => `
        <a class="card line" href="#/item/${kind}?id=${it.id}">
          <div class="grow"><b>${esc(it.name)}</b><span>${[K.withDur ? fmtDur(it.duration) : '', it.price ? brl(it.price) : ''].filter(Boolean).join(' · ') || 'Sem valor definido'}</span></div>
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
        <div class="field"><label for="p">Valor <span class="opt">(se quiser)</span></label>
          <div class="money"><input type="text" id="p" inputmode="decimal" placeholder="0,00" value="${moneyVal(it?.price)}"></div></div>
        <button class="btn main" type="submit">✓ Salvar</button>
        ${it ? '<button class="btn danger" type="button" id="del" style="margin-top:2rem">🗑️ Apagar</button>' : ''}
      </form>`,
    bind(el) {
      if (!it) $('#n', el).focus();
      $('#f', el).addEventListener('submit', e => {
        e.preventDefault();
        const name = $('#n', el).value.trim().replace(/\s+/g, ' ');
        if (!name) { $('#err', el).innerHTML = '<div class="error">Escreva o nome.</div>'; return; }
        const same = findByName(K.list(), name);
        if (same && same !== it) { $('#err', el).innerHTML = `<div class="error">Já existe "${esc(same.name)}".</div>`; return; }
        const pv = $('#p', el).value, price = parseMoney(pv);
        if (pv.trim() && price == null) { $('#err', el).innerHTML = '<div class="error">O valor não está certo. Exemplo: 50,00</div>'; return; }
        const data = { name, price };
        if (K.withDur) { const d = parseInt($('#d', el).value, 10); data.duration = d > 0 ? d : null; }
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
      if (!confirm(`Essa cópia tem ${d.clients.length} clientes e ${d.appts.length} horários.\n\nTrocar TUDO o que está no celular por ela?`)) return;
      db = d; save(); applySettings(); toast('Dados recuperados ✓'); render();
    } catch { alert('Esse arquivo não é uma cópia válida da agenda.'); }
  };
  r.readAsText(f);
}

/* ---------------------------- início ---------------------------- */
function applySettings() { document.documentElement.classList.toggle('big', !!db.settings.big); }

applySettings();
stack.push(curHash());
render();

// Pede ao navegador para não apagar os dados sozinho
navigator.storage?.persist?.();
// Funciona sem internet depois de aberto uma vez
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
// Atualiza a tela quando volta para o app (ex.: horário "passou")
document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('#app form')) { db = load(); render(); } });
