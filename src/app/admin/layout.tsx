import type { ReactNode } from "react";
import { AdminActionsProvider } from "@/components/admin/AdminActions";
import { AdminNav } from "@/components/admin/AdminNav";
import { requireAdminPage } from "@/server/admin";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  // Each admin page checks access itself too; layouts aren't re-run on every navigation.
  const auth = await requireAdminPage();
  return (
    <AdminActionsProvider hasPasskey={auth.mfa.passkeys > 0} hasTotp={auth.mfa.totp}>
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:py-8">
        <AdminNav />
        {children}
      </div>
    </AdminActionsProvider>
  );
}
