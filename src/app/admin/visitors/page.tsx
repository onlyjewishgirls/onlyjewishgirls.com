import type { Metadata } from "next";
import Link from "next/link";
import { DailyBars } from "@/components/admin/DailyBars";
import { StatTile } from "@/components/admin/StatTile";
import { compactNumber, countryName, describeDevice, formatDateTime, timeAgo } from "@/lib/admin/format";
import { VISIT_KINDS, VISIT_RANGES, isVisitKind, isVisitRange } from "@/lib/admin/visits";
import { requireAdminPage } from "@/server/admin";
import { findUserById } from "@/server/users";
import { listVisits, visitSummary, type Ranked, type VisitFilter } from "@/server/visits";

export const metadata: Metadata = { title: "Visitors · Admin · OnlyJewishGirls", robots: { index: false } };

type Search = { [key: string]: string | string[] | undefined };
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

function TopList({
  title,
  items,
  href,
  format = (label) => label,
  mono = false,
}: {
  title: string;
  items: Ranked[];
  href: (label: string) => string;
  format?: (label: string) => string;
  mono?: boolean;
}) {
  const max = Math.max(...items.map((i) => i.count), 1);
  return (
    <section className="panel" aria-label={title}>
      <h2 className="mb-3 font-semibold">{title}</h2>
      {items.length === 0 ? (
        <p className="text-sm text-muted">None yet.</p>
      ) : (
        <ol className="space-y-1.5 text-sm">
          {items.map((item) => (
            <li key={item.label} className="relative">
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 rounded-md bg-brand-soft"
                style={{ width: `${(item.count / max) * 100}%` }}
              />
              <Link href={href(item.label)} className="relative flex items-center justify-between gap-3 px-2 py-1 hover:underline">
                <span className={`min-w-0 truncate ${mono ? "font-mono text-xs" : ""}`}>{format(item.label)}</span>
                <span className="tabular shrink-0 text-muted">{compactNumber(item.count)}</span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export default async function AdminVisitorsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { user: viewer, now } = await requireAdminPage();
  const params = await searchParams;
  const range = isVisitRange(one(params.range)) ? (one(params.range) as VisitFilter["range"]) : "day";
  const kind = isVisitKind(one(params.kind)) ? (one(params.kind) as VisitFilter["kind"]) : "all";
  const q = one(params.q)?.trim().slice(0, 100) ?? "";
  const visitorParam = one(params.visitor);
  const visitorId = visitorParam && /^[A-Za-z0-9_-]{22}$/.test(visitorParam) ? visitorParam : undefined;
  const userParam = Number(one(params.user));
  const subject = Number.isSafeInteger(userParam) && userParam > 0 ? await findUserById(userParam) : null;
  const before = Number(one(params.before));

  const filter: VisitFilter = { range, kind, q, visitorId, userId: subject?.id };
  const [summary, { visits, nextBefore }] = await Promise.all([
    visitSummary(filter, viewer.timeZone, now),
    listVisits(filter, { before: Number.isSafeInteger(before) && before > 0 ? before : undefined, limit: 50 }, now),
  ]);
  const tz = viewer.timeZone;

  const href = (extra: Record<string, string | number | undefined>) => {
    const sp = new URLSearchParams();
    const all = { range, kind, q: q || undefined, visitor: visitorId, user: subject?.id, ...extra };
    for (const [k, v] of Object.entries(all)) {
      if (v === undefined || (k === "range" && v === "day") || (k === "kind" && v === "all")) continue;
      sp.set(k, String(v));
    }
    const s = sp.toString();
    return `/admin/visitors${s ? `?${s}` : ""}`;
  };
  const search = (text: string) => href({ q: text, before: undefined });

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Visitors</h1>

      <form method="get" className="panel grid gap-3 sm:grid-cols-[auto_auto_1fr_auto]" role="search">
        {visitorId && <input type="hidden" name="visitor" value={visitorId} />}
        {subject && <input type="hidden" name="user" value={subject.id} />}
        <div>
          <label htmlFor="range" className="sr-only">
            Time
          </label>
          <select id="range" name="range" className="input" defaultValue={range}>
            {Object.entries(VISIT_RANGES).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="kind" className="sr-only">
            Who
          </label>
          <select id="kind" name="kind" className="input" defaultValue={kind}>
            {Object.entries(VISIT_KINDS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="visitors-q" className="sr-only">
            Page, IP address, country, city, network, username or referrer
          </label>
          <input
            id="visitors-q"
            name="q"
            type="search"
            className="input"
            placeholder="Page, IP, country code, city, network, username"
            defaultValue={q}
          />
        </div>
        <button type="submit" className="btn-secondary">
          Filter
        </button>
      </form>

      {(visitorId || subject) && (
        <p className="text-sm">
          Showing visits from{" "}
          {subject ? (
            <Link href={`/admin/users/${subject.id}`} className="link">
              {subject.username}
            </Link>
          ) : (
            <>
              browser <span className="font-mono">{visitorId!.slice(0, 8)}</span>
            </>
          )}{" "}
          ·{" "}
          <Link href={href({ visitor: undefined, user: undefined })} className="link">
            Show everyone
          </Link>
        </p>
      )}

      <section aria-label="Totals" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Page views" value={compactNumber(summary.views)} note={VISIT_RANGES[range]} />
        <StatTile label="Visitors" value={compactNumber(summary.visitors)} note="Different browsers" />
        <StatTile
          label="Members"
          value={compactNumber(summary.members)}
          note="Accounts that were signed in"
          href={href({ kind: "members" })}
        />
        <StatTile label="Bot hits" value={compactNumber(summary.bots)} note="Crawlers, previews, scripts" href={href({ kind: "bots" })} />
      </section>

      <DailyBars title="Visitors per day (last 30 days, not counting bots)" unit="visitors" data={summary.visitorsByDay} />

      <div className="grid gap-3 md:grid-cols-2">
        <TopList title="Top pages" items={summary.topPages} href={search} mono />
        <TopList title="Countries" items={summary.topCountries} href={search} format={(c) => countryName(c) ?? c} />
        <TopList title="Came from" items={summary.topReferrers} href={search} />
        <TopList title="Networks" items={summary.topNetworks} href={search} />
      </div>

      <section className="panel" aria-label="Visitor log">
        <h2 className="mb-1 font-semibold">Every page view</h2>
        {visits.length === 0 ? (
          <p className="text-sm text-muted">Nothing matches.</p>
        ) : (
          <ol className="divide-y divide-border">
            {visits.map((v) => {
              const place = [v.city, countryName(v.country)].filter(Boolean).join(", ");
              const extra = [v.timeZone, v.language, v.screen && `${v.screen} window`].filter(Boolean).join(" · ");
              return (
                <li key={v.id} className="py-3 text-sm" data-visit={v.path}>
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-mono text-xs break-all">{v.path}</span>
                    {v.bot && <span className="rounded-md bg-warning/15 px-1.5 py-0.5 text-xs font-medium">Bot</span>}
                    <span className="text-muted">·</span>
                    {v.username ? (
                      v.userId !== null ? (
                        <Link href={`/admin/users/${v.userId}`} className="font-semibold hover:underline">
                          {v.username}
                        </Link>
                      ) : (
                        <span className="font-semibold">
                          {v.username} <span className="font-normal text-muted">(deleted)</span>
                        </span>
                      )
                    ) : (
                      <span className="text-muted">Guest</span>
                    )}
                    <Link
                      href={href({ visitor: v.visitorId, user: undefined, before: undefined })}
                      className="font-mono text-xs text-muted hover:underline"
                      title="Show everything from this browser"
                    >
                      {v.visitorId.slice(0, 8)}
                    </Link>
                  </p>
                  <p className="mt-0.5 text-xs break-words text-muted">
                    <time dateTime={new Date(v.at).toISOString()} title={formatDateTime(v.at, tz)}>
                      {timeAgo(v.at, now, tz)}
                    </time>
                    {` · ${describeDevice(v.userAgent)}`}
                    {place && ` · ${place}`}
                    {v.ip && (
                      <>
                        {" · "}
                        <Link href={search(v.ip)} className="hover:underline">
                          {v.ip}
                        </Link>
                      </>
                    )}
                    {v.network && ` · ${v.network}`}
                  </p>
                  {(v.referrer || extra) && (
                    <p className="mt-0.5 text-xs break-words text-muted">
                      {v.referrer && `From ${v.referrer}`}
                      {v.referrer && extra && " · "}
                      {extra}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        )}
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
