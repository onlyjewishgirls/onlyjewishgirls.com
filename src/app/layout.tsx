import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { SignOutButton } from "@/components/SignOutButton";
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

  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col font-sans">
        <header className="border-b border-border bg-surface/80 backdrop-blur">
          <nav className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
            <Link href={signedIn ? "/home" : "/"} className="text-lg font-bold tracking-tight">
              Only<span className="text-brand">Jewish</span>Girls
            </Link>
            <div className="flex items-center gap-2 text-sm">
              {auth ? (
                <SignOutButton />
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
      </body>
    </html>
  );
}
