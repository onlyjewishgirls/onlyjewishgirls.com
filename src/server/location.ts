import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { observesIsraelSchedule, type Place } from "@/lib/streak/calendar";
import { updateLocation, type User } from "./users";

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

/** Updates the stored location from this request if it changed, and returns the user's place. */
export async function syncPlace(user: User): Promise<Place> {
  const location = requestLocation(user.timeZone);
  if (
    location.latitude !== user.latitude ||
    location.longitude !== user.longitude ||
    location.country !== user.country
  ) {
    await updateLocation(user.id, location);
  }
  return {
    timeZone: user.timeZone,
    israel: observesIsraelSchedule(user.timeZone, location.country),
    latitude: location.latitude,
    longitude: location.longitude,
  };
}
