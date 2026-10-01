# onlyjewishgirls.com

Sign-up, sign-in with mandatory two-step verification (passkey + authenticator app), and a Yom Tov–aware 🔥 daily streak. The rest of the site is a "coming soon" placeholder for now.

Built with Next.js 16 (App Router), TypeScript, Tailwind CSS 4, SQLite (`better-sqlite3`), [SimpleWebAuthn](https://simplewebauthn.dev) for passkeys and [`@hebcal/core`](https://github.com/hebcal/hebcal-es6) for the Jewish calendar.

## Running it

```bash
npm install
npm run dev          # http://localhost:3000
```

Open the site at **exactly** `http://localhost:3000`, not `127.0.0.1`. Passkeys and the cross-site-request check are tied to that origin. Settings are in [`.env.example`](.env.example). Development needs none of them; the SQLite database and an encryption key are created in `.data/` the first time you run it.

| Command | What it does |
| --- | --- |
| `npm test` | Unit tests: password rules, TOTP (RFC 6238 vectors), streak and Yom Tov math, form validation |
| `npm run test:e2e` | Builds, then drives Chromium through registration → passkey → authenticator app → recovery codes → every sign-in method → streak continue/break. Uses a throwaway database in `.data/e2e`. If your machine already has Chromium, set `CHROMIUM_PATH` to skip `npx playwright install`. |
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

Passwords are hashed with scrypt (N=2¹⁷, r=8, p=1, OWASP's recommendation).

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
- Every POST checks `Origin` (CSRF protection), and cookies are `HttpOnly` + `SameSite=Lax` (`__Host-` + `Secure` on HTTPS).

## 🔥 Streak

The engine is [`src/lib/streak/engine.ts`](src/lib/streak/engine.ts), a set of pure functions with tests against the real 2026–27 calendar.

- **Check in at least once every 30 hours.** Signing in, or opening the site while signed in, counts. 30 hours covers a regular Shabbat if you check in Friday afternoon and again after Havdalah.
- **2-day Yom Tov: +24 h. 3-day Yom Tov (Yom Tov running into Shabbat): +48 h.** The extension applies when the Yom Tov starts inside your window, so you still need to check in on Erev Yom Tov. Only days still ahead count: checking in on day 1 of a 3-day block gives +24 h.
- **Diaspora vs Israel** comes from the user's time zone (`Asia/Jerusalem` = Israel). Example: Pesach 5787 is a 3-day block in the Diaspora (Thu–Fri–Shabbat) and no extension in Israel.
- **The count goes up once per new calendar day** you check in on. Shabbat/Yom Tov days you skipped over are added automatically, so keeping Shabbat never costs a day.
- **Miss the deadline** and the next check-in starts again at 1. Your longest streak is kept.
- A ⌛ shows when less than 4 hours are left.

Numbers are constants at the top of the engine (`STREAK_WINDOW_HOURS`, `YOM_TOV_EXTRA_DAY_HOURS`, `AT_RISK_HOURS`).

## Deploying

- Set `APP_ORIGIN=https://onlyjewishgirls.com`, `WEBAUTHN_RP_ID=onlyjewishgirls.com` and `APP_SECRET` (`openssl rand -base64 32`). The site refuses to start in production without `APP_SECRET`. Changing it later makes existing authenticator-app setups unreadable.
- SQLite needs a persistent disk (a VPS, Fly volume, Render disk, etc.). Serverless hosts with throwaway filesystems would need the data layer ([`src/server/users.ts`](src/server/users.ts), [`session.ts`](src/server/session.ts), [`rate-limit.ts`](src/server/rate-limit.ts)) moved to Postgres.
- Set `TRUSTED_PROXY_HOPS` to the number of proxies in front of the app, so rate limits see real client IPs.

## Layout

```
src/lib/password/      password rules (shared by browser + server)
src/lib/streak/        streak engine, Shabbat/Yom Tov calendar, date helpers
src/lib/validation.ts  registration field rules (shared)
src/server/            database, sessions, scrypt, TOTP, WebAuthn, rate limits
src/app/api/           auth + MFA endpoints
src/app/               pages: /register, /login, /login/verify, /setup-mfa, /home
tests/unit, tests/e2e  Vitest and Playwright
```
