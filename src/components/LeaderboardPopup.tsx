"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { describeStanding, type Board } from "@/lib/streak/leaderboard";
import { LeaderboardList } from "./LeaderboardList";

/** The session the popup was last shown for, so it appears once per sign-in rather than on every visit. */
const STORAGE_KEY = "ojg-leaderboard-shown";

/**
 * The first thing members see after signing in: the streak leaderboard, over the home page.
 * A native <dialog>, so focus stays inside it, Escape closes it and the page behind is inert.
 * It's in the page (hidden) from the start and opened once the page is ready.
 */
export function LeaderboardPopup({ board, sessionKey }: { board: Board; sessionKey: number }) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element || element.open) return; // already open (React strict mode runs this twice in development)
    try {
      if (localStorage.getItem(STORAGE_KEY) === String(sessionKey)) return;
      localStorage.setItem(STORAGE_KEY, String(sessionKey));
    } catch {
      // Storage blocked: the popup then shows each time the home page loads, which beats never showing it.
    }
    element.showModal();
  }, [sessionKey]);

  const close = () => dialog.current?.close();

  return (
    <dialog
      ref={dialog}
      aria-labelledby="leaderboard-popup-title"
      data-testid="leaderboard-popup"
      // `open:flex`, not `flex`: a closed dialog must stay hidden. The list scrolls while the heading and buttons stay put.
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(30rem,calc(100%-2rem))] flex-col overflow-hidden rounded-2xl border border-border bg-surface p-0 text-foreground shadow-2xl backdrop:bg-black/50 open:flex"
      // Only a click on the dimmed backdrop lands on the dialog itself.
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="space-y-3 px-5 pt-5 sm:px-6 sm:pt-6">
        <div>
          <h2 id="leaderboard-popup-title" className="text-xl font-bold tracking-tight">
            🏆 Streak leaderboard
          </h2>
          <p className="mt-1 text-sm text-muted">The longest streaks going right now.</p>
        </div>
        <p className="rounded-xl bg-brand-soft px-3 py-2 text-sm font-medium" data-testid="leaderboard-standing">
          {describeStanding(board.you, board.total)}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-4">
        <LeaderboardList board={board} label="Top streaks" />
      </div>
      <div className="flex flex-wrap gap-2 border-t border-border px-5 py-4 sm:px-6">
        <button type="button" className="btn-primary" onClick={close}>
          Continue
        </button>
        <Link href="/leaderboard" className="btn-secondary">
          Full leaderboard
        </Link>
      </div>
    </dialog>
  );
}
