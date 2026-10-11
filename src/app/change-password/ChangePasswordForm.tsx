"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { FormError } from "@/components/AuthCard";
import { PasswordChecklist } from "@/components/PasswordChecklist";
import { postJson } from "@/lib/api-client";
import { checkPassword, type PasswordRuleResult } from "@/lib/password/policy";

/** The server knows the dictionary and the account's name, username, email and phone. */
const SERVER_RULES = new Set<PasswordRuleResult["id"]>(["dictionary", "personal"]);

type Fields = { currentPassword?: string; password?: string; confirmPassword?: string };

export function ChangePasswordForm({ forced, username }: { forced: boolean; username: string }) {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<Fields>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [serverCheck, setServerCheck] = useState<{ password: string; rules: PasswordRuleResult[] } | null>(null);

  useEffect(() => {
    if (!password) return;
    const timer = setTimeout(async () => {
      const res = await postJson<{ rules: PasswordRuleResult[] }>("/api/auth/password-check", { self: true, password });
      if (res.ok) setServerCheck({ password, rules: res.data.rules });
    }, 350);
    return () => clearTimeout(timer);
  }, [password]);

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
    if (!forced && !currentPassword) fieldErrors.currentPassword = "Enter your current password";
    if (!password) fieldErrors.password = "Enter a new password";
    else if (rules.some((r) => r.ok === false)) fieldErrors.password = "Password doesn't meet every requirement yet";
    if (!fieldErrors.password && password !== confirmPassword) fieldErrors.confirmPassword = "Passwords don't match";
    setErrors(fieldErrors);
    const first = (["currentPassword", "password", "confirmPassword"] as const).find((k) => fieldErrors[k]);
    if (first) {
      document.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
      return;
    }
    setSubmitting(true);
    const res = await postJson<{ fields?: Fields; passwordRules?: PasswordRuleResult[] }>("/api/auth/change-password", {
      currentPassword,
      password,
      confirmPassword,
    });
    if (res.ok && res.data.next) {
      router.push(res.data.next);
      router.refresh();
      return;
    }
    setSubmitting(false);
    if (res.data.fields) setErrors(res.data.fields);
    if (res.data.passwordRules) setServerCheck({ password, rules: res.data.passwordRules });
    setFormError(res.data.error ?? "Something went wrong.");
  }

  const input = (name: keyof Fields, label: string, value: string, onChange: (v: string) => void, autoComplete: string) => (
    <div>
      <label htmlFor={name} className="label">
        {label}
      </label>
      <input
        id={name}
        name={name}
        type={showPassword ? "text" : "password"}
        className="input"
        autoComplete={autoComplete}
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
      {!forced && input("currentPassword", "Current password", currentPassword, setCurrentPassword, "current-password")}
      {input("password", "New password", password, setPassword, "new-password")}
      <div>
        {input("confirmPassword", "Confirm new password", confirmPassword, setConfirmPassword, "new-password")}
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
