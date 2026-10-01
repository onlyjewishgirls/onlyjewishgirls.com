"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/api-client";

export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn-secondary"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await postJson("/api/auth/logout");
        router.push("/");
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
