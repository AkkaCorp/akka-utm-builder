import type { NextResponse } from "next/server";
import { SHARED_SITE, cookieDomain } from "./config";

/**
 * 0.5: one session for every tool on akkatools.com. The Supabase session
 * cookies go on `.akkatools.com` instead of the app's own host, and the
 * cookies 0.4 left on each host are moved over. Server side only (middleware
 * and route handlers); the browser clients only need {@link browserCookieOptions}.
 *
 * Migration rule, on an akkatools.com host (never elsewhere):
 *
 * 1. Every auth cookie written on `.akkatools.com` comes with an expiry of its
 *    host-only namesake (Set-Cookie without Domain, Max-Age=0). The browser
 *    then never sends two cookies with the same name, one of them stale (a
 *    stale refresh token sent after rotation can get the session revoked).
 * 2. The first request of a browser on a host (no {@link MIGRATED_COOKIE}
 *    there yet) that carries auth cookies, or any request that carries the
 *    same auth cookie twice: each auth cookie is written again on
 *    `.akkatools.com` with the value the server reads, its host-only
 *    namesake is expired, and the host is marked as done.
 *    - Only the host cookie exists (a 0.4 session): it is copied to the
 *      domain, then expired on the host. The session stays valid and now
 *      covers every tool.
 *    - Both exist (same name twice): the server reads the last one sent,
 *      which browsers order by creation time, so the newest: the shared one
 *      in practice. That one is kept on the domain, the host one expired.
 *    - Only the domain cookie exists: written again unchanged, nothing lost.
 *    A name Supabase itself writes in the same response is not copied: the
 *    renewed value wins.
 * 3. The apex `akkatools.com` (the hub) is left alone: there a host-only
 *    cookie and a `.akkatools.com` one are too close for some browsers to
 *    tell apart, and an expiry could hit the shared session.
 */

type CookieOptions = Record<string, unknown> & { domain?: string; maxAge?: number };
export type CookieToSet = { name: string; value: string; options?: CookieOptions };

/** Host-only, set once the host's 0.4 cookies are moved to the domain. */
export const MIGRATED_COOKIE = "akka-auth-migrated";

/**
 * Set on `.akkatools.com` for a minute when the central sign-in page sends a
 * signed-in visitor back to a tool. A tool that still sees no session then
 * shows its own `/login` instead of bouncing to the central page again: a
 * redirect loop is impossible even when a tool cannot read the shared
 * session (another Supabase project, a misconfiguration).
 */
export const BOUNCE_COOKIE = "akka-auth-bounce";

/** @supabase/ssr's default lifetime (400 days, the browsers' cap). */
const MAX_AGE = 400 * 24 * 60 * 60;

/** `sb-<project ref>-auth-token`, the name supabase-js gives the session (and the prefix of its chunks and PKCE verifier). */
export function authStorageKey(supabaseUrl: string): string | null {
  try {
    return `sb-${new URL(supabaseUrl).hostname.split(".")[0]}-auth-token`;
  } catch {
    return null;
  }
}

/** The session (`key`, its chunks `key.0`, `key.1`…) and the PKCE verifiers (`key-…code-verifier`). */
export function isAuthCookie(name: string, key: string) {
  if (name === key || name.startsWith(`${key}-`)) return true;
  return name.startsWith(`${key}.`) && /^\d+$/.test(name.slice(key.length + 1));
}

/** Every `name=value` of a Cookie header, in order, duplicates kept (Next's parser keeps the last). */
export function readCookieHeader(header: string | null | undefined): Array<{ name: string; value: string }> {
  if (!header) return [];
  const out: Array<{ name: string; value: string }> = [];
  for (const pair of header.split(/; */)) {
    if (!pair) continue;
    const at = pair.indexOf("=");
    const name = (at === -1 ? pair : pair.slice(0, at)).trim();
    let value = at === -1 ? "true" : pair.slice(at + 1);
    try {
      value = decodeURIComponent(value);
    } catch {
      // Kept as sent, like Next's own parser would skip it.
    }
    if (name) out.push({ name, value });
  }
  return out;
}

/** Set-Cookie that removes the host-only cookie `name` and leaves a `.akkatools.com` namesake alone. */
export function hostOnlyExpiry(name: string) {
  return `${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax`;
}

/** cookieOptions for createBrowserClient: the shared domain on akkatools.com, nothing elsewhere. */
export function browserCookieOptions(hostname: string): { domain: string } | undefined {
  const domain = cookieDomain(hostname);
  return domain ? { domain } : undefined;
}

export type SessionCookies = {
  /** The shared domain, or undefined (cookie limited to the host). */
  domain: string | undefined;
  /** `cookieOptions` for createServerClient. */
  cookieOptions: { domain: string } | undefined;
  /**
   * Filters what @supabase/ssr asks to write: on akkatools.com every auth
   * cookie is forced onto the domain, and host-only clears are dropped from
   * the list (a cookie store keyed by name would let them overwrite the
   * domain write): {@link SessionCookies.finish} emits them instead.
   */
  write<T extends CookieToSet>(entries: T[]): T[];
  /** Applies the migration to the response that is returned. Call it last: it appends raw Set-Cookie headers. */
  finish<T extends NextResponse>(res: T): T;
};

export function sessionCookies({
  host,
  cookieHeader,
  supabaseUrl,
  shared = true,
}: {
  host: string | null | undefined;
  cookieHeader: string | null | undefined;
  supabaseUrl: string;
  /** false: cookies limited to the host, no migration (the zcmph gate keeps its own rules). */
  shared?: boolean;
}): SessionCookies {
  const domain = shared ? cookieDomain(host) : undefined;
  const key = authStorageKey(supabaseUrl);
  if (!domain || !key) {
    return { domain: undefined, cookieOptions: undefined, write: (e) => e, finish: (res) => res };
  }
  const apex = (host ?? "").split(":")[0].toLowerCase() === SHARED_SITE;

  const sent = readCookieHeader(cookieHeader);
  const auth = sent.filter((c) => isAuthCookie(c.name, key));
  // Last occurrence wins, as in Next's own parser: the value the server reads.
  const current = new Map(auth.map((c) => [c.name, c.value]));
  const twice = current.size < auth.length;
  const marked = sent.some((c) => c.name === MIGRATED_COOKIE);
  const migrate = !apex && current.size > 0 && (!marked || twice);
  const written = new Set<string>();

  return {
    domain,
    cookieOptions: { domain },
    write<T extends CookieToSet>(entries: T[]): T[] {
      const out: T[] = [];
      for (const e of entries) {
        if (!isAuthCookie(e.name, key)) {
          out.push(e);
          continue;
        }
        written.add(e.name);
        // @supabase/ssr's own host-only clear (no Domain, Max-Age=0): finish() emits it.
        if (!e.options?.domain && e.options?.maxAge === 0) continue;
        out.push({ ...e, options: { ...e.options, domain } });
      }
      return out;
    },
    finish(res) {
      if (migrate) {
        for (const [name, value] of current) {
          if (written.has(name)) continue;
          res.cookies.set(name, value, { path: "/", sameSite: "lax", httpOnly: false, maxAge: MAX_AGE, domain });
        }
        res.cookies.set(MIGRATED_COOKIE, "1", { path: "/", sameSite: "lax", httpOnly: true, secure: true, maxAge: MAX_AGE });
      }
      if (apex) return res;
      // Raw headers, appended after every cookies.set (which rewrites the
      // Set-Cookie list from a map keyed by name).
      const expire = new Set([...written, ...(migrate ? current.keys() : [])]);
      for (const name of expire) res.headers.append("set-cookie", hostOnlyExpiry(name));
      return res;
    },
  };
}

/** The central page sends a signed-in visitor back: see {@link BOUNCE_COOKIE}. */
export function markBounce(res: NextResponse) {
  res.cookies.set(BOUNCE_COOKIE, "1", {
    domain: `.${SHARED_SITE}`,
    path: "/",
    maxAge: 60,
    sameSite: "lax",
    httpOnly: true,
    secure: true,
  });
  return res;
}

export function clearBounce(res: NextResponse) {
  res.cookies.set(BOUNCE_COOKIE, "", { domain: `.${SHARED_SITE}`, path: "/", maxAge: 0 });
  return res;
}
