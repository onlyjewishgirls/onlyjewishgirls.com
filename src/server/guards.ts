import "server-only";
import { redirect } from "next/navigation";
import { mfaState, nextStep, type MfaState, type NextStep } from "./mfa";
import { getAuth, type AuthContext } from "./session";

export type PageAuth = AuthContext & { mfa: MfaState; next: NextStep };

export async function getPageAuth(): Promise<PageAuth | null> {
  const ctx = await getAuth();
  if (!ctx) return null;
  const mfa = await mfaState(ctx.user);
  return { ...ctx, mfa, next: nextStep(ctx.session.stage, mfa) };
}

/** Sends the visitor wherever they belong unless it's `here`. */
export async function requirePage(here: PageAuth["next"]): Promise<PageAuth> {
  const auth = await getPageAuth();
  if (!auth) redirect("/login");
  if (auth.next !== here) redirect(auth.next);
  return auth;
}

/** Sign-in and sign-up pages: skip them if already fully signed in. */
export async function redirectIfSignedIn() {
  const auth = await getPageAuth();
  if (auth?.session.stage === "full") redirect(auth.next);
}
