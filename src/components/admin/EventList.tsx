import Link from "next/link";
import { eventLabel, isWarningEvent } from "@/lib/admin/events";
import { countryName, describeDevice, formatDateTime, timeAgo } from "@/lib/admin/format";
import type { AdminEvent } from "@/server/admin";
import { UndoButton } from "./UndoButton";

const METHOD_LABELS: Record<string, string> = {
  passkey: "with a passkey",
  totp: "with the authenticator app",
  recovery_code: "with a recovery code",
  first_setup: "while setting up two-step sign-in",
};

/** One plain-English line of extra detail, when the event has any worth showing. */
function describeDetail(event: AdminEvent): string | null {
  const d = event.detail;
  if (!d) return null;
  if (typeof d.method === "string" && event.type === "signin.complete") return METHOD_LABELS[d.method] ?? null;
  if (typeof d.method === "string" && event.type === "signin.mfa_failed") {
    return `${d.method === "totp" ? "Authenticator code" : d.method === "passkey" ? "Passkey" : "Recovery code"}${d.context === "admin" ? " (admin re-check)" : ""}`;
  }
  if (typeof d.identifier === "string") return `Typed “${d.identifier}”`;
  if (typeof d.reason === "string" && d.reason) return `Reason: ${d.reason}`;
  if (Array.isArray(d.changed)) return `Changed: ${d.changed.join(", ").replace(/([A-Z])/g, " $1").toLowerCase()}`;
  if (typeof d.from !== "undefined" && typeof d.to !== "undefined") return `${String(d.from)} → ${String(d.to)}`;
  if (typeof d.count === "number" && event.type.startsWith("streak.")) return `Now ${d.count} day${d.count === 1 ? "" : "s"}`;
  if (typeof d.accounts === "number") return `${d.accounts} accounts`;
  if (typeof d.sessions === "number") return `${d.sessions} session${d.sessions === 1 ? "" : "s"} ended`;
  if (typeof d.change === "string") return `Undid: ${eventLabel(d.change).toLowerCase()}`;
  if (d.forced === true) return "After an admin set a temporary password";
  return null;
}

function Person({ id, name }: { id: number | null; name: string | null }) {
  if (!name) return <span className="text-muted">Someone</span>;
  return id !== null ? (
    <Link href={`/admin/users/${id}`} className="font-semibold hover:underline">
      {name}
    </Link>
  ) : (
    <span className="font-semibold" title="This account was deleted">
      {name} <span className="font-normal text-muted">(deleted)</span>
    </span>
  );
}

export function EventList({
  events,
  timeZone,
  now,
  canUndo = false,
  empty = "Nothing yet.",
}: {
  events: AdminEvent[];
  timeZone: string;
  now: number;
  canUndo?: boolean;
  empty?: string;
}) {
  if (events.length === 0) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <ol className="divide-y divide-border">
      {events.map((event) => {
        const warning = isWarningEvent(event.type);
        const byAdmin = event.type.startsWith("admin.") && event.actorUsername && event.actorId !== event.userId;
        const detail = describeDetail(event);
        const where = [describeDevice(event.userAgent), countryName(event.country), event.ip].filter(Boolean).join(" · ");
        return (
          <li key={event.id} className="flex gap-3 py-3" data-event={event.type}>
            <span
              aria-hidden
              className={`mt-1.5 size-2 shrink-0 rounded-full ${warning ? "bg-danger" : event.type.startsWith("admin.") ? "bg-brand" : "bg-border"}`}
            />
            <div className="min-w-0 flex-1 text-sm">
              <p>
                {byAdmin ? (
                  <>
                    <Person id={event.actorId} name={event.actorUsername} />
                    <span className="text-muted"> → </span>
                    {event.username ? <Person id={event.userId} name={event.username} /> : <span>all accounts</span>}
                    <span className="text-muted">: </span>
                  </>
                ) : event.username ? (
                  <>
                    <Person id={event.userId} name={event.username} />
                    <span className="text-muted">: </span>
                  </>
                ) : event.actorUsername ? (
                  <>
                    <Person id={event.actorId} name={event.actorUsername} />
                    <span className="text-muted">: </span>
                  </>
                ) : null}
                <span className={warning ? "font-medium text-danger" : ""}>{eventLabel(event.type)}</span>
                {warning && <span className="sr-only"> (warning)</span>}
              </p>
              {detail && <p className="mt-0.5 text-muted">{detail}</p>}
              <p className="mt-0.5 text-xs break-words text-muted">
                <time dateTime={new Date(event.at).toISOString()} title={formatDateTime(event.at, timeZone)}>
                  {timeAgo(event.at, now, timeZone)}
                </time>
                {where && ` · ${where}`}
              </p>
              {event.revertedAt !== null && (
                <p className="mt-1 text-xs text-muted">
                  ↩︎ Undone by {event.revertedBy ?? "the owner"} {timeAgo(event.revertedAt, now, timeZone)}
                </p>
              )}
            </div>
            {canUndo && event.undoable && <UndoButton eventId={event.id} label={eventLabel(event.type)} />}
          </li>
        );
      })}
    </ol>
  );
}
