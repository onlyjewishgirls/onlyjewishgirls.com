/**
 * Who every email says it is from, and the one layout every email uses (PORTAL-STANDARD §6: each
 * message must read as a legitimate notice from the business, not phishing). Pure: no Next.js,
 * OpenNext or database imports, so the Worker entry, the app and the tests all render the same mail.
 *
 * The layout is deliberately plain, because Plunk's /v1/send has no text field and builds the
 * plain-text part from this HTML: a heading, short paragraphs, a list of details, "What you can do"
 * and a footer. No images, no tables, and every link's visible text is the URL itself, on this
 * site's own domain.
 */

/** The per-site identity settings (wrangler.jsonc `vars`), each with a default below. */
export interface IdentityEnv {
  MAIL_BUSINESS_NAME?: string;
  MAIL_BUSINESS_LEGAL_NAME?: string;
  MAIL_WEBSITE?: string;
  MAIL_SUPPORT_EMAIL?: string;
}

export interface MailIdentity {
  /** Short public name: the sender name and the subject tag, e.g. "OnlyJewishGirls". */
  name: string;
  /** Legal business name for the footer. */
  legalName: string;
  /** The website as a visible URL, e.g. "https://onlyjewishgirls.com". */
  website: string;
  /** Support address on the site's own domain: the footer and Plunk's `reply`. */
  supportEmail: string;
  /** The website's host, e.g. "onlyjewishgirls.com". Links may only point here or to a subdomain. */
  host: string;
  /** The portal in words, as subjects end: "on the member site". */
  portal: string;
}

/**
 * Defaults, from the site itself: its public name (header, page titles) and domain. The site states
 * no legal entity and has no support address yet, so both are owner questions.
 */
export const IDENTITY_DEFAULTS = {
  name: "OnlyJewishGirls",
  legalName: "OnlyJewishGirls",
  website: "https://onlyjewishgirls.com",
  supportEmail: "info@onlyjewishgirls.com",
} as const;

export const PORTAL_NAME = "member site";

export function mailIdentity(env: IdentityEnv = {}): MailIdentity {
  const pick = (value: string | undefined, fallback: string) => value?.trim() || fallback;
  const website = pick(env.MAIL_WEBSITE, IDENTITY_DEFAULTS.website).replace(/\/+$/, "");
  let host: string;
  try {
    host = new URL(website).hostname.replace(/^www\./, "");
  } catch {
    host = new URL(IDENTITY_DEFAULTS.website).hostname;
  }
  return {
    name: pick(env.MAIL_BUSINESS_NAME, IDENTITY_DEFAULTS.name),
    legalName: pick(env.MAIL_BUSINESS_LEGAL_NAME, pick(env.MAIL_BUSINESS_NAME, IDENTITY_DEFAULTS.legalName)),
    website,
    supportEmail: pick(env.MAIL_SUPPORT_EMAIL, IDENTITY_DEFAULTS.supportEmail),
    host,
    portal: PORTAL_NAME,
  };
}

/** "[OnlyJewishGirls] Failed sign-in attempt on the member site". */
export function subjectLine(id: MailIdentity, what: string, suffix = ""): string {
  return `[${id.name}] ${what} on the ${id.portal}${suffix}`;
}

export const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Whether a link may point at this URL: https (or http) on the site's own domain or a subdomain. */
export function allowedLink(url: string, id: MailIdentity): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    const host = u.hostname.toLowerCase();
    return host === id.host || host.endsWith(`.${id.host}`);
  } catch {
    return false;
  }
}

/**
 * Escapes text and turns URLs on the site's own domain into links whose visible text is the URL.
 * Any other URL stays plain text, so no email ever carries a link to another domain.
 */
function inline(text: string, id: MailIdentity): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    const trail = m[0].match(/[.,;:!?)]+$/)?.[0] ?? "";
    const url = trail ? m[0].slice(0, -trail.length) : m[0];
    out += escapeHtml(text.slice(last, m.index));
    out += allowedLink(url, id) ? `<a href="${escapeHtml(url)}" style="color:#1f3fae">${escapeHtml(url)}</a>` : escapeHtml(url);
    out += escapeHtml(trail);
    last = m.index + m[0].length;
  }
  return out + escapeHtml(text.slice(last));
}

/** "Nov 4, 2026, 3:00:00 PM EST (America/New_York) · 2026-11-04 20:00:00 UTC". */
export function formatWhen(ms: number, timeZone: string): string {
  let local: string;
  try {
    local = new Date(ms).toLocaleString("en-US", { timeZone, dateStyle: "medium", timeStyle: "long" });
  } catch {
    timeZone = "UTC";
    local = new Date(ms).toLocaleString("en-US", { timeZone, dateStyle: "medium", timeStyle: "long" });
  }
  return `${local} (${timeZone}) · ${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** "Lakewood, New Jersey, US", or null when the request carried no location. */
export function approximateLocation(place: { city?: string | null; region?: string | null; country?: string | null }): string | null {
  const parts = [place.city, place.region, place.country].map((p) => p?.trim()).filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

export type Audience = { kind: "admin" } | { kind: "user"; username: string };

export interface Notice {
  /** What happened, in plain words: the email's heading. */
  heading: string;
  audience: Audience;
  /** Something that must not be missed (the owner-lockout notice), shown in a box before the rest. */
  callout?: string;
  /** A sign-in code, shown large, with the sentence that introduces it. */
  code?: { intro: string; value: string };
  /** Short paragraphs: what happened. */
  paragraphs?: string[];
  /** A link the recipient asked for (a password reset), shown as its own visible URL. */
  link?: { intro: string; url: string };
  /** Paragraphs after the link or code (expiry, "we will never ask"). */
  after?: string[];
  /** The key facts: when, IP address, location, account, portal. */
  details?: [string, string][];
  /** A titled list, e.g. the addresses in an hourly digest. */
  list?: { heading: string; items: string[] };
  /** "What you can do". */
  actions: string[];
}

/** One line on who we are, one on why this person is getting it. */
export function introLines(id: MailIdentity, audience: Audience): [string, string] {
  const who = `This email is from ${id.name} (${id.website}).`;
  const why =
    audience.kind === "admin"
      ? `You're receiving this because you're an administrator of the ${id.name} ${id.portal}.`
      : `You're receiving this because this address is the account email for "${audience.username}" on the ${id.name} ${id.portal}.`;
  return [who, why];
}

export function footerLines(id: MailIdentity): [string, string] {
  return [
    `${id.legalName} · ${id.website} · ${id.supportEmail}`,
    `This is an automated notice from the ${id.name} ${id.portal}. We will never ask for your password by email. Questions? Reply to this email or write to ${id.supportEmail}.`,
  ];
}

const FONT = "font-family:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MUTED = "color:#55545f";

/** The email as Plunk gets it (HTML) and as the logs and local console print it (text). */
export function renderNotice(id: MailIdentity, n: Notice): { html: string; text: string } {
  const [who, why] = introLines(id, n.audience);
  const [footer1, footer2] = footerLines(id);
  const p = (t: string, style = "") => `<p style="margin:0 0 14px${style}">${inline(t, id)}</p>`;
  const h2 = (t: string) => `<h2 style="margin:22px 0 8px;font-size:16px;line-height:1.3">${escapeHtml(t)}</h2>`;
  const ul = (items: string[]) =>
    `<ul style="margin:0 0 14px;padding-left:20px">${items.map((i) => `<li style="margin:0 0 6px">${i}</li>`).join("")}</ul>`;

  const html: string[] = [];
  html.push(`<div style="${FONT};font-size:15px;line-height:1.55;color:#1c1b22;max-width:560px;margin:0 auto;padding:8px 4px;overflow-wrap:anywhere;word-break:break-word">`);
  html.push(`<p style="margin:0 0 18px;font-size:17px;font-weight:700;color:#1f3fae">${escapeHtml(id.name)}</p>`);
  html.push(`<h1 style="margin:0 0 12px;font-size:21px;line-height:1.3">${escapeHtml(n.heading)}</h1>`);
  html.push(p(who, `;${MUTED}`), p(why, `;${MUTED}`));
  if (n.callout) {
    html.push(`<p style="margin:0 0 14px;padding:12px 14px;border-left:4px solid #b42318;background:#fef3f2;color:#7a1a12;font-weight:600">${inline(n.callout, id)}</p>`);
  }
  for (const t of n.paragraphs ?? []) html.push(p(t));
  if (n.code) {
    html.push(p(n.code.intro));
    html.push(
      `<p style="margin:0 0 14px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:32px;font-weight:700;letter-spacing:6px;color:#1c1b22">${escapeHtml(n.code.value)}</p>`,
    );
  }
  if (n.link) {
    html.push(p(n.link.intro));
    html.push(p(n.link.url, ";font-size:15px"));
  }
  for (const t of n.after ?? []) html.push(p(t));
  if (n.details?.length) {
    html.push(h2("Details"));
    html.push(ul(n.details.map(([k, v]) => `<strong>${escapeHtml(k)}:</strong> ${inline(v, id)}`)));
  }
  if (n.list?.items.length) {
    html.push(h2(n.list.heading));
    html.push(ul(n.list.items.map((i) => inline(i, id))));
  }
  if (n.actions.length) {
    html.push(h2("What you can do"));
    html.push(ul(n.actions.map((a) => inline(a, id))));
  }
  html.push(`<hr style="border:0;border-top:1px solid #e3e2ea;margin:26px 0 14px">`);
  html.push(`<p style="margin:0 0 8px;font-size:13px;${MUTED}">${inline(footer1, id)}</p>`);
  html.push(`<p style="margin:0;font-size:13px;${MUTED}">${inline(footer2, id)}</p>`);
  html.push(`</div>`);

  const text: string[] = [id.name, "", n.heading, "", who, why, ""];
  if (n.callout) text.push(n.callout, "");
  for (const t of n.paragraphs ?? []) text.push(t, "");
  if (n.code) text.push(n.code.intro, "", n.code.value, "");
  if (n.link) text.push(n.link.intro, "", n.link.url, "");
  for (const t of n.after ?? []) text.push(t, "");
  if (n.details?.length) text.push("Details", ...n.details.map(([k, v]) => `- ${k}: ${v}`), "");
  if (n.list?.items.length) text.push(n.list.heading, ...n.list.items.map((i) => `- ${i}`), "");
  if (n.actions.length) text.push("What you can do", ...n.actions.map((a) => `- ${a}`), "");
  text.push("--", footer1, footer2, "");
  return { html: html.join("\n"), text: text.join("\n") };
}
