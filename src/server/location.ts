import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { headers } from "next/headers";
import { observesIsraelSchedule, type Place } from "@/lib/streak/calendar";
import { validTimeZone } from "@/lib/streak/dates";
import { updateLocation, updateTimeZone, type User } from "./users";

/** The header every browser request from this site carries (lib/api-client.ts postJson). */
export const TIME_ZONE_HEADER = "x-time-zone";

/**
 * On a successful sign-in (password, passkey, authenticator, email code,
 * recovery code): store the browser's time zone, from the request body if the
 * route has one or else the X-Time-Zone header. Validated, canonicalised, and
 * only ever used for the user's streak days and the times shown to them.
 * Returns the zone stored, or null when nothing usable was sent.
 */
export async function captureTimeZone(user: User, fromBody?: unknown): Promise<string | null> {
  const timeZone = validTimeZone(fromBody) ?? validTimeZone((await headers()).get(TIME_ZONE_HEADER));
  if (!timeZone) return null;
  if (timeZone !== user.timeZone) {
    await updateTimeZone(user.id, timeZone);
    user.timeZone = timeZone;
  }
  return timeZone;
}

interface Location {
  latitude: number | null;
  longitude: number | null;
  country: string | null;
}

/**
 * Cloudflare's city-level estimate of where this request came from. It's
 * only trusted when its time zone matches the browser's; otherwise (a VPN, or
 * no data) the location is unknown and the streak uses the cautious
 * whole-day Shabbat / Yom Tov window instead of sunset times.
 */
function requestLocation(timeZone: string): Location {
  const cf = getCloudflareContext().cf as { latitude?: string; longitude?: string; country?: string; timezone?: string } | undefined;
  const latitude = Number.parseFloat(cf?.latitude ?? "");
  const longitude = Number.parseFloat(cf?.longitude ?? "");
  if (cf?.timezone !== timeZone || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return { latitude: null, longitude: null, country: null };
  }
  // ~1 km precision is plenty for sunset times and stores no more than needed.
  return {
    latitude: Math.round(latitude * 100) / 100,
    longitude: Math.round(longitude * 100) / 100,
    country: cf.country ?? null,
  };
}

/**
 * The time zone a user's streak days are judged in: their own (taken from the
 * browser at every sign-in, or set by an admin), else the portal's.
 */
export function streakTimeZone(user: User, portalTimeZone: string): string {
  return validTimeZone(user.timeZone) ?? portalTimeZone;
}

/** Updates the stored location from this request if it changed, and returns the user's place. */
export async function syncPlace(user: User, portalTimeZone: string): Promise<Place> {
  const timeZone = streakTimeZone(user, portalTimeZone);
  const location = requestLocation(timeZone);
  if (
    location.latitude !== user.latitude ||
    location.longitude !== user.longitude ||
    location.country !== user.country
  ) {
    await updateLocation(user.id, location);
  }
  return {
    timeZone,
    israel: observesIsraelSchedule(timeZone, location.country),
    latitude: location.latitude,
    longitude: location.longitude,
  };
}

/** The user's place as last stored, for looking at someone else's streak (admin panel). */
export function storedPlace(user: User, portalTimeZone: string): Place {
  const timeZone = streakTimeZone(user, portalTimeZone);
  return {
    timeZone,
    israel: observesIsraelSchedule(timeZone, user.country),
    latitude: user.latitude,
    longitude: user.longitude,
  };
}
