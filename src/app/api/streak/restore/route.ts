import { NextResponse } from "next/server";
import { api, fail } from "@/server/http";
import { getAuth } from "@/server/session";
import { selfRestore } from "@/server/streak";

/** "Restore my streak": a courtesy restore, N per calendar month (PORTAL-STANDARD §4). */
export const POST = api(async () => {
  const ctx = await getAuth();
  if (!ctx || ctx.session.stage !== "full") return fail(401, "unauthenticated", "Your sign-in expired. Sign in again.", null, { next: "/login" });
  const result = await selfRestore(ctx.user);
  if (!result.ok) return fail(409, result.code, result.error);
  return NextResponse.json({
    ok: true,
    from: result.from,
    to: result.to,
    left: result.quota.left,
    message: `Streak restored to ${result.to}. ${result.quota.left} restore${result.quota.left === 1 ? "" : "s"} left in ${result.quota.month}.`,
  });
});
