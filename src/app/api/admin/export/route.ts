import { ROLE_LABELS } from "@/lib/admin/permissions";
import { allUsersForExport, recentlyVerified, requireAdminApi } from "@/server/admin";
import { logEvent } from "@/server/events";
import { api, jsonError } from "@/server/http";

const iso = (ms: number | null) => (ms === null ? "" : new Date(ms).toISOString());

/** Spreadsheet apps run cells starting with these as formulas. */
function cell(value: string | number | null): string {
  let text = value === null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Every account as a CSV file. It's everyone's personal details, so it needs a fresh second factor too. */
export const POST = api(async () => {
  const guard = await requireAdminApi();
  if (!guard.ok) return guard.response;
  if (!recentlyVerified(guard.ctx.session)) return jsonError(403, "Confirm it's you to export.", { verify: true });
  const rows = await allUsersForExport();
  const header = [
    "id", "username", "first_name", "middle_name", "last_name", "email", "phone", "role", "status",
    "suspended_reason", "created", "last_sign_in", "last_active", "streak", "longest_streak", "passkeys",
    "authenticator_app", "recovery_codes_left", "time_zone", "country",
  ];
  const lines = rows.map(({ user: u, passkeys, recoveryCodesLeft }) =>
    [
      u.id, u.username, u.firstName, u.middleName, u.lastName, u.email, u.phone, ROLE_LABELS[u.role],
      u.suspendedAt === null ? "active" : "suspended", u.suspendedReason, iso(u.createdAt), iso(u.lastLoginAt),
      iso(u.streak.lastActivityAt), u.streak.count, u.streak.longest, passkeys, u.totpEnabledAt === null ? "no" : "yes",
      recoveryCodesLeft, u.timeZone, u.country,
    ].map(cell).join(","),
  );
  await logEvent("admin.export", { actor: guard.ctx.user, detail: { accounts: rows.length } });
  const date = new Date().toISOString().slice(0, 10);
  return new Response(`${[header.join(","), ...lines].join("\r\n")}\r\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="onlyjewishgirls-accounts-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
});
