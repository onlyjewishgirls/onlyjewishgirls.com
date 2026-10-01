import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/AuthCard";
import { redirectIfSignedIn } from "@/server/guards";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Sign in · OnlyJewishGirls" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  await redirectIfSignedIn();
  const { reset } = await searchParams;
  return (
    <AuthCard
      title="Welcome back"
      subtitle={
        <>
          New here?{" "}
          <Link href="/register" className="link">
            Create an account
          </Link>
        </>
      }
    >
      {reset === "1" && (
        <p role="status" className="mb-4 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
          Password changed. Sign in with your new password, then confirm it&apos;s you with your passkey or authenticator
          app.
        </p>
      )}
      <LoginForm />
    </AuthCard>
  );
}
