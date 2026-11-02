import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import {
  MFA_PATH,
  UNIFIED_PUBLIC_PATHS,
  appKey,
  centralLoginFor,
  centralLoginHref,
  leadsElsewhere,
  safeNextUrl,
  supabaseConfig,
} from "./config";
import { decide, endsSession, type Decision, type DenyReason, type SessionClaims } from "./decision";
import { BOUNCE_COOKIE, clearBounce, markBounce, sessionCookies } from "./shared-session";

type AuthClient = {
  auth: {
    getClaims(): Promise<{ data: { claims: unknown } | null; error: unknown }>;
    signOut(options?: { scope?: "global" | "local" | "others" }): Promise<unknown>;
  };
};

/**
 * The verified token claims, or null. getClaims() checks the JWT signature
 * locally against the project's published keys (asymmetric signing keys), and
 * refreshes an expiring session first; it never trusts the cookie as is.
 */
export async function readClaims(supabase: AuthClient): Promise<SessionClaims | null> {
  try {
    const { data, error } = await supabase.auth.getClaims();
    if (error || !data?.claims) return null;
    return data.claims as SessionClaims;
  } catch {
    return null;
  }
}

/**
 * Ends the session for an identity refusal (0.5: `suspended`, `provider`).
 * `local` revokes this session and clears its cookies: on akkatools.com the
 * cookie is shared, so that is every tool in this browser, which is the point
 * (the account must not get in anywhere). The user's other devices are not
 * touched; they meet the same refusal on their next request. An
 * authorization refusal (`no_app`, `not_configured`) never calls this.
 */
export async function endSession(supabase: AuthClient) {
  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    // The cookies are cleared anyway; a refusal must not turn into a 500.
  }
}

/**
 * Where a decision sends someone headed for `next` (already through
 * safeNextUrl), from a page of `host`: `next` itself when the session passes,
 * or when `next` is another tool and the refusal is about this app only (the
 * central sign-in page does not decide for the tool the user came from; that
 * tool checks its own access when the user lands on it). Null: stay and
 * apply the decision here.
 */
export function onwardTarget(decision: Decision, next: string, host: string | null | undefined): string | null {
  if (decision.kind === "allow") return next;
  if (decision.kind === "deny" && !endsSession(decision.reason) && leadsElsewhere(next, host)) return next;
  return null;
}

function isPublic(pathname: string, publicPaths: string[]) {
  return publicPaths.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

export const API_ERRORS: Record<DenyReason, string> = {
  not_configured: "Access is not configured for this account",
  suspended: "Account suspended",
  provider: "Sign-in method not allowed for this account",
  no_app: "No access to this tool",
};

/**
 * Unified rules 1 to 6 (CONTRAT.md), on every request the matcher sends here.
 *
 * 0.5: the session cookie lives on `.akkatools.com` (shared-session.ts); a
 * page without a session on akkatools.com goes to the central sign-in page;
 * an authorization refusal answers 403 and keeps the session.
 */
export async function unifiedMiddleware(request: NextRequest, publicPaths: string[]) {
  const allPublic = [...UNIFIED_PUBLIC_PATHS, ...publicPaths];
  const { pathname, search } = request.nextUrl;
  const key = appKey();

  if (!key) {
    // Without its key the app cannot read its roles: fail closed, like a
    // missing Supabase config. Public paths still answer.
    if (isPublic(pathname, allPublic)) return NextResponse.next({ request });
    return NextResponse.json({ error: "AKKA_APP_KEY is not set" }, { status: 503 });
  }

  const config = supabaseConfig()!;
  const host = request.nextUrl.host;
  const jar = sessionCookies({ host, cookieHeader: request.headers.get("cookie"), supabaseUrl: config.url });
  let response = NextResponse.next({ request });

  const supabase = createServerClient(config.url, config.key, {
    cookieOptions: jar.cookieOptions,
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        const toSet = jar.write(cookiesToSet);
        for (const { name, value } of toSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of toSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const decision = decide(await readClaims(supabase), key);
  const bounced = request.cookies.has(BOUNCE_COOKIE);
  const out = await route();
  // Every early answer carries the cookies a refresh or a sign-out just set,
  // then the shared-session migration (last: it appends raw headers).
  if (out !== response) for (const c of response.cookies.getAll()) out.cookies.set(c);
  if (bounced && decision.kind === "allow") clearBounce(out);
  return jar.finish(out);

  async function route(): Promise<NextResponse> {
    const isApi = pathname.startsWith("/api/");
    const redirect = (path: string, query: Record<string, string> = {}) => {
      const url = request.nextUrl.clone();
      url.pathname = path;
      url.search = new URLSearchParams(query).toString();
      return NextResponse.redirect(url);
    };
    const nextParam = (): Record<string, string> => {
      // The query string matters: an OAuth consent URL carries its parameters.
      const from = pathname + search;
      return from && from !== "/" ? { next: from } : {};
    };
    const refuse = async (reason: DenyReason, status: number) => {
      if (endsSession(reason)) await endSession(supabase);
      if (isApi) return NextResponse.json({ error: API_ERRORS[reason] }, { status });
      // The refusal screen is this app's own /login, even on akkatools.com.
      return redirect("/login", { error: reason });
    };
    // No session, a page: the central sign-in page when there is one for
    // this host, unless it just sent the visitor back (BOUNCE_COOKIE).
    const signIn = (next: string) => {
      const central = centralLoginFor(host);
      if (central && !bounced) return NextResponse.redirect(centralLoginHref(central, next));
      return null;
    };

    // The second-factor screen needs a session, and only a session waiting for one.
    if (pathname === MFA_PATH || pathname.startsWith(MFA_PATH + "/")) {
      const next = safeNextUrl(request.nextUrl.searchParams.get("next"));
      if (decision.kind === "mfa") return response;
      if (decision.kind === "login") return redirect("/login");
      const onward = onwardTarget(decision, next, host);
      if (onward || decision.kind === "allow") return NextResponse.redirect(new URL(onward ?? next, request.url));
      return refuse(decision.reason, decision.status);
    }

    if (isPublic(pathname, allPublic)) {
      // Not when the page has an error to show (a role refusal from server
      // code, a 403), or the redirect would bounce straight back to it.
      if (pathname !== "/login" || request.nextUrl.searchParams.has("error")) return response;
      const next = safeNextUrl(request.nextUrl.searchParams.get("next"));
      // Already signed in: go where the login was meant to lead.
      const onward = onwardTarget(decision, next, host);
      if (onward) {
        const go = NextResponse.redirect(new URL(onward, request.url));
        return leadsElsewhere(onward, host) ? markBounce(go) : go;
      }
      switch (decision.kind) {
        case "mfa":
          return redirect(MFA_PATH, next !== "/" ? { next } : {});
        case "deny":
          // Signed in but refused here: say why instead of a sign-in button.
          if (endsSession(decision.reason)) return refuse(decision.reason, decision.status);
          return redirect("/login", { error: decision.reason, ...(next !== "/" ? { next } : {}) });
        case "login":
          return signIn(new URL(next, request.nextUrl.origin).href) ?? response;
      }
    }

    switch (decision.kind) {
      case "allow":
        return response;
      case "login":
        // An unauthenticated API call gets a 401, not an HTML redirect.
        if (isApi) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
        return signIn(request.nextUrl.href) ?? redirect("/login", nextParam());
      case "mfa":
        if (isApi) return NextResponse.json({ error: "Second factor required" }, { status: 401 });
        return redirect(MFA_PATH, nextParam());
      case "deny":
        return refuse(decision.reason, decision.status);
    }
  }
}
