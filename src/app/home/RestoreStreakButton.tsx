"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { FormError } from "@/components/AuthCard";
import { postJson } from "@/lib/api-client";

export function RestoreStreakButton({ to, left, allowance }: { to: number; left: number; allowance: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function restore() {
    setBusy(true);
    setError(null);
    const res = await postJson<{ message?: string }>("/api/streak/restore");
    setBusy(false);
    if (res.ok) {
      setDone(res.data.message ?? "Streak restored.");
      router.refresh();
    } else setError(res.data.error ?? `The server answered ${res.status}.`);
  }

  if (done) return <p role="status" className="text-sm text-success">{done}</p>;
  return (
    <div className="space-y-2" data-testid="restore-streak">
      <button type="button" className="btn-primary w-full py-3" onClick={restore} disabled={busy || left === 0}>
        {busy ? "Restoring…" : `Restore my streak (${left} of ${allowance} left this month)`}
      </button>
      <p className="text-xs text-muted">Puts your streak back to {to} days.</p>
      <FormError message={error} />
    </div>
  );
}
