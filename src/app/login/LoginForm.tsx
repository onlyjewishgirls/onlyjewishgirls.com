"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { FormError } from "@/components/AuthCard";
import { browserSupportsAutofill, passkeyLogin } from "@/components/passkeys";
import { browserTimeZone, postJson, type ApiResult } from "@/lib/api-client";

type Field = "identifier" | "password";
interface Problem {
  field: Field | null;
  message: string;
}

/**
 * PORTAL-STANDARD §1: identifier and password on the first screen, one submit;
 * MFA comes after. The server's exact error is shown under the field it names,
 * or as a banner. Passkey sign-in sits alongside (button + autofill).
 */
export function LoginForm() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [problem, setProblem] = useState<Problem | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const autofillStarted = useRef(false);

  function handle(res: ApiResult<Record<string, unknown>>) {
    if (res.ok && res.data.next) {
      router.push(res.data.next);
      router.refresh();
      return true;
    }
    const field = res.data.field === "identifier" || res.data.field === "password" ? res.data.field : null;
    setProblem({ field, message: res.data.error ?? `The server answered ${res.status} without a reason.` });
    return false;
  }

  // Passkey autofill (conditional UI): offered in the username field's suggestions.
  useEffect(() => {
    if (autofillStarted.current) return;
    autofillStarted.current = true;
    browserSupportsAutofill().then((ok) => {
      if (!ok) return;
      passkeyLogin({ autofill: true }).then((res) => {
        // A cancelled autofill (the user typed a password instead) isn't an error worth showing.
        if (!res.ok && res.status === 0 && /cancelled/i.test(String(res.data.error))) return;
        handle(res);
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setProblem(null);
    setSubmitting(true);
    const res = await postJson("/api/auth/login", { identifier, password, timeZone: browserTimeZone() });
    if (!handle(res)) setSubmitting(false);
  }

  async function onPasskey() {
    setProblem(null);
    setSubmitting(true);
    const res = await passkeyLogin();
    if (!handle(res)) setSubmitting(false);
  }

  const fieldError = (f: Field) =>
    problem?.field === f ? (
      <p id={`${f}-error`} role="alert" data-testid={`${f}-error`} className="mt-1.5 text-sm text-danger">
        {problem.message}
      </p>
    ) : null;

  return (
    <div className="space-y-4">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div>
          <label htmlFor="identifier" className="label">
            Username or email
          </label>
          <input
            id="identifier"
            name="identifier"
            className="input"
            autoComplete="username webauthn"
            autoCapitalize="none"
            spellCheck={false}
            required
            aria-invalid={problem?.field === "identifier" || undefined}
            aria-describedby={problem?.field === "identifier" ? "identifier-error" : undefined}
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
          />
          {fieldError("identifier")}
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
            aria-invalid={problem?.field === "password" || undefined}
            aria-describedby={problem?.field === "password" ? "password-error" : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {fieldError("password")}
        </div>
        {problem && problem.field === null && <FormError message={problem.message} />}
        <button type="submit" className="btn-primary w-full py-3" disabled={submitting}>
          {submitting ? "Checking…" : "Continue"}
        </button>
      </form>
      <div className="flex items-center gap-3 text-xs text-muted">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>
      <button type="button" className="btn-secondary w-full py-3" onClick={onPasskey} disabled={submitting}>
        🔑 Sign in with a passkey
      </button>
    </div>
  );
}
