/* eslint-disable @typescript-eslint/no-explicit-any -- the parsed config is read loosely */
/**
 * wrangler.jsonc settings the CAPTCHA wall (PORTAL-STANDARD §10) depends on. Preview URLs are a
 * per-Worker switch: while it is on, every older version's preview (built before the wall) serves
 * the whole app without a CAPTCHA, so it must stay off. The workers.dev host is off too: production
 * is served on the custom domain only.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** JSONC → JSON: drops // and block comments and trailing commas, leaving string contents alone. */
function parseJsonc(text: string): Record<string, any> {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const config = parseJsonc(readFileSync(fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url)), "utf8"));

describe("wrangler.jsonc", () => {
  it("turns preview URLs off, so no pre-wall version is served on a workers.dev preview host", () => {
    expect(config.preview_urls).toBe(false);
  });

  it("turns the workers.dev host off and doesn't set it again in an environment", () => {
    expect(config.workers_dev).toBe(false);
    for (const [name, e] of Object.entries<Record<string, unknown>>(config.env ?? {})) {
      expect([name, e.preview_urls ?? false, e.workers_dev ?? false]).toEqual([name, false, false]);
    }
  });

  it("still runs the Worker (and so the wall) before every static file", () => {
    expect(config.main).toBe("worker.ts");
    expect(config.assets.run_worker_first).toBe(true);
  });
});
