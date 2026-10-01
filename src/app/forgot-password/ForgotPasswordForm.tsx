"use client";

import { useState, type FormEvent } from "react";
import { FormError } from "@/components/AuthCard";
import { postJson } from "@/lib/api-client";

export function ForgotPasswordForm() {
  const [identifier, setIdentifier] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const res = await postJson<{ message?: string }>("/api/auth/forgot-password", { identifier });
    setSubmitting(false);
    if (res.ok && res.data.message) setSent(res.data.message);
    else setError(res.data.error ?? "Something went wrong.");
  }

  if (sent) {
    return (
      <div className="space-y-4">
        <p role="status" className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
          {sent}
        </p>
        <p className="text-sm text-muted">
          Didn&apos;t get it? Check your spam folder, or{" "}
          <button type="button" className="link" onClick={() => setSent(null)}>
            try again
          </button>
          .
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <p className="text-sm text-muted">
        Enter your username or email and we&apos;ll email you a link to choose a new password. You&apos;ll still need
        your passkey or authenticator app to sign in.
      </p>
      <div>
        <label htmlFor="identifier" className="label">
          Username or email
        </label>
        <input
          id="identifier"
          name="identifier"
          className="input"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
        />
      </div>
      <FormError message={error} />
      <button type="submit" className="btn-primary w-full py-3" disabled={submitting}>
        {submitting ? "Sending…" : "Email me a reset link"}
      </button>
    </form>
  );
}
