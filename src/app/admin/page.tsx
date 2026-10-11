import type { Metadata } from "next";
import Link from "next/link";
import { DailyBars } from "@/components/admin/DailyBars";
import { EventList } from "@/components/admin/EventList";
import { compactNumber, fullName } from "@/lib/admin/format";
import { dashboardStats, requireAdminPage } from "@/server/admin";
import { cfEnv } from "@/server/env";

export const metadata: Metadata = { title: "Admin · OnlyJewishGirls", robots: { index: false } };

function StatTile({ label, value, note, href }: { label: string; value: string; note?: string; href?: string }) {
  const body = (
    <>
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-1 text-3xl font-semibold tracking-tight">{value}</p>
      {note && <p className="mt-1 text-xs text-muted">{note}</p>}
    </>
  );
  return href ? (
    <Link href={href} className="panel block transition hover:border-brand/50">
      {body}
    </Link>
  ) : (
    <div className="panel">{body}</div>
  );
}

export default async function AdminOverviewPage() {
  const { user, now } = await requireAdminPage();
  const stats = await dashboardStats(user.timeZone, now);
  const env = cfEnv();

  const incomplete = stats.totalUsers - stats.twoStepComplete;
  const warnings: { text: string; href?: string }[] = [];
  if (!env.EMAIL_API_KEY || !env.EMAIL_FROM) {
    warnings.push({ text: "Emails aren't set up, so password reset links can't be sent. Add EMAIL_API_KEY and EMAIL_FROM to the Worker." });
  }
  if (stats.lockedNow > 0) {
    warnings.push({
      text: `${stats.lockedNow} account${stats.lockedNow === 1 ? " is" : "s are"} locked out after too many wrong attempts.`,
      href: "/admin/users?filter=locked",
    });
  }
  if (stats.failedSignIns24h >= 10) {
    warnings.push({
      text: `${stats.failedSignIns24h} failed sign-in attempts in the last 24 hours.`,
      href: "/admin/activity?group=signin",
    });
  }
  if (incomplete > 0) {
    warnings.push({
      text: `${incomplete} account${incomplete === 1 ? " hasn't" : "s haven't"} finished setting up two-step sign-in.`,
      href: "/admin/users?filter=incomplete",
    });
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Overview</h1>

      {warnings.length > 0 && (
        <section aria-label="Needs attention" className="space-y-2">
          {warnings.map((w) => (
            <div key={w.text} className="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
              <span aria-hidden>⚠️</span>
              <p className="flex-1">
                <span className="sr-only">Warning: </span>
                {w.text}
              </p>
              {w.href && (
                <Link href={w.href} className="link shrink-0">
                  View
                </Link>
              )}
            </div>
          ))}
        </section>
      )}

      <section aria-label="Key numbers" className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatTile
          label="Accounts"
          value={compactNumber(stats.totalUsers)}
          note={`${stats.newUsers.day} new today · ${stats.newUsers.week} this week`}
          href="/admin/users"
        />
        <StatTile
          label="Active in the last 24 hours"
          value={compactNumber(stats.activeUsers.day)}
          note={`${stats.activeUsers.week} in the last 7 days`}
          href="/admin/users?sort=last_active"
        />
        <StatTile label="Signed in now" value={compactNumber(stats.liveSessions)} note="Live sessions on all devices" />
        <StatTile
          label="Two-step sign-in finished"
          value={stats.totalUsers === 0 ? "—" : `${Math.round((stats.twoStepComplete / stats.totalUsers) * 100)}%`}
          note={`${stats.twoStepComplete} of ${stats.totalUsers} accounts`}
          href="/admin/users?filter=incomplete"
        />
        <StatTile
          label="Failed sign-ins (24 hours)"
          value={compactNumber(stats.failedSignIns24h)}
          note={`${stats.lockouts24h} lockout${stats.lockouts24h === 1 ? "" : "s"}`}
          href="/admin/activity?group=signin"
        />
        <StatTile
          label="Suspended"
          value={compactNumber(stats.suspended)}
          note={`${stats.admins} admin${stats.admins === 1 ? "" : "s"} including you`}
          href="/admin/users?filter=suspended"
        />
      </section>

      <section aria-label="Last 30 days" className="grid gap-3 lg:grid-cols-2">
        <DailyBars title="New accounts per day" unit="new accounts" data={stats.signupsByDay} />
        <DailyBars title="People active per day" unit="people active" data={stats.activeByDay} />
      </section>

      <div className="grid gap-3 lg:grid-cols-5">
        <section className="panel lg:col-span-2" aria-labelledby="streaks-title">
          <h2 id="streaks-title" className="mb-3 font-semibold">
            🔥 Longest live streaks
          </h2>
          {stats.topStreaks.length === 0 ? (
            <p className="text-sm text-muted">No live streaks right now.</p>
          ) : (
            <ol className="space-y-2 text-sm">
              {stats.topStreaks.map(({ user: u, status }, i) => (
                <li key={u.id} className="flex items-center gap-3">
                  <span className="tabular w-5 text-muted">{i + 1}.</span>
                  <Link href={`/admin/users/${u.id}`} className="min-w-0 flex-1 truncate hover:underline">
                    <span className="font-medium">{u.username}</span>{" "}
                    <span className="text-muted">{fullName(u)}</span>
                  </Link>
                  <span className="tabular font-semibold">
                    {status.count} {status.atRisk ? "⌛" : "🔥"}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="panel lg:col-span-3" aria-labelledby="recent-title">
          <div className="mb-1 flex items-baseline justify-between">
            <h2 id="recent-title" className="font-semibold">
              Recent activity
            </h2>
            <Link href="/admin/activity" className="link text-sm">
              See all
            </Link>
          </div>
          <EventList events={stats.recentEvents} timeZone={user.timeZone} now={now} />
        </section>
      </div>
    </div>
  );
}
