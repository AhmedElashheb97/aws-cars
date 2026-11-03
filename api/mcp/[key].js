/* MCP connector for Claude (Streamable HTTP, JSON responses).
   URL: https://<your-site>/api/mcp/<MCP_SECRET>
   Env vars (Vercel > Settings > Environment Variables):
     MCP_SECRET               long random text; it is the password inside the URL
     FIREBASE_SERVICE_ACCOUNT the Firebase service-account JSON (plain or base64) */
const crypto = require('crypto');
const { TOOLS } = require('../../lib/tools');

const INSTRUCTIONS = 'AWS cars office system (Alashhab Washurakauh Co.): cars bought at Copart/IAAI for customers and shipped to Al Khums, Libya. Money is in USD unless a currency is given. ' +
  'Customers pay in two stages: on purchase (car + auction fees + $150 office fee) and on arrival (towing + ocean + extra charges + transfer fee, 1.5%). Extra charges are passed on, not profit. ' +
  'Expected profit = office fee + transfer fee - payment costs - expected shipping wire cost + shipping margin. Actual profit received counts gains only, and costs once the car has arrived and is fully paid. ' +
  'Always look things up before changing them, and confirm with the user before deleting anything.';

function okKey(given) {
  const want = process.env.MCP_SECRET || '';
  if (want.length < 16 || !given) return false;
  const a = Buffer.from(String(given)), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function handle(msg) {
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
      return reply({ tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: /^(get|search|list)_/.test(t.name), destructiveHint: t.name === 'delete_document' } })) });
    case 'tools/call': {
      const t = TOOLS.find(x => x.name === params.name);
      if (!t) return fail(-32602, 'Unknown tool: ' + params.name);
      try {
        const out = await t.run(params.arguments || {});
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
  if (!okKey(req.query && req.query.key)) return res.status(404).json({ error: 'Not found' });
  if (req.method !== 'POST') return res.status(405).setHeader('Allow', 'POST').json({ error: 'Use POST' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); } }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map(handle))).filter(Boolean);
    return out.length ? res.status(200).json(out) : res.status(202).end();
  }
  const out = await handle(body);
  return out ? res.status(200).json(out) : res.status(202).end();
};
