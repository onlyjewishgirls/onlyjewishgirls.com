"use client";

import { useState } from "react";

/** A temporary password, shown this once. */
export function TemporaryPassword({ password, username }: { password: string; username: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-3">
      <p className="text-sm">
        Give <strong>{username}</strong> this temporary password. It won&apos;t be shown again. After signing in with it, they
        confirm it&apos;s them with two-step sign-in and then choose their own password.
      </p>
      <div className="flex items-center gap-2 rounded-xl border border-border bg-background p-3">
        <code data-testid="temporary-password" className="flex-1 font-mono text-lg break-all select-all">
          {password}
        </code>
        <button
          type="button"
          className="btn-secondary btn-sm shrink-0"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(password);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
    </div>
  );
}
