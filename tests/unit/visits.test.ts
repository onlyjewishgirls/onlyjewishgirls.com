import { describe, expect, it } from "vitest";
import { cleanPath, cleanReferrer, isBot, isTrackedPath, isVisitKind, isVisitRange } from "@/lib/admin/visits";

describe("cleanPath", () => {
  it("keeps the path and drops query strings and fragments", () => {
    expect(cleanPath("/home")).toBe("/home");
    expect(cleanPath("/reset-password?token=secret-token-value")).toBe("/reset-password");
    expect(cleanPath("/reset-password#token=secret")).toBe("/reset-password");
  });

  it("rejects anything that isn't a same-site path", () => {
    expect(cleanPath("https://evil.example/")).toBeNull();
    expect(cleanPath("//evil.example/")).toBeNull();
    expect(cleanPath("home")).toBeNull();
    expect(cleanPath("/<script>")).toBeNull();
    expect(cleanPath(42)).toBeNull();
    expect(cleanPath(undefined)).toBeNull();
  });

  it("caps the length", () => {
    expect(cleanPath(`/${"a".repeat(1000)}`)).toHaveLength(300);
  });
});

describe("cleanReferrer", () => {
  it("keeps another site's host and path, without the query string", () => {
    expect(cleanReferrer("https://www.google.com/", "onlyjewishgirls.com")).toBe("www.google.com");
    expect(cleanReferrer("https://t.co/abc?x=1", "onlyjewishgirls.com")).toBe("t.co/abc");
  });

  it("drops this site's own pages and unusable values", () => {
    expect(cleanReferrer("https://onlyjewishgirls.com/login", "onlyjewishgirls.com")).toBeNull();
    expect(cleanReferrer("android-app://com.google/", "onlyjewishgirls.com")).toBeNull();
    expect(cleanReferrer("not a url", "onlyjewishgirls.com")).toBeNull();
    expect(cleanReferrer("", "onlyjewishgirls.com")).toBeNull();
    expect(cleanReferrer(null, "onlyjewishgirls.com")).toBeNull();
  });
});

describe("isBot", () => {
  it("spots crawlers, link previews and scripts", () => {
    expect(isBot("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toBe(true);
    expect(isBot("facebookexternalhit/1.1")).toBe(true);
    expect(isBot("WhatsApp/2.23.20.0")).toBe(true);
    expect(isBot("curl/8.4.0")).toBe(true);
    expect(isBot("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0 Safari/537.36")).toBe(true);
    expect(isBot(null)).toBe(true);
  });

  it("lets real browsers through", () => {
    expect(
      isBot("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"),
    ).toBe(false);
    expect(isBot("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36")).toBe(false);
  });
});

describe("filters", () => {
  it("skips the admin panel and API", () => {
    expect(isTrackedPath("/admin")).toBe(false);
    expect(isTrackedPath("/admin/users/3")).toBe(false);
    expect(isTrackedPath("/api/visit")).toBe(false);
    expect(isTrackedPath("/administer")).toBe(true);
    expect(isTrackedPath("/")).toBe(true);
  });

  it("only accepts known ranges and kinds", () => {
    expect(isVisitRange("week")).toBe(true);
    expect(isVisitRange("toString")).toBe(false);
    expect(isVisitKind("bots")).toBe(true);
    expect(isVisitKind("__proto__")).toBe(false);
  });
});
