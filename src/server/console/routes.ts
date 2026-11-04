import "server-only";
import type { Route } from "./core";
import * as people from "./people";
import * as records from "./records";
import * as sections from "./sections";

/** /api/console/* (console-kit/API.md). `write` routes need a fresh second factor (step-up). */
export const ROUTES: Route[] = [
  { method: "GET", pattern: "bootstrap", handler: sections.bootstrap },
  { method: "GET", pattern: "overview", handler: sections.overview },
  { method: "GET", pattern: "events", handler: records.recentEvents },

  { method: "GET", pattern: "people", handler: people.listPeople },
  { method: "POST", pattern: "people", handler: people.createPerson, write: true },
  { method: "GET", pattern: "people/:id", handler: people.getPerson },
  { method: "PATCH", pattern: "people/:id", handler: people.patchPerson, write: true },
  { method: "DELETE", pattern: "people/:id", handler: people.deletePerson, write: true },
  { method: "POST", pattern: "people/:id/roles", handler: people.setPersonRoles, write: true },
  { method: "POST", pattern: "people/:id/permissions", handler: people.setPersonPermissions, write: true },
  { method: "POST", pattern: "people/:id/status", handler: people.setPersonStatus, write: true },
  { method: "POST", pattern: "people/:id/lock", handler: people.lockPerson, write: true },
  { method: "POST", pattern: "people/:id/unlock", handler: people.unlockPerson, write: true },
  { method: "POST", pattern: "people/:id/password", handler: people.resetPassword, write: true },
  { method: "POST", pattern: "people/:id/force-change", handler: people.forceChange, write: true },
  { method: "POST", pattern: "people/:id/mfa/reset", handler: people.resetMfa, write: true },
  { method: "POST", pattern: "people/:id/mfa/totp/reset", handler: people.resetTotp, write: true },
  { method: "DELETE", pattern: "people/:id/mfa/passkeys/:pid", handler: people.removePersonPasskey, write: true },
  { method: "POST", pattern: "people/:id/sessions/revoke", handler: people.revokePersonSessions, write: true },
  { method: "POST", pattern: "people/:id/streak", handler: people.setPersonStreak, write: true },
  { method: "POST", pattern: "people/:id/streak/restores", handler: people.grantPersonRestores, write: true },
  { method: "POST", pattern: "people/:id/email", handler: people.emailPerson, write: true },

  { method: "GET", pattern: "roles", handler: sections.roles },
  { method: "GET", pattern: "streaks", handler: sections.streaks },
  { method: "GET", pattern: "streaks/restores", handler: sections.streakRestores },
  { method: "GET", pattern: "settings", handler: sections.getSettingsRoute },
  { method: "PATCH", pattern: "settings", handler: sections.patchSettings, write: true },
  { method: "POST", pattern: "alerts/test", handler: records.testAlert, write: true },

  { method: "GET", pattern: "security/visitors", handler: sections.visitors },
  { method: "GET", pattern: "security/visitors/:id", handler: sections.visitorDetail },

  { method: "GET", pattern: "ips", handler: sections.listAllow },
  { method: "POST", pattern: "ips", handler: sections.addAllow, write: true },
  { method: "PATCH", pattern: "ips/:id", handler: sections.patchAllow, write: true },
  { method: "DELETE", pattern: "ips/:id", handler: sections.deleteAllow, write: true },
  { method: "GET", pattern: "deny", handler: sections.listDeny },
  { method: "POST", pattern: "deny", handler: sections.addDeny, write: true },
  { method: "PATCH", pattern: "deny/:id", handler: sections.patchDeny, write: true },
  { method: "POST", pattern: "deny/:id/unblock", handler: sections.unblock, write: true },

  { method: "GET", pattern: "sessions", handler: sections.sessions },
  { method: "DELETE", pattern: "sessions/:id", handler: sections.deleteSessionRoute, write: true },

  { method: "GET", pattern: "audit", handler: records.listAudit },
  { method: "POST", pattern: "audit/:id/revert", handler: records.revertAudit, write: true },
  { method: "GET", pattern: "alerts", handler: records.listAlertsRoute },
];
