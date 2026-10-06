import { NextResponse } from "next/server";
import { authMode, isAllowedEmail, safeNext } from "./config";
import { createServerSupabase } from "./server";

/** Resolves the public origin, which differs from request.url behind Vercel's proxy. */
function publicOrigin(request: Request, fallback: string) {
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (!forwardedHost) return fallback;
  const proto = request.headers.get("x-forwarded-proto") || "https";
  return `${proto}://${forwardedHost}`;
}

/** GET handler for `app/auth/callback/route.ts`. */
export async function handleAuthCallback(request: Request) {
  const url = new URL(request.url);
  const origin = publicOrigin(request, url.origin);
  const code = url.searchParams.get("code");
  const next = safeNext(url.searchParams.get("next"));

  if (url.searchParams.get("error") || !code) {
    return NextResponse.redirect(`${origin}/login?error=oauth`);
  }

  const supabase = await createServerSupabase();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    console.error("[auth] code exchange failed:", error.message);
    return NextResponse.redirect(`${origin}/login?error=oauth`);
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Google's `hd` parameter is only a hint the user can drop, so the domain is
  // decided here — and again in middleware on every later request.
  if (!isAllowedEmail(user?.email) || user?.user_metadata?.email_verified === false) {
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/login?error=domain`);
  }

  return NextResponse.redirect(`${origin}${next}`);
}

/** POST handler for `app/auth/signout/route.ts`. */
export async function handleSignOut(request: Request) {
  if (authMode() === "required") {
    const supabase = await createServerSupabase();
    await supabase.auth.signOut();
  }
  return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
}
