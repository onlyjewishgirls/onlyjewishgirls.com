# Gate kit: integration

The CAPTCHA wall from PORTAL-STANDARD §10, built once and vendored unchanged
into every repo. Nothing on a site loads (no page, asset, API, console,
sign-in, 404, `robots.txt` or favicon) until the visitor has solved a
Cloudflare Turnstile CAPTCHA. The only things that answer without a pass are
the challenge page, `POST /__gate/verify`, and the machine clients a site names
through the `exempt` hook.

Kit version: `GATE_KIT_VERSION` in `gate.mjs` (1.2.0). What changed since 1.0.0, and
what a site must do about it: §10.

---

## 1. What to copy

Copy the whole folder, unchanged, into the repo. Do not edit it per site; every
site-specific thing goes through `createGate()` options.

| File | Needed by |
|---|---|
| `gate.mjs` | every site (Workers, Node, OpenNext) |
| `gate.d.ts`, `gate.d.mts` | TypeScript sites (TS looks for `.d.mts` next to an `.mjs` import; keep both, they are identical) |
| `gate-node.mjs`, `gate-node.d.ts`, `gate-node.d.mts` | the Node runtime (chaimyuirmafia.com `server.js`) |
| `test/` | run it in the repo's test script: `node --test gate-kit/test/gate.test.mjs` |
| `demo/` | optional: local demo server and the screenshot script |

Where:

- JS Workers and Node: `<repo>/gate-kit/`.
- TypeScript Worker whose tsconfig includes only `src/**` (KidMonitor): `src/vendor/gate-kit/`.
  KidMonitor's `scripts/ci-grep-gates.sh` (CI and the deploy preflight) scans
  everything under `src/`; the whole kit passes it as shipped, and the kit's own
  suite checks that (`vendoring` test). Also add `src/vendor/` to
  `.prettierignore`: vendored files are never reformatted, or they stop being
  byte-identical to the kit. (KidMonitor's `npx prettier --check .` step already
  fails on 50 of its own files today, so that step is red with or without the kit.)
- Next.js/OpenNext: `<repo>/gate-kit/`, and add `gate-kit/` to the ESLint ignores.

Several repos already have something called "gate" (chaimyuirmafia.com
`src/gate.js` is the admin-PIN decoy, employees has `src/gate.js`, Sousveil has
`guard.js#gate`). Keep the kit in its own `gate-kit/` folder and call the
instance `captcha`, so the two are never confused:

```js
import { createGate } from './gate-kit/gate.mjs';
const captcha = createGate({ siteName: 'Chaim Yuir Mafia' /* , hooks */ });
```

When a site's assets directory is the repo root (tevaenviro `"."`,
lakewoodpolicenj.org `"./"`), add `gate-kit/` and the Worker file to
`.assetsignore`, or the source is published as static files.

---

## 2. API

```ts
createGate(options) -> Gate

options = {
  siteName: string,                       // "Checking that you're human before loading <siteName>."
  siteDomain?: string,                    // shown above the name; default: the request's hostname
  getSetting?(key, env) -> value | null,  // asked for 'captcha_pass_hours' when a pass is issued
  exempt?(request, url, env) -> name | null,   // machine clients only
  onEvent?(type, detail, env),            // counters only, see §5
  onStats?(rows, env),                    // batched hourly counts, see §5
  statsFlushSeconds?: number,             // default 60
  now?(): number, fetch?: typeof fetch,   // tests
}
// Every hook may be sync or return a Promise. A hook that throws never
// changes the gate's answer (a throwing exempt() means "not exempt").

gate.handle(request, env, ctx?) -> Promise<Response | null>
   // Response: return it as-is (challenge page, 403 JSON, 503, verify answer).
   // null: the request may continue (valid pass, exemption, or GATE_MODE="off").
gate.decorate(response) -> Response       // Vary: Cookie + private Cache-Control, CDN-only cache headers removed; leaves a 101 alone
gate.exemptionOf(request) -> string | null   // the exemption name if handle() let THIS Request through only via exempt(); see §5
gate.run(request, env, ctx, next) -> Promise<Response>   // handle(), then decorate(await next())
gate.stats()                              // in-memory totals for this isolate/process; `since` = its first request
gate.flushStats(env, ctx?)                // hand pending counts to onStats now

gateStatus(env) -> { state: 'on'|'off'|'not_configured'|'misconfigured', ok, label, detail }
   // the console posture item, from the deploy's variables alone

// helpers, also used by gate-node.mjs
isPrivateAddress(ip) -> boolean      // empty/unparseable, loopback, RFC 1918, CGNAT, link-local, ULA, multicast
isLoopbackHost(host) -> boolean      // localhost, *.localhost, 127.0.0.1, [::1] (port allowed)
isSharedCacheHeader(name) -> boolean // CDN-Cache-Control, <vendor>-CDN-Cache-Control, Surrogate-Control, X-Accel-Expires
GatePassKey                          // type: the key derivePassKey() returns (a CryptoKey, declared without the DOM lib)
```

Node only (`gate-node.mjs`):

```ts
createNodeGate(gate, { env?, trustCloudflare?, protocol?, localDev?, ctx? })
   -> (req, res, next?) => Promise<boolean>     // true: the gate answered; false: passed, next() called.
                                                // Always settles, also when the client hangs up first.
                                                // Exempted (no pass): req.gateExemption = the exemption's name.
toWebRequest(req, { trustCloudflare?, protocol?, body? }) -> Request   // throws on a bad Host or an unsafe path
writeWebResponse(res, response, method?) -> Promise<void>              // resolves early if the client is gone
privatizeNodeResponse(res)                      // the Node twin of decorate(), whichever way writeHead is called
clientIpOf(req, { trustCloudflare? }) -> string // trustCloudflare: false | true | ['127.0.0.1', '::1', 'unix', ...]
MSG_PRIVATE_CLIENT                              // the 503 text for a proxy/private client address (4(c))
```

What the gate answers, exactly:

| Situation | Answer |
|---|---|
| `GATE_MODE="off"` | `null` for everything (break-glass); `gate_off` event |
| keys missing | `503 text/plain` `Not available: CAPTCHA is not configured (TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY).` |
| Cloudflare test keys, not local dev | `503` (they always pass) |
| `GATE_SECRET` set but under 32 characters | `503` |
| any internal error in the gate | `503` `Not available: the CAPTCHA gate failed.` (never a pass) |
| `POST /__gate/verify` | `303` to the return path with the pass cookie, or the challenge page in its error state (`403`; `503` when siteverify is unreachable) |
| `GET/HEAD /__gate/verify` | `303` to `/` |
| exempted machine client | `null`; `exempted` event |
| valid pass | `null` |
| no pass, `GET`/`HEAD` navigation that accepts HTML | `403` challenge page (`HEAD`: headers only) |
| no pass, anything else (assets, API, `OPTIONS`, WebSocket, fetch) | `403` `{"ok":false,"code":"captcha_required","error":"Complete the CAPTCHA at https://<host>/ first."}` with no CORS headers |
| Node only: raw path with a dot-segment (`..`, `.`, `%2e%2e`), a backslash or a non-printable byte; bad `Host` | `400 Bad Request`, before any hook (WHATWG URL would resolve the path one way and Express route it another) |
| Node only: client address loopback, private or missing (a proxy in front, a Unix socket) and no `trustCloudflare` naming that proxy | `503` `MSG_PRIVATE_CLIENT`, see 4(c) |
| Node only: test keys without `localDev`, through a proxy, with an IP-literal `Host`, or with `NODE_ENV=production` | `503` (as on Workers) |

Every gate response carries `Cache-Control: no-store, private`,
`X-Robots-Tag: noindex, nofollow`, `X-Content-Type-Options: nosniff` and
`Referrer-Policy: same-origin`. The challenge page also carries its own strict
CSP (nonce'd inline style and script, Turnstile only) and `X-Frame-Options: DENY`.

The pass: cookie `__Host-gate_pass` (`HttpOnly; Secure; SameSite=Lax; Path=/`,
no Domain), value `v1.<payload>.<HMAC-SHA256>`, payload
`{v, host, ip, uah, iat, exp}`. It is bound to the exact host (with port), the
exact client IP (`CF-Connecting-IP`, canonicalised so every IPv6 spelling
matches) and a hash of the User-Agent. The MAC is checked first, in constant
time. The key is `GATE_SECRET` if set, else derived from the Turnstile secret;
rotating either ends every pass. Lifetime: setting `captcha_pass_hours`,
default 12, clamped to 1-168, read when the pass is issued (lowering it affects
new passes; rotate `GATE_SECRET` to end old ones at once).

---

## 3. Where the gate goes: the order in every `fetch()`

PORTAL-STANDARD §10 (as of 2026-11-12):

1. **Deny list.** A denied IP gets its denial, as today.
2. **The CAPTCHA wall.** `captcha.handle()`.
3. **Scanner, decoy and injection detection** and the rest of the §7 auto-blacklist.
4. **Everything else**: country rule, allowlist, sessions, routes, static files.

The wall sits before detection on purpose: unsolved bot traffic is stopped
silently. A visitor without a pass causes **no security alert email, no audit
entry and no deny-list entry**, only counters (§5). So a scanner hitting
`/.env` without a pass gets the 403 JSON and nothing else; the same request
with a pass still trips detection and the auto-blacklist.

Some checks may stay ahead of step 1 because they return no site content,
for example KidMonitor's 421 "wrong host" guard.

Two rules for every runtime:

- **Return the gate's response untouched.** Do not pass it through a wrapper
  that sets `Content-Security-Policy` or other page headers (KidMonitor's
  `mergeInto(buildSecurityHeaders())`, Lakewood's `withAdminHeaders()`): their
  CSP would replace the challenge page's nonce CSP and the widget would never
  load. Call the gate in `fetch()` itself, before those wrappers.
- **Everything served after the gate goes through `decorate()`**, so no shared
  cache can keep a page for someone without a pass. The simple way is to move
  the existing body of `fetch()` into `route()` and wrap it once.

```js
export default {
  async fetch(request, env, ctx) {
    const denied = await denyListResponse(request, env, ctx);   // (1) the site's own
    if (denied) return denied;
    const blocked = await captcha.handle(request, env, ctx);    // (2)
    if (blocked) return blocked;
    return captcha.decorate(await route(request, env, ctx));    // (3) detection, then (4)
  },
};
```

Where today's code runs detection before the deny list or inside one big
`route()`, split it: pull the deny-list lookup out to run first, then the gate,
then the existing detection.

---

## 4. Per runtime

### (a) Worker with an assets binding

`wrangler.jsonc`:

```jsonc
"assets": {
  "directory": "public",
  "binding": "ASSETS",
  // Every path, every method, runs the Worker first, so no file is ever
  // served around the CAPTCHA wall (PORTAL-STANDARD §10).
  "run_worker_first": true
}
```

Replace any path array (`["/admin", "/api/*", ...]`) with `true`. Keep
`not_found_handling` as it is; it still applies to `env.ASSETS.fetch()`.

`worker.js`: the pattern in §3, with static files served by the Worker after
the gate:

```js
import { createGate } from './gate-kit/gate.mjs';
const captcha = createGate({ siteName: 'Lakewood PD Accountability Record', getSetting, exempt, onStats, onEvent });

async function route(request, env, ctx) {
  // ... detection, then the existing routes ...
  return serveAsset(env, request);   // last: static files
}
```

With `run_worker_first: true`, `env.ASSETS.fetch(request)` has been seen not
to resolve `/` to `/index.html` (and `/x` to `/x.html`) in production.
chaimyuirmafia.com already has a `serveAsset()` that retries those; use it,
or copy it, for every static path.

**Assets-only sites** (momsanytime.com, tevaenviro.com: no `main` today) get a
Worker. Keep each site's existing `directory` and `not_found_handling`; only
`main`, `binding`, `run_worker_first` and the site key are new:

```jsonc
// wrangler.jsonc
"main": "worker.js",
"assets": {
  "directory": "<keep the existing one>",   // momsanytime.com: "./dist/public"; tevaenviro.com: "."
  "binding": "ASSETS",
  "run_worker_first": true
  // , "not_found_handling": <keep the existing one>   (momsanytime.com: "single-page-application")
},
"vars": { "TURNSTILE_SITE_KEY": "0x4AAAA..." }
```

- **momsanytime.com** keeps `"./dist/public"` (the built SPA from `pnpm build`)
  and its `"single-page-application"` fallback, which still applies through
  `env.ASSETS.fetch()` with `run_worker_first: true` (checked in `wrangler dev`).
  Its assets directory is a build output, not the repo, so it needs no
  `.assetsignore` change. Never point it at `"."`: the repo root has no
  `index.html`, only source.
- **tevaenviro.com** publishes the repo root (`"."`), so its existing
  `.assetsignore` must also list `worker.js` and `gate-kit/` (it already covers
  `wrangler.jsonc`, `*.md`, `.git`, `employees/` and the tooling files).
  Without them, `worker.js` and `gate-kit/*` are uploaded as static files.

```js
// worker.js
import { createGate } from './gate-kit/gate.mjs';
const captcha = createGate({ siteName: 'TEVA Environmental Consultants' });
export default {
  async fetch(request, env, ctx) {
    const blocked = await captcha.handle(request, env, ctx);
    if (blocked) return blocked;
    return captcha.decorate(await env.ASSETS.fetch(request));
  },
};
```

Static sites with no settings store use the default 12-hour pass and need no
hooks.

### (b) Worker without assets

Same as (a) without the `assets` block: the gate is the first call in
`fetch()` after the deny list, and every response from `route()` goes
through `decorate()`.

### (c) Node http server mirroring a Worker (chaimyuirmafia.com `server.js`)

`server.js` is CommonJS and the kit is ESM, so load it with `import()`. Put the
options both runtimes share in one ESM module (say `src/captcha-options.mjs`
exporting `captchaOptions({ readSetting, countEvents })`), imported statically
by `worker.js` and dynamically by `server.js`, so the two can't drift.

```js
// server.js: right after `const app = express()` and the deny list,
// BEFORE helmet, the routers and express.static.
const captchaReady = (async () => {
  const { createGate } = await import('./gate-kit/gate.mjs');
  const { createNodeGate } = await import('./gate-kit/gate-node.mjs');
  const { captchaOptions } = await import('./src/captcha-options.mjs');
  const gate = createGate(captchaOptions({ readSetting: nodeReadSetting, countEvents: nodeCountEvents }));
  return createNodeGate(gate, {
    env: process.env,
    trustCloudflare: trustCloudflareFromEnv(),
    localDev: process.env.GATE_LOCAL_DEV === '1',   // a developer's machine only, never production
  });
})();
app.use((req, res, next) => {
  captchaReady.then((mw) => mw(req, res, next)).catch(() => {
    // Fail closed: never serve the site because the gate didn't load.
    res.status(503).type('text/plain').set('Cache-Control', 'no-store, private').end('Not available: the CAPTCHA gate failed to load.');
  });
});

function trustCloudflareFromEnv() {
  const v = (process.env.GATE_TRUST_CLOUDFLARE || '').trim();
  if (!v) return false;                       // socket address only (default)
  if (v === '1' || v === 'true') return true; // every request really comes through Cloudflare
  return v.split(',').map((s) => s.trim());   // trust CF-Connecting-IP only from these peers: "127.0.0.1,::1", "unix", "172.17.0.1"
}
```

#### Behind Caddy or nginx (the documented self-host)

The self-host README puts Caddy or nginx in front for TLS (which the `Secure`,
`__Host-` pass needs anyway): `reverse_proxy localhost:3000`. Then the socket
peer of **every** request is the proxy: `127.0.0.1`/`::1`, a Docker bridge such
as `172.17.0.1` when the app runs in a container, or no address at all over a
Unix socket. A pass bound to that address would let one solve unlock every
visitor, so the adapter refuses to: when the client address it ends up with is
loopback, private, CGNAT, link-local or missing, every request gets
`503 Not available: CAPTCHA is misconfigured (the server sees a proxy's or a
private address, ...)`. Two settings fix it:

1. **The proxy overwrites `CF-Connecting-IP`** with the address of whoever
   connected to it. Both proxies pass the client's own `CF-Connecting-IP`
   through by default, which lets any visitor pick the address their pass is
   bound to (checked: stock Caddy 2.6 forwards it unchanged).

   ```caddyfile
   chaimyuirmafia.com {
   	reverse_proxy localhost:3000 {
   		header_up CF-Connecting-IP {remote_host}
   	}
   }
   ```

   ```nginx
   location / {
       proxy_pass http://127.0.0.1:3000;
       proxy_set_header Host $host;                    # the real host: the pass and siteverify's hostname check use it
       proxy_set_header CF-Connecting-IP $remote_addr; # overwrite; never pass the client's on
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       client_max_body_size 60m;                       # ticket attachments (README)
   }
   ```

   nginx's default `Host` is the upstream (`127.0.0.1:3000`), so
   `proxy_set_header Host $host;` is required: without it no pass can be
   issued (siteverify's hostname is the real one).

2. **The app trusts that header from the proxy only:**
   `GATE_TRUST_CLOUDFLARE=127.0.0.1,::1` (the proxy's address as the app sees
   it; `172.17.0.1` or the like for a container; `unix` when nginx connects over
   a Unix socket, `proxy_pass http://unix:/run/cymafia.sock;`).

If **Cloudflare is also in front** of Caddy/nginx (orange cloud), the proxy's
peer is a Cloudflare edge, and `{remote_host}` / `$remote_addr` would be
Cloudflare's address (many visitors share one, and one visitor moves between
several). Let the proxy take the visitor's address from Cloudflare's header
only for connections from Cloudflare's ranges (https://www.cloudflare.com/ips/),
then overwrite as above:

- nginx: `set_real_ip_from <each Cloudflare range>;` and
  `real_ip_header CF-Connecting-IP;` in the server block (this rewrites
  `$remote_addr`), keeping `proxy_set_header CF-Connecting-IP $remote_addr;`.
- Caddy 2.7+:

  ```caddyfile
  {
  	servers {
  		trusted_proxies static 173.245.48.0/20 103.21.244.0/22 # ...every Cloudflare range
  		client_ip_headers CF-Connecting-IP
  	}
  }
  chaimyuirmafia.com {
  	reverse_proxy localhost:3000 {
  		header_up CF-Connecting-IP {client_ip}
  	}
  }
  ```

The nginx configurations above (direct; Cloudflare-in-front with realip; Unix
socket upstream) and the direct Caddy one were run against the kit: a spoofed
`CF-Connecting-IP` never reaches the app, and a pass from one visitor gets a
403 from any other address. The Caddy 2.7 Cloudflare-in-front lines are from
Caddy's documentation and were not run here.

#### Other Node notes

- The client IP is the socket's. `CF-Connecting-IP` is believed only from the
  peers `GATE_TRUST_CLOUDFLARE` names (or from everyone with `true`, which is
  only safe when a firewall admits nothing but Cloudflare). `X-Forwarded-For`
  (and Express's `TRUST_PROXY` / `req.ip`) is never used by the gate.
- **Local development** (`node server.js` on a laptop): set `GATE_LOCAL_DEV=1`
  and open **`http://localhost:<port>`** (not `127.0.0.1`). Only then does the
  adapter accept Cloudflare's test keys and a loopback client address, and only
  for a request from a loopback socket whose `Host` is `localhost` or
  `*.localhost` (an IP literal never counts) with no proxy headers
  (`X-Forwarded-For`, `Forwarded`, `Via`, `X-Real-IP`, `CF-Connecting-IP`, ...).
  Why the IP-literal rule: a stock nginx `proxy_pass http://127.0.0.1:3000;`
  rewrites `Host` to `127.0.0.1:3000` and adds no proxy headers, so with
  `GATE_LOCAL_DEV=1` on a server every visitor would otherwise look local. The
  adapter also ignores `localDev` when `NODE_ENV=production` and emits a
  `GATE_LOCAL_DEV` process warning whenever it is set. Never set it in
  production: these guards narrow the mistake, they don't make it safe (a
  proxy that forwards `Host: localhost` unchanged and adds no headers would
  still look local).
- **Raw paths:** a request whose raw path has a dot-segment (`/a/../b`,
  `%2e%2e`), a backslash or a non-printable byte gets a `400` before the gate
  or any hook runs. The exempt hook sees WHATWG's resolved path while Express
  routes on the raw one, so `/admin/../client/x` would otherwise be exempted as
  `/client/x` and served by the admin router. Browsers never send these.
- `createNodeGate` reads a request body only for `POST /__gate/verify`, so
  `express.json()`, multer and the rest still get an untouched stream.
- On a pass it patches `res.writeHead` so whatever the app sends, including
  `res.writeHead(status, [name, value, ...])` arrays, goes out with
  `Vary: Cookie`, a private `Cache-Control` (express.static's
  `public, max-age=0` becomes `private, max-age=0`) and no `CDN-Cache-Control`,
  `Cloudflare-CDN-Cache-Control`, `Surrogate-Control` or `X-Accel-Expires`
  (those outrank `Cache-Control` at a CDN or nginx cache in front of the origin).
- The middleware's promise always settles: when a client hangs up before the
  gate answers (a slow siteverify, a slow hook), the answer is dropped and the
  promise resolves, so aborted requests hold no memory.
- The pass cookie is `Secure` with the `__Host-` prefix, so browsers keep it
  only over HTTPS (or `http://localhost` in Chrome/Firefox). The self-host
  must be behind TLS. When `trustCloudflare` is set, URLs are built as `https`.
- Node 18: `gate-node.mjs` installs `globalThis.crypto` from `node:crypto`
  when it is missing. Node 20+ needs nothing. The suite passes on Node 18, 20,
  22 and 24.

### (d) TypeScript Worker (KidMonitor: `src/*.ts`, strict)

```ts
// src/index.ts
import { createGate } from './vendor/gate-kit/gate.mjs';   // types come from gate.d.mts
import type { Env } from './lib/env.ts';

const captcha = createGate<Env>({
  siteName: 'KidMonitor',
  siteDomain: 'kidmonitor.chaimyuirmafia.com',
  getSetting: (key, env) => readSetting(env, key),
  exempt: (request, url, env) => kidmonitorClientExemption(request, url, env),
  onStats: (rows, env) => recordGateStats(env, rows),
});

export default {
  async fetch(request: Request, env: Env, executionCtx: ExecutionContext): Promise<Response> {
    // isAllowedHost() 421 stays first, then ensureSchema() and the deny list
    const blocked = await captcha.handle(request, env, executionCtx);
    if (blocked) return blocked;              // NOT through mergeInto(): it would replace the page's CSP
    // ... existing body: detection, dispatch(), mergeInto(...) ...
    return captcha.decorate(response);
  },
};
```

- Add to `src/lib/env.ts`: `TURNSTILE_SECRET_KEY?: string; GATE_SECRET?: string; GATE_MODE?: string;`
  (`TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET` are already there; the alias is accepted).
  `createGate<Env>` requires `Env` to declare at least one gate variable.
- The declarations compile under KidMonitor's options (`strict`,
  `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`) with
  `@cloudflare/workers-types`; `test/types/` is the fixture.
- The portal's own sign-up/login Turnstile stays as it is. If its widget's
  hostnames include the portal host, the same site key can serve the wall
  (the wall uses action `gate`).
- Existing route tests will now get 403s. In `test/_harness.mjs`, set the
  keys in the test env, stub `fetch` for `SITEVERIFY_URL` to answer
  `{ success: true, hostname: <host>, action: 'gate' }`, `POST /__gate/verify`
  once per client IP, and send the cookie on every request. Don't set
  `GATE_MODE=off` in tests except in one test that proves the switch works.

### (e) Next.js on OpenNext (onlyjewishgirls.com)

Static files and `_next/static` are served by the assets layer before Next's
middleware ever runs, so the gate cannot live in middleware. Wrap the OpenNext
worker instead:

```ts
// worker.ts (repo root)
// @ts-ignore `.open-next/worker.js` is generated by `opennextjs-cloudflare build`
import { default as openNext } from './.open-next/worker.js';
import { createGate } from './gate-kit/gate.mjs';

const captcha = createGate<CloudflareEnv>({ siteName: 'Only Jewish Girls', /* hooks */ });

export default {
  async fetch(request, env, ctx) {
    // (1) deny list, if the app has one that can run here; otherwise it stays
    //     in the app and runs after the wall, which is still in front of everything
    const blocked = await captcha.handle(request, env, ctx);
    if (blocked) return blocked;
    return captcha.decorate(await openNext.fetch(request, env, ctx));
  },
} satisfies ExportedHandler<CloudflareEnv>;

// Only if wrangler.jsonc binds them:
// export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from './.open-next/worker.js';
```

`wrangler.jsonc`:

```jsonc
"main": "worker.ts",
"assets": {
  "directory": ".open-next/assets",
  "binding": "ASSETS",
  "run_worker_first": true
},
"vars": { "TURNSTILE_SITE_KEY": "0x4AAAA..." }
```

- `open-next.config.ts` needs no change. `defineCloudflareConfig()` already
  installs OpenNext's asset resolver, which serves `.open-next/assets`
  (`_next/static`, `public/` files) from inside its own routing layer whenever
  `run_worker_first` is true (checked in `@opennextjs/cloudflare` 1.20.7,
  `dist/api/overrides/asset-resolver`). So those files come out of
  `openNext.fetch()`, after the gate. Don't set `dangerousDisableConfigValidation`.
- The build order is unchanged: `opennextjs-cloudflare build`, then
  `wrangler deploy`. Wrangler bundles `worker.ts` together with the generated
  `.open-next/worker.js`.
- `next dev` does not run the Worker, so the wall is absent there. Use the
  repo's `npm run preview` (`wrangler dev`) to see it.
- Regenerate `cloudflare-env.d.ts` (`npm run cf-typegen`) after adding
  `TURNSTILE_SITE_KEY` to `vars` and `TURNSTILE_SECRET_KEY` to `.dev.vars`.

---

## 5. Wiring the hooks into a site

### getSetting: `captcha_pass_hours`

```js
getSetting: (key, env) => readSetting(env, key),   // the site's settings store
```

Called once per successful verify, never per request, so a D1 read is fine.
Return a number or numeric string. Anything else, a throw, or a missing value
means 12; out-of-range values are clamped to 1-168.

### exempt: machine clients only

Only non-browser clients that cannot solve a CAPTCHA and already authenticate
with their own credentials: the KidMonitor Windows fleet, the Sousveil Android
app's API, the Shnayim native app's API. Each has a console setting
`captcha_exempt_<client>`, default on. Nothing else is exempt: not allowlisted
IPs, not admins, not webhooks, not health checks.

Match **exact routes only**: the same method + path patterns the client
handler itself routes (copy them from the site's router, anchored `^...$`).
Never a bare prefix (`/client/`), suffix (`.msi`) or glob: those let any path
with that shape past the wall, and an unmatched one then falls into the rest
of the site (decoy detection and its alert email, the 404 page, an assets
SPA fallback that serves `index.html`).

```js
// Illustrative: copy the real patterns from the site's own client router.
const MACHINE_CLIENTS = [
  {
    name: 'kidmonitor',
    setting: 'captcha_exempt_kidmonitor',
    routes: [
      ['POST', /^\/client\/heartbeat$/],
      ['POST', /^\/client\/enroll$/],
      ['GET',  /^\/manifest\.json$/],
      ['GET',  /^\/packages\/[A-Za-z0-9._-]{1,128}\.(msi|zip)$/],
    ],
  },
];

exempt: async (request, url, env) => {
  for (const c of MACHINE_CLIENTS) {
    const hit = c.routes.some(([m, re]) => (request.method === m || (m === 'GET' && request.method === 'HEAD')) && re.test(url.pathname));
    if (hit && (await settingIsOn(env, c.setting, true))) return c.name;
  }
  return null;
},
```

**An exempted request is answered by the machine-client handler and nothing
else.** Right after the gate:

```js
const blocked = await captcha.handle(request, env, ctx);
if (blocked) return blocked;
if (captcha.exemptionOf(request)) {
  // No pass: only the client API may answer. Whatever it doesn't serve is a
  // bare 404: no scanner/decoy detection, no alert or audit, no 404 page,
  // no env.ASSETS (its not_found_handling would serve index.html).
  const r = await machineClientRoute(request, env, ctx);
  return captcha.decorate(r || new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store, private' } }));
}
return captcha.decorate(await route(request, env, ctx));
```

On Node the adapter sets `req.gateExemption` instead; check it first thing in
the app and route to the client handler only. The client's own failures
(bad device token, wrong body) stay quiet too (§10: traffic without a pass
never emails, audits or feeds the deny list): answer them with the client
API's error and count them, nothing more.

- The hook runs on every request that has no pass, so cache the setting in
  the isolate (30-60 s) rather than reading D1 each time.
- An exemption is not authentication. The client's own credential checks
  still run, and a request that matches the route but fails them gets the
  client API's own error (quietly, see above).
- `/__gate/verify` is never handed to the hook.

### onStats / onEvent: counters only

Quiet by design (§10): challenges served, solved and failed are counted and
shown in the console. They are never emailed, never audited, and never feed
the auto-blacklist. Don't call the site's alert, audit or blacklist code from
these hooks.

Use `onStats` for the counts. It receives rows already batched per UTC hour,
at most once per `statsFlushSeconds` (default 60) per isolate, so a bot flood
costs one write per isolate per minute instead of one per request. A flush
that throws is retried with the next one.

```sql
-- additive migration (chaimyuirmafia.com: SCHEMA_MIGRATIONS in worker.js + the loop in src/db.js)
CREATE TABLE IF NOT EXISTS gate_stats (
  hour  TEXT NOT NULL,              -- UTC, '2026-11-12T22'
  event TEXT NOT NULL,              -- challenge_served | blocked | verify_ok | verify_failed | exempted | passed | misconfigured | gate_off
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, event)
);
```

```js
onStats: (rows, env) => env.DB.batch(rows.map((r) => env.DB.prepare(
  'INSERT INTO gate_stats (hour, event, count) VALUES (?, ?, ?) ' +
  'ON CONFLICT(hour, event) DO UPDATE SET count = count + excluded.count'
).bind(r.hour, r.event, r.count))),
```

Counts are approximate: an isolate that is evicted between flushes loses up to
a minute of counts. On Node there is one process, so call
`gate.flushStats(env)` on shutdown if exact counts matter.

`gate.stats().since` is when this isolate or process handled its first request.
The clock is read then, not in `createGate()`: at module scope workerd's clock
reads 0, which used to report `1970-01-01`. The first `onStats` flush comes one
full `statsFlushSeconds` after that first request, on Workers and Node alike.

`onEvent` fires per event with
`detail = { ip, host, path, method, country, ua, hour, reason?, exemption?, codes?, hours?, exp? }`:

| type | when | `reason` |
|---|---|---|
| `challenge_served` | challenge page shown | `no_pass`, `expired`, `ip_changed`, `host_mismatch`, `ua_changed`, `bad_signature`, `malformed`, `not_yet_valid` |
| `blocked` | 403 JSON for a non-navigation | same as above |
| `verify_ok` | pass issued | (`hours`, `exp`) |
| `verify_failed` | verify refused | `missing_token`, `malformed_token`, `test_token`, `cross_origin`, `bad_request`, `rejected` (+`codes`), `hostname_mismatch`, `action_mismatch`, `siteverify_http`, `network_error` |
| `exempted` | machine client let through | (`exemption`) |
| `misconfigured` | 503 | `not_configured`, `test_keys`, `weak_gate_secret` |
| `gate_off` | `GATE_MODE="off"` let a request through | |

`misconfigured` and `gate_off` reach `onEvent` at most once per 10 minutes
per isolate (they are still counted every time). The one email the wall may
cause is the daily `GATE_MODE="off"` alert, sent from `onEvent('gate_off')`
through the site's normal alert path with a once-per-day dedupe (for example a
`gate_off_alerted_on` date in settings).

### Console: posture item, settings group, stats

- **Posture item:** `gateStatus(env)` returns `state`, `ok`, `label` and
  `detail`. Show it green when `ok`, red otherwise (`off`, `not_configured`,
  `misconfigured`). Add it to the bootstrap/overview posture list.
- **Settings group "CAPTCHA wall":**
  - `captcha_pass_hours`: number 1-168, default 12. "How long one solved
    CAPTCHA lasts for one browser on one IP address."
  - `captcha_exempt_<client>` per machine client the site has: toggle,
    default on, labelled "Turning this off breaks <client>."
  - Changes are audited and alert like any other setting change (§6).
- **Stats** on the overview or Security page, from `gate_stats`: challenges
  served, solved (`verify_ok`), failed (`verify_failed`), blocked non-page
  requests, per hour for the last day and per day for the last 30.

---

## 6. Variables per site

| Name | Kind | Notes |
|---|---|---|
| `TURNSTILE_SITE_KEY` | `vars` (public) | per site, in wrangler config |
| `TURNSTILE_SECRET_KEY` | secret | `wrangler secret put TURNSTILE_SECRET_KEY`; `TURNSTILE_SECRET` is accepted where a site already uses it |
| `GATE_SECRET` | secret, optional | 32+ characters (`openssl rand -base64 32`); signs passes instead of the Turnstile-derived key; rotate it to sign everyone out |
| `GATE_MODE` | plain var, normally absent | `"off"` is the break-glass switch, nothing else turns the wall off |
| `GATE_TRUST_CLOUDFLARE` | Node only; required behind a reverse proxy | the proxy's address(es) as the app sees them, comma-separated (`127.0.0.1,::1`, `172.17.0.1`, `unix`), or `true` when only Cloudflare can reach the server; see 4(c) |
| `GATE_LOCAL_DEV` | Node only, developer machines only | `1` lets test keys and a loopback client address through for a browser on that machine (4(c)); never set in production |

Sites with `keep_vars` off: wrangler v4 replaces dashboard vars with the file's
on deploy, so a break-glass `GATE_MODE` set in the dashboard is cleared by the
next deploy. That's usually what you want; know it.

Local development: put Cloudflare's always-pass test keys in `.dev.vars`:

```
TURNSTILE_SITE_KEY=1x00000000000000000000AA
TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA
```

The gate accepts test keys and the dummy token only on a loopback request:
host `localhost` / `*.localhost` / `127.0.0.1` / `[::1]` **and** a loopback
client address. Anywhere else, test keys are a 503. On Node the adapter also
requires `GATE_LOCAL_DEV=1` and no proxy headers (4(c)). (`3x00000000000000000000FF`
always shows the checkbox, `2x00000000000000000000AB` always fails; both are
handy for looking at the page.)

**Sites with `routes` in their wrangler config: run `wrangler dev` with
`--local-upstream`.** For a config with `routes` (custom domains or zone
routes), `wrangler dev` rewrites `request.url` and `Host` to the first route's
host, so the gate sees `momsanytime.com` rather than `localhost` and answers
every request with the test-keys 503. Real keys fail too: siteverify reports
`localhost` (hostname mismatch) and the browser's `Origin` is
`http://localhost:8787` (cross-origin). Keep the URL on localhost:

```sh
npx wrangler dev --port 8787 --local-upstream localhost
```

(no port after `localhost`)

and put that in the repo's dev/preview script (KidMonitor's `"dev"`, the WAMV
portal's `"dev"`). This affects momsanytime.com (custom domains;
run it after `pnpm build`), website/ shnayimmikrah.org (custom domains),
KidMonitor (zone route `kidmonitor.chaimyuirmafia.com/*`) and the WAMV portal
(custom domain). Checked with wrangler 3.114 (KidMonitor's) and 4.110 / 4.152: plain
`wrangler dev` gives `url: http://momsanytime.example/...` and a 503. With
`--local-upstream localhost` (no port) the URL, `Host` and `Origin` are all
`localhost`, the challenge appears, and verify passes in a real browser on
both majors. Don't add the port: on wrangler 3.114
`--local-upstream localhost:<port>` rewrites the browser's `Origin` to
`http://localhost` (port dropped) while the URL keeps the port, so every
verify fails as `cross_origin` (a curl POST without `Origin` hides this). The kit deliberately does not trust a loopback client address
alone, because on a Node self-host behind a local proxy every visitor arrives
from 127.0.0.1.

---

## 7. Owner setup checklist (per site, before merging: the wall fails closed)

1. Cloudflare dashboard, Turnstile, **Add widget**. Mode: **Managed**. Name it
   after the site.
2. Hostnames: every hostname the Worker answers on: apex, `www`, each
   subdomain, and `<worker>.<account-subdomain>.workers.dev` if that URL is
   used. For preview deployments (`<version>-<worker>.<account-subdomain>.workers.dev`),
   add `<account-subdomain>.workers.dev`; Turnstile is understood to accept a
   listed hostname's subdomains, but check the widget's hostname help text, and
   if it doesn't, use stable preview aliases and list those. (The gate's own
   check is exact: siteverify's `hostname` must equal the request's host.)
3. Put the widget's **site key** in `TURNSTILE_SITE_KEY` (wrangler `vars`) and
   the **secret** with `wrangler secret put TURNSTILE_SECRET_KEY` (or in the
   dashboard as a secret). Node self-host: both in the server's environment.
4. Optional: `GATE_SECRET` (32+ characters) as a secret.
5. Deploy a preview, open it in a private window: you should see the
   challenge, pass it, and land on the page you asked for. `curl -i` of any
   path without the cookie should be a 403.
6. Break-glass: set `GATE_MODE` = `off` as a plain variable in the dashboard.
   The console posture turns red and the daily alert starts. Delete it to
   turn the wall back on.

---

## 8. What the wall changes for everyone (tell the owner)

These follow directly from "nothing loads without a CAPTCHA":

- **Search engines and link previews** (Google, Slack, iMessage, WhatsApp,
  Facebook) only ever see the 403 challenge with `noindex`. Sites will drop out
  of search results and shared links will have no preview.
- **Images in emails** (alerts, invitations, tickets) that point at a gated
  host won't load in the recipient's mail client. Inline them or host them
  elsewhere.
- **Webhooks, uptime monitors, payment or mail-provider callbacks** to a gated
  host get 403. §10 allows no exemption for them; any that exist need an owner
  decision.
- **Scripted downloads**, for example chaimyuirmafia.com's
  `irm chaimyuirmafia.com/s/<slug>` PowerShell shortlinks, stop working:
  PowerShell can't solve a CAPTCHA. This needs an owner decision too.
- **Cross-host calls**: the pass is host-only (`__Host-`), so a page on one
  host calling an API on another needs a pass on that other host too.
- **IP binding**: a phone moving between Wi-Fi and mobile data, a VPN
  reconnect, or IPv6 privacy addresses rotating all mean a new challenge
  before the 12 hours are up.
- **The chaimyuirmafia.com decoy 404** (its CLAUDE.md: "must not change how it
  looks to a stranger"): a stranger now sees the challenge page first, on
  every path. After passing, the decoy behaves exactly as before. §10 is a
  behaviour rule, and the standard says behaviour follows the standard.
- **Safari on `http://localhost`** does not keep `Secure` cookies, so local
  development there loops on the challenge. Use Chrome or Firefox locally.

---

## 9. Testing and screenshots in a repo

- `node --test gate-kit/test/gate.test.mjs`: the kit's own suite (150 tests;
  Node 18, 20, 22 and 24). Add it to the repo's `npm test`. Set
  `TSC=node_modules/typescript/bin/tsc` to include the strict TypeScript
  compiles: a Worker with the DOM lib (`test/types/tsconfig.json`) and a
  Node-only server with `types: ["node"]`, no DOM lib and `skipLibCheck: false`
  (`test/types/tsconfig.node.json`, which also needs `@types/node`
  installed). Each is skipped when its tools aren't found.
- Site tests: get a pass once (stub siteverify, `POST /__gate/verify`) and
  send it on every request; add one test per request class proving the 403
  without it.
- Look at it: `node gate-kit/demo/serve.mjs` (http://localhost:8788/; add
  `--offline` without network), or `node gate-kit/demo/screenshots.mjs` for
  360, 375, 390, 414, 768, 1024, 1280 and 1440 px in light and dark, the error
  states (widget error, failed verify, Turnstile's script blocked) and
  `<noscript>`. It fails if any page scrolls sideways, the card leaves the
  viewport, or the widget gets the compact (narrow) Turnstile size at 350 px or
  wider.
  The UI pass each repo's CLAUDE.md requires now starts at the challenge page:
  layout checkers must get a pass first or they will only ever see the challenge.
  On a Worker with `routes`, run them against
  `wrangler dev --local-upstream localhost` (§6, no port), or they will only
  ever see the 503.

To update the kit later, re-copy the folder over the old one and check
`GATE_KIT_VERSION`.

---

## 10. Changes

### 1.2.0 (2026-11-13)

What a site must do when it re-copies the kit:

- **Machine-client exemptions:** match exact client routes (method + anchored
  path), never a prefix or suffix, and answer an exempted request from the
  client handler alone: `gate.exemptionOf(request)` (Workers) or
  `req.gateExemption` (Node), with a bare 404 for anything that handler
  doesn't serve (§5).
- **Workers with `routes`:** `wrangler dev --local-upstream localhost`, with
  no port (§6). The 1.1.0 form with a port breaks verify on wrangler 3.
- **Node local development:** open `http://localhost:<port>`, not
  `127.0.0.1`.

Fixed:

- An exempt hook that matched a prefix or suffix let unpassed bot traffic
  (`/.env.msi`, `/client/wp-admin`) reach decoy detection, alert emails and
  the assets SPA fallback. The §5 example now matches exact routes, and the
  kit marks exempted requests so the site can short-circuit them.
- Node: `GATE_LOCAL_DEV=1` behind a stock nginx (`Host: 127.0.0.1:3000`, no
  proxy headers) made every visitor "local". Only `localhost` / `*.localhost`
  count now, `NODE_ENV=production` disables `localDev`, and setting it emits a
  `GATE_LOCAL_DEV` process warning.
- Node: the `MSG_PRIVATE_CLIENT` 503 now says to make the proxy overwrite
  `CF-Connecting-IP` before trusting it, so Cloudflare in front of a stock
  proxy isn't "fixed" by trusting a header any direct-to-origin client can set.

Added: `gate.exemptionOf(request)`; `req.gateExemption` on Node.

### 1.1.0 (2026-11-12)

What a site must do when it re-copies the kit:

- **Node self-host (chaimyuirmafia.com `server.js`) behind Caddy/nginx:** make
  the proxy overwrite `CF-Connecting-IP` and set `GATE_TRUST_CLOUDFLARE` to the
  proxy's address (4(c)). Until then every request gets a 503: before this
  version, one solved CAPTCHA unlocked every visitor behind the proxy.
- **Node local development:** set `GATE_LOCAL_DEV=1` (pass `localDev` to
  `createNodeGate`). Test keys and loopback addresses are refused without it.
- **Workers with `routes`:** run `wrangler dev --local-upstream localhost:<port>` (§6). Superseded in 1.2.0: no port.
- **momsanytime.com / tevaenviro.com:** the assets-only snippet keeps each
  site's own `directory` (4(a)).

Fixed:

- Node: a loopback, private or missing client address (a proxy in front, a
  container bridge, a Unix socket) is a 503 unless a trusted proxy supplies the
  visitor's address; `"unix"` can be trusted. Test keys need `localDev` and a
  request with no proxy headers, so a forwarded `Host: localhost` is no longer
  "local development".
- Node: raw request paths with dot-segments, backslashes or non-printable
  bytes are a 400, so the exempt hook and the app can't see different paths.
- Node: `res.writeHead(status, [array])` no longer drops the private
  `Cache-Control`; `decorate()` and the Node adapter remove `CDN-Cache-Control`,
  `<vendor>-CDN-Cache-Control`, `Surrogate-Control` and `X-Accel-Expires` on a pass.
- Node: the middleware's promise settles when a client hangs up before the
  answer (it used to wait forever and hold the request's memory).
- `stats().since` is the first request, not 1970 on Workers.
- Types: no DOM-only `CryptoKey` (now `GatePassKey`), so Node-only projects
  with `skipLibCheck: false` compile; the TypeScript fixture no longer trips
  KidMonitor's grep gates.
- Challenge page: no empty widget-sized gap when Turnstile's script is blocked
  or slow (and a late script recovers by itself); 361-380 px phones (375 px
  iPhones) get the full-width widget instead of the compact one.

Added: `isPrivateAddress`, `isLoopbackHost`, `isSharedCacheHeader`,
`MSG_TEST_KEYS`, `GatePassKey` (gate.mjs); `MSG_PRIVATE_CLIENT` and the
`localDev` option (gate-node.mjs).
