/* Tools the Claude connector can call. Every write is recorded in the app's activity log as "Claude API". */
const { db, clean } = require('./db');
const C = require('./calc');
const { num, r2, now, today } = C;
/* who is calling (key name) and whether the key may change data; set per request */
const { AsyncLocalStorage } = require('async_hooks');
const CTX = new AsyncLocalStorage();
const who = () => (CTX.getStore() || {}).who || 'Claude API';
/* permission of the key owner (same names as the app): edit, payments, delete, profit, expenses, logs, settings */
const can = p => { const st = CTX.getStore(); return !st || !st.perms || !!st.perms[p]; };

async function load(names) {
  const d = db(), out = {};
  await Promise.all(names.map(async n => {
    if (n === 'settings') out.settings = (await d.get('settings', 'main')) || {};
    else if (n === 'internal') out.internal = Object.fromEntries((await d.all('vinternal')).map(x => [x.id, x]));
    else out[n] = await d.all(n);
  }));
  return out;
}
const log = (act, details, ref) => db().add('logs', { at: now(), user: who(), act, details: details || '', ref: ref || '' }).catch(() => { });
const vt = v => `${v.year || ''} ${v.make || ''} ${v.model || ''}`.trim();
const err = m => { const e = new Error(m); e.user = true; throw e; };
const lc = s => String(s || '').toLowerCase();

function findCustomer(customers, a) {
  const c = a.customer_id ? customers.find(x => x.id === a.customer_id) : a.customer_code ? customers.find(x => String(x.code) === String(a.customer_code).replace('#', '')) : null;
  if (!c) err('Customer not found. Pass customer_id or customer_code (the 4-digit number).');
  return c;
}
function findVehicle(vehicles, a) {
  const id = a.vehicle_id || a.id, vin = (a.vin || '').toUpperCase().trim();
  let v = id ? vehicles.find(x => x.id === id) : null;
  if (!v && vin) v = vehicles.find(x => x.vin === vin) || (vin.length >= 6 ? vehicles.filter(x => (x.vin || '').endsWith(vin)).length === 1 && vehicles.find(x => (x.vin || '').endsWith(vin)) : null);
  if (!v && a.lot_number) v = vehicles.find(x => String(x.lot_number) === String(a.lot_number));
  if (!v) err('Vehicle not found. Pass vehicle_id, vin (full or last 6+ characters) or lot_number.');
  return v;
}
async function syncTracking(v) {
  if (!v.vin) return;
  await db().merge('tracking', v.vin, clean({ vin: v.vin, make: v.make || '', model: v.model || '', year: v.year || '', color: v.color || '', trim: v.trim || '', engine: v.engine || '', status: v.status, status_history: v.status_history || [], container_number: v.container_number || '', auction_name: v.auction_name || '', updated_at: now() }));
}
const custShort = c => ({ id: c.id, code: c.code || '', full_name: c.full_name || '', phone: c.phone || '', alternate_phone: c.alternate_phone || '', city: c.city || '' });
function vehShort(v, cx, customers) {
  const c = customers.find(x => x.id === v.customer_id) || {};
  return { id: v.id, vin: v.vin, lot_number: v.lot_number || '', title: vt(v), status: v.status, status_name: C.ST_NAMES[v.status] || v.status, customer: c.full_name || '', customer_code: c.code || '', purchase_date: v.purchase_date || '', auction: v.auction_name || '', location: v.auction_location || '', us_port: v.us_port || '', ship_port: v.ship_port || '', container_number: v.container_number || '', customer_total: r2(cx.totalCost(v)), customer_paid: r2(cx.vPaid(v.id)), customer_balance: r2(cx.vBal(v)) };
}
const strArgs = (a, keys) => { const o = {}; keys.forEach(k => { if (a[k] !== undefined && a[k] !== null) o[k] = String(a[k]).trim(); }); return o; };
const VEH_FIELDS = ['lot_number', 'make', 'model', 'year', 'color', 'trim', 'engine', 'auction_name', 'auction_location', 'us_port', 'ship_port', 'yard', 'yard_state', 'container_number', 'booking_number', 'purchase_date', 'auction_paid_by', 'auction_paid_date', 'notes'];
const FIN_SCHEMA = { type: 'object', description: 'Money in USD. Keys: bid_price, auction_fees, inland_shipping (towing charged), ocean_shipping (ocean charged), office_commission, transfer_commission, other_fees. On update only the keys you pass change.', properties: Object.fromEntries(C.FIN.map(k => [k, { type: 'number' }])) };
const EXTRAS_SCHEMA = { type: 'array', description: 'Extra charges passed on to the customer, not profit (e.g. moving the car between ports, FedEx, storage). Replaces the whole list.', items: { type: 'object', properties: { d: { type: 'string', description: 'description' }, a: { type: 'number', description: 'amount USD' } }, required: ['d', 'a'] } };
const docGuard = (c, write) => { const need = { vinternal: 'profit', expenses: 'expenses', logs: 'logs', settings: write ? 'settings' : null, payments: write ? 'payments' : null }[c]; if (need && !can(need)) err('No permission for ' + c); };
const COLLECTIONS = ['customers', 'vehicles', 'vinternal', 'payments', 'expenses', 'treasury', 'settings', 'tracking', 'logs'];

const TOOLS = [
  /* ---------- read ---------- */
  { name: 'get_overview', description: 'Snapshot of the business: cars by status, what customers owe, treasury balances, this month\'s expenses and profit totals.', inputSchema: { type: 'object', properties: {} }, run: async () => {
    const d = await load(['customers', 'vehicles', 'payments', 'internal', 'settings', 'expenses', 'treasury']), cx = C.makeCtx(d), m = today().slice(0, 7);
    const by = {}; d.vehicles.forEach(v => { by[v.status] = (by[v.status] || 0) + 1; });
    const owed = d.vehicles.reduce((a, v) => a + Math.max(0, cx.vBal(v)), 0), exp = d.expenses.filter(e => (e.date || '').startsWith(m));
    const o = { today: today(), customers: d.customers.length, vehicles: d.vehicles.length, vehicles_by_status: Object.fromEntries(C.ST.map(k => [C.ST_NAMES[k], by[k] || 0])), customers_owe_usd: r2(owed), treasury_balances: C.treasuryBalances(d.treasury), default_lyd_rate: num(d.settings.rate) || null };
    if (can('profit')) Object.assign(o, { expected_profit_all_cars_usd: r2(d.vehicles.reduce((a, v) => a + cx.profit(v), 0)), actual_profit_received_all_cars_usd: r2(d.vehicles.reduce((a, v) => a + cx.received(v).total, 0)) });
    if (can('expenses')) o.expenses_this_month_usd = r2(exp.reduce((a, e) => a + num(e.amount_usd), 0));
    return o;
  } },
  { name: 'search_customers', description: 'Find customers by name, phone, city or 4-digit customer number. Empty query lists everyone. Includes each customer\'s total, paid and balance.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number', default: 50 } } }, run: async a => {
    const d = await load(['customers', 'vehicles', 'payments']), cx = C.makeCtx(d), q = lc(a.query).replace('#', '');
    return d.customers.filter(c => !q || lc([c.code, c.full_name, c.phone, c.alternate_phone, c.city].join(' ')).includes(q)).slice(0, a.limit || 50).map(c => {
      const vs = d.vehicles.filter(v => v.customer_id === c.id), tot = vs.reduce((s, v) => s + cx.totalCost(v), 0), paid = d.payments.filter(p => p.customer_id === c.id).reduce((s, p) => s + num(p.amount_usd), 0);
      return { ...custShort(c), cars: vs.length, total_usd: r2(tot), paid_usd: r2(paid), balance_usd: r2(tot - paid) }; });
  } },
  { name: 'get_customer', description: 'Full customer file: details, every car with its balance, and every payment.', inputSchema: { type: 'object', properties: { customer_id: { type: 'string' }, customer_code: { type: 'string', description: '4-digit customer number' } } }, run: async a => {
    const d = await load(['customers', 'vehicles', 'payments', 'internal', 'settings']), cx = C.makeCtx(d), c = findCustomer(d.customers, a);
    const vs = d.vehicles.filter(v => v.customer_id === c.id), ps = d.payments.filter(p => p.customer_id === c.id).sort((x, y) => (x.date || '').localeCompare(y.date || ''));
    const tot = vs.reduce((s, v) => s + cx.totalCost(v), 0), paid = ps.reduce((s, p) => s + num(p.amount_usd), 0);
    return { customer: { ...custShort(c), notes: c.notes || '', created_at: c.created_at || '' }, total_usd: r2(tot), paid_usd: r2(paid), balance_usd: r2(tot - paid), vehicles: vs.map(v => vehShort(v, cx, d.customers)), payments: ps.map(p => ({ id: p.id, date: p.date, amount: p.amount, currency: p.currency, rate: p.rate, amount_usd: p.amount_usd, method: p.method || '', ref: p.ref || '', vehicle_id: p.vehicle_id || '', vehicle: (vs.find(v => v.id === p.vehicle_id) || {}).vin || '' })) };
  } },
  { name: 'search_vehicles', description: 'Find cars by VIN, lot, make/model, container, customer, or status. Status values: ' + C.ST.join(', ') + '.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, status: { type: 'string', enum: C.ST }, customer_id: { type: 'string' }, customer_code: { type: 'string' }, only_with_balance: { type: 'boolean' }, limit: { type: 'number', default: 50 } } }, run: async a => {
    const d = await load(['customers', 'vehicles', 'payments']), cx = C.makeCtx(d), q = lc(a.query);
    const cid = a.customer_id || (a.customer_code ? findCustomer(d.customers, a).id : '');
    return d.vehicles.filter(v => (!a.status || v.status === a.status) && (!cid || v.customer_id === cid) && (!a.only_with_balance || cx.vBal(v) > 0.009) && (!q || lc([v.vin, v.lot_number, v.make, v.model, v.year, v.container_number, v.auction_location].join(' ')).includes(q)))
      .sort((x, y) => (y.purchase_date || '').localeCompare(x.purchase_date || '')).slice(0, a.limit || 50).map(v => vehShort(v, cx, d.customers));
  } },
  { name: 'get_vehicle', description: 'Everything about one car: details, status history, customer charges in two stages (on purchase / on arrival), payments from the customer, how we paid (method, account, cost), expected profit and actual profit received.', inputSchema: { type: 'object', properties: { vehicle_id: { type: 'string' }, vin: { type: 'string', description: 'Full VIN or the last 6+ characters' }, lot_number: { type: 'string' } } }, run: async a => {
    const d = await load(['customers', 'vehicles', 'payments', 'internal', 'settings']), cx = C.makeCtx(d), v = findVehicle(d.vehicles, a), cd = (d.internal[v.id] || {}).tcostd || {};
    const { images, auction_invoice, ...rest } = v;
    const mon = cx.money(v); if (!can('profit')) delete mon.internal;
    return { vehicle: { ...rest, images_count: (images || []).length, has_auction_invoice: !!auction_invoice }, customer: custShort(d.customers.find(c => c.id === v.customer_id) || {}), money: mon,
      customer_payments: d.payments.filter(p => p.vehicle_id === v.id).map(p => ({ id: p.id, date: p.date, amount: p.amount, currency: p.currency, amount_usd: p.amount_usd, method: p.method || '', ref: p.ref || '' })),
      how_we_paid: (v.transfers || []).map(t => ({ ...t, receipt: t.receipt ? t.receipt.name : null, ...(can('profit') ? { cost_details: cd[t.id] || null, result: cx.payResult(t.method, t.payee, t.amount, t.charged, cd[t.id]) } : {}) })) };
  } },
  { name: 'list_payments', description: 'Customer payments (money we received), filtered by customer, car or date range (YYYY-MM-DD).', inputSchema: { type: 'object', properties: { customer_id: { type: 'string' }, customer_code: { type: 'string' }, vin: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, limit: { type: 'number', default: 200 } } }, run: async a => {
    const d = await load(['customers', 'vehicles', 'payments']), cid = a.customer_id || (a.customer_code ? findCustomer(d.customers, a).id : ''), vid = a.vin ? findVehicle(d.vehicles, a).id : '';
    const l = d.payments.filter(p => (!cid || p.customer_id === cid) && (!vid || p.vehicle_id === vid) && (!a.from || (p.date || '') >= a.from) && (!a.to || (p.date || '') <= a.to)).sort((x, y) => (y.date || '').localeCompare(x.date || ''));
    return { count: l.length, total_usd: r2(l.reduce((s, p) => s + num(p.amount_usd), 0)), payments: l.slice(0, a.limit || 200).map(p => { const c = d.customers.find(x => x.id === p.customer_id) || {}, v = d.vehicles.find(x => x.id === p.vehicle_id) || {}; return { id: p.id, date: p.date, customer: c.full_name || '', customer_code: c.code || '', vehicle: v.vin ? `${vt(v)} ${v.vin}` : '', amount: p.amount, currency: p.currency, rate: p.rate, amount_usd: p.amount_usd, method: p.method || '', ref: p.ref || '' }; }) };
  } },
  { name: 'list_expenses', description: 'Office expenses, optionally for one month (YYYY-MM).', inputSchema: { type: 'object', properties: { month: { type: 'string' } } }, run: async a => {
    const d = await load(['expenses']), l = d.expenses.filter(e => !a.month || (e.date || '').startsWith(a.month)).sort((x, y) => (y.date || '').localeCompare(x.date || ''));
    const by = {}; l.forEach(e => { by[e.category] = r2((by[e.category] || 0) + num(e.amount_usd)); });
    return { count: l.length, total_usd: r2(l.reduce((s, e) => s + num(e.amount_usd), 0)), by_category_usd: by, expenses: l };
  } },
  { name: 'get_treasury', description: 'Treasury (cash boxes): balance of every box in LYD and USD, and the entries, optionally for one box and/or month (YYYY-MM).', inputSchema: { type: 'object', properties: { box: { type: 'string' }, month: { type: 'string' }, limit: { type: 'number', default: 300 } } }, run: async a => {
    const d = await load(['treasury']), l = d.treasury.filter(e => (!a.box || e.box === a.box || e.to_box === a.box) && (!a.month || (e.date || '').startsWith(a.month))).sort((x, y) => (y.date || '').localeCompare(x.date || ''));
    return { balances: C.treasuryBalances(d.treasury), entries_count: l.length, entries: l.slice(0, a.limit || 300) };
  } },
  { name: 'get_profit_report', description: 'Profit per car: expected profit, actual profit received, and what each is made of. Optionally only cars bought in one month (YYYY-MM). Also office expenses for that month.', inputSchema: { type: 'object', properties: { month: { type: 'string' } } }, run: async a => {
    const d = await load(['customers', 'vehicles', 'payments', 'internal', 'settings', 'expenses']), cx = C.makeCtx(d);
    const vs = d.vehicles.filter(v => !a.month || (v.purchase_date || v.created_at || '').startsWith(a.month));
    const rows = vs.map(v => { const f = v.fin || {}, rc = cx.received(v); return { vin: v.vin, title: vt(v), status: C.ST_NAMES[v.status] || v.status, purchase_date: v.purchase_date || '', office_commission: num(f.office_commission), transfer_fee: num(f.transfer_commission), payment_costs_net: r2(cx.tCost(v)), expected_wire_cost: r2(cx.wireEst(v)), shipping_margin: r2(cx.shipMargin(v)), expected_profit: r2(cx.profit(v)), actual_profit_received: rc.total, costs_deducted: rc.costs_deducted, real: cx.realBreak(v), issues: cx.issues(v) }; });
    const ex = d.expenses.filter(e => !a.month || (e.date || '').startsWith(a.month)).reduce((s, e) => s + num(e.amount_usd), 0);
    return { cars: rows.length, expected_profit_usd: r2(rows.reduce((s, r) => s + r.expected_profit, 0)), actual_profit_received_usd: r2(rows.reduce((s, r) => s + r.actual_profit_received, 0)), office_expenses_usd: r2(ex), rows };
  } },
  { name: 'check_accounting', description: 'Accounting error check (same as the Profit page): for every car, the real profit as amounts (customer pays, our real cost, real profit) and any errors or warnings (missing auction payment, unbooked auction gap, missing shipping cost, wrong transfer fee, payment cost not matching its details, FX payment without loss, duplicates, overpaid, loss). Optionally one month (YYYY-MM) or only cars with problems.', inputSchema: { type: 'object', properties: { month: { type: 'string' }, only_problems: { type: 'boolean' } } }, run: async a => {
    const d = await load(['customers', 'vehicles', 'payments', 'internal', 'settings']), cx = C.makeCtx(d);
    const cn = id => (d.customers.find(c => c.id === id) || {}).full_name || '';
    const vs = d.vehicles.filter(v => !a.month || (v.purchase_date || v.created_at || '').startsWith(a.month));
    const cars = vs.map(v => ({ vin: v.vin, title: vt(v), customer: cn(v.customer_id), status: C.ST_NAMES[v.status] || v.status, ...cx.realBreak(v), issues: cx.issues(v) })).filter(x => !a.only_problems || x.issues.length);
    const general = cx.globalIssues(), all = [...cars.flatMap(c => c.issues), ...general];
    return { errors: all.filter(x => x.level === 'error').length, warnings: all.filter(x => x.level === 'warning').length, total_customer_pays: r2(cars.reduce((s, c) => s + c.customer_pays, 0)), total_real_cost: r2(cars.reduce((s, c) => s + c.real_cost, 0)), total_real_profit: r2(cars.reduce((s, c) => s + c.real_profit, 0)), general, cars };
  } },
  { name: 'get_activity_log', description: 'Latest actions in the system (who did what).', inputSchema: { type: 'object', properties: { limit: { type: 'number', default: 50 } } }, run: async a => (await load(['logs'])).logs.sort((x, y) => (y.at || '').localeCompare(x.at || '')).slice(0, a.limit || 50) },
  { name: 'get_settings', description: 'Company settings and default payment rules (LYD rate, customer fee %, PayPal %, Copart discount %, card return, wire difference, agent fee).', inputSchema: { type: 'object', properties: {} }, run: async () => (await load(['settings'])).settings },

  /* ---------- write ---------- */
  { name: 'create_customer', description: 'Add a customer. The 4-digit customer number is given automatically unless you pass one.', inputSchema: { type: 'object', properties: { full_name: { type: 'string' }, phone: { type: 'string' }, alternate_phone: { type: 'string' }, city: { type: 'string' }, notes: { type: 'string' }, code: { type: 'string' } }, required: ['full_name'] }, run: async a => {
    const d = await load(['customers']), c = { ...strArgs(a, ['full_name', 'phone', 'alternate_phone', 'city', 'notes']), code: a.code ? String(a.code) : C.nextCode(d.customers), created_at: now() };
    if (!/^\d{4}$/.test(c.code)) err('Customer number must be 4 digits'); if (d.customers.some(x => x.code === c.code)) err(`Customer number #${c.code} is already used`);
    const id = await db().add('customers', clean(c)); await log('cust_add', `#${c.code} · ${c.full_name} · ${c.phone || ''}`, 'c:' + id); return { created: true, id, ...c };
  } },
  { name: 'update_customer', description: 'Change a customer\'s details. Only the fields you pass change.', inputSchema: { type: 'object', properties: { customer_id: { type: 'string' }, customer_code: { type: 'string' }, full_name: { type: 'string' }, phone: { type: 'string' }, alternate_phone: { type: 'string' }, city: { type: 'string' }, notes: { type: 'string' }, new_code: { type: 'string' } }, required: [] }, run: async a => {
    const d = await load(['customers']), c = findCustomer(d.customers, a), u = strArgs(a, ['full_name', 'phone', 'alternate_phone', 'city', 'notes']);
    if (a.new_code) { if (!/^\d{4}$/.test(a.new_code)) err('Customer number must be 4 digits'); if (d.customers.some(x => x.code === a.new_code && x.id !== c.id)) err('That customer number is used'); u.code = a.new_code; u.code_auto = false; }
    if (!Object.keys(u).length) err('Nothing to change'); await db().update('customers', c.id, clean(u)); await log('cust_edit', `${u.full_name || c.full_name} · ${Object.keys(u).join(', ')}`, 'c:' + c.id); return { updated: true, id: c.id, changes: u };
  } },
  { name: 'create_vehicle', description: 'Add a car for a customer. Money in USD. The transfer fee is calculated as the customer fee % (default 1.5%) of car + auction fees + towing + ocean + extras unless you pass transfer_commission.', inputSchema: { type: 'object', properties: {
    customer_id: { type: 'string' }, customer_code: { type: 'string' }, vin: { type: 'string' }, lot_number: { type: 'string' }, make: { type: 'string' }, model: { type: 'string' }, year: { type: 'string' }, color: { type: 'string' }, trim: { type: 'string' }, engine: { type: 'string' },
    auction_name: { type: 'string', description: 'Copart, IAAI, Manheim, Other' }, auction_location: { type: 'string' }, us_port: { type: 'string', description: 'Port code from the port map, e.g. NWK, HOU, LAX, SAV, CHI, SEA, HNL' }, ship_port: { type: 'string' }, purchase_date: { type: 'string' }, status: { type: 'string', enum: C.ST }, auction_paid_by: { type: 'string', description: '"office" if we paid the auction before the customer paid' }, notes: { type: 'string' },
    fin: FIN_SCHEMA, extras: EXTRAS_SCHEMA, shipping_cost_actual: { type: 'number', description: 'Our real towing + ocean cost (internal, not shown to the customer)' } }, required: ['vin', 'fin'] }, run: async a => {
    const d = await load(['customers', 'vehicles', 'settings']), c = findCustomer(d.customers, a), vin = String(a.vin || '').toUpperCase().replace(/\s/g, '');
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin) && !/^[A-Z0-9]{8,20}$/.test(vin)) err('VIN must be 17 characters (or a valid HIN/serial)'); if (d.vehicles.some(v => v.vin === vin)) err('This VIN already exists');
    const fin = Object.fromEntries(C.FIN.map(k => [k, r2(num((a.fin || {})[k]))])), extras = (a.extras || []).map(x => ({ d: String(x.d || ''), a: r2(num(x.a)) }));
    if (!(a.fin && a.fin.transfer_commission != null)) { const pct = num(d.settings.fee_cust ?? 1.5); fin.transfer_commission = r2((fin.bid_price + fin.auction_fees + fin.inland_shipping + fin.ocean_shipping + extras.reduce((s, x) => s + x.a, 0)) * pct / 100); }
    const status = a.status || 'WON_PENDING_PAYMENT', v = { customer_id: c.id, vin, ...strArgs(a, VEH_FIELDS), extras, status, status_history: [{ status, at: now() }], fin, transfers: [], created_at: now(), created_by: who() };
    if (!v.purchase_date) v.purchase_date = today(); if (v.auction_paid_by && !v.auction_paid_date) v.auction_paid_date = today();
    v.total_cost = r2(C.FIN.reduce((s, k) => s + fin[k], 0) + extras.reduce((s, x) => s + x.a, 0));
    const id = await db().add('vehicles', clean(v)); if (a.shipping_cost_actual != null) await db().merge('vinternal', id, { shipping_cost_actual: r2(num(a.shipping_cost_actual)) });
    await syncTracking(v); await log('veh_add', `${vt(v)} · ${vin} · ${c.full_name}`, 'v:' + id); return { created: true, id, vin, customer: c.full_name, fin, customer_total: v.total_cost };
  } },
  { name: 'update_vehicle', description: 'Change a car. Pass only what changes: details, fin (merged key by key), extras (replaces the list), shipping_cost_actual and wire (internal). Use set_vehicle_status for the status.', inputSchema: { type: 'object', properties: {
    vehicle_id: { type: 'string' }, vin: { type: 'string' }, lot_number_lookup: { type: 'string' }, ...Object.fromEntries(VEH_FIELDS.map(k => [k, { type: 'string' }])), customer_code: { type: 'string', description: 'Move the car to this customer' },
    fin: FIN_SCHEMA, extras: EXTRAS_SCHEMA, shipping_cost_actual: { type: 'number' }, wire: { type: 'object', description: 'Expected shipping wire: rate (LYD per USD), lyd (difference LYD per USD, e.g. 0.12), agent ($ per $1,000)', properties: { rate: { type: 'number' }, lyd: { type: 'number' }, agent: { type: 'number' } } }, recalc_transfer_fee: { type: 'boolean', description: 'Recalculate the transfer fee from the new amounts' } } }, run: async a => {
    const d = await load(['customers', 'vehicles', 'settings']), v = findVehicle(d.vehicles, { ...a, lot_number: a.lot_number_lookup }), u = strArgs(a, VEH_FIELDS);
    if (a.customer_code) u.customer_id = findCustomer(d.customers, { customer_code: a.customer_code }).id;
    let fin = { ...(v.fin || {}) }, extras = v.extras || [];
    if (a.fin) { Object.entries(a.fin).forEach(([k, x]) => { if (C.FIN.includes(k)) fin[k] = r2(num(x)); }); u.fin = fin; }
    if (a.extras) { extras = a.extras.map(x => ({ d: String(x.d || ''), a: r2(num(x.a)) })); u.extras = extras; }
    if (a.recalc_transfer_fee) { const pct = num(d.settings.fee_cust ?? 1.5); fin.transfer_commission = r2((num(fin.bid_price) + num(fin.auction_fees) + num(fin.inland_shipping) + num(fin.ocean_shipping) + extras.reduce((s, x) => s + num(x.a), 0)) * pct / 100); u.fin = fin; }
    if (u.fin || u.extras) u.total_cost = r2(C.FIN.reduce((s, k) => s + num(fin[k]), 0) + extras.reduce((s, x) => s + num(x.a), 0));
    const iu = {}; if (a.shipping_cost_actual != null) iu.shipping_cost_actual = r2(num(a.shipping_cost_actual)); if (a.wire) iu.wire = { rate: num(a.wire.rate), lyd: num(a.wire.lyd), agent: num(a.wire.agent) };
    if (!Object.keys(u).length && !Object.keys(iu).length) err('Nothing to change');
    if (Object.keys(u).length) await db().update('vehicles', v.id, clean(u)); if (Object.keys(iu).length) await db().merge('vinternal', v.id, clean(iu));
    await syncTracking({ ...v, ...u }); await log('veh_edit', `${vt(v)} · ${v.vin} · ${[...Object.keys(u), ...Object.keys(iu)].join(', ')}`, 'v:' + v.id);
    return { updated: true, id: v.id, vin: v.vin, changes: { ...u, ...iu } };
  } },
  { name: 'set_vehicle_status', description: 'Move a car to a new stage. Values: ' + C.ST.map(k => `${k} (${C.ST_NAMES[k]})`).join(', ') + '. Updates the customer tracking page too.', inputSchema: { type: 'object', properties: { vehicle_id: { type: 'string' }, vin: { type: 'string' }, status: { type: 'string', enum: C.ST } }, required: ['status'] }, run: async a => {
    const d = await load(['vehicles']), v = findVehicle(d.vehicles, a); if (v.status === a.status) return { unchanged: true, status: a.status };
    const h = [...(v.status_history || []), { status: a.status, at: now() }]; await db().update('vehicles', v.id, { status: a.status, status_history: h }); await syncTracking({ ...v, status: a.status, status_history: h });
    await log('veh_status', `${vt(v)} · ${v.vin}: ${C.ST_NAMES[v.status] || v.status} → ${C.ST_NAMES[a.status]}`, 'v:' + v.id); return { updated: true, vin: v.vin, from: v.status, to: a.status };
  } },
  { name: 'add_customer_payment', description: 'Record money received from a customer. In LYD pass rate (LYD per USD). Link it to a car (vin) so the car\'s stages and profit update.', inputSchema: { type: 'object', properties: { customer_id: { type: 'string' }, customer_code: { type: 'string' }, vin: { type: 'string' }, vehicle_id: { type: 'string' }, amount: { type: 'number' }, currency: { type: 'string', enum: ['USD', 'LYD'], default: 'USD' }, rate: { type: 'number' }, date: { type: 'string' }, method: { type: 'string', description: 'cash_usd, cash_lyd, bank, card, transfer, other' }, ref: { type: 'string' }, notes: { type: 'string' } }, required: ['amount'] }, run: async a => {
    const d = await load(['customers', 'vehicles']); let v = null; if (a.vin || a.vehicle_id) v = findVehicle(d.vehicles, a);
    const c = a.customer_id || a.customer_code ? findCustomer(d.customers, a) : v ? d.customers.find(x => x.id === v.customer_id) : err('Pass the customer or the car');
    if (v && v.customer_id !== c.id) err('That car belongs to another customer');
    const cur = a.currency || 'USD', amount = r2(num(a.amount)), rate = num(a.rate); if (!(amount > 0)) err('Amount must be more than 0'); if (cur === 'LYD' && !(rate > 0)) err('Pass the exchange rate for LYD');
    const p = { customer_id: c.id, vehicle_id: v ? v.id : '', amount, currency: cur, rate: cur === 'LYD' ? rate : 1, amount_usd: r2(cur === 'LYD' ? amount / rate : amount), date: a.date || today(), method: a.method || '', ref: a.ref || '', receipt_notes: a.notes || '', created_at: now(), created_by: who() };
    const id = await db().add('payments', clean(p)); await log('pay_add', `${c.full_name} · ${cur === 'LYD' ? amount + ' LYD' : '$' + amount}${v ? ' · ' + vt(v) : ''}`, v ? 'v:' + v.id : 'c:' + c.id); return { created: true, id, ...p };
  } },
  { name: 'add_how_we_paid', description: 'Record a payment WE made for a car (to the auction, shipping line, tow company...) with method, account used and its cost, like "How we paid" in the app. Cost fields: rate (LYD per USD), card_back (LYD per USD returned, card), pp_pct (PayPal %), lyd_cost (LYD difference paid, wire/MoneyGram/WU), agent_fee ($), disc_pct (Copart discount % for wire/MoneyGram/WU), other_cost ($).', inputSchema: { type: 'object', properties: {
    vehicle_id: { type: 'string' }, vin: { type: 'string' }, purpose: { type: 'string', enum: C.PURPOSES }, payee: { type: 'string', description: 'Who we paid, e.g. Copart, IAAI, AEC' }, method: { type: 'string', enum: C.PAY_METHODS }, src: { type: 'string', description: 'Name / account used, e.g. "moayed card 5541", "MoneyGram Monder"' },
    amount: { type: 'number', description: 'USD' }, date: { type: 'string' }, status: { type: 'string', enum: ['pending', 'sent', 'confirmed'], default: 'sent' }, ref: { type: 'string' }, details: { type: 'string' }, notes: { type: 'string' }, currency: { type: 'string', default: 'USD' }, currency_amount: { type: 'number' }, currency_rate: { type: 'number' },
    cost: { type: 'object', properties: { rate: { type: 'number' }, card_back: { type: 'number' }, pp_pct: { type: 'number' }, lyd_cost: { type: 'number' }, agent_fee: { type: 'number' }, disc_pct: { type: 'number' }, other_cost: { type: 'number' } } } }, required: ['purpose', 'payee', 'method', 'amount'] }, run: async a => {
    const d = await load(['vehicles', 'internal', 'settings']), cx = C.makeCtx(d), v = findVehicle(d.vehicles, a), amount = r2(num(a.amount)); if (!(amount > 0)) err('Amount must be more than 0');
    const cur = a.currency || 'USD', t = { id: 't' + Date.now().toString(36), cust_pct: cx.PAYDEF().cust, purpose: a.purpose, payee: a.payee, method: a.method, src: a.src || '', details: a.details || '', ref: a.ref || '', date: a.date || today(),
      items: [{ k: a.purpose === 'auction' ? 'car' : a.purpose === 'shipping' ? 'ocean' : a.purpose === 'towing' ? 'towing' : 'other', note: '', a: amount }], amount, cur, cur_amount: cur === 'USD' ? amount : r2(num(a.currency_amount)), rate: cur === 'USD' ? 1 : num(a.currency_rate), charged: 0, status: a.status || 'sent', conf_date: '', notes: a.notes || '', receipt: null, at: now(), by: who() };
    const P = cx.PAYDEF(), k = a.cost || {}, det = { method: t.method, rate: num(k.rate) || num(d.settings.rate), at: now() };
    if (t.method === 'card') det.card_back = k.card_back != null ? num(k.card_back) : P.card;
    if (t.method === 'paypal') det.pp_pct = k.pp_pct != null ? num(k.pp_pct) : P.paypal;
    if (C.HAND_METHODS.includes(t.method)) { det.lyd_cost = r2(num(k.lyd_cost)); det.agent_fee = r2(num(k.agent_fee)); }
    if (C.DISC_METHODS.includes(t.method) && /copart/i.test(t.payee)) det.disc_pct = k.disc_pct != null ? num(k.disc_pct) : P.disc;
    if (k.other_cost != null) det.other_cost = r2(num(k.other_cost));
    const res = cx.payResult(t.method, t.payee, t.amount, 0, det), iv = d.internal[v.id] || {};
    await db().update('vehicles', v.id, clean({ transfers: [...(v.transfers || []), t] }));
    await db().merge('vinternal', v.id, clean({ tcost: { ...(iv.tcost || {}), [t.id]: r2(res.cost - res.gain) }, tcostd: { ...(iv.tcostd || {}), [t.id]: det } }));
    await log('veh_edit', `${vt(v)} · ${v.vin} · ${t.purpose}: ${t.method} (${t.src}) $${amount}`, 'v:' + v.id);
    return { created: true, vin: v.vin, payment: t, cost_details: det, result: { cost: r2(res.cost), gain: r2(res.gain), net_for_us: r2(res.gain - res.cost) } };
  } },
  { name: 'add_expense', description: 'Record an office expense. Categories: ' + C.EXP_CATS.join(', ') + '.', inputSchema: { type: 'object', properties: { category: { type: 'string', enum: C.EXP_CATS }, amount: { type: 'number' }, currency: { type: 'string', enum: ['LYD', 'USD'], default: 'LYD' }, rate: { type: 'number', description: 'LYD per USD, needed for LYD' }, date: { type: 'string' }, notes: { type: 'string' } }, required: ['category', 'amount'] }, run: async a => {
    const s = (await load(['settings'])).settings, cur = a.currency || 'LYD', amount = r2(num(a.amount)), rate = num(a.rate) || num(s.rate); if (!(amount > 0)) err('Amount must be more than 0'); if (cur === 'LYD' && !(rate > 0)) err('Pass the exchange rate');
    const e = { category: a.category, amount, currency: cur, rate: cur === 'LYD' ? rate : 1, amount_usd: r2(cur === 'LYD' ? amount / rate : amount), date: a.date || today(), notes: a.notes || '', created_at: now(), created_by: who() };
    const id = await db().add('expenses', clean(e)); await log('exp_add', `${a.category} · ${cur === 'LYD' ? amount + ' LYD' : '$' + amount}${e.notes ? ' · ' + e.notes : ''}`); return { created: true, id, ...e };
  } },
  { name: 'add_treasury_entry', description: 'Add a treasury entry. kind: open (opening balance), in (money in), out (money out), move (transfer/exchange from box to to_box). in categories: customer, owner, refund, other. out categories: auction, shipping, expense, agent, owner, other.', inputSchema: { type: 'object', properties: {
    kind: { type: 'string', enum: ['open', 'in', 'out', 'move'] }, box: { type: 'string' }, cur: { type: 'string', enum: ['LYD', 'USD'] }, amount: { type: 'number' }, date: { type: 'string' }, cat: { type: 'string' }, party: { type: 'string', description: 'Received from / paid to' }, desc: { type: 'string' }, ref: { type: 'string' },
    to_box: { type: 'string' }, to_cur: { type: 'string', enum: ['LYD', 'USD'] }, to_amount: { type: 'number' } }, required: ['kind', 'box', 'cur', 'amount'] }, run: async a => {
    const e = { kind: a.kind, box: String(a.box).trim(), cur: a.cur, amount: r2(num(a.amount)), date: a.date || today(), cat: ['in', 'out'].includes(a.kind) ? a.cat || 'other' : '', party: a.party || '', desc: a.desc || '', ref: a.ref || '', to_box: '', to_cur: '', to_amount: 0, created_at: now(), created_by: who() };
    if (!(e.amount > 0)) err('Amount must be more than 0');
    if (a.kind === 'move') { if (!a.to_box || !(num(a.to_amount) > 0) || !a.to_cur) err('A transfer needs to_box, to_cur and to_amount'); Object.assign(e, { to_box: String(a.to_box).trim(), to_cur: a.to_cur, to_amount: r2(num(a.to_amount)) }); }
    const id = await db().add('treasury', clean(e)); await log('tb_add', `${e.kind} · ${e.box}${e.to_box ? ' → ' + e.to_box : ''} · ${e.amount} ${e.cur}${e.desc ? ' · ' + e.desc : ''}`); return { created: true, id, ...e };
  } },
  { name: 'update_document', description: 'Advanced: change fields of any record directly (full access). Collections: ' + COLLECTIONS.join(', ') + '. Fields are merged into the record. Prefer the specific tools when one fits.', inputSchema: { type: 'object', properties: { collection: { type: 'string', enum: COLLECTIONS }, id: { type: 'string' }, fields: { type: 'object' } }, required: ['collection', 'id', 'fields'] }, run: async a => {
    docGuard(a.collection, true); const cur = await db().get(a.collection, a.id); if (!cur && a.collection !== 'vinternal' && a.collection !== 'settings') err('Record not found');
    await db().merge(a.collection, a.id, clean(a.fields)); await log(a.collection === 'treasury' ? 'tb_edit' : a.collection === 'customers' ? 'cust_edit' : 'veh_edit', `${a.collection}/${a.id} · ${Object.keys(a.fields).join(', ')}`);
    if (a.collection === 'vehicles') { const v = await db().get('vehicles', a.id); await syncTracking(v); }
    return { updated: true, collection: a.collection, id: a.id, fields: a.fields };
  } },
  { name: 'get_document', description: 'Advanced: read one record by collection and id.', inputSchema: { type: 'object', properties: { collection: { type: 'string', enum: COLLECTIONS }, id: { type: 'string' } }, required: ['collection', 'id'] }, run: async a => { docGuard(a.collection, false); return (await db().get(a.collection, a.id)) || err('Record not found'); } },
  { name: 'delete_document', description: 'Permanently delete a record (customer, car, payment, expense, treasury entry). Cannot be undone. Deleting a car also removes its tracking page and internal costs; its customer payments are kept unless delete_payments is true. A customer with cars or payments cannot be deleted. Always confirm with the user first and pass confirm: true.', inputSchema: { type: 'object', properties: { collection: { type: 'string', enum: ['customers', 'vehicles', 'payments', 'expenses', 'treasury'] }, id: { type: 'string' }, delete_payments: { type: 'boolean' }, confirm: { type: 'boolean' } }, required: ['collection', 'id', 'confirm'] }, run: async a => {
    if (a.confirm !== true) err('Ask the user to confirm, then call again with confirm: true');
    const doc = await db().get(a.collection, a.id); if (!doc) err('Record not found');
    if (a.collection === 'customers') { const d = await load(['vehicles', 'payments']); if (d.vehicles.some(v => v.customer_id === a.id) || d.payments.some(p => p.customer_id === a.id)) err('This customer has cars or payments'); }
    if (a.collection === 'vehicles') { if (a.delete_payments) { const ps = (await load(['payments'])).payments.filter(p => p.vehicle_id === a.id); for (const p of ps) await db().del('payments', p.id); } if (doc.vin) await db().del('tracking', doc.vin).catch(() => { }); await db().del('vinternal', a.id).catch(() => { }); }
    await db().del(a.collection, a.id);
    const label = a.collection === 'vehicles' ? `${vt(doc)} · ${doc.vin}` : a.collection === 'customers' ? doc.full_name : a.collection === 'treasury' ? `${doc.box} · ${doc.amount} ${doc.cur}` : `${doc.amount || ''} ${doc.currency || ''} · ${doc.date || ''}`;
    await log({ vehicles: 'veh_del', customers: 'cust_del', payments: 'pay_del', expenses: 'exp_del', treasury: 'tb_del' }[a.collection], label); return { deleted: true, collection: a.collection, id: a.id, label };
  } }
];

const isRead = name => /^(get|search|list)_/.test(name);
/* which tools a key may use: read-only keys get the read tools; every tool also needs the owner's permission in the app */
const NEEDP = { get_profit_report: 'profit', check_accounting: 'profit', list_expenses: 'expenses', get_activity_log: 'logs', create_customer: 'edit', update_customer: 'edit', create_vehicle: 'edit', update_vehicle: 'edit', set_vehicle_status: 'edit', add_how_we_paid: 'edit', update_document: 'edit', add_customer_payment: 'payments', add_expense: 'expenses', delete_document: 'delete' };
const allowed = (name, key) => (key.access === 'full' || isRead(name)) && (!NEEDP[name] || !!(key.perms || {})[NEEDP[name]]);
module.exports = { TOOLS, CTX, isRead, allowed };
