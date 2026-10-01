"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { FormError } from "@/components/AuthCard";
import { browserTimeZone, postJson } from "@/lib/api-client";

export function LoginForm() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const res = await postJson("/api/auth/login", { identifier, password, timeZone: browserTimeZone() });
    if (res.ok && res.data.next) {
      router.push(res.data.next);
      return;
    }
    setSubmitting(false);
    setError(res.data.error ?? "Something went wrong.");
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
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
      <div>
        <div className="flex items-baseline justify-between">
          <label htmlFor="password" className="label">
            Password
          </label>
          <Link href="/forgot-password" className="link text-sm">
            Forgot password?
          </Link>
        </div>
        <input
          id="password"
          name="password"
          type="password"
          className="input"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <FormError message={error} />
      <button type="submit" className="btn-primary w-full py-3" disabled={submitting}>
        {submitting ? "Checking…" : "Continue"}
      </button>
    </form>
  );
}
