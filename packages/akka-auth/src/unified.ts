import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { MFA_PATH, UNIFIED_PUBLIC_PATHS, appKey, safeNext, supabaseConfig } from "./config";
import { decide, type DenyReason, type SessionClaims } from "./decision";

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
 * A refusal signs out this app only (`local`): a global sign-out would end the
 * user's sessions on every other tool for being refused on this one.
 */
export async function signOutHere(supabase: AuthClient) {
  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    // The cookies are cleared anyway; a refusal must not turn into a 500.
  }
}

function isPublic(pathname: string, publicPaths: string[]) {
  return publicPaths.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

const API_ERRORS: Record<DenyReason, string> = {
  not_configured: "Access is not configured for this account",
  suspended: "Account suspended",
  provider: "Sign-in method not allowed for this account",
  no_app: "No access to this tool",
};

/** Unified rules 1 to 6 (CONTRAT.md), on every request the matcher sends here. */
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
  let response = NextResponse.next({ request });

  const supabase = createServerClient(config.url, config.key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const decision = decide(await readClaims(supabase), key);
  const isApi = pathname.startsWith("/api/");

  // Every early answer carries the cookies a refresh or a sign-out just set.
  const carry = (out: NextResponse) => {
    for (const c of response.cookies.getAll()) out.cookies.set(c);
    return out;
  };
  const redirect = (path: string, query: Record<string, string> = {}) => {
    const url = request.nextUrl.clone();
    url.pathname = path;
    url.search = new URLSearchParams(query).toString();
    return carry(NextResponse.redirect(url));
  };
  const nextParam = (): Record<string, string> => {
    // The query string matters: an OAuth consent URL carries its parameters.
    const from = pathname + search;
    return from && from !== "/" ? { next: from } : {};
  };
  const refuse = async (reason: DenyReason, status: number) => {
    await signOutHere(supabase);
    if (isApi) return carry(NextResponse.json({ error: API_ERRORS[reason] }, { status }));
    return redirect("/login", { error: reason });
  };

  // The second-factor screen needs a session, and only a session waiting for one.
  if (pathname === MFA_PATH || pathname.startsWith(MFA_PATH + "/")) {
    const next = safeNext(request.nextUrl.searchParams.get("next"));
    if (decision.kind === "mfa") return response;
    if (decision.kind === "allow") return carry(NextResponse.redirect(new URL(next, request.url)));
    if (decision.kind === "login") return redirect("/login");
    return refuse(decision.reason, decision.status);
  }

  if (isPublic(pathname, allPublic)) {
    // Already signed in: go where the login was meant to lead. Not when the
    // page has an error to show (a role refusal from server code), or the
    // redirect would bounce straight back to it.
    if (pathname === "/login" && decision.kind === "allow" && !request.nextUrl.searchParams.has("error")) {
      return carry(NextResponse.redirect(new URL(safeNext(request.nextUrl.searchParams.get("next")), request.url)));
    }
    return response;
  }

  switch (decision.kind) {
    case "allow":
      return response;
    case "login":
      // An unauthenticated API call gets a 401, not an HTML redirect.
      if (isApi) return carry(NextResponse.json({ error: "Not signed in" }, { status: 401 }));
      return redirect("/login", nextParam());
    case "mfa":
      if (isApi) return carry(NextResponse.json({ error: "Second factor required" }, { status: 401 }));
      return redirect(MFA_PATH, nextParam());
    case "deny":
      return refuse(decision.reason, decision.status);
  }
}
