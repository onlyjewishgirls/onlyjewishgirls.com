import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthCard } from "@/components/AuthCard";
import { getPageAuth } from "@/server/guards";
import { ChangePasswordForm } from "./ChangePasswordForm";

export const metadata: Metadata = { title: "Change password · OnlyJewishGirls" };

export default async function ChangePasswordPage() {
  const auth = await getPageAuth();
  if (!auth) redirect("/login");
  // Open to anyone fully signed in; required after an admin sets a temporary password.
  if (auth.next !== "/change-password" && auth.next !== "/home") redirect(auth.next);
  const forced = auth.next === "/change-password";
  return (
    <AuthCard
      title={forced ? "Choose your own password" : "Change your password"}
      subtitle={
        forced ? (
          "You signed in with a temporary password. Choose your own to continue."
        ) : (
          <>
            You&apos;ll stay signed in here and be signed out everywhere else.{" "}
            <Link href="/home" className="link">
              Cancel
            </Link>
          </>
        )
      }
    >
      <ChangePasswordForm forced={forced} username={auth.user.username} />
    </AuthCard>
  );
}
