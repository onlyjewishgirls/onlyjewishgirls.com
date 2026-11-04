/**
 * Runs the real route handlers and server modules against an in-memory SQLite
 * database (node:sqlite) that behaves like D1, with a fake cookie jar and
 * request headers standing in for next/headers. Import this file first, then
 * the routes, in each test file:
 *
 *   import { h } from "./harness";
 *   const { POST } = await import("@/app/api/auth/login/route");
 */
import { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";
import { MIGRATIONS } from "../../src/server/schema";

type Row = Record<string, unknown>;

class Stmt {
  constructor(
    private db: DatabaseSync,
    private sql: string,
    private params: unknown[] = [],
  ) {}
  bind(...params: unknown[]) {
    return new Stmt(this.db, this.sql, params);
  }
  private prepared() {
    return this.db.prepare(this.sql);
  }
  async first<T = Row>(): Promise<T | null> {
    const row = this.prepared().get(...(this.params as never[]));
    return (row ? { ...row } : null) as T | null;
  }
  async all<T = Row>() {
    return { results: this.prepared().all(...(this.params as never[])).map((r) => ({ ...r })) as T[] };
  }
  async run() {
    const r = this.prepared().run(...(this.params as never[]));
    return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  runSync() {
    return this.prepared().run(...(this.params as never[]));
  }
}

export class FakeD1 {
  db = new DatabaseSync(":memory:");
  prepare(sql: string) {
    return new Stmt(this.db, sql);
  }
  async batch(stmts: Stmt[]) {
    this.db.exec("BEGIN");
    try {
      for (const s of stmts) s.runSync();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return [];
  }
  /** Synchronous helpers for tests. */
  rows<T = Row>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...(params as never[])).map((r) => ({ ...r })) as T[];
  }
  one<T = Row>(sql: string, ...params: unknown[]): T | undefined {
    const r = this.db.prepare(sql).get(...(params as never[]));
    return r ? ({ ...r } as T) : undefined;
  }
  exec(sql: string, ...params: unknown[]) {
    return this.db.prepare(sql).run(...(params as never[]));
  }
}

export const h = {
  d1: new FakeD1(),
  env: {} as Record<string, unknown>,
  cookies: new Map<string, string>(),
  headers: new Headers(),
  cf: {} as Record<string, unknown>,
  background: [] as Promise<unknown>[],
  /** Sets the address the next requests come from. */
  ip: "203.0.113.10",
  host: "onlyjewishgirls.com",
};

export function resetHarness() {
  h.d1 = new FakeD1();
  // Apply the real migrations up front (db.ts only migrates once per process).
  h.d1.db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  MIGRATIONS.forEach((statements, i) => {
    for (const sql of statements) h.d1.db.exec(sql);
    h.d1.exec("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", i + 1, Date.now());
  });
  h.env = { DB: h.d1, APP_SECRET: "test-secret-0123456789abcdef0123456789" };
  h.cookies = new Map();
  h.cf = {};
  h.background = [];
  h.ip = "203.0.113.10";
}
resetHarness();

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => ({
    env: h.env,
    cf: h.cf,
    ctx: { waitUntil: (p: Promise<unknown>) => h.background.push(p) },
  }),
}));

vi.mock("next/headers", () => ({
  headers: async () => h.headers,
  cookies: async () => ({
    get: (name: string) => (h.cookies.has(name) ? { name, value: h.cookies.get(name)! } : undefined),
    set: (name: string, value: string) => void h.cookies.set(name, value),
    delete: (name: string) => void h.cookies.delete(name),
  }),
}));

/** Waits for every ctx.waitUntil task (alert emails, etc.), including ones they start. */
export async function settle() {
  for (let i = 0; i < 10 && h.background.length; i++) {
    const batch = h.background.splice(0);
    await Promise.all(batch);
  }
}

/** Builds a request as the browser would send it, from h.ip, and points next/headers at it. */
export async function call(
  handler: (req: import("next/server").NextRequest, ctx?: never) => Promise<Response>,
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string>; ctx?: unknown } = {},
) {
  const { NextRequest } = await import("next/server");
  const url = `https://${h.host}${path}`;
  const headers = new Headers({
    host: h.host,
    origin: `https://${h.host}`,
    "cf-connecting-ip": h.ip,
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15",
    "content-type": "application/json",
    ...options.headers,
  });
  h.headers = headers;
  const req = new NextRequest(url, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const res = await (handler as (r: unknown, c?: unknown) => Promise<Response>)(req, options.ctx);
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { text };
  }
  return { status: res.status, data, res };
}

let seq = 0;
/** Creates a fully set-up account (passkey row, TOTP on, recovery codes) and returns it. */
export async function makeUser(
  options: { username?: string; role?: "member" | "admin" | "owner"; password?: string; totp?: boolean; passkey?: boolean } = {},
) {
  const { hashPassword } = await import("@/server/passwords");
  seq++;
  const username = options.username ?? `user${seq}`;
  const password = options.password ?? "Correct-Horse-Battery-Staple-9!";
  const now = Date.now();
  const r = h.d1.exec(
    `INSERT INTO users (first_name, last_name, email, username, username_lower, phone_e164, password_hash, time_zone,
       webauthn_user_id, created_at, role, totp_enabled_at, recovery_codes_created_at, search_name)
     VALUES ('Test', ?, ?, ?, ?, '+12125550100', ?, 'America/New_York', 'wid', ?, ?, ?, ?, 'test')`,
    `Tester${"abcdefghijklmnopqrstuvwxyz"[seq % 26]}`,
    `${username}@example.com`,
    username,
    username.toLowerCase(),
    await hashPassword(password),
    now,
    options.role ?? "member",
    options.totp === false ? null : now,
    now,
  );
  const id = Number(r.lastInsertRowid);
  if (options.passkey !== false) {
    h.d1.exec(
      "INSERT INTO passkeys (id, user_id, public_key, counter, transports, device_type, backed_up, created_at) VALUES (?, ?, 'AA', 0, '[]', 'multiDevice', 1, ?)",
      `pk-${id}`,
      id,
      now - 1000,
    );
  }
  h.d1.exec("INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, 'x')", id);
  return { id, username, password };
}

/** Signs the cookie jar in as a full, recently verified session for the user. */
export async function signInAs(userId: number, { verified = true } = {}) {
  const { randomToken, sha256 } = await import("@/server/crypto");
  const token = randomToken();
  const now = Date.now();
  h.d1.exec(
    `INSERT INTO sessions (id_hash, user_id, stage, created_at, last_seen_at, expires_at, verified_at, ip)
     VALUES (?, ?, 'full', ?, ?, ?, ?, ?)`,
    sha256(token),
    userId,
    now - 60_000,
    now,
    now + 86_400_000,
    verified ? now : null,
    h.ip,
  );
  h.cookies.set("__Host-ojg_session", token);
  return token;
}
