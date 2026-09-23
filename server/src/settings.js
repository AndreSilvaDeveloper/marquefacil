import { fail, isObj, TIME_RE, DATE_RE, mins } from './util.js';
import { validTz } from './time.js';

// Configurações de cada salão (coluna tenants.settings). O que não foi salvo usa estes padrões.
export const DEFAULTS = {
  timezone: 'America/Sao_Paulo',
  booking: {
    enabled: false,
    // dia da semana (0 = domingo) -> [abre, fecha] ou null (fechado)
    days: { 0: null, 1: ['09:00', '18:00'], 2: ['09:00', '18:00'], 3: ['09:00', '18:00'], 4: ['09:00', '18:00'], 5: ['09:00', '18:00'], 6: ['09:00', '13:00'] },
    lunch: null,            // ['12:00', '13:00'] ou null
    interval: 30,           // de quanto em quanto tempo aparecem os horários
    minAdvanceHours: 2,     // antecedência mínima para agendar
    maxDays: 30,            // até quantos dias para frente
    defaultDuration: 60,    // duração quando o serviço não tem tempo definido
    message: '',            // recado que aparece no topo do link
    closedDates: [],        // folgas e feriados: ['2026-12-25', …]
    requireApproval: true,  // pedido pelo link espera a profissional confirmar
  },
  whatsapp: {
    instance: null,         // nome da instância na Evolution (preenchido ao conectar)
    number: '',             // número conectado (preenchido ao conectar)
    confirmOnline: true,    // confirmar para a cliente quando o pedido do link é aceito
    confirmManual: true,    // confirmar quando a profissional agenda no app (e a cliente tem telefone)
    declineMessage: true,   // avisar a cliente quando o pedido é recusado
    reminderMinutes: 1440,  // lembrete X minutos antes (0 = não manda; até 3 dias)
    notifyOwner: true,      // avisar a profissional de agendamento pelo link
    ownerPhone: '',         // número que recebe o aviso (vazio = o próprio número conectado)
    templates: {
      confirm: 'Olá, {nome}! ✅\nSeu horário no *{salao}* está marcado:\n📅 {dia} às {hora}\n💇 {servico}\n💰 Valor: {valor}\n\nSe precisar remarcar, é só responder esta mensagem.',
      reminder: 'Olá, {nome}! Passando para lembrar do seu horário no *{salao}*:\n📅 {dia} às {hora}\n💇 {servico}\n\nTe esperamos! 💖',
      owner: '📅 Novo pedido de agendamento pelo link!\n👩 {nome_completo} — {telefone}\n📅 {dia} às {hora}\n💇 {servico}\n\nAbra o app para confirmar.',
      decline: 'Olá, {nome}. Infelizmente não conseguimos atender {dia} às {hora} no *{salao}*. 😕\nEscolha outro horário aqui: {link}',
    },
  },
};

function merge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? structuredClone(base) : over;
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? merge(base[k], v) : v;
  return out;
}

export function readSettings(json) {
  let saved = {};
  try { saved = JSON.parse(json || '{}'); } catch { /* usa padrão */ }
  const s = merge(DEFAULTS, saved);
  s.booking.days = { ...DEFAULTS.booking.days, ...(saved.booking?.days || {}) };
  // configuração antiga guardava em horas
  if (saved.whatsapp?.reminderMinutes === undefined && saved.whatsapp?.reminderHours !== undefined) {
    s.whatsapp.reminderMinutes = saved.whatsapp.reminderHours * 60;
  }
  delete s.whatsapp.reminderHours;
  return s;
}

const range = (v, what) => {
  if (v === null) return null;
  if (!Array.isArray(v) || v.length !== 2 || !TIME_RE.test(v[0]) || !TIME_RE.test(v[1]) || mins(v[0]) >= mins(v[1])) {
    fail(400, `Horário inválido em ${what}.`);
  }
  return [v[0], v[1]];
};
const int = (v, min, max, what) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail(400, `Valor inválido em ${what}.`);
  return n;
};
const text = (v, max) => String(v ?? '').slice(0, max);
const bool = v => v === true;

// Aplica o que a profissional mudou, conferindo cada campo. Campos internos
// (instância, número conectado) não podem ser mudados por aqui.
export function updateSettings(current, input) {
  if (!isObj(input)) fail(400, 'Formato inválido.');
  const s = structuredClone(current);

  if (input.timezone !== undefined) {
    if (!validTz(input.timezone)) fail(400, 'Fuso horário inválido.');
    s.timezone = input.timezone;
  }

  const b = input.booking;
  if (isObj(b)) {
    if (b.enabled !== undefined) s.booking.enabled = bool(b.enabled);
    if (isObj(b.days)) for (let d = 0; d <= 6; d++) if (d in b.days) s.booking.days[d] = range(b.days[d], 'dias');
    if (b.lunch !== undefined) s.booking.lunch = range(b.lunch, 'almoço');
    if (b.interval !== undefined) s.booking.interval = int(b.interval, 5, 240, 'intervalo');
    if (b.minAdvanceHours !== undefined) s.booking.minAdvanceHours = int(b.minAdvanceHours, 0, 72, 'antecedência');
    if (b.maxDays !== undefined) s.booking.maxDays = int(b.maxDays, 1, 180, 'dias para frente');
    if (b.defaultDuration !== undefined) s.booking.defaultDuration = int(b.defaultDuration, 5, 600, 'duração');
    if (b.message !== undefined) s.booking.message = text(b.message, 500);
    if (b.requireApproval !== undefined) s.booking.requireApproval = bool(b.requireApproval);
    if (b.closedDates !== undefined) {
      if (!Array.isArray(b.closedDates) || b.closedDates.some(d => !DATE_RE.test(d))) fail(400, 'Datas de folga inválidas.');
      s.booking.closedDates = [...new Set(b.closedDates)].sort().slice(-200);
    }
  }

  const w = input.whatsapp;
  if (isObj(w)) {
    for (const k of ['confirmOnline', 'confirmManual', 'notifyOwner', 'declineMessage']) if (w[k] !== undefined) s.whatsapp[k] = bool(w[k]);
    if (w.reminderMinutes !== undefined) s.whatsapp.reminderMinutes = int(w.reminderMinutes, 0, 3 * 24 * 60, 'lembrete');
    else if (w.reminderHours !== undefined) s.whatsapp.reminderMinutes = int(w.reminderHours, 0, 72, 'lembrete') * 60;
    if (w.ownerPhone !== undefined) s.whatsapp.ownerPhone = text(w.ownerPhone, 30);
    if (isObj(w.templates)) {
      for (const k of ['confirm', 'reminder', 'owner', 'decline']) {
        if (w.templates[k] !== undefined) s.whatsapp.templates[k] = text(w.templates[k], 1000).trim() || DEFAULTS.whatsapp.templates[k];
      }
    }
  }
  return s;
}
