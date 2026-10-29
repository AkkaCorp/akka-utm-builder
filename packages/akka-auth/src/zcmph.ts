import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { appKey, supabaseConfig } from "./config";

/**
 * Legacy adapter `akkatools-zcmph`: the akkatools.com SSO gate, ported from
 * akka-qa (lib/akkatoolsGate.ts, lib/auth.ts). Authentication = the shared
 * Supabase session cookie (scoped to .akkatools.com, issued by the central
 * login on akkatools.com). Authorization = the akkatools matrix via the
 * `akkatools_access` RPC of the identity project zcmph, called with its
 * service role. The tool key is AKKA_APP_KEY. Edge-safe (plain fetch, WebCrypto).
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY (identity
 * project), AKKATOOLS_SERVICE_ROLE_KEY (identity service role), AKKA_APP_KEY.
 */
export const HUB = "https://akkatools.com";

export type HubAccess = { email: string; tools: string[]; is_admin: boolean };

export function cookieDomain(host: string | null | undefined): string | undefined {
  if (!host) return undefined;
  const h = host.split(":")[0].toLowerCase();
  return h === "akkatools.com" || h.endsWith(".akkatools.com") ? ".akkatools.com" : undefined;
}

export function hubLogin(next: string) {
  return `${HUB}/login?next=${encodeURIComponent(next)}`;
}

/** The member's row in the akkatools matrix, or null (unknown, error, missing env). */
export async function getAccess(email: string | null | undefined): Promise<HubAccess | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.AKKATOOLS_SERVICE_ROLE_KEY;
  if (!email || !url || !serviceKey) return null;
  try {
    const res = await fetch(`${url}/rest/v1/rpc/akkatools_access`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_email: email.trim().toLowerCase() }),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const d = (await res.json()) as HubAccess | null;
    return d && d.email && Array.isArray(d.tools) ? d : null;
  } catch {
    return null;
  }
}

// The session and the access matrix live in another region than the functions:
// checking them costs two long round trips. A check that passed is remembered
// for a minute, per session cookie, so a click does not pay it again. A member
// who loses access keeps it for a minute at most.
const REMEMBER_MS = 60_000;
const passed = new Map<string, { email: string; isAdmin: boolean; until: number }>();

export function rememberedPass(key: string | null) {
  const hit = key ? passed.get(key) : undefined;
  return hit && hit.until > Date.now() ? hit : null;
}

export function rememberPass(key: string | null, email: string, isAdmin: boolean) {
  if (!key) return;
  if (passed.size > 500) passed.clear();
  passed.set(key, { email, isAdmin, until: Date.now() + REMEMBER_MS });
}

/** Test hook: forget every remembered pass. */
export function forgetPasses() {
  passed.clear();
}

/** sha256 of the `sb-*` cookies: the session's identity for the cache, never stored in clear. */
export async function sessionKey(all: Array<{ name: string; value: string }>): Promise<string | null> {
  const parts = all.filter((c) => c.name.startsWith("sb-")).map((c) => `${c.name}=${c.value}`);
  if (parts.length === 0) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.sort().join(";")));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Gates a request. Redirects to the central login when not signed in, to the
 * hub when the member lacks this tool, otherwise passes through. Fails closed:
 * missing identity env or AKKA_APP_KEY never opens the tool.
 */
export async function zcmphMiddleware(request: NextRequest): Promise<NextResponse> {
  const config = supabaseConfig();
  const tool = appKey();
  const here = request.nextUrl.href;
  if (!config) return NextResponse.redirect(hubLogin(here));
  if (!tool) {
    return NextResponse.json({ error: "AKKA_APP_KEY is not set" }, { status: 503 });
  }

  const key = await sessionKey(request.cookies.getAll());
  if (rememberedPass(key)) return NextResponse.next({ request });

  const domain = cookieDomain(request.nextUrl.hostname);
  let response = NextResponse.next({ request });
  let renewed = false;
  const supabase = createServerClient(config.url, config.key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        renewed = true;
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, domain ? { ...options, domain } : options);
        }
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(hubLogin(here));
  const access = await getAccess(user.email);
  if (!access) return NextResponse.redirect(hubLogin(here));
  if (!access.tools.includes(tool)) return NextResponse.redirect(HUB);

  // Only a plain pass is remembered, never one that renews the session cookie:
  // the renewed cookie must reach the browser on this very response.
  if (!renewed) rememberPass(key, access.email, access.is_admin);
  return response;
}
