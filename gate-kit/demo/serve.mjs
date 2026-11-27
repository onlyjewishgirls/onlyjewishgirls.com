/* Gate kit demo: a tiny Node server with the real gate in front of a stand-in
   site, for looking at the challenge page and taking screenshots.

     node demo/serve.mjs                 # http://localhost:8788/
     node demo/serve.mjs --offline       # fake siteverify (no network needed)
     PORT=9000 node demo/serve.mjs
     SITE_KEY=3x00000000000000000000FF node demo/serve.mjs   # test key that always asks

   It runs with Cloudflare's always-pass TEST keys and the Node adapter's
   localDev opt-in, so the gate accepts them only for a browser on this
   machine: a loopback socket, a Host of localhost / *.localhost
   and no proxy headers. Point a real hostname or a proxy at it and every
   request gets the 503 instead. Set TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY
   to try real keys.
*/
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createGate, SITEVERIFY_URL } from '../gate.mjs';
import { createNodeGate } from '../gate-node.mjs';

export const TEST_SITE_KEY = '1x00000000000000000000AA';
export const TEST_SECRET = '1x0000000000000000000000000000000AA';
export const DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

/** siteverify stand-in for --offline: the dummy token passes, anything else fails. */
export async function fakeSiteverify(url, init) {
  if (url !== SITEVERIFY_URL) throw new Error('unexpected fetch ' + url);
  const token = new URLSearchParams(String(init.body)).get('response');
  const ok = token === DUMMY_TOKEN;
  return new Response(JSON.stringify(ok
    ? { success: true, hostname: 'example.com', action: '', 'error-codes': [] }
    : { success: false, 'error-codes': ['invalid-input-response'] }), {
    headers: { 'content-type': 'application/json' },
  });
}

function site(req, res) {
  const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Demo site</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:40px auto;max-width:640px;padding:0 16px}</style>
<h1>You're through</h1><p>This is the stand-in site behind the gate. Path: <code>${req.url.replace(/[<>&"]/g, '')}</code></p>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.end(body);
}

export function startDemo({ port = 8788, host = '127.0.0.1', offline = false, siteName = 'Example Portal', siteDomain, siteKey } = {}) {
  const env = {
    TURNSTILE_SITE_KEY: siteKey || process.env.TURNSTILE_SITE_KEY || TEST_SITE_KEY,
    TURNSTILE_SECRET_KEY: process.env.TURNSTILE_SECRET_KEY || TEST_SECRET,
    GATE_MODE: process.env.GATE_MODE || '',
  };
  const gate = createGate({
    siteName,
    ...(siteDomain ? { siteDomain } : {}),
    getSetting: (key) => (key === 'captcha_pass_hours' ? 1 : null),
    exempt: (_req, url) => (url.pathname.startsWith('/client/') ? 'demo-client' : null),
    onEvent: (type, d) => { if (!process.env.QUIET) console.log(`[gate] ${type} ${d.method} ${d.path} ${d.reason || d.exemption || ''}`); },
    ...(offline ? { fetch: fakeSiteverify } : {}),
  });
  const nodeGate = createNodeGate(gate, { env, localDev: true });
  const server = http.createServer(async (req, res) => {
    if (await nodeGate(req, res)) return;
    site(req, res);
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve({ server, gate, port: server.address().port })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const offline = process.argv.includes('--offline');
  const { port } = await startDemo({ port: Number(process.env.PORT) || 8788, offline, siteKey: process.env.SITE_KEY });
  console.log(`Gate demo on http://localhost:${port}/ ${offline ? '(offline siteverify)' : ''}`);
}
