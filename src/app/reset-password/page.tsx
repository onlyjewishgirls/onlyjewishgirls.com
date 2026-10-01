import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/AuthCard";
import { RESET_LINK_EXPIRED, resetLinkUser } from "@/server/password-reset";
import { ResetPasswordForm } from "./ResetPasswordForm";

export const metadata: Metadata = { title: "Reset password · OnlyJewishGirls", robots: { index: false } };

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { token } = await searchParams;
  const user = await resetLinkUser(token);

  if (!user || typeof token !== "string") {
    return (
      <AuthCard title="Link expired">
        <p className="text-muted">{RESET_LINK_EXPIRED}</p>
        <Link href="/forgot-password" className="btn-primary mt-6 block w-full py-3 text-center">
          Send a new link
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Choose a new password" subtitle={`For ${user.username}. You'll be signed out everywhere else.`}>
      <ResetPasswordForm token={token} username={user.username} />
    </AuthCard>
  );
}
