import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { cleanPath, cleanReferrer, cleanText, isTrackedPath } from "@/lib/admin/visits";
import { randomToken } from "@/server/crypto";
import { isLocalHost, requestHost } from "@/server/env";
import { api, readJson } from "@/server/http";
import { getAuth } from "@/server/session";
import { recordVisit } from "@/server/visits";

const YEAR_SECONDS = 365 * 24 * 60 * 60;
const VISITOR_ID = /^[A-Za-z0-9_-]{22}$/;

/** Records one page view, sent by VisitTracker. Always answers 204 so it never shows an error. */
export const POST = api(async (req: NextRequest) => {
  const body = await readJson(req);
  const host = await requestHost();
  const path = cleanPath(body.path);
  const res = new NextResponse(null, { status: 204 });
  if (!path || !isTrackedPath(path)) return res;

  // A random ID in a first-party cookie, so one browser's visits can be followed.
  // __Host- on the deployed site: HTTPS only, and no subdomain can set it.
  const cookie = isLocalHost(host) ? { name: "ojg_vid", secure: false } : { name: "__Host-ojg_vid", secure: true };
  const existing = (await cookies()).get(cookie.name)?.value;
  const visitorId = existing && VISITOR_ID.test(existing) ? existing : randomToken(16);
  if (visitorId !== existing) {
    res.cookies.set(cookie.name, visitorId, {
      httpOnly: true,
      secure: cookie.secure,
      sameSite: "lax",
      path: "/",
      maxAge: YEAR_SECONDS,
    });
  }

  const auth = await getAuth();
  const user = auth?.session.stage === "full" ? { id: auth.user.id, username: auth.user.username } : null;
  await recordVisit(
    {
      path,
      referrer: cleanReferrer(body.referrer, host),
      language: cleanText(body.lang, 35),
      timeZone: cleanText(body.tz, 64),
      screen: typeof body.screen === "string" && /^\d{2,5}x\d{2,5}$/.test(body.screen) ? body.screen : null,
    },
    visitorId,
    user,
  );
  return res;
});
