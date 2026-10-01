import type { Metadata } from "next";
import { AuthCard } from "@/components/AuthCard";
import { requirePage } from "@/server/guards";
import { VerifyMfa } from "./VerifyMfa";

export const metadata: Metadata = { title: "Verify it's you · OnlyJewishGirls" };

export default async function VerifyPage() {
  const { mfa } = await requirePage("/login/verify");
  return (
    <AuthCard title="Verify it's you" subtitle="Use one of your second factors to finish signing in.">
      <VerifyMfa passkey={mfa.passkeys > 0} totp={mfa.totp} recovery={mfa.recoveryCodes} />
    </AuthCard>
  );
}
