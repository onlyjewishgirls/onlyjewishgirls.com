import Link from "next/link";

/** data-export-*: a tile exports as one field, "Label: value (note)" (PORTAL-STANDARD §11). */
export function StatTile({ label, value, note, href }: { label: string; value: string; note?: string; href?: string }) {
  const body = (
    <>
      <p className="text-sm text-muted" data-export-label="">
        {label}
      </p>
      <p className="mt-1 text-3xl font-semibold tracking-tight" data-export-text={note ? `${value} (${note})` : value}>
        {value}
      </p>
      {note && (
        <p className="mt-1 text-xs text-muted" data-export-skip="">
          {note}
        </p>
      )}
    </>
  );
  return href ? (
    <Link href={href} className="panel block transition hover:border-brand/50" data-export-field={label}>
      {body}
    </Link>
  ) : (
    <div className="panel" data-export-field={label}>
      {body}
    </div>
  );
}
