import { NextResponse } from "next/server";
import { logEvent } from "@/server/events";
import { api } from "@/server/http";
import { endSession, getAuth } from "@/server/session";

export const POST = api(async () => {
  const auth = await getAuth();
  if (auth) await logEvent("signout", { user: auth.user });
  await endSession();
  return NextResponse.json({ next: "/" });
});
