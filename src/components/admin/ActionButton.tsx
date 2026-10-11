"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { FormError } from "@/components/AuthCard";
import type { AdminAction } from "@/lib/admin/permissions";
import { Modal, useAdminActions } from "./AdminActions";
import { TemporaryPassword } from "./TemporaryPassword";

export interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** An extra text box: a reason, or the username typed to confirm. */
  input?: { name: string; label: string; placeholder?: string; mustEqual?: string; optional?: boolean; multiline?: boolean };
}

/** Runs one admin action on an account, after an optional confirmation. */
export function ActionButton({
  userId,
  username,
  action,
  extra = {},
  label,
  confirm,
  variant = "secondary",
  small = false,
}: {
  userId: number;
  username: string;
  action: AdminAction;
  extra?: Record<string, unknown>;
  label: ReactNode;
  confirm?: ConfirmOptions;
  variant?: "primary" | "secondary" | "danger";
  small?: boolean;
}) {
  const router = useRouter();
  const { act, notify } = useAdminActions();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    const body = {
      userId,
      expectUsername: username,
      action,
      ...extra,
      ...(confirm?.input ? { [confirm.input.name]: value } : {}),
    };
    const res = await act("/api/admin/action", body);
    setBusy(false);
    if (!res.ok) {
      if (confirm) setError(res.data.error ?? "That didn't work.");
      else notify(res.data.error ?? "That didn't work.", "error");
      return;
    }
    setOpen(false);
    setValue("");
    if (typeof res.data.temporaryPassword === "string") setPassword(res.data.temporaryPassword);
    else notify(typeof res.data.message === "string" ? res.data.message : "Done.");
    if (typeof res.data.next === "string") router.push(res.data.next);
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run();
  };

  const input = confirm?.input;
  const ready = !input || input.optional || (input.mustEqual ? value.trim().toLowerCase() === input.mustEqual.toLowerCase() : value.trim().length > 0);
  const buttonClass = `${variant === "primary" ? "btn-primary" : variant === "danger" ? "btn-danger" : "btn-secondary"}${small ? " btn-sm" : ""}`;

  return (
    <>
      <button
        type="button"
        className={buttonClass}
        disabled={busy}
        data-action={action}
        onClick={() => (confirm ? setOpen(true) : run())}
      >
        {busy && !confirm ? "Working…" : label}
      </button>

      {open && confirm && (
        <Modal title={confirm.title} onClose={() => setOpen(false)} labelledBy={`confirm-${action}`}>
          <form onSubmit={submit} className="space-y-4">
            <div className="text-sm text-muted">{confirm.body}</div>
            {input && (
              <div>
                <label htmlFor={`confirm-${action}-input`} className="label">
                  {input.label}
                </label>
                {input.multiline ? (
                  <textarea
                    id={`confirm-${action}-input`}
                    className="input min-h-20"
                    placeholder={input.placeholder}
                    maxLength={500}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                  />
                ) : (
                  <input
                    id={`confirm-${action}-input`}
                    className="input"
                    placeholder={input.placeholder}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                  />
                )}
              </div>
            )}
            <FormError message={error} />
            <div className="flex gap-2">
              <button type="submit" className={`${confirm.danger ? "btn-danger" : "btn-primary"} flex-1`} disabled={busy || !ready}>
                {busy ? "Working…" : confirm.confirmLabel}
              </button>
              <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
                Cancel
              </button>
            </div>
          </form>
        </Modal>
      )}

      {password && (
        <Modal title="Temporary password" onClose={() => setPassword(null)} labelledBy={`temp-${userId}`}>
          <TemporaryPassword password={password} username={username} />
          <button type="button" className="btn-primary mt-4 w-full" onClick={() => setPassword(null)}>
            Done
          </button>
        </Modal>
      )}
    </>
  );
}
