"use client";

import { useState } from "react";
import { useAdminActions } from "./AdminActions";

export function UndoButton({ eventId, label }: { eventId: number; label: string }) {
  const { act, notify } = useAdminActions();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn-secondary btn-sm h-fit shrink-0"
      disabled={busy}
      aria-label={`Undo: ${label}`}
      onClick={async () => {
        setBusy(true);
        const res = await act("/api/admin/revert", { eventId });
        setBusy(false);
        notify(res.ok ? "Change undone." : (res.data.error ?? "Couldn't undo that."), res.ok ? "success" : "error");
      }}
    >
      ↩︎ Undo
    </button>
  );
}
