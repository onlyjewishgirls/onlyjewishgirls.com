import Link from "next/link";

export function StatTile({ label, value, note, href }: { label: string; value: string; note?: string; href?: string }) {
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
