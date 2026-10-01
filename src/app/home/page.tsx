import type { Metadata } from "next";
import { nextMultiDayYomTov } from "@/lib/streak/calendar";
import { localDate } from "@/lib/streak/dates";
import { AT_RISK_HOURS, STREAK_WINDOW_HOURS, YOM_TOV_EXTRA_DAY_HOURS } from "@/lib/streak/engine";
import { requirePage } from "@/server/guards";
import { checkIn } from "@/server/streak";
import { StreakCard } from "./StreakCard";

export const metadata: Metadata = { title: "Home · OnlyJewishGirls" };

function formatDates(dates: string[]) {
  const fmt = (d: string) =>
    new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  return dates.length > 1 ? `${fmt(dates[0])} – ${fmt(dates[dates.length - 1])}` : fmt(dates[0]);
}

export default async function HomePage() {
  const { user } = await requirePage("/home");
  const { status, today, israel, now } = await checkIn(user);
  const upcoming = nextMultiDayYomTov(localDate(now, user.timeZone), israel);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-10">
      <h1 className="text-3xl font-bold tracking-tight">Hi {user.firstName} 👋</h1>

      <StreakCard
        count={status.count}
        longest={status.longest}
        deadline={status.deadline}
        leeway={status.leeway.map(({ names, extraHours }) => ({ names, extraHours }))}
        today={today && { outcome: today.outcome, added: today.added, previousCount: today.previousCount }}
        serverNow={now}
        atRiskMs={AT_RISK_HOURS * 3_600_000}
      />

      <section className="card space-y-3">
        <h2 className="text-lg font-semibold">How your 🔥 streak works</h2>
        <ul className="list-disc space-y-2 pl-5 text-muted">
          <li>
            Check in at least once every <strong className="text-foreground">{STREAK_WINDOW_HOURS} hours</strong> — signing in
            or just opening the site while signed in both count. That&apos;s enough to cover Shabbat if you check in Friday
            afternoon and again after Havdalah.
          </li>
          <li>
            For a <strong className="text-foreground">2-day Yom Tov</strong> you get an extra {YOM_TOV_EXTRA_DAY_HOURS} hours,
            and for a <strong className="text-foreground">3-day Yom Tov</strong> (Yom Tov running into Shabbat) an extra{" "}
            {YOM_TOV_EXTRA_DAY_HOURS * 2} hours. Just check in on Erev Yom Tov.
          </li>
          <li>Each new day you check in adds one day. Shabbat and Yom Tov count automatically.</li>
          <li>When fewer than {AT_RISK_HOURS} hours are left you&apos;ll see a ⌛ — check in before it runs out!</li>
        </ul>
        <p className="text-sm text-muted">
          You&apos;re on the <strong className="text-foreground">{israel ? "Israel" : "Diaspora"}</strong> Yom Tov schedule
          (based on your time zone, {user.timeZone}).
          {upcoming && (
            <>
              {" "}
              Next Yom Tov leeway: <strong className="text-foreground">{upcoming.names.join(" · ")}</strong> (
              {formatDates(upcoming.dates)}, +{(upcoming.dates.length - 1) * YOM_TOV_EXTRA_DAY_HOURS}h).
            </>
          )}
        </p>
      </section>

      <section className="card text-center text-muted">
        <p className="text-lg font-semibold text-foreground">More is coming soon ✨</p>
        <p className="mt-1">Keep your streak alive — you&apos;ll be the first to see what&apos;s next.</p>
      </section>
    </div>
  );
}
