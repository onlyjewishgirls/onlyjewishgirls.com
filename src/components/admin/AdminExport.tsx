"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, type ReactNode } from "react";

declare global {
  interface Window {
    ConsoleExport?: { attach(container: Element, opts?: Record<string, unknown>): unknown };
  }
}

/** The Console kit's standalone exporter, vendored unchanged next to console.js (bump with the kit). */
const EXPORT_JS = "/console/export.js?v=1.1.1";

/** Pages under the admin layout that show no data: the step-up form. */
const NO_DATA = (pathname: string) => pathname.startsWith("/admin/verify");

/**
 * PORTAL-STANDARD §11 on the classic admin pages: wraps the page in a
 * `data-export-section` region and loads the kit's export.js, which puts the
 * Export menu (TXT, JSON, CSV, DOCX, PDF, HTML) in the `[data-export-menu]` slot
 * AdminNav renders. The title comes from the page's <h1>. The file is built in the
 * browser from what the page shows; each download is audited through the console
 * API (POST /api/console/exports), fire-and-forget.
 *
 * The region is keyed by path, so every client-side navigation gets a fresh
 * container and menu. export.js only ever writes inside the empty slot, never into
 * React-rendered children, and only after hydration (afterInteractive / effects).
 */
export function AdminExportRegion({ site, children }: { site: string; children: ReactNode }) {
  const pathname = usePathname();
  const ref = useRef<HTMLDivElement>(null);
  const attach = useCallback(() => {
    if (ref.current && window.ConsoleExport) window.ConsoleExport.attach(ref.current);
  }, []);
  // Navigations after the script has loaded: attach to the new region.
  useEffect(attach, [attach, pathname]);

  if (NO_DATA(pathname)) return <>{children}</>;
  return (
    <>
      <div
        key={pathname}
        ref={ref}
        data-export-section=""
        data-export-site={site}
        data-export-audit-url="/api/console/exports"
      >
        {children}
      </div>
      <Script src={EXPORT_JS} strategy="afterInteractive" onReady={attach} />
    </>
  );
}

/** Where the Export menu goes (inside the region). Empty for React; export.js fills it. */
export function ExportMenuSlot() {
  const pathname = usePathname();
  if (NO_DATA(pathname)) return null;
  return <div key={pathname} data-export-menu="" className="flex shrink-0 justify-end" />;
}
