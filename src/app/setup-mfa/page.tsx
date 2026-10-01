import type { Metadata } from "next";
import { AuthCard } from "@/components/AuthCard";
import { requirePage } from "@/server/guards";
import { MfaSetup } from "./MfaSetup";

export const metadata: Metadata = { title: "Secure your account · OnlyJewishGirls" };

export default async function SetupMfaPage() {
  const { mfa, user } = await requirePage("/setup-mfa");
  return (
    <AuthCard
      wide
      title="Secure your account"
      subtitle={`Hi ${user.firstName}! Every account here uses two-step sign-in. Set up both a passkey and an authenticator app — if you lose one, you can still get in with the other.`}
    >
      <MfaSetup passkeyDone={mfa.passkeys > 0} totpDone={mfa.totp} />
    </AuthCard>
  );
}
