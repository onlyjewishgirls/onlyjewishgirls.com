// Creates .dev.vars with a random APP_SECRET for local development, if it doesn't exist yet.
// Wrangler and `next dev` read Cloudflare secrets from this file. Never commit it.
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

if (!existsSync(".dev.vars")) {
  writeFileSync(".dev.vars", `APP_SECRET=${randomBytes(32).toString("base64")}\n`, { mode: 0o600 });
  console.log("Created .dev.vars with a new APP_SECRET");
}
