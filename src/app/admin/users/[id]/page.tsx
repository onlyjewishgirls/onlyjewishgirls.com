import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { AccountBadges } from "@/components/admin/AccountBadges";
import { EditProfileForm, NoteForm, RoleForm, StreakForm } from "@/components/admin/AccountForms";
import { ActionButton } from "@/components/admin/ActionButton";
import { EventList } from "@/components/admin/EventList";
import { countryName, describeDevice, formatDate, formatDateTime, formatPhone, fullName, timeAgo } from "@/lib/admin/format";
import { allowedActions, ROLE_LABELS, type AdminAction } from "@/lib/admin/permissions";
import { parsePhone } from "@/lib/validation";
import { requireAdminPage, userDetail } from "@/server/admin";

export const metadata: Metadata = { title: "Account · Admin · OnlyJewishGirls", robots: { index: false } };

function Panel({ title, children, id }: { title: string; children: ReactNode; id: string }) {
  return (
    <section className="panel" aria-labelledby={id}>
      <h2 id={id} className="mb-3 font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export default async function AdminUserPage({ params }: { params: Promise<{ id: string }> }) {
  const { user: viewer, session: viewerSession, now } = await requireAdminPage();
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id)) notFound();
  const detail = await userDetail(id, now);
  if (!detail) notFound();
  const { user: u, passkeys, sessions, lock, streak, recoveryCodesLeft, failedSignIns24h, events } = detail;
  const tz = viewer.timeZone;

  const allowed = new Set<AdminAction>(allowedActions(viewer, u));
  const may = (a: AdminAction) => allowed.has(a);
  const isSelf = viewer.id === u.id;
  const suspended = u.suspendedAt !== null;
  const locked = lock.password || lock.twoStep;
  const twoStepComplete = passkeys.length > 0 && u.totpEnabledAt !== null && u.recoveryCodesCreatedAt !== null;
  const phone = parsePhone(u.phone, "US");
  const btn = { userId: u.id, username: u.username };

  return (
    <div className="space-y-5">
      <Link href="/admin/users" className="link text-sm">
        ← Accounts
      </Link>

      <header className="flex flex-wrap items-start gap-4">
        <span aria-hidden className="grid size-14 shrink-0 place-items-center rounded-full bg-brand-soft text-xl font-semibold text-brand">
          {u.firstName[0]}
          {u.lastName[0]}
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold tracking-tight break-words sm:text-3xl" data-testid="account-username">
            {u.username}
            {isSelf && <span className="ml-2 align-middle text-sm font-normal text-muted">(you)</span>}
          </h1>
          <p className="text-muted">{fullName(u)}</p>
          <div className="mt-2">
            <AccountBadges
              role={u.role}
              suspended={suspended}
              locked={locked}
              twoStepComplete={twoStepComplete}
              mustChangePassword={u.mustChangePassword}
            />
          </div>
        </div>
      </header>

      {suspended && (
        <div role="status" className="rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm">
          <p className="font-semibold text-danger">⛔ Suspended {timeAgo(u.suspendedAt, now, tz)}</p>
          <p className="mt-1">{u.suspendedReason ? `Reason: ${u.suspendedReason}` : "No reason given."}</p>
          <p className="mt-1 text-muted">They can&apos;t sign in or reset their password until the suspension is lifted.</p>
        </div>
      )}
      {locked && (
        <div role="status" className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
          🔒 Locked out after too many wrong {lock.password ? "passwords" : "two-step attempts"}. It clears by itself in about{" "}
          {Math.max(1, Math.ceil(lock.retryAfterSeconds / 60))} minutes.
        </div>
      )}

      {allowed.size > 0 && (
        <section aria-label="Actions" className="panel">
          <h2 className="mb-3 font-semibold">Actions</h2>
          <div className="flex flex-wrap gap-2">
            {may("suspend") && !suspended && (
              <ActionButton
                {...btn}
                action="suspend"
                variant="danger"
                label="⛔ Suspend"
                confirm={{
                  title: `Suspend ${u.username}?`,
                  body: "They'll be signed out everywhere and can't sign in or reset their password until you lift it. You can undo this from the activity log.",
                  confirmLabel: "Suspend account",
                  danger: true,
                  input: { name: "reason", label: "Reason (only admins see it)", optional: true, multiline: true },
                }}
              />
            )}
            {may("unsuspend") && suspended && <ActionButton {...btn} action="unsuspend" variant="primary" label="Lift suspension" />}
            {may("unlock_sign_in") && locked && <ActionButton {...btn} action="unlock_sign_in" label="🔓 Unlock sign-in" />}
            {may("sign_out_everywhere") && sessions.length > 0 && (
              <ActionButton
                {...btn}
                action="sign_out_everywhere"
                label={isSelf ? "Sign out my other devices" : "Sign out everywhere"}
                confirm={{
                  title: isSelf ? "Sign out your other devices?" : `Sign ${u.username} out everywhere?`,
                  body: isSelf
                    ? "Every device except this one will need to sign in again."
                    : "Every device they're signed in on will need to sign in again, with their password and second factor.",
                  confirmLabel: "Sign out",
                }}
              />
            )}
            {may("send_password_reset") && !suspended && (
              <ActionButton
                {...btn}
                action="send_password_reset"
                label="✉️ Email a reset link"
                confirm={{
                  title: "Email a password reset link?",
                  body: `We'll email ${u.email} a link to choose a new password. It works once and expires in 30 minutes. Their current password keeps working until they use it.`,
                  confirmLabel: "Send email",
                }}
              />
            )}
            {may("set_temp_password") && (
              <ActionButton
                {...btn}
                action="set_temp_password"
                label="🔑 Set a temporary password"
                confirm={{
                  title: "Set a temporary password?",
                  body: "Their current password stops working right away and they're signed out everywhere. You'll see the new password once, to give them. After signing in they must choose their own.",
                  confirmLabel: "Set temporary password",
                }}
              />
            )}
            {may("reset_two_step") && (passkeys.length > 0 || u.totpEnabledAt !== null || recoveryCodesLeft > 0) && (
              <ActionButton
                {...btn}
                action="reset_two_step"
                variant="danger"
                label="Reset two-step sign-in"
                confirm={{
                  title: "Reset two-step sign-in?",
                  body: "Removes their passkeys, authenticator app and recovery codes, and signs them out everywhere. Use this if they lost their phone. After their password, they'll set everything up again. This can't be undone.",
                  confirmLabel: "Reset two-step sign-in",
                  danger: true,
                }}
              />
            )}
            {may("delete") && (
              <ActionButton
                {...btn}
                action="delete"
                variant="danger"
                label="🗑 Delete account"
                confirm={{
                  title: `Delete ${u.username}?`,
                  body: "Deletes the account, their passkeys, sessions and streak for good. The activity log keeps their username. This can't be undone.",
                  confirmLabel: "Delete forever",
                  danger: true,
                  input: { name: "confirm", label: `Type ${u.username} to confirm`, mustEqual: u.username },
                }}
              />
            )}
          </div>
          {isSelf && (
            <p className="mt-3 text-xs text-muted">
              Some actions aren&apos;t available on your own account, so you can&apos;t lock yourself out.{" "}
              <Link href="/change-password" className="link">
                Change your password
              </Link>
            </p>
          )}
        </section>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Profile" id="profile">
          <Facts
            items={[
              ["Email", <a key="e" href={`mailto:${encodeURIComponent(u.email)}`} className="link">{u.email}</a>],
              ["Mobile", <a key="p" href={`tel:${u.phone}`} className="link">{formatPhone(u.phone)}</a>],
              ["Role", ROLE_LABELS[u.role]],
              ["Joined", formatDateTime(u.createdAt, tz)],
              ["Last sign-in", `${timeAgo(u.lastLoginAt, now, tz)}${u.lastLoginAt ? ` (${formatDateTime(u.lastLoginAt, tz)})` : ""}`],
              ["Last active", timeAgo(u.streak.lastActivityAt, now, tz)],
              ["Time zone", u.timeZone],
              ["Location", countryName(u.country) ?? "Unknown"],
              ["Failed sign-ins (24 h)", String(failedSignIns24h)],
              ["Account ID", String(u.id)],
            ]}
          />
          {u.adminNote && (
            <p className="mt-4 rounded-lg border border-border bg-background px-3 py-2 text-sm whitespace-pre-wrap">
              <span className="block text-xs font-semibold text-muted">Admin note</span>
              {u.adminNote}
            </p>
          )}
        </Panel>

        <Panel title="🔥 Streak" id="streak">
          <Facts
            items={[
              ["Current", `${streak.count} day${streak.count === 1 ? "" : "s"}${streak.alive ? (streak.atRisk ? " ⌛ at risk" : " 🔥") : ""}`],
              ["Longest", `${streak.longest} day${streak.longest === 1 ? "" : "s"}`],
              ["Deadline", streak.deadline ? formatDateTime(streak.deadline, tz) : "—"],
              ["Started", u.streak.startedAt ? formatDate(u.streak.startedAt, tz) : "—"],
            ]}
          />
          {may("set_streak") && (
            <div className="mt-4 border-t border-border pt-4">
              <StreakForm userId={u.id} username={u.username} count={u.streak.count} />
            </div>
          )}
        </Panel>

        <Panel title="Two-step sign-in" id="two-step">
          <div className="space-y-4 text-sm">
            <div>
              <p className="font-medium">Passkeys ({passkeys.length})</p>
              {passkeys.length === 0 ? (
                <p className="text-muted">None.</p>
              ) : (
                <ul className="mt-1 divide-y divide-border">
                  {passkeys.map((p) => (
                    <li key={p.id} className="flex items-center gap-3 py-2">
                      <span className="min-w-0 flex-1">
                        <span className="block">
                          {p.deviceType === "multiDevice" ? "Synced passkey" : "Device-bound passkey"}
                          {p.backedUp ? " · backed up" : ""}
                        </span>
                        <span className="block text-xs text-muted">
                          Added {formatDate(p.createdAt, tz)} · last used {timeAgo(p.lastUsedAt, now, tz)}
                        </span>
                      </span>
                      {may("remove_passkey") && (
                        <ActionButton
                          {...btn}
                          action="remove_passkey"
                          extra={{ passkeyId: p.id }}
                          small
                          label="Remove"
                          confirm={{
                            title: "Remove this passkey?",
                            body: "It stops working right away. They'll be asked to add a passkey next time they sign in.",
                            confirmLabel: "Remove passkey",
                            danger: true,
                          }}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="flex items-center gap-3">
              <p className="flex-1">
                <span className="font-medium">Authenticator app: </span>
                {u.totpEnabledAt ? `connected ${formatDate(u.totpEnabledAt, tz)}` : "not connected"}
              </p>
              {may("disable_totp") && u.totpEnabledAt && (
                <ActionButton
                  {...btn}
                  action="disable_totp"
                  small
                  label="Turn off"
                  confirm={{
                    title: "Turn off their authenticator app?",
                    body: "Codes from it stop working. They'll be asked to connect one again next time they sign in.",
                    confirmLabel: "Turn off",
                    danger: true,
                  }}
                />
              )}
            </div>
            <div className="flex items-center gap-3">
              <p className="flex-1">
                <span className="font-medium">Recovery codes: </span>
                {u.recoveryCodesCreatedAt ? `${recoveryCodesLeft} of 10 left` : "none yet"}
              </p>
              {may("clear_recovery_codes") && u.recoveryCodesCreatedAt && (
                <ActionButton
                  {...btn}
                  action="clear_recovery_codes"
                  small
                  label="Delete"
                  confirm={{
                    title: "Delete their recovery codes?",
                    body: "Their saved codes stop working. They'll get a new set next time they sign in.",
                    confirmLabel: "Delete codes",
                    danger: true,
                  }}
                />
              )}
            </div>
          </div>
        </Panel>

        <Panel title={`Signed-in devices (${sessions.length})`} id="sessions">
          {sessions.length === 0 ? (
            <p className="text-sm text-muted">Not signed in anywhere.</p>
          ) : (
            <ul className="divide-y divide-border text-sm" data-testid="session-list">
              {sessions.map((s) => {
                const here = s.idHash === viewerSession.idHash;
                return (
                  <li key={s.idHash} className="flex items-center gap-3 py-2">
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">
                        {describeDevice(s.userAgent)}
                        {here && <span className="ml-2 badge">This device</span>}
                        {s.stage === "password" && <span className="ml-2 badge text-muted">Signing in</span>}
                      </span>
                      <span className="block text-xs break-words text-muted">
                        {[s.city, countryName(s.country), s.ip].filter(Boolean).join(" · ") || "Unknown location"}
                      </span>
                      <span className="block text-xs text-muted">
                        Signed in {timeAgo(s.createdAt, now, tz)} · active {timeAgo(s.lastSeenAt, now, tz)}
                      </span>
                    </span>
                    {may("revoke_session") && !here && (
                      <ActionButton {...btn} action="revoke_session" extra={{ sessionId: s.idHash }} small label="Sign out" />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>

      {(may("edit_profile") || may("set_note") || may("set_role")) && (
        <section className="panel space-y-6" aria-labelledby="manage-title">
          <h2 id="manage-title" className="font-semibold">
            Edit
          </h2>
          {may("edit_profile") && (
            <details className="group">
              <summary className="cursor-pointer text-sm font-medium">Edit profile</summary>
              <div className="mt-3">
                <EditProfileForm
                  userId={u.id}
                  username={u.username}
                  initial={{
                    firstName: u.firstName,
                    middleName: u.middleName ?? "",
                    lastName: u.lastName,
                    email: u.email,
                    username: u.username,
                    phoneCountry: phone?.country ?? "US",
                    phone: phone?.formatNational() ?? u.phone,
                  }}
                />
              </div>
            </details>
          )}
          {may("set_role") && <RoleForm userId={u.id} username={u.username} role={u.role} />}
          {may("set_note") && <NoteForm userId={u.id} username={u.username} note={u.adminNote} />}
        </section>
      )}

      <Panel title="Activity" id="activity">
        <EventList events={events} timeZone={tz} now={now} canUndo={viewer.role === "owner"} empty="No activity yet." />
        {events.length >= 100 && (
          <Link href={`/admin/activity?user=${u.id}`} className="link mt-3 inline-block text-sm">
            See older activity
          </Link>
        )}
        <Link href={`/admin/visitors?user=${u.id}&range=month`} className="link mt-3 block text-sm">
          Pages they visited
        </Link>
      </Panel>
    </div>
  );
}
