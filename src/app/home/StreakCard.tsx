"use client";

import { useEffect, useState } from "react";
import type { ActivityOutcome } from "@/lib/streak/engine";

export interface StreakCardProps {
  count: number;
  longest: number;
  deadline: number | null;
  /** Shabbat / Yom Tov periods the deadline was moved past. */
  leeway: { names: string[] }[];
  graceHours: number;
  /** The streak change from today's first check-in. */
  today: { outcome: Exclude<ActivityOutcome, "same-day">; added: number; previousCount: number } | null;
  serverNow: number;
  atRiskMs: number;
}

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function banner(today: StreakCardProps["today"]) {
  switch (today?.outcome) {
    case "started":
      return "Your streak has started! Check in again within 30 hours to keep it going.";
    case "restarted":
      return `Your ${today.previousCount}-day streak ended — a new one starts today. You've got this.`;
    case "continued":
      return today.added > 1
        ? `Streak extended! +${today.added} days — Shabbat / Yom Tov counted.`
        : "Streak extended! ✓ Checked in for today.";
    default:
      return "✓ Checked in for today.";
  }
}

export function StreakCard(props: StreakCardProps) {
  const [now, setNow] = useState(props.serverNow);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const remaining = props.deadline === null ? null : props.deadline - now;
  const alive = remaining !== null && remaining > 0;
  const atRisk = alive && remaining < props.atRiskMs;
  const count = alive ? props.count : 0;

  return (
    <section
      aria-label="Your streak"
      data-testid="streak-card"
      className="card relative overflow-hidden text-center"
    >
      <div className="pointer-events-none absolute inset-x-0 -top-24 mx-auto h-48 w-48 rounded-full bg-fire/20 blur-3xl" />
      <p className="text-sm font-medium uppercase tracking-widest text-muted">Your streak</p>
      <div className="mt-2 flex items-center justify-center gap-3">
        <span className={`text-6xl ${alive ? "flame" : "grayscale"}`} aria-hidden>
          🔥
        </span>
        <span data-testid="streak-count" className="text-7xl font-black tabular-nums">
          {count}
        </span>
        {atRisk && (
          <span className="text-5xl" title="Your streak is about to expire">
            ⌛
          </span>
        )}
      </div>
      <p className="mt-1 text-lg font-semibold">{count === 1 ? "day" : "days"}</p>

      <p data-testid="streak-banner" className="mx-auto mt-4 max-w-md rounded-full bg-brand-soft px-4 py-1.5 text-sm">
        {banner(props.today)}
      </p>

      {alive && props.deadline !== null ? (
        <div className={`mt-6 ${atRisk ? "text-danger" : ""}`}>
          <p className="text-sm text-muted">Check in again within</p>
          <p className="font-mono text-3xl font-bold tabular-nums" suppressHydrationWarning>
            {formatRemaining(remaining!)}
          </p>
          <p className="mt-1 text-sm text-muted" suppressHydrationWarning>
            by{" "}
            {new Date(props.deadline).toLocaleString(undefined, {
              weekday: "long",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </p>
        </div>
      ) : (
        <p className="mt-6 text-danger">Your streak expired. Reload the page to start a new one.</p>
      )}

      {alive &&
        props.leeway.map((l) => (
          <p key={l.names.join()} className="mx-auto mt-3 max-w-md text-sm text-muted">
            Moved past <strong>{l.names.join(" · ")}</strong>: your deadline is {props.graceHours} hours after it
            ends, never during it.
          </p>
        ))}

      <p className="mt-6 text-sm text-muted">
        Longest streak: <strong className="text-foreground">{props.longest}</strong> {props.longest === 1 ? "day" : "days"}
      </p>
    </section>
  );
}
