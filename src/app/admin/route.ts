import type { NextRequest } from "next/server";
import { isAdminRole } from "@/lib/admin/permissions";
import { adminDenied } from "@/server/admin";
import { APP_NAME } from "@/server/env";
import { mfaState, nextStep } from "@/server/mfa";
import { getAuth } from "@/server/session";

/** Bumped with the vendored kit (public/console/) so browsers don't keep an old copy. */
const KIT_VERSION = "1.0.0";

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>Admin console · ${APP_NAME}</title>
<link rel="stylesheet" href="/console/console.css?v=${KIT_VERSION}">
</head>
<body>
<div id="console-root" data-api-base="/api/console" data-sign-out-url="/login" data-home-url="/home" data-login-url="/login" data-brand="">
<noscript>The admin console needs JavaScript.</noscript>
</div>
<script src="/console/console.js?v=${KIT_VERSION}" defer></script>
</body>
</html>`;

/**
 * /admin: the shared Console kit (PORTAL-STANDARD §5), vendored in public/console/ and
 * driven by /api/console/*. Anyone who isn't a fully signed-in admin gets what they got
 * before: the sign-in page, their next sign-in step, or a plain 404.
 */
export async function GET(req: NextRequest) {
  const auth = await getAuth();
  if (!auth) return Response.redirect(new URL("/login", req.url), 303);
  const next = nextStep(auth.session.stage, await mfaState(auth.user), auth.user.mustChangePassword);
  if (next !== "/home") return Response.redirect(new URL(next, req.url), 303);
  if (!isAdminRole(auth.user.role)) {
    await adminDenied(auth.user, "admin console page");
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "same-origin",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    },
  });
}
