// Creates .dev.vars with a random APP_SECRET for local development, if it doesn't exist yet, and adds
// Cloudflare's always-pass Turnstile test keys for the CAPTCHA wall (PORTAL-STANDARD §10) if it has none.
// The wall accepts test keys only on localhost; anywhere else they are a 503. Wrangler and `next dev`
// read Cloudflare secrets from this file. Never commit it.
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

if (!existsSync(".dev.vars")) {
  writeFileSync(".dev.vars", `APP_SECRET=${randomBytes(32).toString("base64")}\n`, { mode: 0o600 });
  console.log("Created .dev.vars with a new APP_SECRET");
}

const current = readFileSync(".dev.vars", "utf8");
if (!/^TURNSTILE_SITE_KEY=/m.test(current)) {
  const keys = "TURNSTILE_SITE_KEY=1x00000000000000000000AA\nTURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA\n";
  appendFileSync(".dev.vars", `${current.endsWith("\n") || current === "" ? "" : "\n"}${keys}`);
  console.log("Added Cloudflare's Turnstile test keys to .dev.vars (local development only)");
}
