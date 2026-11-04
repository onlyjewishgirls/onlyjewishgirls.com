import type { Metadata } from "next";
import { requireAdminPage } from "@/server/admin";
import { StepUp } from "./StepUp";

export const metadata: Metadata = { title: "Confirm it's you · Admin · OnlyJewishGirls" };

/** Only console paths are allowed as `next`, so this can't be used as an open redirect. */
function safeNext(value: string | string[] | undefined): string {
  const v = typeof value === "string" ? value : "";
  return /^\/admin(\/[\w\-/]*)?(#[\w\-/?=&%.]*)?$/.test(v) ? v : "/admin";
}

export default async function VerifyPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const auth = await requireAdminPage();
  const { next } = await searchParams;
  return <StepUp hasPasskey={auth.mfa.passkeys > 0} hasTotp={auth.mfa.totp} next={safeNext(next)} />;
}
