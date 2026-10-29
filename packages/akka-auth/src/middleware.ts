import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { PUBLIC_PATHS, authMode, authStack, isAllowedEmail, legacyAdapter, safeNext, supabaseConfig } from "./config";
import { unifiedMiddleware } from "./unified";
import { zcmphMiddleware } from "./zcmph";

function isPublic(pathname: string, publicPaths: string[]) {
  return publicPaths.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

/**
 * The app's `middleware.ts` calls this on every request. Next.js reads the
 * `config.matcher` export statically, so each app keeps its own literal
 * matcher — see the README for the one to copy.
 *
 * AUTH_STACK picks the rules: `unified` (unified.ts), or `legacy` with its
 * adapter — `akka-auth-domain` (the 0.1.0 code below, unchanged) or
 * `akkatools-zcmph` (zcmph.ts).
 */
export async function authMiddleware(
  request: NextRequest,
  { publicPaths = [] }: { publicPaths?: string[] } = {},
) {
  const mode = authMode();
  const allPublic = [...PUBLIC_PATHS, ...publicPaths];

  if (mode === "open") return NextResponse.next({ request });

  if (authStack() === "legacy" && legacyAdapter() === "akkatools-zcmph") {
    // The central hub owns the login: only the app's own public paths
    // (signed webhooks, crons) skip the gate.
    if (publicPaths.length && isPublic(request.nextUrl.pathname, publicPaths)) {
      return NextResponse.next({ request });
    }
    return zcmphMiddleware(request);
  }

  // Public paths never depend on the session: the login page explains the
  // missing config, webhooks carry their own signature.
  if (mode === "misconfigured" && isPublic(request.nextUrl.pathname, allPublic)) {
    return NextResponse.next({ request });
  }

  if (mode === "misconfigured") {
    // Fail closed: a production deploy without Supabase config serves nothing.
    return NextResponse.json(
      {
        error:
          "Authentication is not configured. Set NEXT_PUBLIC_SUPABASE_URL and the publishable key.",
      },
      { status: 503 },
    );
  }

  if (authStack() === "unified") return unifiedMiddleware(request, publicPaths);

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

  // getUser revalidates the token with Supabase; getSession would trust a
  // cookie the browser could have forged.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname, search } = request.nextUrl;

  if (!user) {
    if (isPublic(pathname, allPublic)) return response;
    // The query string matters: an OAuth consent URL carries its parameters.
    return redirectToLogin(request, pathname + search);
  }

  // Domain is re-checked here, not only at sign-in: a session minted through
  // any other route still has to pass it on every request.
  if (!isAllowedEmail(user.email)) {
    await supabase.auth.signOut();
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "?error=domain";
    return NextResponse.redirect(url);
  }

  if (pathname === "/login") {
    // Already signed in: go where the login was meant to lead.
    const target = new URL(safeNext(request.nextUrl.searchParams.get("next")), request.url);
    return NextResponse.redirect(target);
  }

  return response;
}

function redirectToLogin(request: NextRequest, from: string) {
  // An unauthenticated API call gets a 401, not an HTML redirect.
  if (from.startsWith("/api/")) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = from && from !== "/" ? `?next=${encodeURIComponent(from)}` : "";
  return NextResponse.redirect(url);
}
