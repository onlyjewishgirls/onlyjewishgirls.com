import type { Board, BoardRow } from "@/lib/streak/leaderboard";

const MEDALS: Record<number, string> = { 1: "🥇", 2: "🥈", 3: "🥉" };

function Row({ row, atLeast = false }: { row: BoardRow; atLeast?: boolean }) {
  const medal = MEDALS[row.rank];
  return (
    <li
      data-rank={row.rank}
      data-username={row.username}
      data-you={row.you ? "true" : undefined}
      className={`flex items-center gap-3 rounded-xl px-3 py-2 ${row.you ? "bg-brand-soft ring-1 ring-brand/40" : ""}`}
    >
      <span className="tabular w-10 shrink-0 text-center text-sm font-semibold text-muted">
        {medal ? (
          <>
            <span aria-hidden className="text-lg">
              {medal}
            </span>
            <span className="sr-only">{row.rank}</span>
          </>
        ) : (
          <>
            {row.rank}
            {atLeast && "+"}
          </>
        )}
      </span>
      <span className="min-w-0 flex-1 truncate font-medium" title={row.username}>
        {row.username}
      </span>
      {row.you && <span className="badge shrink-0">You</span>}
      <span className="tabular shrink-0 font-semibold">
        {row.days}
        <span className="font-normal text-muted"> {row.days === 1 ? "day" : "days"}</span>
      </span>
    </li>
  );
}

/** The longest live streaks, with the viewer's own row added underneath if they aren't in the list. */
export function LeaderboardList({ board, label }: { board: Board; label: string }) {
  if (board.top.length === 0) {
    return <p className="text-sm text-muted">No live streaks yet. Check in to be the first!</p>;
  }
  return (
    <ol aria-label={label} data-testid="leaderboard-list" className="space-y-1">
      {board.top.map((row) => (
        <Row key={row.username} row={row} />
      ))}
      {board.you && !board.youInTop && (
        <>
          <li aria-hidden className="text-center leading-none text-muted">
            ⋮
          </li>
          <Row row={board.you} atLeast={board.you.atLeast} />
        </>
      )}
    </ol>
  );
}
