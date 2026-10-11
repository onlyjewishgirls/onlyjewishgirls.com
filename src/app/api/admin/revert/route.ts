import { NextResponse } from "next/server";
import { canRevert } from "@/lib/admin/permissions";
import { recentlyVerified, requireAdminApi } from "@/server/admin";
import { applyUndo, parseUndo, undoAction } from "@/server/admin-undo";
import { first, run } from "@/server/db";
import { logEvent } from "@/server/events";
import { api, jsonError, readJson } from "@/server/http";
import { findUserById } from "@/server/users";

/** Undoes one admin change from the activity log. Owner only; each change can be undone once. */
export const POST = api(async (req) => {
  const guard = await requireAdminApi();
  if (!guard.ok) return guard.response;
  const { ctx } = guard;
  const actor = ctx.user;
  if (actor.role !== "owner") return jsonError(403, "Only the owner can undo changes.");

  const eventId = (await readJson(req)).eventId;
  if (!Number.isSafeInteger(eventId)) return jsonError(400, "Pick a change to undo.");
  const row = await first<{ id: number; type: string; user_id: number | null; undo: string | null; reverted_at: number | null }>(
    "SELECT id, type, user_id, undo, reverted_at FROM events WHERE id = ?",
    eventId as number,
  );
  const undo = parseUndo(row?.undo ?? null);
  if (!row || !undo) return jsonError(404, "That change can't be undone.");
  if (row.reverted_at !== null) return jsonError(409, "That change was already undone.");
  const target = row.user_id === null ? null : await findUserById(row.user_id);
  if (!target) return jsonError(404, "That account doesn't exist anymore.");
  if (!canRevert(actor, undoAction(undo), target)) return jsonError(403, "You can't undo changes to this account.");

  const now = Date.now();
  if (!recentlyVerified(ctx.session, now)) return jsonError(403, "Confirm it's you to make changes.", { verify: true });

  // Claimed first, so two clicks can't undo the same change twice.
  const claim = await run(
    "UPDATE events SET reverted_at = ?, reverted_by = ? WHERE id = ? AND reverted_at IS NULL",
    now,
    actor.username,
    row.id,
  );
  if (claim.changes !== 1) return jsonError(409, "That change was already undone.");
  let error: string | null;
  try {
    error = await applyUndo(target, undo);
  } catch (e) {
    await run("UPDATE events SET reverted_at = NULL, reverted_by = NULL WHERE id = ?", row.id);
    throw e;
  }
  if (error) {
    await run("UPDATE events SET reverted_at = NULL, reverted_by = NULL WHERE id = ?", row.id);
    return jsonError(409, error);
  }
  await logEvent("admin.revert", { user: target, actor, detail: { event: row.id, change: row.type }, now });
  return NextResponse.json({ ok: true, message: "Change undone." });
});
