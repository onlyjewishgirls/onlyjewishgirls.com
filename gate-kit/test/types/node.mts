// A strict, Node-only TypeScript server using the Gate kit: lib ES2022 with
// no DOM, types ["node"] and skipLibCheck false (tsconfig.node.json). The
// declarations must not lean on DOM-only globals such as CryptoKey.
import http from 'node:http';
import {
  createGate, gateStatus, derivePassKey, signPass, isPrivateAddress,
  type GateEnv, type GatePassKey,
} from '../../gate.mjs';
import {
  createNodeGate, toWebRequest, writeWebResponse, privatizeNodeResponse, clientIpOf, MSG_PRIVATE_CLIENT,
} from '../../gate-node.mjs';

interface Env extends GateEnv { DB_PATH?: string }
const env: Env = { TURNSTILE_SITE_KEY: process.env['TURNSTILE_SITE_KEY'], TURNSTILE_SECRET_KEY: process.env['TURNSTILE_SECRET_KEY'] };
const gate = createGate<Env>({ siteName: 'x', getSetting: async (_k, e) => e.DB_PATH ?? null, onStats: (rows) => { void rows; } });
const mw = createNodeGate(gate, { env, trustCloudflare: ['127.0.0.1', '::1', 'unix'], localDev: process.env['GATE_LOCAL_DEV'] === '1' });

http.createServer(async (req, res) => {
  if (await mw(req, res)) return;
  const r: Request = toWebRequest(req, { protocol: 'https' });
  const ip: string = clientIpOf(req, { trustCloudflare: true });
  const priv: boolean = isPrivateAddress(ip);
  void r; void priv; void MSG_PRIVATE_CLIENT;
  privatizeNodeResponse(res);
  await writeWebResponse(res, gate.decorate(new Response('hi')), req.method);
  void gateStatus(env).state;
}).listen(0);

const key: GatePassKey = await derivePassKey('m');
void signPass(key, { host: 'h', ip: '1.2.3.4', uah: 'u', iat: 1, exp: 2 });
