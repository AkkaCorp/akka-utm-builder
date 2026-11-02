import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import {
  MFA_PATH,
  appKey,
  authMode,
  authStack,
  centralLoginFor,
  centralLoginHref,
  cookieDomain,
  isAllowedEmail,
  isZcmph,
  safeNextUrl,
  supabaseConfig,
} from "./config";
import { decide, endsSession, type Decision } from "./decision";
import { readCookieHeader, sessionCookies } from "./shared-session";
import { endSession, onwardTarget, readClaims } from "./unified";

/** Resolves the public origin, which differs from request.url behind Vercel's proxy. */
function publicOrigin(request: Request, fallback: string) {
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (!forwardedHost) return fallback;
  const proto = request.headers.get("x-forwarded-proto") || "https";
  return `${proto}://${forwardedHost}`;
}

type PendingCookie = { name: string; value: string; options: Parameters<NextResponse["cookies"]["set"]>[2] };

/**
 * A Supabase client on this request's cookies. What it writes is held, then
 * put on the response the handler returns, with the shared-session migration
 * (shared-session.ts): `finish(response)` is the last call before returning.
 */
function routeSupabase(request: Request, origin: string) {
  const config = supabaseConfig();
  if (!config) throw new Error("Supabase is not configured");
  const header = request.headers.get("cookie");
  const jar = sessionCookies({
    host: new URL(origin).host,
    cookieHeader: header,
    supabaseUrl: config.url,
    shared: !isZcmph(),
  });
  const current = new Map(readCookieHeader(header).map((c) => [c.name, c.value]));
  const pending: PendingCookie[] = [];
  const supabase = createServerClient(config.url, config.key, {
    cookieOptions: jar.cookieOptions,
    cookies: {
      getAll() {
        return [...current].map(([name, value]) => ({ name, value }));
      },
      setAll(cookiesToSet) {
        for (const c of jar.write(cookiesToSet)) {
          pending.push(c);
          if (c.options?.maxAge === 0) current.delete(c.name);
          else current.set(c.name, c.value);
        }
      },
    },
  });
  const finish = (res: NextResponse) => {
    for (const { name, value, options } of pending) res.cookies.set(name, value, options);
    return jar.finish(res);
  };
  return { supabase, finish };
}

/** `next` (through safeNextUrl) as a URL: a path on this origin, or another tool on akkatools.com. */
function absolute(origin: string, next: string) {
  return next.startsWith("https://") ? next : `${origin}${next}`;
}

/**
 * Where a fresh unified session goes (callback and password sign-in), and
 * whether it must be ended first. Shared by both routes so they cannot drift.
 */
function afterSignIn(decision: Decision, next: string, host: string) {
  const onward = onwardTarget(decision, next, host);
  if (onward) return { to: onward, end: false };
  if (decision.kind === "mfa") return { to: `${MFA_PATH}?next=${encodeURIComponent(next)}`, end: false };
  if (decision.kind === "deny") {
    // 0.5: no access to this tool keeps the session (the 403 screen offers
    // "Use another account"); an identity refusal ends it.
    return { to: `/login?error=${decision.reason}`, end: endsSession(decision.reason) };
  }
  return { to: "/login?error=oauth", end: true };
}

/**
 * GET handler for `app/auth/callback/route.ts`. `next` may be another tool
 * on akkatools.com (0.5): the central sign-in page's callback sends the user
 * back to the tool they came from.
 */
export async function handleAuthCallback(request: Request) {
  const url = new URL(request.url);
  const origin = publicOrigin(request, url.origin);
  const host = new URL(origin).host;
  const code = url.searchParams.get("code");
  const next = safeNextUrl(url.searchParams.get("next"));

  if (url.searchParams.get("error") || !code) {
    return NextResponse.redirect(`${origin}/login?error=oauth`);
  }

  const { supabase, finish } = routeSupabase(request, origin);
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    console.error("[auth] code exchange failed:", error.message);
    return finish(NextResponse.redirect(`${origin}/login?error=oauth`));
  }

  if (authStack() === "unified") {
    // The fresh token already carries the `akka` claim: apply the same rules
    // the middleware will, so a refused account never lands on a page.
    const { to, end } = afterSignIn(decide(await readClaims(supabase), appKey() ?? ""), next, host);
    if (end) await endSession(supabase);
    return finish(NextResponse.redirect(absolute(origin, to)));
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Google's `hd` parameter is only a hint the user can drop, so the domain is
  // decided here — and again in middleware on every later request.
  if (!isAllowedEmail(user?.email) || user?.user_metadata?.email_verified === false) {
    // 0.5: on akkatools.com the session is shared, and a partner admitted by
    // the unified tools must not lose it here: 403 screen, session kept. An
    // unverified address, or any other host (0.1.0 rule): signed out.
    const shared = !isZcmph() && !!cookieDomain(host) && user?.user_metadata?.email_verified !== false;
    if (!shared) await supabase.auth.signOut();
    return finish(NextResponse.redirect(`${origin}/login?error=domain`));
  }

  return finish(NextResponse.redirect(absolute(origin, next)));
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
  const go = (to: string) => NextResponse.redirect(absolute(origin, to), { status: 303 });

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
    next = safeNextUrl(String(form.get("next") ?? ""));
  } catch {
    return go("/login?partner=1&error=credentials");
  }
  const back = (error: string) =>
    go(`/login?partner=1&error=${error}${next !== "/" ? `&next=${encodeURIComponent(next)}` : ""}`);

  if (!email || !password) return back("credentials");
  if (isAllowedEmail(email)) return back("use_google");

  const { supabase, finish } = routeSupabase(request, origin);
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  // One message for every failure: the form never tells which addresses exist.
  if (error) return finish(back("credentials"));

  const decision = decide(await readClaims(supabase), appKey() ?? "");
  if (decision.kind === "login") {
    await endSession(supabase);
    return finish(go("/login?error=credentials"));
  }
  const { to, end } = afterSignIn(decision, next, new URL(origin).host);
  if (end) await endSession(supabase);
  return finish(go(to));
}

/**
 * POST handler for `app/auth/signout/route.ts`. Signs out everywhere (the
 * session is shared by every tool on akkatools.com, and `global` ends the
 * user's other sessions too), then the central sign-in page when the app is
 * on akkatools.com (0.5), this app's `/login` otherwise.
 */
export async function handleSignOut(request: Request) {
  const url = new URL(request.url);
  const origin = publicOrigin(request, url.origin);
  const central = isZcmph() ? null : centralLoginFor(new URL(origin).host);
  const to = central ? centralLoginHref(central, `${origin}/`) : new URL("/login", request.url);
  if (authMode() !== "required") return NextResponse.redirect(to, { status: 303 });
  const { supabase, finish } = routeSupabase(request, origin);
  await supabase.auth.signOut();
  return finish(NextResponse.redirect(to, { status: 303 }));
}
