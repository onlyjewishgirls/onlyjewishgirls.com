import type { NextRequest } from "next/server";
import { dispatch } from "@/server/console/core";
import { ROUTES } from "@/server/console/routes";

/** The Console kit's JSON API (console-kit/API.md), over this site's server modules. */
async function handle(req: NextRequest, ctx: RouteContext<"/api/console/[...path]">) {
  const { path } = await ctx.params;
  return dispatch(req, path, ROUTES);
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;
