"use client";

import { useId, useState } from "react";

export interface DailyPoint {
  date: string; // YYYY-MM-DD
  count: number;
}

const dayLabel = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** Rounds the top of the scale up to 1, 2 or 5 × 10ⁿ so the ticks are clean numbers. */
function niceMax(max: number): number {
  if (max <= 4) return 4;
  const power = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 5, 10]) if (step * power >= max) return step * power;
  return 10 * power;
}

/**
 * One series of daily counts as columns. Single series, so no legend: the
 * title names it. Each column is focusable and shows its value on hover or
 * focus; the table view has every number without hovering.
 */
export function DailyBars({ title, unit, data }: { title: string; unit: string; data: DailyPoint[] }) {
  const [active, setActive] = useState<number | null>(null);
  const id = useId();
  const total = data.reduce((sum, d) => sum + d.count, 0);
  const top = niceMax(Math.max(...data.map((d) => d.count), 0));
  const ticks = [top, top / 2, 0];
  const today = data[data.length - 1];

  return (
    <figure className="panel" aria-labelledby={`${id}-title`}>
      <figcaption className="mb-4 flex items-baseline justify-between gap-3">
        <span id={`${id}-title`} className="font-semibold">
          {title}
        </span>
        <span className="text-sm text-muted">
          <strong className="text-foreground">{total.toLocaleString("en-US")}</strong> in {data.length} days ·{" "}
          {today?.count ?? 0} today
        </span>
      </figcaption>

      <div className="flex gap-2">
        {/* Y axis */}
        <div className="tabular flex h-36 flex-col justify-between text-right text-[11px] text-muted" aria-hidden>
          {ticks.map((t) => (
            <span key={t} className="-translate-y-1/2 leading-none first:translate-y-0 last:translate-y-0">
              {t.toLocaleString("en-US")}
            </span>
          ))}
        </div>

        <div className="relative h-36 flex-1">
          {/* Gridlines: hairline, solid, recessive. */}
          {ticks.map((t) => (
            <div
              key={t}
              aria-hidden
              className="absolute inset-x-0 border-t border-viz-grid"
              style={{ top: `${(1 - t / top) * 100}%` }}
            />
          ))}
          <div className="absolute inset-0 flex items-end gap-[2px]" role="list" aria-label={title}>
            {data.map((d, i) => (
              <button
                key={d.date}
                type="button"
                role="listitem"
                aria-label={`${dayLabel(d.date)}: ${d.count} ${unit}`}
                className="group relative flex h-full flex-1 items-end justify-center outline-none"
                onPointerEnter={() => setActive(i)}
                onPointerLeave={() => setActive((a) => (a === i ? null : a))}
                onFocus={() => setActive(i)}
                onBlur={() => setActive((a) => (a === i ? null : a))}
              >
                <span
                  className={`block w-full max-w-6 rounded-t-[4px] bg-viz-series transition-opacity ${
                    active !== null && active !== i ? "opacity-60" : ""
                  } group-focus-visible:ring-2 group-focus-visible:ring-brand/40`}
                  style={{ height: d.count === 0 ? 0 : `max(2px, ${(d.count / top) * 100}%)` }}
                />
                {active === i && (
                  <span
                    role="tooltip"
                    className={`pointer-events-none absolute bottom-full z-10 mb-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-left whitespace-nowrap shadow-md ${
                      i < data.length / 3 ? "left-0" : i > (data.length * 2) / 3 ? "right-0" : "left-1/2 -translate-x-1/2"
                    }`}
                  >
                    <span className="block text-sm font-semibold text-foreground">
                      {d.count.toLocaleString("en-US")} {unit}
                    </span>
                    <span className="block text-xs text-muted">{dayLabel(d.date)}</span>
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-2 flex justify-between pl-8 text-[11px] text-muted" aria-hidden>
        <span>{data[0] && dayLabel(data[0].date)}</span>
        <span>{today && dayLabel(today.date)}</span>
      </div>

      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-muted hover:text-foreground">Show as table</summary>
        <div className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-border">
          <table className="tabular w-full text-left text-sm">
            <thead className="sticky top-0 bg-surface text-xs text-muted">
              <tr>
                <th className="px-3 py-1.5 font-medium">Day</th>
                <th className="px-3 py-1.5 text-right font-medium">{unit[0].toUpperCase() + unit.slice(1)}</th>
              </tr>
            </thead>
            <tbody>
              {[...data].reverse().map((d) => (
                <tr key={d.date} className="border-t border-border">
                  <td className="px-3 py-1">{dayLabel(d.date)}</td>
                  <td className="px-3 py-1 text-right">{d.count.toLocaleString("en-US")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
