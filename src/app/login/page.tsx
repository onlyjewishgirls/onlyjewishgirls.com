import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/AuthCard";
import { redirectIfSignedIn } from "@/server/guards";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Sign in · OnlyJewishGirls" };

export default async function LoginPage() {
  await redirectIfSignedIn();
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
      <LoginForm />
    </AuthCard>
  );
}
