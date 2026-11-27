/* Screenshots of the challenge page through the real gate (demo/serve.mjs),
   with the pre-installed Playwright. Writes ./screenshots/*.png and prints a
   layout report: horizontal overflow, card inside the viewport, the widget's
   box (Turnstile's full-width size needs 300 px; below that it falls back to
   the narrow compact one) and, when the script is blocked, the gap left above
   the error.

     node demo/screenshots.mjs

   Uses Cloudflare's test site keys so the page stays up long enough to see:
   3x...FF always asks (the normal, interactive state) and 2x...AB always
   fails (the widget error state). If challenges.cloudflare.com can't be
   reached, the page shows its "could not load" error state instead, which
   is fine for checking layout.
*/
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startDemo } from './serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'screenshots');

const ASKS = '3x00000000000000000000FF';
const FAILS = '2x00000000000000000000AB';
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;

process.env.QUIET = '1';
const normal = await startDemo({ port: 0, offline: true, siteKey: ASKS, siteDomain: 'portal.example.com' });
const failing = await startDemo({ port: 0, offline: true, siteKey: FAILS, siteDomain: 'portal.example.com' });
const longName = await startDemo({
  port: 0, offline: true, siteKey: ASKS,
  siteName: "Shnayim Mikra V'echad Targum Learning Community", siteDomain: 'members.shnayimmikrah.org',
});

const browser = await chromium.launch(proxy ? { proxy: { server: proxy, bypass: 'localhost,127.0.0.1' } } : {});
const report = [];

async function shoot(name, port, { width, scheme, js = true, prepare, blockTurnstile = false } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height: width >= 1024 ? 900 : 844 },
    colorScheme: scheme,
    javaScriptEnabled: js,
    ignoreHTTPSErrors: true,
  });
  // An ad blocker, a corporate filter or an outage: Turnstile's script never arrives.
  if (blockTurnstile) await ctx.route('https://challenges.cloudflare.com/**', (r) => r.abort('blockedbyclient'));
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${port}/scripts?ref=home`);
  if (prepare) await prepare(page);
  else if (js) await page.waitForTimeout(6000);
  const m = await page.evaluate(() => {
    const card = document.querySelector('.g-card').getBoundingClientRect();
    const de = document.documentElement;
    const btn = document.getElementById('gate-retry');
    const errEl = document.getElementById('gate-error');
    const b = btn && !errEl.hidden ? btn.getBoundingClientRect() : null;
    const box = document.getElementById('gate-widget');
    const shown = box.getClientRects().length > 0;
    const line = document.querySelector('.g-line').getBoundingClientRect();
    return {
      overflowX: de.scrollWidth > de.clientWidth,
      cardLeft: Math.round(card.left), cardRight: Math.round(card.right), vw: de.clientWidth,
      widget: shown ? box.clientWidth : '-',
      gap: errEl.hidden ? '-' : Math.round(errEl.getBoundingClientRect().top - line.bottom),
      retry: b ? `${Math.round(b.width)}x${Math.round(b.height)}` : '-',
      status: (document.getElementById('gate-status') || {}).textContent || '',
      error: document.getElementById('gate-error').hidden ? '' : document.getElementById('gate-error-text').textContent,
    };
  });
  const file = path.join(out, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  report.push({ name, ...m });
  await ctx.close();
}

for (const scheme of ['light', 'dark']) {
  for (const width of [360, 375, 390, 414, 768, 1024, 1280, 1440]) {
    await shoot(`${scheme}-${width}-challenge`, normal.port, { width, scheme });
  }
  for (const width of [390, 1440]) {
    await shoot(`${scheme}-${width}-script-blocked`, normal.port, {
      width, scheme, blockTurnstile: true,
      prepare: (page) => page.waitForTimeout(1500),
    });
    await shoot(`${scheme}-${width}-widget-error`, failing.port, { width, scheme });
    await shoot(`${scheme}-${width}-verify-failed`, normal.port, {
      width, scheme,
      prepare: async (page) => {
        await page.evaluate(() => {
          document.getElementById('gate-token').value = 'not-a-real-token';
          document.getElementById('gate-form').submit();
        });
        await page.waitForLoadState('load');
        await page.waitForTimeout(5000);
      },
    });
  }
}
await shoot('light-390-noscript', normal.port, { width: 390, scheme: 'light', js: false });
await shoot('dark-1440-noscript', normal.port, { width: 1440, scheme: 'dark', js: false });
await shoot('light-360-long-name', longName.port, { width: 360, scheme: 'light' });
await shoot('dark-390-long-name', longName.port, { width: 390, scheme: 'dark' });

await browser.close();
for (const s of [normal, failing, longName]) s.server.close();

console.table(report);
const bad = report.filter((r) => r.overflowX || r.cardLeft < 0 || r.cardRight > r.vw
  || (typeof r.widget === 'number' && r.vw >= 350 && r.widget < 300)   // compact widget on a phone that fits the full one
  || (r.name.includes('script-blocked') && !(r.gap <= 24)));           // an empty widget-sized hole above the error
if (bad.length) {
  console.error('Layout problems:', bad.map((b) => b.name).join(', '));
  process.exitCode = 1;
}
