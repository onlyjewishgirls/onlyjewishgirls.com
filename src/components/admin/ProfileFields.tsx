"use client";

import { useCountryOptions } from "@/components/useCountryOptions";

export interface ProfileInput {
  firstName: string;
  middleName: string;
  lastName: string;
  email: string;
  username: string;
  phoneCountry: string;
  phone: string;
}

export type ProfileErrors = Partial<Record<keyof ProfileInput, string>>;

/** Name, email, username and mobile number fields, for creating and editing accounts. */
export function ProfileFields({
  value,
  errors,
  onChange,
  idPrefix,
}: {
  value: ProfileInput;
  errors: ProfileErrors;
  onChange: (next: ProfileInput) => void;
  idPrefix: string;
}) {
  const countries = useCountryOptions();
  const field = (name: Exclude<keyof ProfileInput, "phoneCountry">, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => {
    const id = `${idPrefix}-${name}`;
    return (
      <div>
        <label htmlFor={id} className="label">
          {label}
        </label>
        <input
          id={id}
          name={name}
          className="input"
          value={value[name]}
          onChange={(e) => onChange({ ...value, [name]: e.target.value })}
          aria-invalid={!!errors[name]}
          aria-describedby={errors[name] ? `${id}-error` : undefined}
          {...props}
        />
        {errors[name] && (
          <p id={`${id}-error`} className="field-error">
            {errors[name]}
          </p>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        {field("firstName", "First name", { autoComplete: "off" })}
        {field("middleName", "Middle name (optional)", { autoComplete: "off" })}
        {field("lastName", "Last name", { autoComplete: "off" })}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {field("email", "Email", { type: "email", inputMode: "email", autoComplete: "off" })}
        {field("username", "Username", { autoCapitalize: "none", spellCheck: false, autoComplete: "off" })}
      </div>
      <div>
        <label htmlFor={`${idPrefix}-phone`} className="label">
          Mobile number
        </label>
        <div className="flex gap-2">
          <select
            aria-label="Country code"
            className="input w-36 shrink-0 sm:w-48"
            value={value.phoneCountry}
            onChange={(e) => onChange({ ...value, phoneCountry: e.target.value })}
          >
            {countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
              </option>
            ))}
          </select>
          <input
            id={`${idPrefix}-phone`}
            name="phone"
            type="tel"
            inputMode="tel"
            className="input"
            autoComplete="off"
            value={value.phone}
            onChange={(e) => onChange({ ...value, phone: e.target.value })}
            aria-invalid={!!errors.phone}
            aria-describedby={errors.phone ? `${idPrefix}-phone-error` : undefined}
          />
        </div>
        {errors.phone && (
          <p id={`${idPrefix}-phone-error`} className="field-error">
            {errors.phone}
          </p>
        )}
      </div>
    </div>
  );
}
