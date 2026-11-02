import { createServerClient } from "@supabase/ssr";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import {
  MFA_PATH,
  appKey,
  authMode,
  authStack,
  cookieDomain,
  isAllowedEmail,
  isZcmph,
  legacyAdapter,
  supabaseConfig,
} from "./config";
import { decide, endsSession, type AuthUser, type Decision } from "./decision";
import { sessionCookies } from "./shared-session";
import { endSession, readClaims } from "./unified";
import { HUB, getAccess, hubLogin, rememberPass, rememberedPass, sessionKey } from "./zcmph";

export type { AuthUser } from "./decision";

/** The public host of the current request (behind Vercel's proxy: x-forwarded-host). */
async function requestHost() {
  const headerStore = await headers();
  return headerStore.get("x-forwarded-host")?.split(",")[0].trim() || headerStore.get("host");
}

/**
 * The Supabase server client of a Server Component or a route handler, on
 * next/headers' cookies. 0.5: on akkatools.com its cookies go on
 * `.akkatools.com`, like the middleware's.
 */
export async function createServerSupabase() {
  const config = supabaseConfig();
  if (!config) throw new Error("Supabase is not configured");
  const cookieStore = await cookies();
  const headerStore = await headers();
  const host = await requestHost();
  const jar = sessionCookies({
    host,
    cookieHeader: headerStore.get("cookie"),
    supabaseUrl: config.url,
    shared: !isZcmph(),
  });

  return createServerClient(config.url, config.key, {
    cookieOptions: jar.cookieOptions,
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of jar.write(cookiesToSet)) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component: the middleware refreshes the
          // session cookies instead, so this is safe to ignore.
        }
      },
    },
  });
}

/**
 * `next dev` without Supabase config has no user at all. It gets every role,
 * so the admin screens can be built locally; production never reaches this.
 */
const OPEN_USER: AuthUser = { email: null, kind: "internal", groups: [], roles: ["user", "admin"] };

/** Who the request is, under the active stack. One code path for every helper below. */
type Resolution =
  | { kind: "open" }
  | { kind: "misconfigured" }
  | { kind: "allow"; user: AuthUser }
  | { kind: "login" }
  | { kind: "mfa" }
  | { kind: "deny"; reason: string; status: 403 };

async function resolve(): Promise<Resolution> {
  const mode = authMode();
  if (mode === "open") return { kind: "open" };
  if (mode === "misconfigured") return { kind: "misconfigured" };

  if (authStack() === "unified") {
    const key = appKey();
    if (!key) return { kind: "misconfigured" };
    const supabase = await createServerSupabase();
    const decision: Decision = decide(await readClaims(supabase), key);
    // 0.5: an identity refusal ends the session (a Server Component cannot
    // clear the cookies, but the session is revoked); no access to this tool
    // leaves it alone, the user stays signed in to the other tools.
    if (decision.kind === "deny" && endsSession(decision.reason)) await endSession(supabase);
    return decision;
  }

  if (legacyAdapter() === "akkatools-zcmph") return resolveZcmph();

  // Legacy, akka-auth-domain: the 0.1.0 rule, the domain only.
  // Always getUser(), never getSession(): getUser revalidates the token with
  // Supabase, getSession trusts a cookie.
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { kind: "login" };
  if (!isAllowedEmail(user.email)) {
    // 0.5: on akkatools.com the session is shared (a partner of the unified
    // tools): a 403 for this tool, the session kept. Elsewhere: as 0.1.0.
    return cookieDomain(await requestHost()) ? { kind: "deny", reason: "domain", status: 403 } : { kind: "login" };
  }
  return { kind: "allow", user: { email: user.email ?? null, kind: "internal", groups: [], roles: ["user"] } };
}

async function resolveZcmph(): Promise<Resolution> {
  const tool = appKey();
  if (!tool) return { kind: "misconfigured" };
  const cookieStore = await cookies();
  const key = await sessionKey(cookieStore.getAll());
  const known = rememberedPass(key);
  const asUser = (email: string, isAdmin: boolean): AuthUser => ({
    email,
    kind: "internal",
    groups: [],
    roles: isAdmin ? ["user", "admin"] : ["user"],
  });
  if (known) return { kind: "allow", user: asUser(known.email, known.isAdmin) };

  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const email = user?.email?.trim().toLowerCase();
  if (!email) return { kind: "login" };
  const access = await getAccess(email);
  if (!access) return { kind: "login" };
  if (!access.tools.includes(tool)) return { kind: "deny", reason: "no_app", status: 403 };
  rememberPass(key, access.email, access.is_admin);
  return { kind: "allow", user: asUser(access.email, access.is_admin) };
}

/**
 * Where a page goes when the resolution is not a pass. Never returns. A
 * refusal lands on this app's `/login?error=…`, the 403 screen (0.5: with
 * "Use another account" and the session kept for `no_app`); no session goes
 * to `/login`, which the middleware forwards to the central sign-in page on
 * akkatools.com.
 */
function leave(r: Exclude<Resolution, { kind: "allow" } | { kind: "open" }>): never {
  const zcmph = authStack() === "legacy" && legacyAdapter() === "akkatools-zcmph";
  if (zcmph) redirect(r.kind === "deny" ? HUB : hubLogin(HUB));
  if (r.kind === "mfa") redirect(MFA_PATH);
  if (r.kind === "deny") redirect(`/login?error=${r.reason}`);
  redirect("/login");
}

/**
 * Defence in depth behind the middleware: a Server Component that renders
 * internal data re-checks the session itself, so a matcher gap or a
 * middleware change cannot quietly expose a page.
 *
 * Unified: `{ email, kind, groups, roles }`, roles = `akka.apps[AKKA_APP_KEY]`.
 * Legacy: the same shape, with `roles: ["user"]` (zcmph: plus `admin` for a
 * hub admin) and no groups.
 */
export async function requireUser(): Promise<AuthUser> {
  const r = await resolve();
  if (r.kind === "open") return OPEN_USER;
  if (r.kind === "allow") return r.user;
  leave(r);
}

/** `requireUser()`, plus a role on this app. Without it, the login page explains the refusal. */
export async function requireRole(role: string): Promise<AuthUser> {
  const user = await requireUser();
  if (!user.roles.includes(role)) redirect("/login?error=role");
  return user;
}

/**
 * The signed-in user, for route handlers that need to know who acts.
 * `open` is true in a development build without Supabase config, where there
 * is no user at all. A user the rules refuse comes back as no user.
 */
export async function currentUser(): Promise<{ open: boolean } & AuthUser> {
  const r = await resolve();
  if (r.kind === "open") return { open: true, ...OPEN_USER };
  if (r.kind === "allow") return { open: false, ...r.user };
  return { open: false, email: null, kind: "internal", groups: [], roles: [] };
}

/**
 * Route-handler equivalent: returns a 401/403 response to return as-is, or
 * null when the caller may proceed. `{ role }` also requires that role.
 */
export async function rejectUnauthenticated({ role }: { role?: string } = {}): Promise<Response | null> {
  const r = await resolve();
  if (r.kind === "open") return null;
  if (r.kind === "misconfigured") {
    return Response.json({ error: "Authentication is not configured" }, { status: 503 });
  }
  if (r.kind === "login") return Response.json({ error: "Not signed in" }, { status: 401 });
  if (r.kind === "mfa") return Response.json({ error: "Second factor required" }, { status: 401 });
  if (r.kind === "deny") return Response.json({ error: "Access denied" }, { status: r.status });
  if (role && !r.user.roles.includes(role)) {
    return Response.json({ error: `Requires the ${role} role` }, { status: 403 });
  }
  return null;
}

export { APP_ROLES_SQL, createAppAccessCheck, type AppAccess, type AppAccessQuery } from "./access-check";
