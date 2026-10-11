"use client";

import { startAuthentication } from "@simplewebauthn/browser";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { FormError } from "@/components/AuthCard";
import { postJson, type ApiResult } from "@/lib/api-client";

type Result = ApiResult<Record<string, unknown>>;

interface AdminActionsValue {
  /**
   * Calls an admin API. If the server wants a fresh second factor, asks for
   * one and retries. Refreshes the page's data after a success.
   */
  act: (url: string, body?: unknown, options?: { refresh?: boolean }) => Promise<Result>;
  /** Like act, for a file download: saves the response as a file. Returns an error message, or null. */
  download: (url: string, fallbackName: string) => Promise<string | null>;
  /** Shows a short message at the bottom of the screen. */
  notify: (message: string, tone?: "success" | "error") => void;
}

const AdminActionsContext = createContext<AdminActionsValue | null>(null);

export function useAdminActions(): AdminActionsValue {
  const value = useContext(AdminActionsContext);
  if (!value) throw new Error("useAdminActions must be used inside <AdminActionsProvider>");
  return value;
}

interface Toast {
  id: number;
  message: string;
  tone: "success" | "error";
}

export function AdminActionsProvider({
  children,
  hasPasskey,
  hasTotp,
}: {
  children: ReactNode;
  hasPasskey: boolean;
  hasTotp: boolean;
}) {
  const router = useRouter();
  const [toast, setToast] = useState<Toast | null>(null);
  const [verifyOpen, setVerifyOpen] = useState(false);
  /** Everything waiting on the "Confirm it's you" dialog; one check retries them all. */
  const waiting = useRef<((ok: boolean) => void)[]>([]);

  const notify = useCallback((message: string, tone: "success" | "error" = "success") => {
    setToast({ id: Date.now(), message, tone });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.tone === "error" ? 8000 : 5000);
    return () => clearTimeout(timer);
  }, [toast]);

  const askToVerify = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        waiting.current.push(resolve);
        setVerifyOpen(true);
      }),
    [],
  );

  const act = useCallback(
    async (url: string, body: unknown = {}, { refresh = true } = {}) => {
      let res = await postJson(url, body);
      if (res.status === 403 && res.data.verify === true) {
        if (!(await askToVerify())) return { ok: false, status: 0, data: { error: "Cancelled." } } as Result;
        res = await postJson(url, body);
      }
      if (res.status === 401 && typeof res.data.next === "string") {
        router.push(res.data.next);
        return res;
      }
      if (res.ok && refresh) router.refresh();
      return res;
    },
    [askToVerify, router],
  );

  const download = useCallback(
    async (url: string, fallbackName: string) => {
      const send = () => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      let res: Response;
      try {
        res = await send();
        if (res.status === 403) {
          const data = (await res.clone().json().catch(() => ({}))) as { verify?: boolean };
          if (data.verify === true) {
            if (!(await askToVerify())) return "Cancelled.";
            res = await send();
          }
        }
      } catch {
        return "Can't reach the server. Check your connection.";
      }
      if (!res.ok) return ((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Download failed.";
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? fallbackName;
      const href = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = href;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
      return null;
    },
    [askToVerify],
  );

  const finishVerify = (ok: boolean) => {
    setVerifyOpen(false);
    const resolvers = waiting.current;
    waiting.current = [];
    for (const resolve of resolvers) resolve(ok);
  };

  return (
    <AdminActionsContext.Provider value={{ act, download, notify }}>
      {children}
      {verifyOpen && <VerifyDialog hasPasskey={hasPasskey} hasTotp={hasTotp} onDone={finishVerify} />}
      {toast && (
        <div
          key={toast.id}
          data-testid="toast"
          role={toast.tone === "error" ? "alert" : "status"}
          className={`fixed inset-x-4 bottom-4 z-50 mx-auto max-w-md rounded-xl border px-4 py-3 text-sm shadow-lg sm:inset-x-auto sm:right-6 sm:left-auto ${
            toast.tone === "error"
              ? "border-danger/40 bg-surface text-danger"
              : "border-success/40 bg-surface text-foreground"
          }`}
        >
          <div className="flex items-start gap-3">
            <span aria-hidden>{toast.tone === "error" ? "⚠️" : "✓"}</span>
            <p className="flex-1">{toast.message}</p>
            <button type="button" className="text-muted hover:text-foreground" onClick={() => setToast(null)} aria-label="Dismiss">
              ✕
            </button>
          </div>
        </div>
      )}
    </AdminActionsContext.Provider>
  );
}

/** A modal built on <dialog>, so focus, Escape and the backdrop behave natively. */
export function Modal({
  title,
  children,
  onClose,
  labelledBy = "modal-title",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  labelledBy?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={labelledBy}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl border border-border bg-surface p-0 text-foreground shadow-xl backdrop:bg-black/50"
    >
      <div className="p-5 sm:p-6">
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 id={labelledBy} className="text-lg font-semibold">
            {title}
          </h2>
          <button type="button" className="text-muted hover:text-foreground" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

function VerifyDialog({
  hasPasskey,
  hasTotp,
  onDone,
}: {
  hasPasskey: boolean;
  hasTotp: boolean;
  onDone: (ok: boolean) => void;
}) {
  const [method, setMethod] = useState<"passkey" | "totp">(hasPasskey ? "passkey" : "totp");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function verifyWithPasskey() {
    setError(null);
    setBusy(true);
    const options = await postJson("/api/admin/verify/options");
    if (!options.ok) {
      setBusy(false);
      setError(options.data.error ?? "Couldn't start the passkey check.");
      return;
    }
    try {
      const response = await startAuthentication({ optionsJSON: options.data as never });
      const res = await postJson("/api/admin/verify", { method: "passkey", response });
      if (res.ok) return onDone(true);
      setError(res.data.error ?? "That passkey didn't work.");
    } catch (e) {
      setError((e as Error)?.name === "NotAllowedError" ? "The passkey prompt was closed. Try again." : "Passkey failed. Try again.");
    }
    setBusy(false);
  }

  async function verifyWithCode(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const res = await postJson("/api/admin/verify", { method: "totp", code });
    if (res.ok) return onDone(true);
    setBusy(false);
    setCode("");
    setError(res.data.error ?? "That code didn't work.");
  }

  return (
    <Modal title="Confirm it's you" onClose={() => onDone(false)} labelledBy="verify-title">
      <p className="mb-4 text-sm text-muted">
        Changes to accounts need a fresh check of your passkey or authenticator app. It lasts 15 minutes.
      </p>
      {method === "passkey" ? (
        <button type="button" className="btn-primary w-full py-3" disabled={busy} onClick={verifyWithPasskey}>
          🔑 {busy ? "Waiting for your passkey…" : "Use my passkey"}
        </button>
      ) : (
        <form onSubmit={verifyWithCode} className="space-y-3">
          <label htmlFor="verify-code" className="label">
            6-digit code from your authenticator app
          </label>
          <input
            id="verify-code"
            className="input text-center font-mono text-2xl tracking-[0.4em]"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          />
          <button type="submit" className="btn-primary w-full py-3" disabled={busy || code.length !== 6}>
            Confirm
          </button>
        </form>
      )}
      <div className="mt-3">
        <FormError message={error} />
      </div>
      {hasPasskey && hasTotp && (
        <button
          type="button"
          className="link mt-4 text-sm"
          onClick={() => {
            setMethod(method === "passkey" ? "totp" : "passkey");
            setError(null);
          }}
        >
          {method === "passkey" ? "Use my authenticator app instead" : "Use my passkey instead"}
        </button>
      )}
    </Modal>
  );
}
