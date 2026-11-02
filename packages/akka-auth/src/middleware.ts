import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import {
  PUBLIC_PATHS,
  authMode,
  authStack,
  centralLoginFor,
  centralLoginHref,
  isAllowedEmail,
  leadsElsewhere,
  legacyAdapter,
  safeNextUrl,
  supabaseConfig,
} from "./config";
import { BOUNCE_COOKIE, clearBounce, markBounce, sessionCookies } from "./shared-session";
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
 * adapter — `akka-auth-domain` (the 0.1.0 rules below) or `akkatools-zcmph`
 * (zcmph.ts, unchanged).
 *
 * 0.5, every stack but zcmph: the session cookie lives on `.akkatools.com`
 * on an akkatools.com host (shared-session.ts), and a page without a session
 * there goes to the central sign-in page (`AUTH_LOGIN_URL`).
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

  // getUser revalidates the token with Supabase; getSession would trust a
  // cookie the browser could have forged.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname, search, searchParams } = request.nextUrl;
  const bounced = request.cookies.has(BOUNCE_COOKIE);
  // No session, a page: the central sign-in page when there is one for this
  // host, unless it just sent the visitor back (BOUNCE_COOKIE).
  const central = bounced ? null : centralLoginFor(host);

  const route = async (): Promise<NextResponse> => {
    if (!user) {
      if (isPublic(pathname, allPublic)) {
        if (central && pathname === "/login" && !searchParams.has("error")) {
          const next = new URL(safeNextUrl(searchParams.get("next")), request.nextUrl.origin).href;
          return NextResponse.redirect(centralLoginHref(central, next));
        }
        return response;
      }
      // An unauthenticated API call gets a 401, not an HTML redirect.
      if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
      if (central) return NextResponse.redirect(centralLoginHref(central, request.nextUrl.href));
      // The query string matters: an OAuth consent URL carries its parameters.
      return redirectToLogin(request, pathname + search);
    }

    // Domain is re-checked here, not only at sign-in: a session minted through
    // any other route still has to pass it on every request.
    if (!isAllowedEmail(user.email)) {
      if (jar.domain) {
        // 0.5, shared session on akkatools.com: the account may be a partner
        // whom unified tools admit. A 403 for this tool only, no sign-out.
        if (pathname.startsWith("/api/")) {
          return NextResponse.json({ error: "No access to this tool" }, { status: 403 });
        }
        // Public paths answer (the 403 screen itself, the sign-out route).
        if (isPublic(pathname, allPublic) && (pathname !== "/login" || searchParams.has("error"))) return response;
        const url = request.nextUrl.clone();
        url.pathname = "/login";
        url.search = "?error=domain";
        return NextResponse.redirect(url);
      }
      // Elsewhere (preview, localhost, akka.app): the 0.1.0 rule, signed out.
      await supabase.auth.signOut();
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      url.search = "?error=domain";
      return NextResponse.redirect(url);
    }

    if (pathname === "/login" && !searchParams.has("error")) {
      // Already signed in: go where the login was meant to lead.
      const next = safeNextUrl(searchParams.get("next"));
      const go = NextResponse.redirect(new URL(next, request.url));
      return leadsElsewhere(next, host) ? markBounce(go) : go;
    }

    return response;
  };

  const out = await route();
  // Early answers carry the cookies a refresh or a sign-out just set, then
  // the shared-session migration (last: it appends raw headers).
  if (out !== response) for (const c of response.cookies.getAll()) out.cookies.set(c);
  if (bounced && user) clearBounce(out);
  return jar.finish(out);
}

function redirectToLogin(request: NextRequest, from: string) {
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = from && from !== "/" ? `?next=${encodeURIComponent(from)}` : "";
  return NextResponse.redirect(url);
}
