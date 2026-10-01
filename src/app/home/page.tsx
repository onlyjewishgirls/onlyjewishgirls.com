import type { Metadata } from "next";
import { ENDS_AFTER_SUNSET_MINUTES, STARTS_BEFORE_SUNSET_MINUTES, holyPeriods } from "@/lib/streak/calendar";
import { AFTER_HOLY_DAY_HOURS, AT_RISK_HOURS, STREAK_WINDOW_HOURS } from "@/lib/streak/engine";
import { requirePage } from "@/server/guards";
import { checkIn } from "@/server/streak";
import { StreakCard } from "./StreakCard";

export const metadata: Metadata = { title: "Home · OnlyJewishGirls" };

const DAY = 86_400_000;

export default async function HomePage() {
  const { user } = await requirePage("/home");
  const { status, today, place, now } = await checkIn(user);
  const next = holyPeriods(place, now, now + 8 * DAY).find((p) => p.end > now);
  const at = (instant: number) =>
    new Date(instant).toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: user.timeZone,
    });

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-10">
      <h1 className="text-3xl font-bold tracking-tight">Hi {user.firstName} 👋</h1>

      <StreakCard
        count={status.count}
        longest={status.longest}
        deadline={status.deadline}
        leeway={status.leeway.map(({ names }) => ({ names }))}
        graceHours={AFTER_HOLY_DAY_HOURS}
        today={today && { outcome: today.outcome, added: today.added, previousCount: today.previousCount }}
        serverNow={now}
        atRiskMs={AT_RISK_HOURS * 3_600_000}
      />

      <section className="card space-y-3">
        <h2 className="text-lg font-semibold">How your 🔥 streak works</h2>
        <ul className="list-disc space-y-2 pl-5 text-muted">
          <li>
            Check in at least once every <strong className="text-foreground">{STREAK_WINDOW_HOURS} hours</strong>. Signing
            in, or just opening the site while signed in, counts.
          </li>
          <li>
            <strong className="text-foreground">Your deadline never falls on Shabbat or Yom Tov.</strong> When one comes
            up, including a 2- or 3-day Yom Tov, your deadline moves to at least {AFTER_HOLY_DAY_HOURS} hours after it
            ends. Times are based on sunset where you are, from {STARTS_BEFORE_SUNSET_MINUTES} minutes before sunset until{" "}
            {ENDS_AFTER_SUNSET_MINUTES} minutes after.
          </li>
          <li>Each new day you check in adds one day. Shabbat and Yom Tov days count automatically.</li>
          <li>When fewer than {AT_RISK_HOURS} hours are left you&apos;ll see a ⌛. Check in before it runs out!</li>
        </ul>
        <p className="text-sm text-muted">
          You&apos;re on the <strong className="text-foreground">{place.israel ? "Israel" : "Diaspora"}</strong> Yom Tov
          schedule.
          {next && (
            <>
              {" "}
              Next: <strong className="text-foreground">{next.names.join(" · ")}</strong>, from {at(next.start)} until{" "}
              {at(next.end)}
              {place.latitude === null && " (approximate, because we couldn't tell where you are)"}.
            </>
          )}
        </p>
      </section>

      <section className="card text-center text-muted">
        <p className="text-lg font-semibold text-foreground">More is coming soon ✨</p>
        <p className="mt-1">Keep your streak alive. You&apos;ll be the first to see what&apos;s next.</p>
      </section>
    </div>
  );
}
