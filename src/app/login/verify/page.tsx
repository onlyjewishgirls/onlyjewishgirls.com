import type { Metadata } from "next";
import { AuthCard } from "@/components/AuthCard";
import { requirePage } from "@/server/guards";
import { getSettings } from "@/server/settings";
import { VerifyMfa } from "./VerifyMfa";

export const metadata: Metadata = { title: "Verify it's you · OnlyJewishGirls" };

export default async function VerifyPage() {
  const { mfa } = await requirePage("/login/verify");
  const { mfa_default_method: preferred } = await getSettings();
  return (
    <AuthCard title="Verify it's you" subtitle="Use one of your second factors to finish signing in.">
      <VerifyMfa passkey={mfa.passkeys > 0} totp={mfa.totp} recovery={mfa.recoveryCodes} preferred={preferred} />
    </AuthCard>
  );
}
