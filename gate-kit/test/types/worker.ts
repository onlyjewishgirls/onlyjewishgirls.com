// A strict TypeScript Worker using the Gate kit, the way KidMonitor will.
import {
  createGate, VERIFY_PATH, PASS_HOURS, derivePassKey, signPass, verifyPass,
  type GateEnv, type GateEventType, type GateEventDetail, type GateStatsRow, type Gate, type GatePassKey,
} from '../../gate.mjs';

interface Env {
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET: string;
  GATE_MODE?: string;
  // A typed stand-in for the site's own D1 helper. (Deliberately not spelled
  // with D1's statement-builder method: repos such as KidMonitor forbid that
  // call outside their db module, and this file is vendored under src/.)
  DB: { run(sql: string, ...binds: unknown[]): Promise<unknown> };
}
interface ExecCtx {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const gate: Gate<Env> = createGate<Env>({
  siteName: 'KidMonitor',
  siteDomain: 'kidmonitor.chaimyuirmafia.com',
  getSetting: async (key, env) => {
    void env.DB;
    return key === 'captcha_pass_hours' ? '12' : null;
  },
  exempt: (request, url) => (url.pathname.startsWith('/client/') && request.method !== 'OPTIONS' ? 'kidmonitor' : null),
  onEvent: (type: GateEventType, detail: GateEventDetail) => {
    const country: string | null = detail.country;
    const reason: string | undefined = detail.reason;
    void country; void reason; void type;
  },
  onStats: async (rows: GateStatsRow[], env) => {
    for (const r of rows) {
      await env.DB.run('INSERT INTO gate_stats (hour, event, count) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET count = count + excluded.count',
        r.hour, r.event, r.count);
    }
  },
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecCtx): Promise<Response> {
    const blocked = await gate.handle(request, env, ctx);
    if (blocked) return blocked;
    return gate.decorate(new Response('ok'));
  },
  async run(request: Request, env: Env, ctx: ExecCtx): Promise<Response> {
    return gate.run(request, env, ctx, () => new Response('site'));
  },
};

// The env type is inferred from the hooks when no generic is given.
const plain = createGate({ siteName: 'x', getSetting: (_k, env: GateEnv) => env.GATE_MODE ?? null });
const hours: number = PASS_HOURS.max;
const path: '/__gate/verify' = VERIFY_PATH;
void plain; void hours; void path;

// @ts-expect-error siteName is required
createGate({});
// @ts-expect-error an Env without any gate variable is not a GateEnv
createGate<{ DB: string }>({ siteName: 'x' });

// A Web Crypto key is a GatePassKey, and derivePassKey()'s result feeds signPass/verifyPass.
async function keys(): Promise<boolean> {
  const k: GatePassKey = await derivePassKey('material');
  const webKey: GatePassKey = await crypto.subtle.importKey('raw', new Uint8Array(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const v = await signPass(k, { host: 'h', ip: '1.2.3.4', uah: 'u', iat: 1, exp: 2 });
  void webKey;
  return (await verifyPass(v, k, { host: 'h', ip: '1.2.3.4', uah: 'u' }, 1)).ok;
}
void keys;
