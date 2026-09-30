/* Vendas pagas depois (de uma vez ou parceladas).
   Uma compra ("pedido") pode ter vários produtos: cada produto é um registro em `sales`, todos com o
   mesmo `orderId`. Quem vai pagar depois tem um plano, igual em todas as linhas do pedido:
     plan = { entrada: valor pago na hora (0 se nada), dates: ['AAAA-MM-DD', …] }  → uma data por parcela.
   O que ela vai pagando cobre as parcelas na ordem (a 1ª primeiro). O app faz a mesma conta (public/app.js). */

const r2 = n => Math.round(n * 100) / 100;
const valueOf = x => ('total' in x ? x.total : x.price) || 0;
const paymentsOf = x => (x.payments?.length ? x.payments : x.paid && valueOf(x) > 0 ? [{ v: valueOf(x) }] : []);
const paidOf = x => r2(paymentsOf(x).reduce((t, p) => t + (p.v || 0), 0));

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
