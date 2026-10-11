import type { Metadata } from "next";
import Link from "next/link";
import { EventList } from "@/components/admin/EventList";
import { EVENT_GROUPS, isEventGroup } from "@/lib/admin/events";
import { listEvents, requireAdminPage } from "@/server/admin";
import { findUserById } from "@/server/users";

export const metadata: Metadata = { title: "Activity · Admin · OnlyJewishGirls", robots: { index: false } };

type Search = { [key: string]: string | string[] | undefined };
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

export default async function AdminActivityPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { user: viewer, now } = await requireAdminPage();
  const params = await searchParams;
  const group = isEventGroup(one(params.group)) ? (one(params.group) as keyof typeof EVENT_GROUPS) : "all";
  const q = one(params.q)?.slice(0, 100) ?? "";
  const userId = Number(one(params.user));
  const subject = Number.isSafeInteger(userId) && userId > 0 ? await findUserById(userId) : null;
  const before = Number(one(params.before));
  const { events, nextBefore } = await listEvents({
    group,
    q,
    userId: subject?.id,
    before: Number.isSafeInteger(before) && before > 0 ? before : undefined,
    limit: 50,
  });

  const href = (extra: Record<string, string | number | undefined>) => {
    const sp = new URLSearchParams();
    if (group !== "all") sp.set("group", group);
    if (q) sp.set("q", q);
    if (subject) sp.set("user", String(subject.id));
    for (const [k, v] of Object.entries(extra)) if (v !== undefined) sp.set(k, String(v));
    const s = sp.toString();
    return `/admin/activity${s ? `?${s}` : ""}`;
  };

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Activity</h1>

      <form method="get" className="panel grid gap-3 sm:grid-cols-[auto_1fr_auto]" role="search">
        {subject && <input type="hidden" name="user" value={subject.id} />}
        <div>
          <label htmlFor="group" className="sr-only">
            Show
          </label>
          <select id="group" name="group" className="input" defaultValue={group}>
            {Object.entries(EVENT_GROUPS).map(([key, g]) => (
              <option key={key} value={key}>
                {g.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="activity-q" className="sr-only">
            Username or IP address
          </label>
          <input id="activity-q" name="q" type="search" className="input" placeholder="Username or IP address" defaultValue={q} />
        </div>
        <button type="submit" className="btn-secondary">
          Filter
        </button>
      </form>

      {subject && (
        <p className="text-sm">
          Showing activity for{" "}
          <Link href={`/admin/users/${subject.id}`} className="link">
            {subject.username}
          </Link>{" "}
          ·{" "}
          <Link href="/admin/activity" className="link">
            Show everyone
          </Link>
        </p>
      )}

      <section className="panel" aria-label="Activity log">
        <EventList
          events={events}
          timeZone={viewer.timeZone}
          now={now}
          canUndo={viewer.role === "owner"}
          empty="Nothing matches."
        />
      </section>

      <nav aria-label="Pages" className="flex justify-between text-sm">
        {before ? (
          <Link href={href({})} className="btn-secondary">
            ← Newest
          </Link>
        ) : (
          <span />
        )}
        {nextBefore !== null && (
          <Link href={href({ before: nextBefore })} className="btn-secondary">
            Older →
          </Link>
        )}
      </nav>
    </div>
  );
}
