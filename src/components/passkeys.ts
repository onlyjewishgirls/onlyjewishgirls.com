"use client";

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { postJson, type ApiResult } from "@/lib/api-client";

type Next = ApiResult<Record<string, unknown>>;

function describe(error: unknown): string {
  // SimpleWebAuthn's WebAuthnError takes the name of the underlying DOMException.
  const name = (error as Error)?.name;
  if (name === "NotAllowedError") return "The passkey prompt was closed or timed out. Try again when you're ready.";
  if (name === "InvalidStateError") return "This device already has a passkey for your account.";
  if (name === "NotSupportedError" || name === "SecurityError") return "This browser can't use passkeys here.";
  return (error as Error)?.message || "Passkey failed. Please try again.";
}

const failed = (error: string): Next => ({ ok: false, status: 0, data: { error } });

export async function createPasskey(): Promise<Next> {
  const options = await postJson("/api/mfa/passkey/register/options");
  if (!options.ok) return options;
  try {
    const response = await startRegistration({ optionsJSON: options.data as never });
    return await postJson("/api/mfa/passkey/register/verify", response);
  } catch (error) {
    return failed(describe(error));
  }
}

export async function signInWithPasskey(): Promise<Next> {
  const options = await postJson("/api/mfa/passkey/authenticate/options");
  if (!options.ok) return options;
  try {
    const response = await startAuthentication({ optionsJSON: options.data as never });
    return await postJson("/api/mfa/passkey/authenticate/verify", response);
  } catch (error) {
    return failed(describe(error));
  }
}
