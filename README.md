# onlyjewishgirls.com

Sign-up, sign-in with mandatory two-step verification (passkey + authenticator app), forgot password, a Shabbat- and Yom Tov–aware 🔥 daily streak, and a streak leaderboard that pops up on sign-in. The rest of the site is a "coming soon" placeholder for now.

Built with Next.js 16 (App Router), TypeScript and Tailwind CSS 4. It runs on a Cloudflare Worker via [OpenNext](https://opennext.js.org/cloudflare), with data in Cloudflare D1. Passkeys use [SimpleWebAuthn](https://simplewebauthn.dev) and the Jewish calendar comes from [`@hebcal/core`](https://github.com/hebcal/hebcal-es6).

## Running it

```bash
npm install
npm run dev          # http://localhost:3000
```

Open the site at `http://localhost:3000`, not `127.0.0.1`. Passkeys made on one address don't work on the other. `npm run dev` creates `.dev.vars` (local secrets; see [`.dev.vars.example`](.dev.vars.example)). The local D1 database lives in `.wrangler/`. Tables are created automatically on first use, locally and in production ([`src/server/schema.ts`](src/server/schema.ts)).

| Command | What it does |
| --- | --- |
| `npm test` | Unit tests: password rules, TOTP (RFC 6238 vectors), streak and Yom Tov math, the streak leaderboard (ranking, who counts as live, and a calendar sweep proving how long a deadline can reach), form validation, admin permissions and temporary passwords, visitor log cleaning and bot detection |
| `npm run test:e2e` | Builds the Worker, runs it in the Workers runtime (`wrangler dev`) with a throwaway D1 database in `.data/e2e`, and drives Chromium through: registration → passkey → authenticator app → recovery codes → every sign-in method → streak continue/break → forgot password, the leaderboard popup and page, plus the admin panel (create an account, forced password change, re-verification, suspend + undo, edits, roles, remote sign-out, two-step reset, CSV export, delete, visitor log). If your machine already has Chromium, set `CHROMIUM_PATH` to skip `npx playwright install`. |
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
- Rate limits on login, sign-up, forgot password and the password checker.
- Every POST checks `Origin` (CSRF protection), and cookies are `HttpOnly` + `SameSite=Lax` (`__Host-` + `Secure` everywhere except localhost).

## Forgot password

**Forgot password?** on the sign-in page asks for a username or email and emails a reset link.

- The answer is the same whether or not the account exists, and the email is sent after the response, so neither the message nor the timing gives away who has an account.
- The link is single-use and expires after 30 minutes. Only a SHA-256 hash of its token is stored. Asking again replaces the old link. Each account gets at most 3 emails an hour.
- The new password must pass every rule above (checked against the account's own name, username, email and phone), and it can't be the current password.
- Saving it signs the account out on every device and emails a "your password was changed" notice.
- **It never skips two-step verification.** After a reset you still need your passkey, authenticator app or a recovery code, so someone who gets into your email still can't get into your account.

Email goes through [Resend](https://resend.com), with [Plunk](https://useplunk.com) as the backup when Resend fails (`PLUNK_API_KEY`; set the `EMAIL_PRIMARY` variable to `plunk` to try Plunk first). Either key alone is enough. Until a key and `EMAIL_FROM` are set (see [Deploying](#deploying-cloudflare)), local development prints the email, including the link, to the terminal. In production a missing key is logged as an error.

## 🔥 Streak

The engine is [`src/lib/streak/engine.ts`](src/lib/streak/engine.ts), a set of pure functions with tests against the real 2026–27 calendar.

- **Check in at least once every 30 hours.** Signing in, or opening the site while signed in, counts.
- **Your deadline never falls on Shabbat or Yom Tov, wherever you are.** If Shabbat or Yom Tov (including a 2- or 3-day Yom Tov) starts before your deadline, the deadline moves to **12 hours after it ends**. You never need to check in during it or race to check in right after Havdalah. If another one starts within those 12 hours, the deadline moves past that one too.
- **Times are local.** Shabbat and Yom Tov run from 40 minutes before sunset (candle lighting, with margin for places that light earlier) until 72 minutes after sunset (later than any common custom for nightfall), using sunset where you are. The location is Cloudflare's city-level estimate for the request, rounded to about 1 km, and used only when its time zone matches your browser's. If it doesn't (a VPN, for example) or isn't known, the app plays it safe: from noon on Erev Shabbat/Yom Tov until 3 AM after it ends. Near the poles, where the sun may not set, the same safe window is used.
- **Diaspora vs Israel** is based on that location (or an Israeli time zone). Example: Pesach 5787 is one 3-day block in the Diaspora (Thu–Fri–Shabbat), while in Israel it's Yom Tov on Thursday, a weekday, then Shabbat.
- **The count goes up once per new calendar day** you check in on. Shabbat/Yom Tov days you skipped over are added automatically, so keeping Shabbat never costs a day.
- **Miss the deadline** and the next check-in starts again at 1. Your longest streak is kept.
- A ⌛ shows when less than 4 hours are left.

The unit tests sweep a full year in New York, Jerusalem, London, Melbourne, Los Angeles, Tromsø (polar) and an unknown location, and check that no deadline ever lands inside Shabbat or Yom Tov.

Numbers are constants at the top of the engine (`STREAK_WINDOW_HOURS`, `AFTER_HOLY_DAY_HOURS`, `AT_RISK_HOURS`) and the calendar (`STARTS_BEFORE_SUNSET_MINUTES`, `ENDS_AFTER_SUNSET_MINUTES`).

## 🏆 Leaderboard

Right after signing in, a popup over the home page shows the longest streaks going right now, how many days each has, and where you stand. It appears once per sign-in (it remembers the session in the browser's local storage), closes with **Continue**, Escape or a click outside, and the full top 50 is always at [`/leaderboard`](src/app/leaderboard/page.tsx) and behind the 🏆 button in the header. Only signed-in members can see it, and only usernames are shown.

- **Only live streaks are ranked.** A stored count doesn't drop to 0 until the person comes back, so each one is checked against the streak rules: Shabbat and Yom Tov leeway is honored, and a lapsed streak disappears the moment its deadline passes. Suspended accounts are left off. Equal streaks share a rank (1, 2, 2, 4).
- **Your own row is always current.** The shared list can be up to a minute old; yours comes from the check-in that just happened.
- **Cheap on D1's free plan.** A `users_streak` index (migration 6) lets the board read the top of the table in order instead of every user, and each Worker instance reuses its result for 60 seconds (`LEADERBOARD_CACHE_SECONDS`, 0 to turn it off). Anyone who checked in within 30 hours is alive without any calendar work; only the rest are checked against sunset times. The index is only rewritten when a streak count changes, because a same-day check-in now writes just the deadline (`touchStreak`).
- **Skipping old streaks is safe.** The read ignores anyone whose last check-in is more than `STREAK_CERTAINLY_OVER_MS` (7 days) old. The longest deadline that can really happen is about 6.4 days: when the place is unknown, a Yom Tov, one ordinary day and Shabbat chain together. A unit test scans six years in six kinds of place to prove it stays below the cut-off. (The admin panel used to assume 6 days, which could hide such a streak for a few hours.)
- Pure ranking is in [`src/lib/streak/leaderboard.ts`](src/lib/streak/leaderboard.ts); the database read and cache are in [`src/server/leaderboard.ts`](src/server/leaderboard.ts).

## Admin panel

`/admin`, linked from the header for admins. Anyone else gets a 404.

**Roles.** `owner` (the site owner, set for briefchaimyuir@gmail.com by migration 3), `admin` and `member`. The owner can make members admins and back. Admins see everything and manage members, but can't act on other admins or the owner. Nobody can suspend, delete, demote, reset two-step sign-in or set a temporary password on their own account. The rules are in [`src/lib/admin/permissions.ts`](src/lib/admin/permissions.ts) and are enforced on the server.

On a fresh database (local or the preview database), make yourself owner after registering:

```bash
npx wrangler d1 execute DB --local --command "UPDATE users SET role = 'owner' WHERE email = 'you@example.com'"
```

**What it shows**

- **Overview:** setup warnings, key numbers, sign-ups and active people per day for 30 days, longest live streaks, recent activity.
- **Accounts:** search (name, username, email, phone, ID), filters (suspended, admins, two-step not finished, joined this week, locked out), sorting, and a CSV export of every account.
- **Account page:** profile, streak, passkeys, authenticator app, recovery codes, signed-in devices (browser, city, country, IP), lockout state, admin note, and their activity.
- **Activity:** every sign-in, failure, lockout, two-step, password, streak and admin event, with device, country and IP. Kept for a year.
- **Visitors:** every page view, signed in or not: page, account or guest, browser and device, city and country, IP address, network (ISP or host), the site they came from, time zone, language and window size. Totals, visitors per day, top pages, countries, referrers and networks; filter by time, signed in / guests / bots, or search. Click a guest's browser ID to see everything that browser did, or an IP to see everyone on it. Kept 90 days.

**What it can do:** create accounts with a temporary password; set a temporary password; email a reset link; suspend and lift suspensions; sign out everywhere or one device; unlock sign-in; remove a passkey, turn off the authenticator app, delete recovery codes or reset two-step sign-in; edit the profile, streak, note and role; delete the account.

Temporary passwords are shown to the admin once and never stored or logged. After signing in with one, the person sets up two-step sign-in if needed, then must choose their own password at `/change-password` (also linked from Home for anyone).

**How visits are recorded.** `VisitTracker` (in the root layout) posts each page's path to `/api/visit` as the visitor moves around. The server adds the IP, location and network from Cloudflare, the signed-in account if any, and a random browser ID kept in a first-party cookie (`__Host-ojg_vid`, one year). Query strings are never stored, so reset links can't leak into the log; `/admin` and `/api` aren't logged; the same browser reloading a page within 30 seconds counts once; each IP address is capped at 30 logged views a minute; and the whole log stops at 10,000 views in any 24 hours (`PER_DAY` in `src/server/visits.ts`), so it can never use up D1's free daily write allowance and take sign-ins down with it.

**Undo:** the owner can undo a suspension, a lifted suspension, and role, profile, streak and note changes from the activity log, once each. An undo is refused if the account has changed since.

**Safeguards:**
- Every change, plus the export, needs a passkey or authenticator check within the last 15 minutes. The panel asks for one and retries.
- Wrong codes count toward the normal hourly lockout.
- Every change is logged with who made it, when, the device and the IP.
- A suspended account's sessions end on its next request, and its reset links stop working.

## Deploying (Cloudflare)

Workers Builds deploys this repo to the `onlyjewishgirlsdotcom` Worker, and the D1 database `onlyjewishgirls` is bound as `DB`. Pull-request previews (`wrangler preview`) use a separate database, `onlyjewishgirls-preview` (the `previews` block in `wrangler.jsonc`), so testing never touches real accounts.

One-time setup in the Cloudflare dashboard, under **Workers & Pages → onlyjewishgirlsdotcom**:

1. **Settings → Build → Build configuration:** set **Build command** to `npx opennextjs-cloudflare build`. Keep the default deploy (`npx wrangler deploy`) and preview commands. Workers Builds ignores the `build` section in `wrangler.jsonc`, which is only used by local `wrangler dev` / `wrangler deploy`.
2. **Settings → Variables and Secrets:** add a secret `APP_SECRET`. Best is 32 random bytes (`openssl rand -base64 32`), but any random string of 16+ characters works, such as a UUID or a password manager's random password; it's hashed into a key. If it's missing or too short, the authenticator-app step says so on screen. Add it to the preview settings too if you use preview URLs. It encrypts authenticator-app secrets, so if it changes later, existing authenticator-app setups stop working.
3. **Email (for forgot password):** in Resend, verify the domain `onlyjewishgirls.com` (it adds DNS records; with the domain on Cloudflare this is a couple of clicks). Then add a secret `EMAIL_API_KEY` with a Resend API key, and a variable `EMAIL_FROM`, e.g. `OnlyJewishGirls <no-reply@onlyjewishgirls.com>`. Resend's free tier (100 emails a day, 3,000 a month) is plenty. For the backup, verify the same domain in Plunk and add a secret `PLUNK_API_KEY` with its secret key (`sk_…`). Dashboard variables survive deploys because `wrangler.jsonc` sets `keep_vars: true`; without it, each `wrangler deploy` would delete them.
4. **Optional:** to serve both `onlyjewishgirls.com` and `www.onlyjewishgirls.com`, set the variable `WEBAUTHN_RP_ID=onlyjewishgirls.com` so one passkey works on both.

## Layout

```
src/lib/password/      password rules (shared by browser + server)
src/lib/streak/        streak engine, Shabbat/Yom Tov calendar, date helpers, leaderboard ranking (leaderboard.ts)
src/lib/validation.ts  registration field rules (shared)
src/lib/admin/         admin roles/permissions, event labels, display helpers, visitor log cleaning (visits.ts)
src/server/            D1 access + schema, sessions, password hashing, TOTP, WebAuthn, rate limits, email,
                       activity log (events.ts), admin queries and guards (admin.ts), undo (admin-undo.ts),
                       visitor log (visits.ts), streak leaderboard read + cache (leaderboard.ts)
src/app/api/           auth, MFA and admin endpoints, and /api/visit (page views from VisitTracker)
src/app/               pages: /register, /login, /login/verify, /setup-mfa, /forgot-password, /reset-password,
                       /change-password, /home, /leaderboard, /admin (overview, accounts, account, activity, visitors)
tests/unit, tests/e2e  Vitest and Playwright
```
