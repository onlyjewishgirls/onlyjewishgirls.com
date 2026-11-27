import type { Metadata } from "next";
import Link from "next/link";
import { ENDS_AFTER_SUNSET_MINUTES, STARTS_BEFORE_SUNSET_MINUTES, holyPeriods } from "@/lib/streak/calendar";
import { dueDayLabel } from "@/lib/streak/dates";
import { AFTER_HOLY_DAY_HOURS, AT_RISK_HOURS, STREAK_WINDOW_HOURS, computeDeadline } from "@/lib/streak/engine";
import { requirePage } from "@/server/guards";
import { getSettings } from "@/server/settings";
import { checkIn, currentRestorePlan, restoreQuota } from "@/server/streak";
import { findUserById } from "@/server/users";
import { RestoreStreakButton } from "./RestoreStreakButton";
import { StreakCard } from "./StreakCard";

export const metadata: Metadata = { title: "Home · OnlyJewishGirls" };

const DAY = 86_400_000;

export default async function HomePage() {
  const { user } = await requirePage("/home");
  const { status, today, place, now, calendar } = await checkIn(user);
  const { weekendGrace, calendarDays } = calendar.rules;
  // Courtesy restore (PORTAL-STANDARD §4): offered whenever restorePlan() finds something to put back.
  const fresh = (await findUserById(user.id)) ?? user;
  const plan = currentRestorePlan(fresh, await getSettings(), now);
  // A restore that restarts the window does so from now.
  const restoredDue = plan ? computeDeadline(plan.state.lastActivityAt ?? now, calendar).dueDate : null;
  const tzLabel = place.timeZone.replace(/_/g, " ");
  const quota = plan ? await restoreQuota(user.id, now) : null;
  const allowance = quota ? (quota.perMonth === 0 ? quota.extra : quota.perMonth + quota.extra) : 0;
  const next = holyPeriods(place, now, now + 8 * DAY).find((p) => p.end > now);
  const at = (instant: number) =>
    new Date(instant).toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: place.timeZone,
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
        timeZone={place.timeZone}
        dueDate={status.dueDate}
        wholeDays={calendarDays}
        today={
          fresh.streakLastEvent?.restored
            ? { outcome: "restored", added: 0, previousCount: fresh.streakLastEvent.previousCount }
            : today && { outcome: today.outcome, added: today.added, previousCount: today.previousCount }
        }
        serverNow={now}
        atRiskMs={AT_RISK_HOURS * 3_600_000}
      />

      {plan && quota && allowance > 0 && (
        <section className="card">
          <RestoreStreakButton
            to={plan.to}
            left={quota.left}
            allowance={allowance}
            until={restoredDue && dueDayLabel(restoredDue)}
          />
        </section>
      )}

      <section className="card space-y-3">
        <h2 className="text-lg font-semibold">How your 🔥 streak works</h2>
        <ul className="list-disc space-y-2 pl-5 text-muted" data-testid="streak-rules">
          {calendarDays ? (
            <li>
              Check in once on every <strong className="text-foreground">required day</strong>:{" "}
              {weekendGrace ? "Monday to Thursday" : "Sunday to Friday"}, unless it&apos;s Yom Tov. You have until the{" "}
              <strong className="text-foreground">end of the next required day in your time zone</strong> ({tzLabel}),
              so {weekendGrace ? "any time Thursday, then any time Monday," : "any time one day, then any time the next,"}{" "}
              keeps it. Signing in, or just opening the site while signed in, counts.
            </li>
          ) : (
            <li>
              Check in at least once every <strong className="text-foreground">{STREAK_WINDOW_HOURS} hours</strong>.
              Signing in, or just opening the site while signed in, counts.
            </li>
          )}
          <li>
            <strong className="text-foreground">
              {weekendGrace ? "Friday, Shabbat, Sunday and Yom Tov are grace days." : "Shabbat and Yom Tov are grace days."}
            </strong>{" "}
            Skipping one never breaks your streak
            {weekendGrace ? ", and checking in on a Friday or Sunday still adds a day." : "."}
          </li>
          {!calendarDays && (
            <li>
              <strong className="text-foreground">Your deadline never falls on Shabbat or Yom Tov.</strong> When one
              comes up, including a 2- or 3-day Yom Tov, your deadline moves to at least {AFTER_HOLY_DAY_HOURS} hours
              after it ends. Times are based on sunset where you are, from {STARTS_BEFORE_SUNSET_MINUTES} minutes before
              sunset until {ENDS_AFTER_SUNSET_MINUTES} minutes after.
            </li>
          )}
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

      <p className="text-center text-sm">
        <Link href="/change-password" className="link">
          Change password
        </Link>
      </p>
    </div>
  );
}
