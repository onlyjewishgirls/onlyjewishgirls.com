import { ROLE_LABELS, type Role } from "@/lib/admin/permissions";

/** Status chips: always an icon or word next to the color, never color alone. */
export function AccountBadges({
  role,
  suspended,
  locked,
  twoStepComplete,
  mustChangePassword,
}: {
  role: Role;
  suspended: boolean;
  locked?: boolean;
  twoStepComplete: boolean;
  mustChangePassword: boolean;
}) {
  return (
    <span className="flex flex-wrap gap-1">
      {role !== "member" && <span className="badge border-brand/40 bg-brand-soft text-brand">★ {ROLE_LABELS[role]}</span>}
      {suspended && <span className="badge border-danger/40 bg-danger/10 text-danger">⛔ Suspended</span>}
      {locked && <span className="badge border-warning/40 bg-warning/10 text-warning">🔒 Locked out</span>}
      {!twoStepComplete && <span className="badge border-warning/40 bg-warning/10 text-warning">⚠ Two-step not finished</span>}
      {mustChangePassword && <span className="badge text-muted">🔑 Temporary password</span>}
    </span>
  );
}
