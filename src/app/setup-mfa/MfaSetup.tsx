"use client";

import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { FormError } from "@/components/AuthCard";
import { createPasskey } from "@/components/passkeys";
import { postJson } from "@/lib/api-client";

const noop = () => () => {};

function Step({
  number,
  title,
  done,
  locked,
  children,
}: {
  number: number;
  title: string;
  done: boolean;
  locked?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      data-step={number}
      data-done={done}
      className={`rounded-xl border p-5 ${done ? "border-success/40 bg-success/5" : "border-border"} ${locked ? "opacity-60" : ""}`}
    >
      <h2 className="flex items-center gap-3 font-semibold">
        <span
          className={`flex size-7 shrink-0 items-center justify-center rounded-full text-sm ${
            done ? "bg-success text-white dark:text-black" : "bg-brand-soft text-brand"
          }`}
        >
          {done ? "✓" : number}
        </span>
        {title}
      </h2>
      <div className="mt-3 pl-10 text-sm">{children}</div>
    </section>
  );
}

function PasskeyStep({ done, onDone }: { done: boolean; onDone: () => void }) {
  const supported = useSyncExternalStore(noop, browserSupportsWebAuthn, () => true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (done) return <p className="text-success">Passkey added. You can sign in with Face ID, fingerprint or your device PIN.</p>;
  return (
    <div className="space-y-3">
      <p className="text-muted">
        A passkey lives on your phone or computer and is unlocked with your face, fingerprint or PIN. It can&apos;t be
        phished or guessed.
      </p>
      {!supported && <FormError message="This browser doesn't support passkeys. Try an up-to-date Safari, Chrome, Edge or Firefox." />}
      <button
        type="button"
        className="btn-primary"
        disabled={busy || !supported}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const res = await createPasskey();
          setBusy(false);
          if (res.ok) onDone();
          else setError(res.data.error ?? "Couldn't add the passkey.");
        }}
      >
        🔑 {busy ? "Waiting for your device…" : "Create a passkey"}
      </button>
      <FormError message={error} />
    </div>
  );
}

function TotpStep({ done, onDone }: { done: boolean; onDone: () => void }) {
  const [setup, setSetup] = useState<{ qrCode: string; secret: string; uri: string } | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (done) return <p className="text-success">Authenticator app connected.</p>;

  async function start() {
    setBusy(true);
    setError(null);
    const res = await postJson<{ qrCode: string; secret: string; uri: string }>("/api/mfa/totp/setup");
    setBusy(false);
    if (res.ok) setSetup(res.data);
    else setError(res.data.error ?? "Couldn't start setup.");
  }

  async function confirm(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await postJson("/api/mfa/totp/enable", { code });
    setBusy(false);
    if (res.ok) onDone();
    else setError(res.data.error ?? "That code didn't work.");
  }

  if (!setup) {
    return (
      <div className="space-y-3">
        <p className="text-muted">
          Use Google Authenticator, Microsoft Authenticator, 1Password, Authy or any app that shows 6-digit codes.
        </p>
        <button type="button" className="btn-primary" disabled={busy} onClick={start}>
          📱 Set up authenticator app
        </button>
        <FormError message={error} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        {/* eslint-disable-next-line @next/next/no-img-element -- data: URL generated on our server */}
        <img src={setup.qrCode} alt="QR code for your authenticator app" width={180} height={180} className="rounded-lg bg-white p-2" />
        <div className="space-y-2 text-muted">
          <p>1. Scan this QR code with your authenticator app.</p>
          <p>
            Can&apos;t scan? Enter this key instead:
            <code data-testid="totp-secret" className="mt-1 block break-all rounded bg-brand-soft px-2 py-1 font-mono text-foreground">
              {setup.secret}
            </code>
          </p>
          <p className="sm:hidden">
            On this phone?{" "}
            <a href={setup.uri} className="link">
              Open in authenticator app
            </a>
          </p>
          <p>2. Enter the 6-digit code it shows.</p>
        </div>
      </div>
      <form onSubmit={confirm} className="flex gap-2">
        <input
          aria-label="6-digit code"
          name="totpCode"
          className="input max-w-44 text-center font-mono text-lg tracking-[0.3em]"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
        />
        <button type="submit" className="btn-primary" disabled={busy || code.length !== 6}>
          Confirm
        </button>
      </form>
      <FormError message={error} />
    </div>
  );
}

function RecoveryStep({ locked }: { locked: boolean }) {
  const router = useRouter();
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (locked) return <p className="text-muted">Finish the two steps above first.</p>;

  if (!codes) {
    return (
      <div className="space-y-3">
        <p className="text-muted">
          If you ever lose your phone and your passkey, a recovery code gets you back in. Each one works once.
        </p>
        <button
          type="button"
          className="btn-primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const res = await postJson<{ codes: string[] }>("/api/mfa/recovery-codes/generate");
            setBusy(false);
            if (res.ok) setCodes(res.data.codes);
            else setError(res.data.error ?? "Couldn't create recovery codes.");
          }}
        >
          Show my recovery codes
        </button>
        <FormError message={error} />
      </div>
    );
  }

  const text = `OnlyJewishGirls recovery codes\nEach code works once.\n\n${codes.join("\n")}\n`;
  return (
    <div className="space-y-4">
      <ul data-testid="recovery-codes" className="grid grid-cols-2 gap-2 rounded-lg bg-brand-soft p-4 font-mono text-base">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-secondary"
          onClick={async () => {
            await navigator.clipboard?.writeText(text);
            setCopied(true);
          }}
        >
          {copied ? "Copied ✓" : "Copy"}
        </button>
        <a
          className="btn-secondary"
          download="onlyjewishgirls-recovery-codes.txt"
          href={`data:text/plain;charset=utf-8,${encodeURIComponent(text)}`}
        >
          Download
        </a>
      </div>
      <label className="flex items-center gap-2">
        <input type="checkbox" className="size-4 accent-[var(--brand)]" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        I saved these somewhere safe
      </label>
      <button
        type="button"
        className="btn-primary"
        disabled={!saved}
        onClick={() => {
          router.push("/home");
          router.refresh();
        }}
      >
        Continue 🔥
      </button>
    </div>
  );
}

export function MfaSetup({ passkeyDone, totpDone }: { passkeyDone: boolean; totpDone: boolean }) {
  const [passkey, setPasskey] = useState(passkeyDone);
  const [totp, setTotp] = useState(totpDone);
  return (
    <div className="space-y-4">
      <Step number={1} title="Add a passkey" done={passkey}>
        <PasskeyStep done={passkey} onDone={() => setPasskey(true)} />
      </Step>
      <Step number={2} title="Connect an authenticator app" done={totp}>
        <TotpStep done={totp} onDone={() => setTotp(true)} />
      </Step>
      <Step number={3} title="Save your recovery codes" done={false} locked={!passkey || !totp}>
        <RecoveryStep locked={!passkey || !totp} />
      </Step>
    </div>
  );
}
