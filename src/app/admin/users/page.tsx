import type { Metadata } from "next";
import Link from "next/link";
import { AccountBadges } from "@/components/admin/AccountBadges";
import { AccountsToolbar } from "@/components/admin/AccountsToolbar";
import { fullName, timeAgo } from "@/lib/admin/format";
import {
  listUsers,
  requireAdminPage,
  streakStatusFor,
  USER_FILTERS,
  USER_SORTS,
  type UserFilter,
  type UserSort,
} from "@/server/admin";

export const metadata: Metadata = { title: "Accounts · Admin · OnlyJewishGirls", robots: { index: false } };

type Search = { [key: string]: string | string[] | undefined };
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

export default async function AdminUsersPage({ searchParams }: { searchParams: Promise<Search> }) {
  const { user: viewer, now } = await requireAdminPage();
  const params = await searchParams;
  const q = one(params.q)?.slice(0, 100) ?? "";
  const filter = (one(params.filter) ?? "all") as UserFilter;
  const sort = (one(params.sort) ?? "newest") as UserSort;
  const safeFilter: UserFilter = filter in USER_FILTERS ? filter : "all";
  const safeSort: UserSort = sort in USER_SORTS ? sort : "newest";
  const result = await listUsers({ q, filter: safeFilter, sort: safeSort, page: Number(one(params.page)) || 1 }, now);

  const pageHref = (page: number) => {
    const sp = new URLSearchParams();
    if (q) sp.set("q", q);
    if (safeFilter !== "all") sp.set("filter", safeFilter);
    if (safeSort !== "newest") sp.set("sort", safeSort);
    if (page > 1) sp.set("page", String(page));
    const s = sp.toString();
    return `/admin/users${s ? `?${s}` : ""}`;
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Accounts</h1>
        <AccountsToolbar canCreateAdmins={viewer.role === "owner"} />
      </div>

      <form method="get" className="panel grid gap-3 sm:grid-cols-[1fr_auto_auto_auto]" role="search">
        <div>
          <label htmlFor="q" className="sr-only">
            Search
          </label>
          <input
            id="q"
            name="q"
            type="search"
            className="input"
            placeholder="Name, username, email, phone or ID"
            defaultValue={q}
          />
        </div>
        <div>
          <label htmlFor="filter" className="sr-only">
            Show
          </label>
          <select id="filter" name="filter" className="input" defaultValue={safeFilter}>
            {Object.entries(USER_FILTERS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="sort" className="sr-only">
            Sort by
          </label>
          <select id="sort" name="sort" className="input" defaultValue={safeSort}>
            {Object.entries(USER_SORTS).map(([key, label]) => (
              <option key={key} value={key}>
                Sort: {label}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="btn-secondary">
          Search
        </button>
      </form>

      <p className="text-sm text-muted" aria-live="polite">
        {result.total === 0
          ? "No accounts match."
          : `${result.total.toLocaleString("en-US")} account${result.total === 1 ? "" : "s"}${result.pages > 1 ? ` · page ${result.page} of ${result.pages}` : ""}`}
      </p>

      {result.users.length > 0 && (
        <ul className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface" data-testid="account-list">
          {result.users.map(({ user: u, passkeys }) => {
            const streak = streakStatusFor(u, now);
            const complete = passkeys > 0 && u.totpEnabledAt !== null && u.recoveryCodesCreatedAt !== null;
            return (
              <li key={u.id}>
                <Link href={`/admin/users/${u.id}`} className="flex items-center gap-3 px-4 py-3 transition hover:bg-brand-soft/50">
                  <span
                    aria-hidden
                    className="grid size-10 shrink-0 place-items-center rounded-full bg-brand-soft font-semibold text-brand"
                  >
                    {u.firstName[0]}
                    {u.lastName[0]}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-semibold">{u.username}</span>
                      <span className="truncate text-sm text-muted">{fullName(u)}</span>
                    </span>
                    <span className="block truncate text-sm text-muted">{u.email}</span>
                    <span className="mt-1 block">
                      <AccountBadges
                        role={u.role}
                        suspended={u.suspendedAt !== null}
                        twoStepComplete={complete}
                        mustChangePassword={u.mustChangePassword}
                      />
                    </span>
                  </span>
                  <span className="shrink-0 text-right text-xs text-muted">
                    <span className="block text-sm font-semibold text-foreground">
                      {streak.count} {streak.alive ? (streak.atRisk ? "⌛" : "🔥") : ""}
                    </span>
                    <span className="block">
                      {u.lastLoginAt === null ? "Never signed in" : `Signed in ${timeAgo(u.lastLoginAt, now, viewer.timeZone)}`}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {result.pages > 1 && (
        <nav aria-label="Pages" className="flex items-center justify-between text-sm">
          {result.page > 1 ? (
            <Link href={pageHref(result.page - 1)} className="btn-secondary">
              ← Previous
            </Link>
          ) : (
            <span />
          )}
          {result.page < result.pages && (
            <Link href={pageHref(result.page + 1)} className="btn-secondary">
              Next →
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}
