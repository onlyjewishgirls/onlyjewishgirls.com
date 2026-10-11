"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/admin", label: "Overview", match: (p: string) => p === "/admin" },
  { href: "/admin/users", label: "Accounts", match: (p: string) => p.startsWith("/admin/users") },
  { href: "/admin/activity", label: "Activity", match: (p: string) => p.startsWith("/admin/activity") },
] as const;

export function AdminNav() {
  const pathname = usePathname();
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <p className="text-xs font-semibold tracking-widest text-muted uppercase">Admin panel</p>
      <nav aria-label="Admin sections" className="flex gap-1 rounded-xl border border-border bg-surface p-1 text-sm">
        {TABS.map((tab) => {
          const active = tab.match(pathname);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={`rounded-lg px-3 py-1.5 font-medium transition ${
                active ? "bg-brand text-white dark:text-[#10132a]" : "text-muted hover:bg-brand-soft hover:text-foreground"
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
