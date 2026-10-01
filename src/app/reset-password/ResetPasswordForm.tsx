"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { FormError } from "@/components/AuthCard";
import { PasswordChecklist } from "@/components/PasswordChecklist";
import { postJson } from "@/lib/api-client";
import { checkPassword, type PasswordRuleResult } from "@/lib/password/policy";

/** The server knows the dictionary and the account's name, username, email and phone. */
const SERVER_RULES = new Set<PasswordRuleResult["id"]>(["dictionary", "personal"]);

type Fields = { password?: string; confirmPassword?: string };

export function ResetPasswordForm({ token, username }: { token: string; username: string }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<Fields>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [expired, setExpired] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [serverCheck, setServerCheck] = useState<{ password: string; rules: PasswordRuleResult[] } | null>(null);

  useEffect(() => {
    if (!password) return;
    const timer = setTimeout(async () => {
      const res = await postJson<{ rules: PasswordRuleResult[]; expired?: boolean }>("/api/auth/password-check", {
        resetToken: token,
        password,
      });
      if (res.ok) setServerCheck({ password, rules: res.data.rules });
      else if (res.data.expired) setExpired(res.data.error ?? "This reset link has expired.");
    }, 350);
    return () => clearTimeout(timer);
  }, [password, token]);

  const serverRules = serverCheck?.password === password ? serverCheck.rules : null;
  const rules: PasswordRuleResult[] = checkPassword(password, {}).map((rule) =>
    !password
      ? { id: rule.id, ok: null }
      : SERVER_RULES.has(rule.id)
        ? (serverRules?.find((r) => r.id === rule.id) ?? { id: rule.id, ok: null })
        : rule,
  );
  const pending = !!password && !serverRules;
  const passwordsMatch = confirmPassword.length > 0 && password === confirmPassword;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const fieldErrors: Fields = {};
    if (!password) fieldErrors.password = "Enter a new password";
    else if (rules.some((r) => r.ok === false)) fieldErrors.password = "Password doesn't meet every requirement yet";
    if (!fieldErrors.password && password !== confirmPassword) fieldErrors.confirmPassword = "Passwords don't match";
    setErrors(fieldErrors);
    if (fieldErrors.password || fieldErrors.confirmPassword) {
      document.querySelector<HTMLElement>(`[name="${fieldErrors.password ? "password" : "confirmPassword"}"]`)?.focus();
      return;
    }

    setSubmitting(true);
    const res = await postJson<{ fields?: Fields; passwordRules?: PasswordRuleResult[]; expired?: boolean }>(
      "/api/auth/reset-password",
      { token, password, confirmPassword },
    );
    if (res.ok && res.data.next) {
      router.push(res.data.next);
      return;
    }
    setSubmitting(false);
    if (res.data.expired) {
      setExpired(res.data.error ?? "This reset link has expired.");
      return;
    }
    if (res.data.fields) setErrors(res.data.fields);
    if (res.data.passwordRules) setServerCheck({ password, rules: res.data.passwordRules });
    setFormError(res.data.error ?? "Something went wrong.");
  }

  if (expired) {
    return (
      <div className="space-y-6">
        <FormError message={expired} />
        <Link href="/forgot-password" className="btn-primary block w-full py-3 text-center">
          Send a new link
        </Link>
      </div>
    );
  }

  const input = (name: keyof Fields, label: string, value: string, onChange: (v: string) => void) => (
    <div>
      <label htmlFor={name} className="label">
        {label}
      </label>
      <input
        id={name}
        name={name}
        type={showPassword ? "text" : "password"}
        className="input"
        autoComplete="new-password"
        required
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setErrors((errs) => ({ ...errs, [name]: undefined }));
        }}
        aria-invalid={!!errors[name]}
        aria-describedby={errors[name] ? `${name}-error` : undefined}
      />
      {errors[name] && (
        <p id={`${name}-error`} className="field-error">
          {errors[name]}
        </p>
      )}
    </div>
  );

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      {/* Lets password managers update the right saved login. */}
      <input type="text" name="username" autoComplete="username" value={username} readOnly hidden />
      {input("password", "New password", password, setPassword)}
      <div>
        {input("confirmPassword", "Confirm new password", confirmPassword, setConfirmPassword)}
        {confirmPassword && !errors.confirmPassword && (
          <p className={`mt-1.5 text-sm ${passwordsMatch ? "text-success" : "text-muted"}`}>
            {passwordsMatch ? "✓ Passwords match" : "Passwords don't match yet"}
          </p>
        )}
      </div>
      <label className="-mt-2 flex items-center gap-2 text-sm text-muted">
        <input
          type="checkbox"
          className="size-4 accent-[var(--brand)]"
          checked={showPassword}
          onChange={(e) => setShowPassword(e.target.checked)}
        />
        Show passwords
      </label>

      <div className="rounded-xl border border-border bg-background/60 p-4">
        <p className="mb-2 text-sm font-semibold">Your password needs:</p>
        <PasswordChecklist results={rules} pending={pending} />
      </div>

      <FormError message={formError} />

      <button type="submit" className="btn-primary w-full py-3" disabled={submitting}>
        {submitting ? "Saving…" : "Save new password"}
      </button>
    </form>
  );
}
