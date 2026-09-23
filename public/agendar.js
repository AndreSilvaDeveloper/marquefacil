'use strict';

/* Página pública: a cliente escolhe serviço, dia e horário e deixa nome e WhatsApp. */

const slug = location.pathname.split('/').filter(Boolean)[0] || '';
const API = `/api/public/${encodeURIComponent(slug)}`;
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = v => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtDur = m => !m ? '' : m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${m % 60 ? String(m % 60).padStart(2, '0') : ''}`;
const toDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
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
const st = { info: null, service: undefined, days: [], date: null, slots: [], time: null };
const remembered = (() => { try { return JSON.parse(localStorage.getItem('mf.cliente')) || {}; } catch { return {}; } })();

function step(n, title, body, done = false) {
  return `<section class="step ${done ? 'done' : ''}" id="step${n}"><h2><span class="n">${done ? '✓' : n}</span>${title}</h2>${body}</section>`;
}

function paint() {
  const { info } = st;
  const hasServices = info.services.length > 0;
  let n = 0;
  let html = info.message ? `<div class="summary">${esc(info.message).replace(/\n/g, '<br>')}</div>` : '';

  if (hasServices) {
    html += step(++n, 'Qual serviço?', `<div class="pick" id="services">
      ${info.services.map(s => `<button type="button" data-id="${s.id}" class="${st.service?.id === s.id ? 'on' : ''}">${esc(s.name)}
        <small>${[fmtDur(s.duration), s.price ? brl(s.price) : ''].filter(Boolean).join(' · ') || '&nbsp;'}</small></button>`).join('')}
      <button type="button" data-id="" class="${st.service === null ? 'on' : ''}">Outro / ainda não sei</button>
    </div>`, st.service !== undefined);
  }

  const canDay = !hasServices || st.service !== undefined;
  if (canDay) {
    const any = st.days.some(d => d.free);
    html += step(++n, 'Qual dia?', st.days.length ? (any ? `<div class="days" id="days">
      ${st.days.map(d => {
        const x = toDate(d.date);
        return `<button type="button" data-date="${d.date}" ${d.free ? '' : 'disabled'} class="${st.date === d.date ? 'on' : ''}">
          ${x.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '')}<b>${x.getDate()}</b>${x.toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '')}</button>`;
      }).join('')}</div>` : '<p class="muted">Não há horários livres nos próximos dias. 😕</p>') : '<p class="muted">Carregando dias…</p>', !!st.date);
  }

  if (st.date) {
    html += step(++n, `Qual horário? <small class="muted" style="font-weight:400">${dayName(st.date)}</small>`,
      st.slots.length ? `<div class="times" id="times">${st.slots.map(t => `<button type="button" class="${st.time === t ? 'on' : ''}">${t}</button>`).join('')}</div>`
        : '<p class="muted">Não sobrou horário nesse dia. Escolha outro dia.</p>', !!st.time);
  }

  if (st.time) {
    html += step(++n, 'Seus dados', `
      <div class="summary">
        <b>${dayName(st.date)}</b> às <b>${st.time}</b>
        ${st.service ? `<br>💇 ${esc(st.service.name)}${st.service.price ? ' · ' + brl(st.service.price) : ''}` : ''}
      </div>
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

  $('#app').innerHTML = html;
  bind();
}

const submitLabel = () => (st.info.approval ? '✓ Pedir este horário' : '✓ Confirmar agendamento');

function scrollToStep(id) { setTimeout(() => $(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50); }

async function loadDays() {
  st.days = []; st.date = null; st.time = null; paint();
  try {
    st.days = (await api(`/days${st.service ? '?service=' + st.service.id : ''}`)).days;
  } catch (e) { alert(e.message); }
  paint();
  scrollToStep('#step' + (st.info.services.length ? 2 : 1));
}

async function loadSlots() {
  st.slots = []; st.time = null;
  try {
    st.slots = (await api(`/slots?date=${st.date}${st.service ? '&service=' + st.service.id : ''}`)).slots;
  } catch (e) { alert(e.message); }
  paint();
  scrollToStep('#step' + (st.info.services.length ? 3 : 2));
}

function bind() {
  $('#services')?.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    st.service = b.dataset.id ? st.info.services.find(s => s.id === b.dataset.id) : null;
    loadDays();
  });
  $('#days')?.addEventListener('click', e => {
    const b = e.target.closest('button[data-date]');
    if (!b || b.disabled) return;
    st.date = b.dataset.date;
    loadSlots();
  });
  // mantém o dia escolhido visível na faixa
  $('#days .on')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  $('#times')?.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    st.time = b.textContent;
    paint();
    scrollToStep('#step' + (st.info.services.length ? 4 : 3));
  });
  $('#f')?.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('#f button[type=submit]');
    const data = {
      name: $('#name').value, phone: $('#phone').value, notes: $('#notes').value, website: $('#website').value,
      date: st.date, time: st.time, serviceId: st.service?.id || null,
    };
    btn.disabled = true;
    btn.textContent = 'Enviando…';
    try {
      const r = await api('/book', data);
      try { localStorage.setItem('mf.cliente', JSON.stringify({ name: data.name.trim(), phone: data.phone.trim() })); } catch { /* ok */ }
      done(r);
    } catch (err) {
      $('#err').innerHTML = `<div class="error">${esc(err.message)}</div>`;
      btn.disabled = false;
      btn.textContent = submitLabel();
      if (err.status === 409) {
        await loadSlots(); // mostra os horários que sobraram, com o aviso em cima
        $('#times, #step3 p, #step2 p')?.insertAdjacentHTML('beforebegin', `<div class="error">${esc(err.message)}</div>`);
      }
    }
  });
}

function done(r) {
  window.scrollTo(0, 0);
  $('#app').innerHTML = `
    <div class="step ok-box">
      <div class="big">${r.pending ? '⏳' : '✅'}</div>
      <h2 style="justify-content:center">${r.pending ? 'Pedido enviado!' : 'Horário agendado!'}</h2>
      <p style="font-size:1.15rem"><b>${esc(dayName(r.date))}</b> às <b>${esc(r.time)}</b></p>
      ${r.service ? `<p>💇 ${esc(r.service)}</p>` : ''}
      <p class="muted">${esc(r.salon)}</p>
      ${r.pending
        ? '<p><b>O salão vai confirmar o seu horário.</b><br>Você recebe a confirmação pelo WhatsApp. 💬</p>'
        : '<p class="muted">Se precisar remarcar ou cancelar, fale com o salão pelo WhatsApp.</p>'}
      <button class="btn" id="again" style="margin-top:1rem">Agendar outro horário</button>
    </div>`;
  $('#again').onclick = () => { Object.assign(st, { service: undefined, date: null, time: null }); start(); };
}

async function start() {
  try {
    st.info = await api('');
  } catch (e) {
    $('#app').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  document.title = `Agendar — ${st.info.name}`;
  $('#title').textContent = st.info.name;
  if (!st.info.enabled) {
    $('#app').innerHTML = '<div class="empty">Os agendamentos pela internet estão fechados no momento.<br>Fale com o salão pelo WhatsApp. 💬</div>';
    return;
  }
  if (st.info.services.length) paint(); else loadDays();
}

start();
