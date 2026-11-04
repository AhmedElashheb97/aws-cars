/* MCP connector for Claude (Streamable HTTP, JSON responses).
   URL: https://<your-site>/api/mcp/<key>
   Keys are created in the app (page "Claude connector"). The key is the last part of the URL.
   Env vars (Vercel > Settings > Environment Variables):
     FIREBASE_SERVICE_ACCOUNT the Firebase service-account JSON (plain or base64), required
     MCP_SECRET               optional extra full-access key */
const crypto = require('crypto');
const { TOOLS, CTX, allowed } = require('../../lib/tools');
const { db } = require('../../lib/db');

const INSTRUCTIONS = 'AWS cars office system (Alashhab Washurakauh Co.): cars bought at Copart/IAAI for customers and shipped to Al Khums, Libya. Money is in USD unless a currency is given. ' +
  'Customers pay in two stages: on purchase (car + auction fees + $150 office fee) and on arrival (towing + ocean + extra charges + transfer fee, 1.5%). Extra charges are passed on, not profit. ' +
  'Expected profit = office fee + transfer fee - payment costs - expected shipping wire cost + shipping margin. Actual profit received counts gains only, and costs once the car has arrived and is fully paid. ' +
  'Always look things up before changing them, and confirm with the user before deleting anything.';

/* Keys are created in the app (page "Claude connector") and stored as apikeys/{sha256(key)}.
   A key works with the permissions its owner has in the app right now (checked on every call).
   MCP_SECRET in Vercel still works as a full-access admin key. */
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'ahmedesmal97@gmail.com').toLowerCase();
const ALL = { edit: true, payments: true, delete: true, profit: true, expenses: true, logs: true, settings: true };
async function checkKey(given) {
  given = String(given || '');
  if (given.length < 16 || given.length > 200) return null;
  const want = process.env.MCP_SECRET || '';
  if (want.length >= 16 && given.length === want.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want))) return { who: 'Claude API', access: 'full', perms: ALL };
  const id = crypto.createHash('sha256').update(given).digest('hex'), k = await db().get('apikeys', id);
  if (!k || k.active === false) return null;
  const owner = String(k.owner || k.created_by || '').toLowerCase();
  let perms = ALL;
  if (owner !== ADMIN_EMAIL) {
    const u = owner ? await db().get('users', owner) : null;
    if (!u || u.active !== true) return null; // owner removed or turned off
    perms = u.perms || {};
  }
  if (!k.last_used || Date.now() - Date.parse(k.last_used) > 10 * 60e3) db().merge('apikeys', id, { last_used: new Date().toISOString() }).catch(() => { });
  return { who: 'Claude API · ' + (k.name || id.slice(0, 6)) + (owner ? ' (' + owner + ')' : ''), access: k.access === 'read' ? 'read' : 'full', perms };
}
async function handle(msg, key) {
  const { id, method, params = {} } = msg || {};
  const reply = result => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof method !== 'string') return fail(-32600, 'Invalid request');
  if (id === undefined || id === null) return null; // notification
  switch (method) {
    case 'initialize':
      return reply({ protocolVersion: params.protocolVersion || '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'aws-cars', version: '1.0.0' }, instructions: INSTRUCTIONS });
    case 'ping': return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS.filter(t => allowed(t.name, key)).map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: /^(get|search|list)_/.test(t.name), destructiveHint: t.name === 'delete_document' } })) });
    case 'tools/call': {
      const t = TOOLS.find(x => x.name === params.name);
      if (!t) return fail(-32602, 'Unknown tool: ' + params.name);
      if (!allowed(t.name, key)) return reply({ content: [{ type: 'text', text: key.access !== 'full' && !/^(get|search|list)_/.test(t.name) ? 'Error: this key is read only.' : 'Error: the owner of this key does not have permission for this in the app.' }], isError: true });
      try {
        const out = await CTX.run({ who: key.who, perms: key.perms }, () => t.run(params.arguments || {}));
        return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 1) }] });
      } catch (e) {
        if (!e.user) console.error(t.name, e);
        return reply({ content: [{ type: 'text', text: 'Error: ' + (e.message || String(e)) }], isError: true });
      }
    }
    case 'resources/list': return reply({ resources: [] });
    case 'prompts/list': return reply({ prompts: [] });
    default: return fail(-32601, 'Method not found: ' + method);
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, mcp-session-id, mcp-protocol-version, authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) return res.status(503).json({ error: 'not_configured', message: 'FIREBASE_SERVICE_ACCOUNT is not set in Vercel' });
  let key;
  try { key = await checkKey(req.query && req.query.key); } catch (e) { console.error(e); return res.status(500).json({ error: 'server_error', message: e.message }); }
  if (!key) return res.status(404).json({ error: 'Not found' });
  if (req.method !== 'POST') return res.status(405).setHeader('Allow', 'POST').json({ error: 'Use POST' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); } }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map(m => handle(m, key)))).filter(Boolean);
    return out.length ? res.status(200).json(out) : res.status(202).end();
  }
  const out = await handle(body, key);
  return out ? res.status(200).json(out) : res.status(202).end();
};
