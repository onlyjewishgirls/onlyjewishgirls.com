import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { SignOutButton } from "@/components/SignOutButton";
import { VisitTracker } from "@/components/VisitTracker";
import { isAdminRole } from "@/lib/admin/permissions";
import { getAuth } from "@/server/session";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "OnlyJewishGirls",
  description: "Coming soon.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const auth = await getAuth();
  const signedIn = auth?.session.stage === "full";
  const admin = signedIn && isAdminRole(auth.user.role);

  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col font-sans">
        <header className="border-b border-border bg-surface/80 backdrop-blur">
          <nav className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-y-2 px-4 py-3">
            <Link href={signedIn ? "/home" : "/"} className="text-lg font-bold tracking-tight">
              Only<span className="text-brand">Jewish</span>Girls
            </Link>
            <div className="ml-auto flex items-center gap-1.5 text-sm sm:gap-2">
              {auth ? (
                <>
                  {signedIn && (
                    <Link href="/leaderboard" className="btn-secondary px-3 whitespace-nowrap sm:px-4" aria-label="Leaderboard">
                      <span aria-hidden>🏆</span>
                      <span className="hidden sm:inline">Leaderboard</span>
                    </Link>
                  )}
                  {admin && (
                    <Link href="/admin" className="btn-secondary px-3 whitespace-nowrap sm:px-4">
                      Admin
                    </Link>
                  )}
                  <SignOutButton />
                </>
              ) : (
                <>
                  <Link href="/login" className="btn-secondary">
                    Sign in
                  </Link>
                  <Link href="/register" className="btn-primary">
                    Create account
                  </Link>
                </>
              )}
            </div>
          </nav>
        </header>
        <main className="flex flex-1 flex-col">{children}</main>
        <VisitTracker />
      </body>
    </html>
  );
}
