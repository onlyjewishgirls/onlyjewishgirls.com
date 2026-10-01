import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/AuthCard";
import { redirectIfSignedIn } from "@/server/guards";
import { RegisterForm } from "./RegisterForm";

export const metadata: Metadata = { title: "Create account · OnlyJewishGirls" };

export default async function RegisterPage() {
  await redirectIfSignedIn();
  return (
    <AuthCard
      wide
      title="Create your account"
      subtitle={
        <>
          Already have one?{" "}
          <Link href="/login" className="link">
            Sign in
          </Link>
        </>
      }
    >
      <RegisterForm />
    </AuthCard>
  );
}
