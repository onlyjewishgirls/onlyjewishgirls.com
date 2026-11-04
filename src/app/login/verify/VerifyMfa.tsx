"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { FormError } from "@/components/AuthCard";
import { signInWithPasskey } from "@/components/passkeys";
import { postJson, type ApiResult } from "@/lib/api-client";
import { defaultMfaMethod } from "@/lib/mfa-order";

type Method = "passkey" | "totp" | "recovery";


export function VerifyMfa({
  passkey,
  totp,
  recovery,
  preferred = "passkey",
}: {
  passkey: boolean;
  totp: boolean;
  recovery: boolean;
  preferred?: "passkey" | "totp";
}) {
  const router = useRouter();
  const [method, setMethod] = useState<Method>(
    (defaultMfaMethod({ passkey, totp, recovery }, preferred) as Method | null) ?? "recovery",
  );
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function finish(run: () => Promise<ApiResult<Record<string, unknown>>>) {
    setError(null);
    setBusy(true);
    const res = await run();
    if (res.data.next && (res.ok || res.status === 401)) {
      router.push(res.data.next);
      router.refresh();
      if (res.ok) return;
    }
    setBusy(false);
    setError(res.data.error ?? "That didn't work. Please try again.");
  }

  // Default = passkey: the prompt starts by itself (once) when the account has one.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current || method !== "passkey" || !passkey) return;
    autoStarted.current = true;
    finish(signInWithPasskey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitCode = (url: string) => (e: FormEvent) => {
    e.preventDefault();
    finish(() => postJson(url, { code }));
  };

  const switchTo = (m: Method) => {
    setMethod(m);
    setCode("");
    setError(null);
  };

  return (
    <div className="space-y-5">
      {method === "passkey" && (
        <div className="space-y-3">
          <p className="text-sm text-muted">Use Face ID, your fingerprint, or your device PIN.</p>
          <button type="button" className="btn-primary w-full py-3" disabled={busy} onClick={() => finish(signInWithPasskey)}>
            🔑 {busy ? "Waiting for your passkey…" : "Use my passkey"}
          </button>
        </div>
      )}

      {method === "totp" && (
        <form onSubmit={submitCode("/api/mfa/totp/verify")} className="space-y-3">
          <label htmlFor="totp" className="label">
            6-digit code from your authenticator app
          </label>
          <input
            id="totp"
            name="totp"
            className="input text-center font-mono text-2xl tracking-[0.4em]"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            required
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          />
          <button type="submit" className="btn-primary w-full py-3" disabled={busy || code.length !== 6}>
            Verify
          </button>
        </form>
      )}

      {method === "recovery" && (
        <form onSubmit={submitCode("/api/mfa/recovery-codes/verify")} className="space-y-3">
          <label htmlFor="recovery" className="label">
            Recovery code
          </label>
          <input
            id="recovery"
            name="recovery"
            className="input font-mono uppercase"
            autoComplete="off"
            spellCheck={false}
            placeholder="XXXXX-XXXXX"
            required
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <p className="text-xs text-muted">Each recovery code works once.</p>
          <button type="submit" className="btn-primary w-full py-3" disabled={busy || !code.trim()}>
            Verify
          </button>
        </form>
      )}

      <FormError message={error} />

      <div className="border-t border-border pt-4 text-sm">
        <p className="mb-2 text-muted">Use another method:</p>
        <ul className="flex flex-col items-start gap-1.5" data-testid="mfa-methods">
          <li data-method="passkey">
            {passkey ? (
              method !== "passkey" ? (
                <button type="button" className="link" onClick={() => switchTo("passkey")}>
                  Passkey
                </button>
              ) : (
                <span className="text-muted">Passkey (current)</span>
              )
            ) : (
              <span className="text-muted">
                Passkey — set one up: you&apos;ll be asked to add one right after you verify with another method.
              </span>
            )}
          </li>
          {totp && (
            <li data-method="totp">
              {method !== "totp" ? (
                <button type="button" className="link" onClick={() => switchTo("totp")}>
                  Authenticator app
                </button>
              ) : (
                <span className="text-muted">Authenticator app (current)</span>
              )}
            </li>
          )}
          {recovery && (
            <li data-method="recovery">
              {method !== "recovery" ? (
                <button type="button" className="link" onClick={() => switchTo("recovery")}>
                  Recovery code
                </button>
              ) : (
                <span className="text-muted">Recovery code (current)</span>
              )}
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
