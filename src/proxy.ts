import type { NextRequest } from "next/server";
import { authMiddleware } from "@akka/auth/middleware";

/**
 * Google sign-in restricted to @akka.app, through Supabase Auth (packages/akka-auth).
 * Supabase not configured: open in `next dev`, 503 in production (fail closed).
 * Next 16's `proxy` convention (formerly `middleware`).
 */
export async function proxy(request: NextRequest) {
  return authMiddleware(request);
}

export const config = {
  /**
   * Everything is protected except Next's static assets and the icons, which the login page
   * needs before anyone is signed in. Next reads this statically, so it stays a literal.
   * `/icon.png` and `/apple-icon.png` are excluded too: without that they 302 to the login
   * page and the tab is left with no icon.
   */
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|icon|apple-icon|akka-logo).*)"],
};
