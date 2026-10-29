import type { Metadata } from "next";
import Link from "next/link";
import { LeaderboardList } from "@/components/LeaderboardList";
import { describeStanding } from "@/lib/streak/leaderboard";
import { AFTER_HOLY_DAY_HOURS, STREAK_WINDOW_HOURS } from "@/lib/streak/engine";
import { requirePage } from "@/server/guards";
import { leaderboardFor } from "@/server/leaderboard";
import { checkIn } from "@/server/streak";

export const metadata: Metadata = { title: "Streak leaderboard · OnlyJewishGirls", robots: { index: false } };

const SHOWN = 50;

export default async function LeaderboardPage() {
  const { user } = await requirePage("/home");
  // Opening the site while signed in counts as a check-in, here as on the home page.
  const { status, now } = await checkIn(user);
  const board = await leaderboardFor({ id: user.id, username: user.username, streak: status.count }, SHOWN, now);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-10">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">🏆 Streak leaderboard</h1>
        <p className="mt-1 text-muted">The longest streaks going right now.</p>
      </div>

      <p className="rounded-xl bg-brand-soft px-4 py-3 font-medium" data-testid="leaderboard-standing">
        {describeStanding(board.you, board.total)}
      </p>

      <section className="card" aria-label="Leaderboard">
        <LeaderboardList board={board} label="Longest streaks" />
        {board.total !== null && board.total > board.top.length && (
          <p className="mt-3 text-center text-sm text-muted">
            Showing the top {board.top.length} of {board.total} live streaks.
          </p>
        )}
      </section>

      <section className="card space-y-2 text-sm text-muted">
        <h2 className="text-base font-semibold text-foreground">How the leaderboard works</h2>
        <ul className="list-disc space-y-1.5 pl-5">
          <li>Only streaks that are still alive are ranked, and only usernames are shown.</li>
          <li>
            Check in at least every <strong className="text-foreground">{STREAK_WINDOW_HOURS} hours</strong> to stay on.
            Shabbat and Yom Tov never count against you: your deadline moves to at least {AFTER_HOLY_DAY_HOURS} hours
            after they end.
          </li>
          <li>Equal streaks share a rank. The list refreshes about once a minute; your own row is always current.</li>
        </ul>
      </section>

      <p className="text-center text-sm">
        <Link href="/home" className="link">
          ← Back to home
        </Link>
      </p>
    </div>
  );
}
