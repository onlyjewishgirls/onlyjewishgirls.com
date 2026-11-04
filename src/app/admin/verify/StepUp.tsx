"use client";

import { useState } from "react";
import { VerifyDialog } from "@/components/admin/AdminActions";

/** The console's "Re-verify" target (step_up_required): a passkey or authenticator check, then back. */
export function StepUp({ hasPasskey, hasTotp, next }: { hasPasskey: boolean; hasTotp: boolean; next: string }) {
  const [cancelled, setCancelled] = useState(false);
  if (cancelled) {
    return (
      <div className="card space-y-3">
        <p>Not verified. Changes in the console stay locked until you confirm it&apos;s you.</p>
        <div className="flex gap-2">
          <button type="button" className="btn-primary" onClick={() => setCancelled(false)}>
            Try again
          </button>
          <a href={next} className="btn-secondary">
            Back to the console
          </a>
        </div>
      </div>
    );
  }
  return (
    <VerifyDialog
      hasPasskey={hasPasskey}
      hasTotp={hasTotp}
      onDone={(ok) => (ok ? window.location.assign(next) : setCancelled(true))}
    />
  );
}
