"use client";

import { getCountries, getCountryCallingCode } from "libphonenumber-js";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useSyncExternalStore, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { FormError } from "@/components/AuthCard";
import { PasswordChecklist } from "@/components/PasswordChecklist";
import { browserTimeZone, postJson } from "@/lib/api-client";
import { checkPassword, passwordIsValid, type PasswordRuleResult } from "@/lib/password/policy";
import { parsePhone, validateRegistration, type FieldErrors, type RegistrationInput } from "@/lib/validation";

type TextField = Exclude<keyof RegistrationInput, "noMiddleName" | "timeZone">;

const EMPTY: RegistrationInput = {
  firstName: "",
  middleName: "",
  noMiddleName: false,
  lastName: "",
  email: "",
  username: "",
  phoneCountry: "US",
  phone: "",
  password: "",
  confirmPassword: "",
};

/** Shown first, with fixed names so the server and browser render identical HTML. */
const PINNED_COUNTRIES: [string, string][] = [
  ["US", "United States"],
  ["IL", "Israel"],
  ["CA", "Canada"],
  ["GB", "United Kingdom"],
];

const noopSubscribe = () => () => {};
const callingCode = (code: string) => getCountryCallingCode(code as Parameters<typeof getCountryCallingCode>[0]);

function useCountryOptions() {
  // Country names come from the runtime's ICU data, which differs between Node and browsers
  // ("Hong Kong SAR China" vs "Hong Kong"), so the full list is only built after hydration.
  const hydrated = useSyncExternalStore(noopSubscribe, () => true, () => false);
  return useMemo(() => {
    const pinned = PINNED_COUNTRIES.map(([code, name]) => ({ code, label: `${name} (+${callingCode(code)})` }));
    if (!hydrated) return pinned;
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    const rest = getCountries()
      .filter((c) => !PINNED_COUNTRIES.some(([p]) => p === c))
      .map((code) => ({ code, label: `${names.of(code) ?? code} (+${callingCode(code)})` }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return [...pinned, ...rest];
  }, [hydrated]);
}

export function RegisterForm() {
  const router = useRouter();
  const countries = useCountryOptions();
  const [form, setForm] = useState<RegistrationInput>(EMPTY);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [serverCheck, setServerCheck] = useState<{ key: string; rules: PasswordRuleResult[] } | null>(null);

  const phoneE164 = parsePhone(form.phone, form.phoneCountry)?.number;
  const personal = {
    firstName: form.firstName,
    middleName: form.noMiddleName ? "" : form.middleName,
    lastName: form.lastName,
    username: form.username,
    email: form.email,
    phone: phoneE164,
  };
  const checkKey = JSON.stringify([form.password, personal]);

  // Everything except the dictionary is checked instantly in the browser.
  const localRules = checkPassword(form.password, personal);

  // The dictionary lives on the server; ask it after the user pauses typing.
  useEffect(() => {
    if (!form.password) return;
    const timer = setTimeout(async () => {
      const res = await postJson<{ rules: PasswordRuleResult[] }>("/api/auth/password-check", {
        ...personal,
        phone: form.phone,
        phoneCountry: form.phoneCountry,
        password: form.password,
      });
      if (res.ok) setServerCheck({ key: checkKey, rules: res.data.rules });
    }, 350);
    return () => clearTimeout(timer);
    // checkKey captures every input the check depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkKey]);

  const serverRules = serverCheck?.key === checkKey ? serverCheck.rules : null;
  const rules: PasswordRuleResult[] = form.password
    ? localRules.map((rule) =>
        rule.id === "dictionary" ? (serverRules?.find((r) => r.id === "dictionary") ?? rule) : rule,
      )
    : localRules.map(({ id }) => ({ id, ok: null }));
  const dictionaryPending = !!form.password && !serverRules;
  const passwordsMatch = form.confirmPassword.length > 0 && form.password === form.confirmPassword;

  const set = (field: TextField) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setForm((f) => ({ ...f, [field]: e.target.value }));
    setErrors((errs) => ({ ...errs, [field]: undefined }));
  };

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const clientErrors = validateRegistration(form);
    if (!clientErrors.password && !passwordIsValid(rules.filter((r) => r.id !== "dictionary"))) {
      clientErrors.password = "Password doesn't meet every requirement yet";
    }
    if (rules.find((r) => r.id === "dictionary")?.ok === false) {
      clientErrors.password = "Password contains a dictionary word";
    }
    setErrors(clientErrors);
    if (Object.keys(clientErrors).length > 0) {
      document.querySelector<HTMLElement>(`[name="${Object.keys(clientErrors)[0]}"]`)?.focus();
      return;
    }

    setSubmitting(true);
    const res = await postJson<{ fields?: FieldErrors; passwordRules?: PasswordRuleResult[] }>("/api/auth/register", {
      ...form,
      timeZone: browserTimeZone(),
    });
    if (res.ok && res.data.next) {
      router.push(res.data.next);
      return;
    }
    setSubmitting(false);
    if (res.data.fields) setErrors(res.data.fields);
    if (res.data.passwordRules) setServerCheck({ key: checkKey, rules: res.data.passwordRules });
    setFormError(res.data.error ?? "Something went wrong.");
  }

  const field = (name: TextField, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}, extra?: ReactNode) => (
    <div>
      <label htmlFor={name} className="label">
        {label}
      </label>
      <input
        id={name}
        name={name}
        className="input"
        value={form[name]}
        onChange={set(name)}
        aria-invalid={!!errors[name]}
        aria-describedby={errors[name] ? `${name}-error` : undefined}
        {...props}
      />
      {extra}
      {errors[name] && (
        <p id={`${name}-error`} className="field-error">
          {errors[name]}
        </p>
      )}
    </div>
  );

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-3">
        {field("firstName", "First name", { autoComplete: "given-name", required: true })}
        {field(
          "middleName",
          "Middle name",
          { autoComplete: "additional-name", disabled: form.noMiddleName, placeholder: form.noMiddleName ? "None" : "" },
          <label className="mt-2 flex items-center gap-2 text-sm text-muted">
            <input
              type="checkbox"
              name="noMiddleName"
              className="size-4 accent-[var(--brand)]"
              checked={form.noMiddleName}
              onChange={(e) => {
                const noMiddleName = e.target.checked;
                setForm((f) => ({ ...f, noMiddleName, middleName: noMiddleName ? "" : f.middleName }));
                setErrors((errs) => ({ ...errs, middleName: undefined }));
              }}
            />
            No middle name
          </label>,
        )}
        {field("lastName", "Last name", { autoComplete: "family-name", required: true })}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {field("email", "Email", { type: "email", autoComplete: "email", inputMode: "email", required: true })}
        {field("username", "Username", {
          autoComplete: "username",
          autoCapitalize: "none",
          spellCheck: false,
          required: true,
        })}
      </div>

      <div>
        <label htmlFor="phone" className="label">
          Mobile number
        </label>
        <div className="flex gap-2">
          <select
            aria-label="Country code"
            name="phoneCountry"
            className="input w-40 shrink-0 sm:w-56"
            value={form.phoneCountry}
            onChange={set("phoneCountry")}
          >
            {countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
              </option>
            ))}
          </select>
          <input
            id="phone"
            name="phone"
            type="tel"
            className="input"
            autoComplete="tel-national"
            inputMode="tel"
            value={form.phone}
            onChange={set("phone")}
            aria-invalid={!!errors.phone}
            aria-describedby={errors.phone ? "phone-error" : undefined}
          />
        </div>
        {errors.phone && (
          <p id="phone-error" className="field-error">
            {errors.phone}
          </p>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {field("password", "Password", {
          type: showPassword ? "text" : "password",
          autoComplete: "new-password",
          required: true,
        })}
        {field(
          "confirmPassword",
          "Confirm password",
          { type: showPassword ? "text" : "password", autoComplete: "new-password", required: true },
          form.confirmPassword && !errors.confirmPassword ? (
            <p className={`mt-1.5 text-sm ${passwordsMatch ? "text-success" : "text-muted"}`}>
              {passwordsMatch ? "✓ Passwords match" : "Passwords don't match yet"}
            </p>
          ) : null,
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
        <PasswordChecklist results={rules} pending={dictionaryPending} />
      </div>

      <FormError message={formError} />

      <button type="submit" className="btn-primary w-full py-3" disabled={submitting}>
        {submitting ? "Creating account…" : "Create account"}
      </button>
      <p className="text-center text-xs text-muted">
        Next you&apos;ll secure your account with a passkey and an authenticator app.
      </p>
    </form>
  );
}
