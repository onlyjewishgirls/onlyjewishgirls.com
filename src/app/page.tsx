import Link from "next/link";
import { getPageAuth } from "@/server/guards";

export default async function Landing() {
  const auth = await getPageAuth();
  const signedIn = auth?.session.stage === "full";

  return (
    <div className="flex flex-1 items-center justify-center px-4 py-20">
      <div className="max-w-xl text-center">
        <p className="text-6xl" aria-hidden>
          ✡️
        </p>
        <h1 className="mt-6 text-4xl font-black tracking-tight sm:text-5xl">
          Only<span className="text-brand">Jewish</span>Girls
        </h1>
        <p className="mt-4 text-lg text-muted">Something new is on the way. Join now and start your 🔥 streak.</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          {signedIn ? (
            <Link href={auth.next} className="btn-primary px-6 py-3 text-base">
              Go to my streak 🔥
            </Link>
          ) : (
            <>
              <Link href="/register" className="btn-primary px-6 py-3 text-base">
                Create account
              </Link>
              <Link href="/login" className="btn-secondary px-6 py-3 text-base">
                Sign in
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
