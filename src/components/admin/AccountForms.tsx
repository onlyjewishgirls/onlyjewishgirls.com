"use client";

import { useState, type FormEvent } from "react";
import { FormError } from "@/components/AuthCard";
import type { Role } from "@/lib/admin/permissions";
import { useAdminActions } from "./AdminActions";
import { ProfileFields, type ProfileErrors, type ProfileInput } from "./ProfileFields";

function useAction(userId: number) {
  const { act, notify } = useAdminActions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: string, body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    const res = await act("/api/admin/action", { userId, action, ...body });
    setBusy(false);
    if (res.ok) notify(typeof res.data.message === "string" ? res.data.message : "Saved.");
    else setError(res.data.error ?? "That didn't work.");
    return res;
  };
  return { run, busy, error };
}

export function EditProfileForm({ userId, initial }: { userId: number; initial: ProfileInput }) {
  const { run, busy, error } = useAction(userId);
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<ProfileErrors>({});
  async function submit(e: FormEvent) {
    e.preventDefault();
    const res = await run("edit_profile", { ...form });
    setErrors(res.ok ? {} : ((res.data.fields as ProfileErrors) ?? {}));
  }
  return (
    <form onSubmit={submit} noValidate className="space-y-3">
      <ProfileFields value={form} errors={errors} onChange={setForm} idPrefix={`edit-${userId}`} />
      <FormError message={error} />
      <button type="submit" className="btn-primary" disabled={busy}>
        {busy ? "Saving…" : "Save profile"}
      </button>
    </form>
  );
}

export function StreakForm({ userId, count }: { userId: number; count: number }) {
  const { run, busy, error } = useAction(userId);
  const [value, setValue] = useState(String(count));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        run("set_streak", { count: Number(value) });
      }}
      className="space-y-2"
    >
      <label htmlFor={`streak-${userId}`} className="label">
        Set streak to
      </label>
      <div className="flex gap-2">
        <input
          id={`streak-${userId}`}
          type="number"
          min={0}
          max={100000}
          step={1}
          inputMode="numeric"
          className="input w-32"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button type="submit" className="btn-secondary" disabled={busy || value === "" || Number(value) === count}>
          {busy ? "Saving…" : "Set"}
        </button>
      </div>
      <p className="text-xs text-muted">0 resets it. Any other number counts today as checked in, so their 30-hour window starts now.</p>
      <FormError message={error} />
    </form>
  );
}

export function NoteForm({ userId, note }: { userId: number; note: string | null }) {
  const { run, busy, error } = useAction(userId);
  const [value, setValue] = useState(note ?? "");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        run("set_note", { note: value });
      }}
      className="space-y-2"
    >
      <label htmlFor={`note-${userId}`} className="label">
        Admin note <span className="font-normal text-muted">(only admins see this)</span>
      </label>
      <textarea
        id={`note-${userId}`}
        className="input min-h-24"
        maxLength={2000}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <FormError message={error} />
      <button type="submit" className="btn-secondary" disabled={busy || value.trim() === (note ?? "")}>
        {busy ? "Saving…" : "Save note"}
      </button>
    </form>
  );
}

export function RoleForm({ userId, role }: { userId: number; role: Role }) {
  const { run, busy, error } = useAction(userId);
  const [value, setValue] = useState<Role>(role);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        run("set_role", { role: value });
      }}
      className="space-y-2"
    >
      <label htmlFor={`role-${userId}`} className="label">
        Role
      </label>
      <div className="flex gap-2">
        <select id={`role-${userId}`} className="input w-40" value={value} onChange={(e) => setValue(e.target.value as Role)}>
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
        <button type="submit" className="btn-secondary" disabled={busy || value === role}>
          {busy ? "Saving…" : "Change"}
        </button>
      </div>
      <p className="text-xs text-muted">Admins can see this panel and manage members. Only you can manage admins.</p>
      <FormError message={error} />
    </form>
  );
}
