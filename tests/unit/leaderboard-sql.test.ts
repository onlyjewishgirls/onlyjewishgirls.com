import { describe, expect, it } from "vitest";
import { LEADERBOARD_COLUMNS, leaderboardQuery } from "@/lib/streak/leaderboard-query";
import { MIGRATIONS } from "@/server/schema";

// The leaderboard's real SQL, run on a real SQLite database built from the real migrations
// (D1 is SQLite), so ordering, the cursor, the filters and the index are tested rather than imitated.
// Needs Node's built-in SQLite (Node 22+); skipped where it isn't there.
type Db = {
  exec(sql: string): void;
  prepare(sql: string): { run(...p: unknown[]): unknown; all(...p: unknown[]): Record<string, unknown>[] };
};
let sqlite: { DatabaseSync: new (path: string) => Db } | null = null;
try {
  sqlite = (await import("node:sqlite")) as unknown as typeof sqlite;
} catch {
  sqlite = null;
}

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-28T16:00:00Z");
const CUTOFF = NOW - 7 * 24 * HOUR;

function openDatabase(): Db {
  const db = new sqlite!.DatabaseSync(":memory:");
  for (const statements of MIGRATIONS) for (const statement of statements) db.exec(statement);
  return db;
}

let nextId = 0;
function addUser(
  db: Db,
  o: { streak: number; hoursAgo: number; suspended?: boolean; username?: string; id?: number; password?: string },
) {
  const id = o.id ?? ++nextId;
  db.prepare(
    `INSERT INTO users (id, first_name, last_name, email, username, username_lower, phone_e164, password_hash, time_zone,
                        webauthn_user_id, created_at, streak_count, streak_longest, streak_last_activity_at,
                        streak_last_counted_date, streak_started_at, suspended_at)
     VALUES (?, 'First', 'Last', ?, ?, ?, '+12125550100', ?, 'America/New_York', ?, 0, ?, ?, ?, '2026-10-27', 0, ?)`,
  ).run(
    id,
    `u${id}@example.com`,
    o.username ?? `user${id}`,
    (o.username ?? `user${id}`).toLowerCase(),
    o.password ?? "secret-hash",
    `w${id}`,
    o.streak,
    o.streak,
    NOW - o.hoursAgo * HOUR,
    o.suspended ? NOW : null,
  );
  return id;
}

/** Reads every page the way the server does. */
function readAll(db: Db, pageSize: number) {
  const pages: Record<string, unknown>[][] = [];
  let after: { streak_count: number; id: number } | null = null;
  for (;;) {
    const rows: Record<string, unknown>[] = after
      ? db.prepare(leaderboardQuery(true)).all(CUTOFF, after.streak_count, after.id, pageSize)
      : db.prepare(leaderboardQuery(false)).all(CUTOFF, pageSize);
    pages.push(rows);
    if (rows.length < pageSize) return pages;
    const last = rows[rows.length - 1] as { streak_count: number; id: number };
    after = { streak_count: last.streak_count, id: last.id };
  }
}

describe.skipIf(!sqlite)("the leaderboard query on a real SQLite database", () => {
  it("returns who might have a live streak, longest first, and nobody else", () => {
    const db = openDatabase();
    const a = addUser(db, { streak: 10, hoursAgo: 5 });
    const b = addUser(db, { streak: 30, hoursAgo: 29 });
    addUser(db, { streak: 77, hoursAgo: 1, suspended: true }); // suspended
    addUser(db, { streak: 0, hoursAgo: 1 }); // no streak
    addUser(db, { streak: 99, hoursAgo: 24 * 8 }); // last check-in older than any deadline can reach
    const c = addUser(db, { streak: 50, hoursAgo: 24 * 6.9 }); // old, but the calendar must decide
    const rows = db.prepare(leaderboardQuery(false)).all(CUTOFF, 100);
    expect(rows.map((r) => r.id)).toEqual([c, b, a]);
  });

  it("selects only what the streak rules need: no passwords, emails, phone numbers or names", () => {
    const db = openDatabase();
    addUser(db, { streak: 5, hoursAgo: 1, password: "TOP-SECRET-HASH" });
    const [row] = db.prepare(leaderboardQuery(false)).all(CUTOFF, 10);
    expect(Object.keys(row).sort()).toEqual([...LEADERBOARD_COLUMNS].sort());
    expect(JSON.stringify(row)).not.toMatch(/TOP-SECRET-HASH|example\.com|2125550100|First|Last/);
  });

  it("pages without skipping or repeating anyone, even through long runs of equal streaks", () => {
    const db = openDatabase();
    db.exec("BEGIN");
    const expected: number[] = [];
    // 450 people over a handful of streak lengths, so every page boundary lands inside a tie.
    for (let i = 0; i < 450; i++) expected.push(addUser(db, { streak: [7, 7, 7, 12, 3, 12][i % 6], hoursAgo: 2 }));
    db.exec("COMMIT");
    for (const pageSize of [1, 7, 50, 200, 449, 450, 451]) {
      const rows = readAll(db, pageSize).flat();
      const ids = rows.map((r) => r.id as number);
      expect(new Set(ids).size, `page size ${pageSize}`).toBe(450);
      expect([...ids].sort((x, y) => x - y)).toEqual([...expected].sort((x, y) => x - y));
      // Highest stored streak first; within equal streaks, newest id first (the order the cursor relies on).
      const keys = rows.map((r) => [r.streak_count as number, r.id as number]);
      for (let i = 1; i < keys.length; i++) {
        expect(keys[i - 1][0] > keys[i][0] || (keys[i - 1][0] === keys[i][0] && keys[i - 1][1] > keys[i][1])).toBe(true);
      }
    }
  });

  it("ends on a short page, and on an empty one when the last page is exactly full", () => {
    const db = openDatabase();
    for (let i = 0; i < 6; i++) addUser(db, { streak: 4, hoursAgo: 1 });
    expect(readAll(db, 4).map((p) => p.length)).toEqual([4, 2]);
    expect(readAll(db, 3).map((p) => p.length)).toEqual([3, 3, 0]);
  });

  it("reads the users(streak_count) index for every page, and seeks past earlier pages", () => {
    const db = openDatabase();
    for (let i = 0; i < 300; i++) addUser(db, { streak: 1 + (i % 40), hoursAgo: 1 });
    const first = db.prepare(`EXPLAIN QUERY PLAN ${leaderboardQuery(false)}`).all(CUTOFF, 200).map((r) => String(r.detail));
    const later = db.prepare(`EXPLAIN QUERY PLAN ${leaderboardQuery(true)}`).all(CUTOFF, 20, 100, 200).map((r) => String(r.detail));
    for (const plan of [first, later]) {
      expect(plan.join(" | ")).toContain("USING INDEX users_streak");
      expect(plan.join(" | ")).not.toMatch(/SCAN users(?! USING INDEX)/); // never a full table scan
      expect(plan.join(" | ")).not.toContain("TEMP B-TREE"); // already in order: no sorting
    }
    // The cursor is a range on the index, not a filter that re-walks every earlier page.
    expect(later.join(" | ")).toMatch(/streak_count>\? AND streak_count<\?/);
  });
});
