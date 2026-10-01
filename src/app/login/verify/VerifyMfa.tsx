"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { FormError } from "@/components/AuthCard";
import { signInWithPasskey } from "@/components/passkeys";
import { postJson, type ApiResult } from "@/lib/api-client";

type Method = "passkey" | "totp" | "recovery";

export function VerifyMfa({ passkey, totp, recovery }: { passkey: boolean; totp: boolean; recovery: boolean }) {
  const router = useRouter();
  const [method, setMethod] = useState<Method>(passkey ? "passkey" : totp ? "totp" : "recovery");
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
        <p className="mb-2 text-muted">Other ways to verify:</p>
        <div className="flex flex-col items-start gap-1.5">
          {passkey && method !== "passkey" && (
            <button type="button" className="link" onClick={() => switchTo("passkey")}>
              Use a passkey
            </button>
          )}
          {totp && method !== "totp" && (
            <button type="button" className="link" onClick={() => switchTo("totp")}>
              Use my authenticator app
            </button>
          )}
          {recovery && method !== "recovery" && (
            <button type="button" className="link" onClick={() => switchTo("recovery")}>
              Use a recovery code
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
