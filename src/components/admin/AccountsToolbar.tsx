"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { FormError } from "@/components/AuthCard";
import { browserTimeZone } from "@/lib/api-client";
import { Modal, useAdminActions } from "./AdminActions";
import { ProfileFields, type ProfileErrors, type ProfileInput } from "./ProfileFields";
import { TemporaryPassword } from "./TemporaryPassword";

const EMPTY: ProfileInput = { firstName: "", middleName: "", lastName: "", email: "", username: "", phoneCountry: "US", phone: "" };

export function AccountsToolbar({ canCreateAdmins }: { canCreateAdmins: boolean }) {
  const { download, notify } = useAdminActions();
  const [creating, setCreating] = useState(false);
  const [exporting, setExporting] = useState(false);

  return (
    <div className="flex gap-2">
      <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
        + New account
      </button>
      <button
        type="button"
        className="btn-secondary"
        disabled={exporting}
        onClick={async () => {
          setExporting(true);
          const error = await download("/api/admin/export", "accounts.csv");
          setExporting(false);
          if (error) notify(error, "error");
        }}
      >
        {exporting ? "Exporting…" : "Export CSV"}
      </button>
      {creating && <CreateAccount canCreateAdmins={canCreateAdmins} onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateAccount({ canCreateAdmins, onClose }: { canCreateAdmins: boolean; onClose: () => void }) {
  const { act } = useAdminActions();
  const [form, setForm] = useState<ProfileInput>(EMPTY);
  const [role, setRole] = useState<"member" | "admin">("member");
  const [errors, setErrors] = useState<ProfileErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ userId: number; password: string; username: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await act("/api/admin/create", { ...form, role, timeZone: browserTimeZone() });
    setBusy(false);
    if (res.ok) {
      setCreated({
        userId: res.data.userId as number,
        password: res.data.temporaryPassword as string,
        username: form.username.trim(),
      });
      return;
    }
    setErrors((res.data.fields as ProfileErrors) ?? {});
    setError(res.data.error ?? "Couldn't create the account.");
  }

  return (
    <Modal title={created ? "Account created" : "New account"} onClose={onClose} labelledBy="create-title">
      {created ? (
        <div className="space-y-4">
          <TemporaryPassword password={created.password} username={created.username} />
          <div className="flex gap-2">
            <Link href={`/admin/users/${created.userId}`} className="btn-primary flex-1" onClick={onClose}>
              Open account
            </Link>
            <button type="button" className="btn-secondary" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} noValidate className="space-y-4">
          <ProfileFields value={form} errors={errors} onChange={setForm} idPrefix="create" />
          {canCreateAdmins && (
            <fieldset>
              <legend className="label">Role</legend>
              <div className="flex gap-4 text-sm">
                {(["member", "admin"] as const).map((r) => (
                  <label key={r} className="flex items-center gap-2">
                    <input type="radio" name="role" value={r} checked={role === r} onChange={() => setRole(r)} className="accent-[var(--brand)]" />
                    {r === "member" ? "Member" : "Admin"}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <p className="text-xs text-muted">
            We&apos;ll make a temporary password for you to give them. They&apos;ll set up a passkey and an authenticator
            app, then choose their own password.
          </p>
          <FormError message={error} />
          <button type="submit" className="btn-primary w-full py-3" disabled={busy}>
            {busy ? "Creating…" : "Create account"}
          </button>
        </form>
      )}
    </Modal>
  );
}
