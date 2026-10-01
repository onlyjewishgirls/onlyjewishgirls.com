import { NextResponse } from "next/server";
import { api } from "@/server/http";
import { endSession } from "@/server/session";

export const POST = api(async () => {
  await endSession();
  return NextResponse.json({ next: "/" });
});
