/* Vendas pagas depois (de uma vez ou parceladas).
   Uma compra ("pedido") pode ter vários produtos: cada produto é um registro em `sales`, todos com o
   mesmo `orderId`. Quem vai pagar depois tem um plano, igual em todas as linhas do pedido:
     plan = { entrada: valor pago na hora (0 se nada), dates: ['AAAA-MM-DD', …] }  → uma data por parcela.
   O que ela vai pagando cobre as parcelas na ordem (a 1ª primeiro). O app faz a mesma conta (public/app.js). */

export const r2 = n => Math.round(n * 100) / 100;
export const valueOf = x => ('total' in x ? x.total : x.price) || 0;
export const paymentsOf = x => (x.payments?.length ? x.payments : x.paid && valueOf(x) > 0 ? [{ v: valueOf(x), m: x.payMethod || '', d: x.date }] : []);
export const paidOf = x => r2(paymentsOf(x).reduce((t, p) => t + (p.v || 0), 0));
export const leftOf = x => Math.max(0, r2(valueOf(x) - paidOf(x)));
// Recebeu um valor: guarda o pagamento e marca pago quando cobre tudo (igual ao app)
export function withPayment(x, v, m, d, extra = {}) {
  const payments = [...paymentsOf(x), { v: r2(v), m, d, ...extra }];
  const y = { ...x, payments };
  y.paid = valueOf(y) > 0 ? leftOf(y) === 0 : true;
  return y;
}
// Valor da compra: vai cobrindo os produtos em ordem (igual a payOrder do app)
export function payOrderLines(lines, v, m, d, extra = {}) {
  let rest = r2(v);
  return lines.map(x => {
    const part = Math.min(rest, leftOf(x));
    if (part <= 0) return null;
    rest = r2(rest - part);
    return withPayment(x, part, m, d, extra);
  }).filter(Boolean);
}

export const orderKey = s => s.orderId || s.id;

// Junta as linhas de cada pedido: { key, clientId, date, lines, total, paid, left, plan }
export function groupOrders(sales) {
  const map = new Map();
  for (const s of sales) {
    const k = orderKey(s);
    let o = map.get(k);
    if (!o) map.set(k, o = { key: k, clientId: s.clientId || '', date: s.date, lines: [], total: 0, paid: 0, plan: null });
    o.lines.push(s);
    o.total = r2(o.total + valueOf(s));
    o.paid = r2(o.paid + paidOf(s));
    if (!o.plan && s.plan?.dates?.length) o.plan = s.plan;
  }
  for (const o of map.values()) o.left = Math.max(0, r2(o.total - o.paid));
  return [...map.values()];
}

// Parcelas do pedido: [{ n, of, date, amount, paid, left }]. Sem plano: lista vazia.
export function installments(o) {
  const dates = o.plan?.dates || [];
  if (!dates.length) return [];
  const entrada = Math.min(o.plan.entrada || 0, o.total);
  const base = Math.max(0, r2(o.total - entrada));
  const n = dates.length;
  const each = Math.floor(base / n * 100) / 100;
  let covered = Math.max(0, r2(o.paid - entrada));
  return dates.map((date, i) => {
    const amount = i < n - 1 ? each : r2(base - each * (n - 1));
    const got = Math.min(amount, covered);
    covered = r2(covered - got);
    return { n: i + 1, of: n, date, amount, paid: r2(got), left: r2(amount - got) };
  });
}

// "Shampoo e Pente (2x)"
export function productsText(o) {
  const names = o.lines.map(s => `${s.product}${s.desc ? ` (${s.desc})` : ''}${s.qty > 1 ? ` (${s.qty}x)` : ''}`);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} e ${names.at(-1)}` : names[0] || 'compra';
}

// Remarcação: o que já foi pago (ex.: sinal pelo banco) passa do horário antigo para o novo
export function movePayments(from, to) {
  const pays = paymentsOf(from);
  if (!pays.length) return [from, to];
  const next = { ...to, payments: [...paymentsOf(to), ...pays] };
  next.paid = valueOf(next) > 0 ? leftOf(next) === 0 : true;
  return [{ ...from, payments: [], paid: false, paymentsMovedTo: to.id }, next];
}
