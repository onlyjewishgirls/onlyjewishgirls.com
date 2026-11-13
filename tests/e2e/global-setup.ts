import { mkdirSync } from "node:fs";
import path from "node:path";
import { devices, request } from "@playwright/test";
import { E2E_ORIGIN, E2E_PASS_STATE } from "../../playwright.config";

/**
 * Nothing on the site loads until the CAPTCHA is solved (PORTAL-STANDARD §10). With Cloudflare's test
 * keys on localhost, the wall accepts the dummy token, so solve it once here and save the pass cookie;
 * playwright.config.ts gives it to every browser and API context. The pass is bound to the address
 * (127.0.0.1) and the browser's User-Agent, so it is issued to the same Desktop Chrome UA the tests use.
 */
export default async function globalSetup() {
  const api = await request.newContext({ baseURL: E2E_ORIGIN, userAgent: devices["Desktop Chrome"].userAgent });
  const res = await api.post("/__gate/verify", {
    form: { token: "XXXX.DUMMY.TOKEN.XXXX", return: "/" },
    headers: { Origin: E2E_ORIGIN },
    maxRedirects: 0,
  });
  if (res.status() !== 303) throw new Error(`CAPTCHA verify answered ${res.status()}: ${(await res.text()).slice(0, 300)}`);
  const state = await api.storageState();
  if (!state.cookies.some((c) => c.name === "__Host-gate_pass")) throw new Error("CAPTCHA verify set no pass cookie.");
  mkdirSync(path.dirname(E2E_PASS_STATE), { recursive: true });
  await api.storageState({ path: E2E_PASS_STATE });
  await api.dispose();
}
