/* Same money rules as index.html, so the API and the app always show the same numbers.
   If you change a formula in index.html, change it here too. */
const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
const r2 = n => Math.round(n * 100) / 100;
const FIN = ['bid_price', 'auction_fees', 'inland_shipping', 'ocean_shipping', 'office_commission', 'transfer_commission', 'other_fees'];
const ST = ['WON_PENDING_PAYMENT', 'PAID', 'INLAND_TRANSIT', 'AT_US_WAREHOUSE', 'LOADED_SHIPPED', 'ARRIVED_LOCAL_PORT', 'DELIVERED'];
const ST_NAMES = { WON_PENDING_PAYMENT: 'Won - pending payment', PAID: 'Paid to auction', INLAND_TRANSIT: 'Inland transit', AT_US_WAREHOUSE: 'At US warehouse', LOADED_SHIPPED: 'Loaded and shipped', ARRIVED_LOCAL_PORT: 'Arrived local port', DELIVERED: 'Delivered' };
const HAND_METHODS = ['wire', 'moneygram', 'wu', 'agent', 'zelle', 'cash', 'other'];
const DISC_METHODS = ['wire', 'moneygram', 'wu', 'agent'];
const PAY_METHODS = ['paypal', 'card', 'wire', 'moneygram', 'wu', 'zelle', 'agent', 'cash', 'other'];
const PURPOSES = ['auction', 'shipping', 'towing', 'other'];
const EXP_CATS = ['rent', 'salaries', 'utilities', 'telecom', 'transport', 'hospitality', 'ads', 'other'];
const pad = n => String(n).padStart(2, '0');
const today = () => { const t = new Date(Date.now() + 2 * 3600e3); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; }; // Libya time
const now = () => new Date().toISOString();

function makeCtx(data) {
  const S = { settings: data.settings || {}, internal: data.internal || {}, payments: data.payments || [], vehicles: data.vehicles || [], customers: data.customers || [] };
  const paidBy = {}; S.payments.forEach(p => { if (p.vehicle_id) paidBy[p.vehicle_id] = (paidBy[p.vehicle_id] || 0) + num(p.amount_usd); });
  const PAYDEF = () => ({ cust: num(S.settings.fee_cust ?? 1.5), paypal: num(S.settings.fee_paypal ?? 2.5), disc: num(S.settings.disc_copart ?? 3.5), card: num(S.settings.card_back ?? 0.08), wire: num(S.settings.wire_lyd ?? 0.12), agent: num(S.settings.agent_k ?? 0) });
  const wireOpt = o => { o = o || {}; const P = PAYDEF(); return { rate: num(o.rate) || num(S.settings.rate) || 1, lyd: o.lyd != null && o.lyd !== '' ? num(o.lyd) : P.wire, agent: o.agent != null && o.agent !== '' ? num(o.agent) : P.agent }; };
  const wireCost = (a, o) => { a = Math.max(0, num(a)); const w = wireOpt(o); return a * w.lyd / w.rate + a * w.agent / 1000; };
  const iv = v => S.internal[v.id] || {};
  const extrasSum = v => (v.extras || []).reduce((a, x) => a + num(x.a), 0);
  const totalCost = v => FIN.reduce((s, k) => s + num((v.fin || {})[k]), 0) + extrasSum(v);
  const vPaid = id => paidBy[id] || 0;
  const vBal = v => totalCost(v) - vPaid(v.id);
  function stages(v) {
    const f = v.fin || {}, base1 = num(f.bid_price) + num(f.auction_fees), base2 = num(f.inland_shipping) + num(f.ocean_shipping) + extrasSum(v), fee = num(f.transfer_commission);
    const t1 = r2(base1 + num(f.office_commission) + num(f.other_fees)), t2 = r2(base2 + fee), paid = r2(vPaid(v.id));
    return { t1, t2, base1, base2, fee1: 0, fee2: fee, paid, rem1: r2(Math.max(0, t1 - paid)), rem2: r2(Math.max(0, t2 - Math.max(0, paid - t1))), rem: r2(t1 + t2 - paid) };
  }
  const shipPays = v => (v.transfers || []).filter(t => ['shipping', 'towing'].includes(t.purpose));
  const shipPaid = v => shipPays(v).reduce((a, t) => a + num(t.amount), 0);
  const actCost = v => { const p = shipPaid(v); if (p > 0) return p; const e = num(iv(v).shipping_cost_actual); return e > 0 ? e + extrasSum(v) : 0; };
  const shipPlan = v => { const f = v.fin || {}, e = num(iv(v).shipping_cost_actual); return (e > 0 ? e : num(f.inland_shipping) + num(f.ocean_shipping)) + extrasSum(v); };
  const wireEst = v => wireCost(Math.max(0, shipPlan(v) - shipPaid(v)), iv(v).wire);
  const shipMargin = v => { const f = v.fin || {}, act = actCost(v); return act > 0 ? num(f.inland_shipping) + num(f.ocean_shipping) + extrasSum(v) - act : 0; };
  function payResult(method, payee, amount, charged, d) {
    d = d || {}; const R = num(d.rate) || num(S.settings.rate) || 1, a = num(amount);
    const cardGain = method === 'card' ? a * num(d.card_back) / R : 0, ppCost = method === 'paypal' ? a * num(d.pp_pct) / 100 : 0;
    const lydCost = HAND_METHODS.includes(method) ? num(d.lyd_cost) / R : 0, agent = HAND_METHODS.includes(method) ? num(d.agent_fee) : 0, other = num(d.other_cost);
    const disc = DISC_METHODS.includes(method) && /copart/i.test(payee || '') ? a * num(d.disc_pct) / 100 : 0;
    const legacy = d.method ? 0 : ['transfer', 'bank', 'fx', 'other'].reduce((x, k) => x + num(d[k]), 0);
    const cost = ppCost + lydCost + agent + other + legacy, gain = cardGain + disc;
    return { cardGain, ppCost, lydCost, agent, other: other + legacy, disc, cost, gain, net: num(charged) + gain - cost };
  }
  const tCost = v => Object.values(iv(v).tcost || {}).reduce((a, b) => a + num(b), 0);
  const profit = v => { const f = v.fin || {}; return num(f.office_commission) + num(f.transfer_commission) - tCost(v) - wireEst(v) + shipMargin(v); };
  function split(v) {
    const st = stages(v), pays = S.payments.filter(x => x.vehicle_id === v.id).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    let cum = 0, d1 = '', d2 = ''; for (const x of pays) { cum += num(x.amount_usd); if (!d1 && cum >= st.t1 - 0.009) d1 = x.date || ''; if (!d2 && st.t2 > 0 && cum >= st.t1 + st.t2 - 0.009) d2 = x.date || ''; }
    const paid = vPaid(v.id), r1 = paid >= st.t1 - 0.009, rr2 = st.t2 > 0 && paid >= st.t1 + st.t2 - 0.009;
    return { r1, r2: rr2, d1: r1 ? d1 || today() : '', d2: rr2 ? d2 || today() : '', need1: Math.max(0, st.t1 - paid), need2: Math.max(0, st.t1 + st.t2 - paid) };
  }
  /* actual profit received: gains only; costs are deducted once the car has arrived and is fully paid */
  function received(v) {
    const f = v.fin || {}, x = split(v), cd = iv(v).tcostd || {}, got = [], wait = [], cost = [], sm = shipMargin(v);
    const g = (ok, t, a, d) => { if (!(a > 0.004)) return; (ok ? got : wait).push(ok ? { item: t, amount: r2(a), date: d } : { item: t, amount: r2(a) }); };
    g(x.r1, 'Office commission', num(f.office_commission), x.d1); g(x.r2, 'Transfer fee', num(f.transfer_commission), x.d2); g(x.r2, 'Shipping margin', sm, x.d2);
    (v.transfers || []).filter(t => t.status !== 'pending').forEach(t => { const r = payResult(t.method, t.payee, t.amount, t.charged, cd[t.id]), lab = `${t.method}${t.src ? ' ' + t.src : ''} $${num(t.amount)}`, d = t.date || '';
      if (r.cardGain > 0.004) got.push({ item: 'Card return - ' + lab, amount: r2(r.cardGain), date: d });
      if (r.disc > 0.004) got.push({ item: 'Copart discount - ' + lab, amount: r2(r.disc), date: d });
      if (r.cost > 0.004) cost.push({ item: 'Payment cost - ' + lab, amount: r2(r.cost), date: d }); });
    const we = wireEst(v); if (we > 0.004) cost.push({ item: 'Expected shipping wire (not paid yet)', amount: r2(we) });
    if (sm < -0.004) cost.push({ item: 'Actual shipping above what the customer was charged', amount: r2(-sm) });
    const done = ST.indexOf(v.status) >= ST.indexOf('ARRIVED_LOCAL_PORT') && vBal(v) <= 0.009, gs = got.reduce((a, o) => a + o.amount, 0), cs = cost.reduce((a, o) => a + o.amount, 0);
    return { total: r2(gs - (done ? cs : 0)), costs_deducted: done, received: got, not_received_yet: wait, costs: cost };
  }
  function money(v) {
    const f = v.fin || {}, st = stages(v), i = iv(v);
    return {
      customer_total: r2(totalCost(v)), customer_paid: r2(vPaid(v.id)), customer_balance: r2(vBal(v)),
      stage1_on_purchase: { total: st.t1, remaining: st.rem1, items: { bid_price: num(f.bid_price), auction_fees: num(f.auction_fees), office_commission: num(f.office_commission), other_fees: num(f.other_fees) } },
      stage2_on_arrival: { total: st.t2, remaining: st.rem2, items: { towing: num(f.inland_shipping), ocean: num(f.ocean_shipping), extras: extrasSum(v), transfer_fee: num(f.transfer_commission) } },
      internal: { shipping_cost_actual: num(i.shipping_cost_actual), wire: wireOpt(i.wire), shipping_paid_so_far: r2(shipPaid(v)), expected_shipping_wire_cost: r2(wireEst(v)), recorded_payment_costs_net: r2(tCost(v)), shipping_margin: r2(shipMargin(v)), expected_profit: r2(profit(v)), actual_profit_received: received(v) }
    };
  }
  return { S, PAYDEF, wireOpt, wireCost, extrasSum, totalCost, vPaid, vBal, stages, payResult, tCost, profit, received, money, shipMargin, wireEst };
}

/* treasury balances per box and currency */
function treasuryBalances(list) {
  const b = {}, add = (box, cur, a) => { if (!box) return; const o = b[box] = b[box] || { LYD: 0, USD: 0 }; o[cur || 'USD'] = r2((o[cur || 'USD'] || 0) + num(a)); };
  list.forEach(e => { if (e.kind === 'out') add(e.box, e.cur, -e.amount); else if (e.kind === 'move') { add(e.box, e.cur, -e.amount); add(e.to_box, e.to_cur, e.to_amount); } else add(e.box, e.cur, e.amount); });
  return b;
}
const nextCode = customers => { const used = customers.map(c => parseInt(c.code, 10)).filter(n => n >= 1000 && n <= 9999); let n = Math.max(4477, ...used) + 1; if (n > 9999) { n = 4478; while (used.includes(n)) n++; } return String(n); };

module.exports = { num, r2, FIN, ST, ST_NAMES, PAY_METHODS, PURPOSES, EXP_CATS, HAND_METHODS, DISC_METHODS, today, now, makeCtx, treasuryBalances, nextCode };
