"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { isTrackedPath } from "@/lib/admin/visits";

/**
 * Tells the server about each page view, for the admin visitor log. Sends the
 * path only (never the query string), plus the referring site on the first page.
 */
export function VisitTracker() {
  const pathname = usePathname();
  const first = useRef(true);

  useEffect(() => {
    if (!pathname || !isTrackedPath(pathname)) return;
    const referrer = first.current ? document.referrer : "";
    first.current = false;
    let tz: string | undefined;
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      tz = undefined;
    }
    fetch("/api/visit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: pathname,
        referrer,
        tz,
        lang: navigator.language,
        screen: `${window.innerWidth}x${window.innerHeight}`,
      }),
      keepalive: true,
      credentials: "same-origin",
    }).catch(() => {});
  }, [pathname]);

  return null;
}
