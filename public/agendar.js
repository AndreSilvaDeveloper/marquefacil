'use strict';

/* Página pública: a cliente pede um horário, um passo de cada vez:
   1) serviço (da lista ou escrito por ela)  2) dia no calendário  3) horário  4) nome e WhatsApp */

// Marca do domínio (o servidor coloca window.BRAND no HTML)
const BRAND = window.BRAND || {};
if (BRAND.colors) {
  const r = document.documentElement.style;
  for (const [k, v] of Object.entries({ '--brand': BRAND.colors.brand, '--brand-soft': BRAND.colors.brandSoft, '--header': BRAND.colors.header, '--bg': BRAND.colors.bg, '--line': BRAND.colors.line })) if (v) r.setProperty(k, v);
}

const slug = location.pathname.split('/').filter(Boolean)[0] || '';
const API = `/api/public/${encodeURIComponent(slug)}`;
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const toDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const dstr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const dayName = s => cap(toDate(s).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }));

async function api(path, body) {
  let r;
  try {
    r = await fetch(API + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  } catch { throw new Error('Sem internet. Confira a conexão e tente de novo.'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || 'Algo deu errado. Tente de novo.'); e.status = r.status; throw e; }
  return j;
}

// O que a cliente já escolheu
const st = {
  info: null, step: 1,
  service: undefined,   // objeto da lista, ou null (escreveu / não tem lista)
  serviceText: '',      // o que ela escreveu, quando não está na lista
  writing: false,
  days: [], month: null, date: null, slots: [], loadingSlots: false, time: null,
};
const remembered = (() => { try { return JSON.parse(localStorage.getItem('mf.cliente')) || {}; } catch { return {}; } })();
const hasServices = () => st.info.services.length > 0;
const firstStep = () => (hasServices() ? 1 : 2);
const totalSteps = () => (hasServices() ? 4 : 3);
const stepNumber = n => n - (hasServices() ? 0 : 1);
const serviceLabel = () => st.service?.name || st.serviceText || '';
const serviceQuery = () => (st.service ? `service=${encodeURIComponent(st.service.id)}` : '');

/* ------------------------------ navegação entre passos ------------------------------ */
// Cada passo entra no histórico: o "voltar" do celular volta um passo em vez de sair da página
function go(step, push = true) {
  st.step = step;
  if (push) history.pushState({ step }, '');
  paint();
  window.scrollTo(0, 0);
}
window.addEventListener('popstate', e => {
  if (e.state?.portal) return portalGo(e.state.portal, false);
  const s = e.state?.step;
  if (st.info && typeof s === 'number') go(s, false);
});

// Resumo do que já foi escolhido (tocar leva de volta àquele passo)
function summary() {
  const items = [];
  if (st.step > 1 && hasServices()) items.push(['💇', serviceLabel(), 1]);
  if (st.step > 2 && st.date) items.push(['📅', dayName(st.date), 2]);
  if (st.step > 3 && st.time) items.push(['🕐', st.time, 3]);
  if (!items.length) return '';
  return `<div class="picked">${items.map(([ic, txt, s]) => `<button type="button" data-go="${s}">${ic} ${esc(txt)} <span>trocar</span></button>`).join('')}</div>`;
}

function frame(title, body, { back = true } = {}) {
  const n = stepNumber(st.step), total = totalSteps();
  return `
    ${st.info.message && st.step === firstStep() ? `<div class="summary">${esc(st.info.message).replace(/\n/g, '<br>')}</div>` : ''}
    <div class="progress" aria-label="Passo ${n} de ${total}">${Array.from({ length: total }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('')}</div>
    ${summary()}
    <section class="step">
      <p class="muted" style="margin:0 0 .2rem">Passo ${n} de ${total}</p>
      <h2 style="margin-top:0">${title}</h2>
      ${body}
    </section>
    ${back && st.step > firstStep() ? '<button type="button" class="btn" id="back">‹ Voltar</button>' : ''}`;
}

/* ------------------------------ passos ------------------------------ */
function stepService() {
  return frame('Qual serviço você quer?', `
    <div class="pick" id="services">
      ${st.info.services.map(s => `<button type="button" data-id="${s.id}" class="${st.service?.id === s.id ? 'on' : ''}">${esc(s.name)}
        ${s.description ? `<small>${esc(s.description)}</small>` : ''}</button>`).join('')}
      <button type="button" data-id="" class="${st.writing ? 'on' : ''}">✏️ Outro serviço (escrever)</button>
    </div>
    ${st.writing ? `
    <form class="form" id="own" style="margin-top:1rem" novalidate>
      <div class="field"><label for="svc">O que você quer fazer?</label>
        <input type="text" id="svc" maxlength="80" value="${esc(st.serviceText)}" placeholder="Ex.: Luzes, progressiva, unha em gel…" autocapitalize="sentences">
        <small class="hint">O salão confirma se faz esse serviço.</small></div>
      <button class="btn main" type="submit">Continuar ›</button>
    </form>` : ''}
    <p class="price-note">💬 O valor varia conforme o serviço e cada cliente. O salão informa o valor quando confirmar o seu horário.</p>`, { back: false })
    + `<button type="button" class="btn" id="to-meus" style="margin-top:1rem">📋 ${meusToken() ? 'Meus horários — ver ou remarcar' : 'Já tenho horário — ver ou remarcar'}</button>`;
}

// Calendário do mês: dias livres em destaque (usado para pedir e para remarcar)
function calendarHtml(days, month, selected) {
  const free = new Map(days.map(d => [d.date, d.free]));
  const first = days[0].date, last = days.at(-1).date;
  const m = month || (selected || [...free].find(([, n]) => n > 0)[0]).slice(0, 7);
  const [y, mo] = m.split('-').map(Number);
  const start = new Date(y, mo - 1, 1);
  const cells = [];
  for (let i = 0; i < start.getDay(); i++) cells.push('<span></span>');
  for (let d = new Date(start); d.getMonth() === mo - 1; d.setDate(d.getDate() + 1)) {
    const ds = dstr(d), ok = free.get(ds) > 0;
    cells.push(`<button type="button" data-date="${ds}" ${ok ? '' : 'disabled'} class="${ds === selected ? 'on' : ''} ${ds === first ? 'today' : ''}"
      aria-label="${dayName(ds)}${ok ? '' : ' — sem horário'}">${d.getDate()}</button>`);
  }
  const prev = m > first.slice(0, 7), next = m < last.slice(0, 7);
  const monthName = cap(start.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }));
  return `
    <p class="muted" style="margin-top:-.4rem">Toque em um dia <b>em destaque</b>. Os dias apagados não têm horário livre.</p>
    <div class="cal" data-month-of="${m}">
      <div class="cal-head">
        <button type="button" class="cal-nav" data-month="-1" ${prev ? '' : 'disabled'} aria-label="Mês anterior">‹</button>
        <b>${monthName}</b>
        <button type="button" class="cal-nav" data-month="1" ${next ? '' : 'disabled'} aria-label="Próximo mês">›</button>
      </div>
      <div class="cal-grid cal-week">${['D', 'S', 'T', 'Q', 'Q', 'S', 'S'].map(w => `<span>${w}</span>`).join('')}</div>
      <div class="cal-grid" id="cal">${cells.join('')}</div>
    </div>`;
}
const shiftMonth = (m, n) => { const [y, mo] = m.split('-').map(Number); const d = new Date(y, mo - 1 + n, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };

function stepDay() {
  if (!st.days.length) return frame('Qual dia?', '<p class="muted">Carregando dias…</p>');
  if (!st.days.some(d => d.free)) return frame('Qual dia?', '<p class="muted">Não há horários livres nos próximos dias. 😕<br>Fale com o salão pelo WhatsApp.</p>');
  return frame('Qual dia?', calendarHtml(st.days, st.month, st.date));
}

function stepTime() {
  return frame('Qual horário?',
    st.loadingSlots ? '<p class="muted">Carregando horários…</p>'
      : st.slots.length ? `<div class="times" id="times">${st.slots.map(t => `<button type="button" class="${st.time === t ? 'on' : ''}">${t}</button>`).join('')}</div>`
        : '<p class="muted">Não sobrou horário nesse dia. Volte e escolha outro dia.</p>');
}

const submitLabel = () => (st.info.approval ? '✓ Pedir este horário' : '✓ Confirmar agendamento');
function stepData() {
  return frame('Seus dados', `
    <form class="form" id="f" novalidate autocomplete="on">
      <div id="err"></div>
      <div class="field"><label for="name">Seu nome</label>
        <input type="text" id="name" autocomplete="name" autocapitalize="words" value="${esc(remembered.name || '')}"></div>
      <div class="field"><label for="phone">Seu WhatsApp (com DDD)</label>
        <input type="tel" id="phone" autocomplete="tel" placeholder="(11) 99999-9999" value="${esc(remembered.phone || '')}"></div>
      <div class="field"><label for="notes">Observação <span class="opt">(se quiser)</span></label>
        <textarea id="notes" placeholder="Algo que a profissional precisa saber?"></textarea></div>
      <input class="hp" type="text" id="website" tabindex="-1" autocomplete="off" aria-hidden="true">
      <button class="btn main" type="submit">${submitLabel()}</button>
    </form>`);
}

function paint() {
  const view = { 1: stepService, 2: stepDay, 3: stepTime, 4: stepData }[st.step];
  $('#app').innerHTML = view();
  bind();
}

/* ------------------------------ ações ------------------------------ */
async function chooseService(service, text = '', push = true) {
  st.service = service; st.serviceText = text;
  st.days = []; st.date = null; st.time = null; st.month = null;
  go(2, push);
  try { st.days = (await api(`/days${serviceQuery() ? '?' + serviceQuery() : ''}`)).days; }
  catch (e) { alert(e.message); }
  if (st.step === 2) paint();
}

async function chooseDay(date, push = true) {
  st.date = date; st.time = null; st.slots = []; st.loadingSlots = true;
  go(3, push);
  try { st.slots = (await api(`/slots?date=${date}${serviceQuery() ? '&' + serviceQuery() : ''}`)).slots; }
  catch (e) { alert(e.message); }
  st.loadingSlots = false;
  if (st.step === 3) paint();
}

function bind() {
  $('#back')?.addEventListener('click', () => history.back());
  $('#to-meus')?.addEventListener('click', () => portalGo(meusToken() ? 'meus' : 'acesso'));
  document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => go(+b.dataset.go));

  $('#services')?.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.id) { st.writing = false; chooseService(st.info.services.find(s => s.id === b.dataset.id)); return; }
    st.writing = true;
    paint();
    setTimeout(() => $('#svc')?.focus(), 50);
  });
  $('#own')?.addEventListener('submit', e => {
    e.preventDefault();
    const text = $('#svc').value.trim();
    if (!text) { $('#svc').focus(); $('#svc').placeholder = 'Escreva o serviço aqui'; return; }
    chooseService(null, text);
  });

  $('#cal')?.addEventListener('click', e => {
    const b = e.target.closest('button[data-date]');
    if (b && !b.disabled) chooseDay(b.dataset.date);
  });
  document.querySelectorAll('[data-month]').forEach(b => b.onclick = () => {
    st.month = shiftMonth($('.cal').dataset.monthOf, +b.dataset.month);
    paint();
  });

  $('#times')?.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    st.time = b.textContent;
    go(4);
  });

  $('#f')?.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('#f button[type=submit]');
    const data = {
      name: $('#name').value, phone: $('#phone').value, notes: $('#notes').value, website: $('#website').value,
      date: st.date, time: st.time, serviceId: st.service?.id || null, serviceText: st.service ? '' : st.serviceText,
    };
    btn.disabled = true;
    btn.textContent = 'Enviando…';
    try {
      const r = await api('/book', data);
      try { localStorage.setItem('mf.cliente', JSON.stringify({ name: data.name.trim(), phone: data.phone.trim() })); } catch { /* ok */ }
      if (r.meus) saveMeus(r.meus);
      done(r);
    } catch (err) {
      $('#err').innerHTML = `<div class="error">${esc(err.message)}</div>`;
      btn.disabled = false;
      btn.textContent = submitLabel();
      if (err.status === 409) { // alguém pegou o horário: volta para a lista de horários, com o aviso
        await chooseDay(st.date);
        $('.step h2')?.insertAdjacentHTML('afterend', `<div class="error">${esc(err.message)}</div>`);
      }
    }
  });
}

function done(r) {
  history.replaceState({ step: 'done' }, '');
  window.scrollTo(0, 0);
  $('#app').innerHTML = `
    <div class="step ok-box">
      <div class="big">${r.pending ? '⏳' : '✅'}</div>
      <h2 style="justify-content:center">${r.pending ? 'Pedido enviado!' : 'Horário agendado!'}</h2>
      <p style="font-size:1.15rem"><b>${esc(dayName(r.date))}</b> às <b>${esc(r.time)}</b></p>
      ${r.service ? `<p>💇 ${esc(r.service)}</p>` : ''}
      <p class="muted">${esc(r.salon)}</p>
      ${r.pending
        ? '<p><b>O salão vai confirmar o seu horário.</b><br>Você recebe a confirmação e o valor pelo WhatsApp. 💬</p>'
        : '<p class="muted">Se precisar remarcar ou cancelar, é só abrir "Meus horários".</p>'}
      <button class="btn main" id="see-meus" style="margin-top:1rem">📋 Ver meus horários</button>
      <button class="btn" id="again" style="margin-top:.6rem">Pedir outro horário</button>
    </div>`;
  $('#see-meus').onclick = () => portalGo('meus');
  $('#again').onclick = () => {
    Object.assign(st, { service: undefined, serviceText: '', writing: false, date: null, time: null, month: null });
    start();
  };
}

async function start() {
  try {
    st.info = await api('');
  } catch (e) {
    $('#app').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  document.title = `Agendar — ${st.info.name}`;
  if (BRAND.logo) $('#top').innerHTML = `<img class="top-logo" src="${esc(BRAND.logo)}" alt="${esc(st.info.name)}">`;
  else $('#title').textContent = st.info.name;
  const m = location.hash.match(/meus=([\w-]+)/);
  if (m) { saveMeus(m[1]); history.replaceState(null, '', location.pathname); }
  if (m) { history.replaceState({ portal: 'meus' }, ''); portalGo('meus', false); return; }
  if (!st.info.enabled) {
    $('#app').innerHTML = `<div class="empty">Os agendamentos pela internet estão fechados no momento.<br>Fale com o salão pelo WhatsApp. 💬</div>
      ${meusToken() ? '<button class="btn" id="to-meus2">📋 Meus horários</button>' : ''}`;
    $('#to-meus2')?.addEventListener('click', () => portalGo('meus'));
    return;
  }
  // salão sem serviços na lista: começa direto pelo dia
  history.replaceState({ step: firstStep() }, '');
  if (hasServices()) go(1, false); else chooseService(null, '', false);
}

/* ============================ MEUS HORÁRIOS ============================ */
const MEUS_KEY = `mf.meus.${slug}`;
const meusToken = () => { try { return localStorage.getItem(MEUS_KEY) || ''; } catch { return ''; } };
const saveMeus = t => { try { localStorage.setItem(MEUS_KEY, t); } catch { /* ok */ } };
const forgetMeus = () => { try { localStorage.removeItem(MEUS_KEY); } catch { /* ok */ } };
const pv = { data: null, appt: null, days: [], month: null, date: null, slots: [], time: null, msg: '' };

function portalGo(view, push = true) {
  st.portal = view;
  if (push) history.pushState({ portal: view }, '');
  window.scrollTo(0, 0);
  ({ meus: showMeus, acesso: showAccess, rdia: showRDay, rhora: showRTime, rconf: showRConfirm })[view]?.();
}
const backBtn = (label = '‹ Voltar') => `<button type="button" class="btn" id="pback" style="margin-top:1rem">${label}</button>`;
const bindBack = () => $('#pback')?.addEventListener('click', () => history.back());
const statusBadge = a => a.status === 'pendente'
  ? '<span class="badge warn">⏳ Esperando o salão confirmar</span>' : '<span class="badge ok">✅ Confirmado</span>';
const fmtDay = d => cap(toDate(d).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' }).replace('.,', ''));

async function showMeus() {
  $('#app').innerHTML = '<div class="empty">Carregando…</div>';
  try {
    pv.data = await api(`/me?t=${encodeURIComponent(meusToken())}`);
  } catch (e) {
    if (e.status === 401) { forgetMeus(); pv.msg = 'O seu link expirou. Peça um novo aqui embaixo. 👇'; return portalGo('acesso', false); }
    $('#app').innerHTML = `<div class="error">${esc(e.message)}</div>${backBtn()}`; bindBack(); return;
  }
  const d = pv.data;
  const card = a => `<div class="step meu">
    <p class="big-when"><b>${esc(dayName(a.date))}</b> às <b>${esc(a.time)}</b></p>
    ${a.service ? `<p>💇 ${esc(a.service)}</p>` : ''}
    <div class="badges">${statusBadge(a)}</div>
    ${a.moving ? '<p class="moving">🔁 Você pediu para mudar este horário. Esperando o salão confirmar.</p>' : ''}
    ${a.canChange ? `<div class="row" style="margin-top:.8rem">
      <button type="button" class="btn main" data-move="${a.id}">🔁 Remarcar</button>
      <button type="button" class="btn danger" data-cancel="${a.id}">Cancelar</button></div>`
      : '<p class="muted" style="margin:.6rem 0 0;font-size:.9rem">Para mudar este horário, fale com o salão.</p>'}
  </div>`;
  $('#app').innerHTML = `
    <h2 style="margin-top:0">Olá, ${esc(d.name.split(' ')[0])}! 👋</h2>
    ${pv.msg ? `<div class="summary">${pv.msg}</div>` : ''}
    <h2>Seus próximos horários</h2>
    ${d.upcoming.length ? d.upcoming.map(card).join('') : '<p class="muted">Você não tem horário marcado.</p>'}
    ${d.enabled ? '<button type="button" class="btn main" id="new">📅 Pedir um horário novo</button>' : ''}
    ${d.past.length ? `<h2>Últimas vezes</h2><div class="list">${d.past.map(a => `<div class="card line"><div class="grow"><b>${esc(fmtDay(a.date))}</b><span>${esc(a.service || '')}</span></div></div>`).join('')}</div>` : ''}
    <button type="button" class="btn" id="notme" style="margin-top:1.5rem">Não é você? Sair</button>`;
  pv.msg = '';
  $('#new')?.addEventListener('click', () => {
    Object.assign(st, { service: undefined, serviceText: '', writing: false, date: null, time: null, month: null });
    history.pushState({ step: firstStep() }, '');
    if (hasServices()) go(1, false); else chooseService(null, '', false);
  });
  $('#notme').onclick = () => { forgetMeus(); location.reload(); };
  $('#app').onclick = async e => {
    const mv = e.target.closest('[data-move]'), cl = e.target.closest('[data-cancel]');
    if (mv) { pv.appt = d.upcoming.find(a => a.id === mv.dataset.move); pv.date = null; pv.month = null; loadRDays(); }
    if (cl) {
      const a = d.upcoming.find(x => x.id === cl.dataset.cancel);
      if (!confirm(`Cancelar o horário de ${dayName(a.date)} às ${a.time}?`)) return;
      cl.disabled = true;
      try { await api('/me/cancel', { t: meusToken(), id: a.id }); pv.msg = '❌ Horário cancelado. O salão foi avisado.'; showMeus(); }
      catch (err) { alert(err.message); cl.disabled = false; }
    }
  };
}

function showAccess() {
  $('#app').onclick = null;
  $('#app').innerHTML = `
    <section class="step">
      <h2 style="margin-top:0">📋 Ver ou remarcar seus horários</h2>
      ${pv.msg ? `<div class="summary">${esc(pv.msg)}</div>` : ''}
      <p>Escreva o seu WhatsApp. Vamos mandar lá um link para você ver seus horários.</p>
      <form class="form" id="acc" novalidate>
        <div id="err"></div>
        <div class="field"><label for="ph">Seu WhatsApp (com DDD)</label>
          <input type="tel" id="ph" autocomplete="tel" placeholder="(11) 99999-9999" value="${esc(remembered.phone || '')}"></div>
        <button class="btn main" type="submit">💬 Receber o link no WhatsApp</button>
      </form>
    </section>${backBtn()}`;
  pv.msg = '';
  bindBack();
  $('#acc').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('#acc button');
    btn.disabled = true;
    try {
      await api('/access', { phone: $('#ph').value });
      $('#acc').outerHTML = '<div class="summary">✅ Pronto! Se esse número tiver horário aqui, o link chega no seu WhatsApp em instantes.<br>Não chegou? Fale com o salão.</div>';
    } catch (err) { $('#err').innerHTML = `<div class="error">${esc(err.message)}</div>`; btn.disabled = false; }
  });
}

// Remarcar: dia → horário → confirmar
const rq = () => `dur=${pv.appt.duration || ''}&except=${encodeURIComponent(pv.appt.id)}`;
async function loadRDays() {
  pv.days = [];
  portalGo('rdia');
  try { pv.days = (await api(`/days?${rq()}`)).days; } catch (e) { alert(e.message); }
  if (st.portal === 'rdia') showRDay();
}
const movingBox = () => `<div class="summary">🔁 Mudando: <b>${esc(dayName(pv.appt.date))} às ${esc(pv.appt.time)}</b>${pv.appt.service ? ' · ' + esc(pv.appt.service) : ''}</div>`;
function showRDay() {
  $('#app').onclick = null;
  $('#app').innerHTML = `${movingBox()}<section class="step"><h2 style="margin-top:0">Para qual dia?</h2>
    ${!pv.days.length ? '<p class="muted">Carregando dias…</p>' : pv.days.some(d => d.free) ? calendarHtml(pv.days, pv.month, pv.date) : '<p class="muted">Não há horários livres nos próximos dias.</p>'}
    </section>${backBtn()}`;
  bindBack();
  $('#cal')?.addEventListener('click', async e => {
    const b = e.target.closest('button[data-date]');
    if (!b || b.disabled) return;
    pv.date = b.dataset.date; pv.slots = null;
    portalGo('rhora');
    try { pv.slots = (await api(`/slots?date=${pv.date}&${rq()}`)).slots; } catch (err) { alert(err.message); pv.slots = []; }
    if (st.portal === 'rhora') showRTime();
  });
  document.querySelectorAll('[data-month]').forEach(b => b.onclick = () => { pv.month = shiftMonth($('.cal').dataset.monthOf, +b.dataset.month); showRDay(); });
}
function showRTime() {
  $('#app').innerHTML = `${movingBox()}<section class="step"><h2 style="margin-top:0">Qual horário?</h2><p class="muted" style="margin-top:-.4rem">${esc(dayName(pv.date))}</p>
    ${pv.slots === null ? '<p class="muted">Carregando horários…</p>' : pv.slots.length
      ? `<div class="times" id="times">${pv.slots.map(t => `<button type="button">${t}</button>`).join('')}</div>`
      : '<p class="muted">Não sobrou horário nesse dia. Volte e escolha outro.</p>'}</section>${backBtn()}`;
  bindBack();
  $('#times')?.addEventListener('click', e => { const b = e.target.closest('button'); if (b) { pv.time = b.textContent; portalGo('rconf'); } });
}
function showRConfirm() {
  const approval = pv.data?.approval;
  $('#app').innerHTML = `<section class="step">
    <h2 style="margin-top:0">Confirma a troca?</h2>
    <p class="muted" style="margin-bottom:.2rem">De:</p><p style="margin-top:0;text-decoration:line-through">${esc(dayName(pv.appt.date))} às ${esc(pv.appt.time)}</p>
    <p class="muted" style="margin-bottom:.2rem">Para:</p><p style="margin-top:0;font-size:1.2rem"><b>${esc(dayName(pv.date))} às ${esc(pv.time)}</b></p>
    ${approval ? '<p class="summary">O salão vai confirmar a troca. <b>Até lá, o seu horário de antes continua valendo.</b></p>' : ''}
    <div id="err"></div>
    <button class="btn main" id="ok">✓ ${approval ? 'Pedir a troca' : 'Trocar horário'}</button>
  </section>${backBtn()}`;
  bindBack();
  $('#ok').onclick = async () => {
    $('#ok').disabled = true;
    try {
      const r = await api('/me/reschedule', { t: meusToken(), id: pv.appt.id, date: pv.date, time: pv.time });
      pv.msg = r.pending ? `🔁 Pedido enviado! Você pediu para mudar para <b>${esc(dayName(r.date))} às ${esc(r.time)}</b>. Avisamos no WhatsApp quando o salão confirmar.`
        : `✅ Horário trocado para <b>${esc(dayName(r.date))} às ${esc(r.time)}</b>.`;
      history.replaceState({ portal: 'meus' }, '');
      portalGo('meus', false);
    } catch (err) {
      $('#err').innerHTML = `<div class="error">${esc(err.message)}</div>`;
      $('#ok').disabled = false;
    }
  };
}

// link pessoal aberto com a página já aberta
window.addEventListener('hashchange', () => {
  const m = location.hash.match(/meus=([\w-]+)/);
  if (!m || !st.info) return;
  saveMeus(m[1]);
  history.replaceState({ portal: 'meus' }, '', location.pathname);
  portalGo('meus', false);
});

start(); // início
