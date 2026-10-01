# onlyjewishgirls.com

Sign-up, sign-in with mandatory two-step verification (passkey + authenticator app), and a Yom Tov–aware 🔥 daily streak. The rest of the site is a "coming soon" placeholder for now.

Built with Next.js 16 (App Router), TypeScript and Tailwind CSS 4. It runs on a Cloudflare Worker via [OpenNext](https://opennext.js.org/cloudflare), with data in Cloudflare D1. Passkeys use [SimpleWebAuthn](https://simplewebauthn.dev) and the Jewish calendar comes from [`@hebcal/core`](https://github.com/hebcal/hebcal-es6).

## Running it

```bash
npm install
npm run dev          # http://localhost:3000
```

Open the site at `http://localhost:3000`, not `127.0.0.1`. Passkeys made on one address don't work on the other. `npm run dev` creates `.dev.vars` (local secrets; see [`.dev.vars.example`](.dev.vars.example)). The local D1 database lives in `.wrangler/`. Tables are created automatically on first use, locally and in production ([`src/server/schema.ts`](src/server/schema.ts)).

| Command | What it does |
| --- | --- |
| `npm test` | Unit tests: password rules, TOTP (RFC 6238 vectors), streak and Yom Tov math, form validation |
| `npm run test:e2e` | Builds the Worker, runs it in the Workers runtime (`wrangler dev`) with a throwaway D1 database in `.data/e2e`, and drives Chromium through: registration → passkey → authenticator app → recovery codes → every sign-in method → streak continue/break. If your machine already has Chromium, set `CHROMIUM_PATH` to skip `npx playwright install`. |
| `npm run preview` | Builds and serves the Worker locally in the Workers runtime |
| `npm run lint` / `npm run typecheck` | ESLint / TypeScript |

## Registration

Fields: first name, middle name (or tick **No middle name**), last name, email, username, mobile number (with country code), password, confirm password. The browser validates as you type and the server checks everything again. Usernames and emails must be unique (case-insensitive). Mobile numbers are stored in E.164 form, and numbers known to be landlines are rejected.

### Password rules

All in [`src/lib/password/`](src/lib/password). The sign-up form shows a live checklist.

| Rule | Exactly what's enforced |
| --- | --- |
| Length | 16–128 characters |
| Capitals / lowercase | at least 3 of each (Unicode-aware) |
| Symbol / number | at least 1 of each |
| No dictionary words | no English word of 4+ letters (≈79k words, US/UK/CA/AU spellings), plus common Hebrew/Yiddish words, Jewish names and password clichés ([`extra-words.ts`](src/server/extra-words.ts)). Look-alikes count: `P@ssw0rd` → *password*, `h0us3` → *house*. Words of 1–3 letters are allowed, because blocking those would reject almost every password. |
| No personal info | no 3+ character piece of the first, middle or last name, username, or any part of the email (a 2-letter name like "Li" is blocked whole), and no 4+ digit run from the phone number. Look-alikes count here too. |
| No sequences | `abc`/`cba`/`123`/`987`, keyboard rows `qwe`/`asd`/`zxc`/`!@#`, keyboard columns `1qaz`/`wsx`, number-pad lines `147`/`159`, repeats `aaa`, repeated chunks `abab`/`1212`, skip-counting `2468`/`aceg` |

Passwords are hashed with PBKDF2-HMAC-SHA256 at 100,000 iterations, using the Workers runtime's built-in WebCrypto. 100,000 is the most it allows in one call, and it costs about 15 ms of CPU, which keeps sign-in within the Workers Free plan. The password rules carry most of the weight against guessing.

The dictionary is precomputed in [`src/server/dictionary-words.json`](src/server/dictionary-words.json), so the Worker doesn't spend ~80 ms building it. A unit test fails if that file falls out of date; `npm run dictionary` regenerates it from [`scripts/dictionary-source.ts`](scripts/dictionary-source.ts).

## Two-step verification

Nobody gets past the setup screen until they have **both**:

1. **A passkey** (Face ID, fingerprint or device PIN; user verification is required).
2. **An authenticator app** (TOTP, 6 digits, 30 s). The QR code is rendered on our server so the secret never goes to a third party. Secrets are encrypted at rest (AES-256-GCM), and a code can't be used twice.

After that they get **10 one-time recovery codes**.

Signing in = password, then any one of: passkey, authenticator code, or recovery code.

Safeguards:

- If an account already has any second factor, the password alone can't add another one.
- The session ID is replaced at each privilege step.
- Each session gets 5 wrong second-factor tries, and each account gets 10 wrong tries per hour.
- Rate limits on login, sign-up and the password checker.
- Every POST checks `Origin` (CSRF protection), and cookies are `HttpOnly` + `SameSite=Lax` (`__Host-` + `Secure` everywhere except localhost).

## 🔥 Streak

The engine is [`src/lib/streak/engine.ts`](src/lib/streak/engine.ts), a set of pure functions with tests against the real 2026–27 calendar.

- **Check in at least once every 30 hours.** Signing in, or opening the site while signed in, counts. 30 hours covers a regular Shabbat if you check in Friday afternoon and again after Havdalah.
- **2-day Yom Tov: +24 h. 3-day Yom Tov (Yom Tov running into Shabbat): +48 h.** The extension applies when the Yom Tov starts inside your window, so you still need to check in on Erev Yom Tov. Only days still ahead count: checking in on day 1 of a 3-day block gives +24 h.
- **Diaspora vs Israel** comes from the user's time zone (`Asia/Jerusalem` = Israel). Example: Pesach 5787 is a 3-day block in the Diaspora (Thu–Fri–Shabbat) and no extension in Israel.
- **The count goes up once per new calendar day** you check in on. Shabbat/Yom Tov days you skipped over are added automatically, so keeping Shabbat never costs a day.
- **Miss the deadline** and the next check-in starts again at 1. Your longest streak is kept.
- A ⌛ shows when less than 4 hours are left.

Numbers are constants at the top of the engine (`STREAK_WINDOW_HOURS`, `YOM_TOV_EXTRA_DAY_HOURS`, `AT_RISK_HOURS`).

## Deploying (Cloudflare)

Workers Builds deploys this repo to the `onlyjewishgirlsdotcom` Worker, and the D1 database `onlyjewishgirls` is bound as `DB`.

One-time setup in the Cloudflare dashboard, under **Workers & Pages → onlyjewishgirlsdotcom**:

1. **Settings → Build → Build configuration:** set **Build command** to `npx opennextjs-cloudflare build`. Keep the default deploy (`npx wrangler deploy`) and preview commands. Workers Builds ignores the `build` section in `wrangler.jsonc`, which is only used by local `wrangler dev` / `wrangler deploy`.
2. **Settings → Variables and Secrets:** add a secret `APP_SECRET` with 32 random bytes (`openssl rand -base64 32`). Add it to the preview settings too if you use preview URLs. It encrypts authenticator-app secrets, so if it changes later, existing authenticator-app setups stop working.
3. **Optional:** to serve both `onlyjewishgirls.com` and `www.onlyjewishgirls.com`, set the variable `WEBAUTHN_RP_ID=onlyjewishgirls.com` so one passkey works on both.

Preview deployments use the same D1 database as production unless you give previews their own binding.

## Layout

```
src/lib/password/      password rules (shared by browser + server)
src/lib/streak/        streak engine, Shabbat/Yom Tov calendar, date helpers
src/lib/validation.ts  registration field rules (shared)
src/server/            D1 access + schema, sessions, password hashing, TOTP, WebAuthn, rate limits
src/app/api/           auth + MFA endpoints
src/app/               pages: /register, /login, /login/verify, /setup-mfa, /home
tests/unit, tests/e2e  Vitest and Playwright
```
