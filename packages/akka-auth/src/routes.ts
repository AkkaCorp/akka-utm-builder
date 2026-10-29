import { NextResponse } from "next/server";
import { MFA_PATH, appKey, authMode, authStack, isAllowedEmail, safeNext } from "./config";
import { decide } from "./decision";
import { createServerSupabase } from "./server";
import { readClaims, signOutHere } from "./unified";

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

  if (authStack() === "unified") {
    // The fresh token already carries the `akka` claim: apply the same rules
    // the middleware will, so a refused account never lands on a page.
    const decision = decide(await readClaims(supabase), appKey() ?? "");
    if (decision.kind === "allow") return NextResponse.redirect(`${origin}${next}`);
    if (decision.kind === "mfa") {
      return NextResponse.redirect(`${origin}${MFA_PATH}?next=${encodeURIComponent(next)}`);
    }
    await signOutHere(supabase);
    const reason = decision.kind === "deny" ? decision.reason : "oauth";
    return NextResponse.redirect(`${origin}/login?error=${reason}`);
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

/**
 * POST handler for `app/auth/password/route.ts`: the partner sign-in form.
 * Unified stack only (404 otherwise). Signs in an existing account, never
 * creates one. Akka addresses are turned away before Supabase is even asked:
 * they sign in with Google (rule 4), and the middleware refuses them anyway.
 */
export async function handlePasswordSignIn(request: Request) {
  if (authStack() !== "unified" || authMode() !== "required") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const url = new URL(request.url);
  const origin = publicOrigin(request, url.origin);
  // 303: the browser follows a POST's redirect with a GET.
  const go = (path: string) => NextResponse.redirect(`${origin}${path}`, { status: 303 });

  // A form posted from another site would sign the visitor into someone
  // else's account (login CSRF). Browsers send Origin on every POST.
  const from = request.headers.get("origin");
  if (from && from !== origin && from !== url.origin) {
    return NextResponse.json({ error: "Cross-site sign-in refused" }, { status: 403 });
  }

  let email = "";
  let password = "";
  let next = "/";
  try {
    const form = await request.formData();
    email = String(form.get("email") ?? "").trim().toLowerCase();
    password = String(form.get("password") ?? "");
    next = safeNext(String(form.get("next") ?? ""));
  } catch {
    return go("/login?partner=1&error=credentials");
  }
  const back = (error: string) =>
    go(`/login?partner=1&error=${error}${next !== "/" ? `&next=${encodeURIComponent(next)}` : ""}`);

  if (!email || !password) return back("credentials");
  if (isAllowedEmail(email)) return back("use_google");

  const supabase = await createServerSupabase();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  // One message for every failure: the form never tells which addresses exist.
  if (error) return back("credentials");

  const decision = decide(await readClaims(supabase), appKey() ?? "");
  if (decision.kind === "mfa") return go(`${MFA_PATH}?next=${encodeURIComponent(next)}`);
  if (decision.kind === "allow") return go(next);
  await signOutHere(supabase);
  return go(`/login?error=${decision.kind === "deny" ? decision.reason : "credentials"}`);
}

/** POST handler for `app/auth/signout/route.ts`. */
export async function handleSignOut(request: Request) {
  if (authMode() === "required") {
    const supabase = await createServerSupabase();
    await supabase.auth.signOut();
  }
  return NextResponse.redirect(new URL("/login", request.url), { status: 303 });
}
