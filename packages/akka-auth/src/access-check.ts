import { appKey, authMode, authStack, isAllowedEmail, legacyAdapter } from "./config";
import { getAccess } from "./zcmph";

/**
 * Re-checks, outside a browser session, whether an email still has access to
 * this app. For the app's own long-lived credentials (MCP OAuth refresh
 * tokens, named bearer tokens): removing someone from a Google group only
 * reaches new sign-ins and token renewals, never a token the app issued itself.
 *
 * Server only. The lib does not talk to Postgres: the app passes a function
 * that runs `APP_ROLES_SQL` with its own database role (granted
 * `akka_access_check` by the platform), e.g. with `postgres`:
 *
 *   const checkAccess = createAppAccessCheck(async (email, key) => {
 *     const [row] = await db()<{ roles: string[] }[]>`select access.app_roles(${email}, ${key}) as roles`;
 *     return row.roles;
 *   });
 */
export type AppAccessQuery = (email: string, appKey: string) => Promise<string[]>;

export type AppAccess = { ok: boolean; roles: string[] };

/** `access.app_roles(email, app_key)` returns this app's roles for the email, `{}` when none. */
export const APP_ROLES_SQL = "select access.app_roles($1, $2) as roles";

const DEFAULT_TTL_MS = 60_000;
/** Entries kept per check; the least recently used goes first. */
const MAX_ENTRIES = 500;

const denied = (): AppAccess => ({ ok: false, roles: [] });

/** `admin` implies `user` (CONTRAT.md); any other role name grants nothing. */
const grantsAccess = (roles: string[]) => roles.includes("user") || roles.includes("admin");

/**
 * Returns `check(email)`, under the active stack:
 *
 * - `next dev` without config (`authMode() === "open"`): `ok`, every role.
 * - Misconfigured production build: refused.
 * - `unified`: `query(email, AKKA_APP_KEY)`; `ok` when the roles hold `user`
 *   or `admin`. Answers, granted or refused, are cached `ttlMs` (default 60 s)
 *   per email, so a removal takes effect within `ttlMs`. A failed query is
 *   refused and not cached (fail closed). No `AKKA_APP_KEY`: refused.
 * - `legacy` + `akka-auth-domain`: the domain rule, no query. `["user"]`.
 * - `legacy` + `akkatools-zcmph`: the hub's `akkatools_access` RPC, as the
 *   gate does (`AKKA_APP_KEY` in the member's tools; `admin` for a hub admin).
 *   That RPC hides its errors, so only grants are cached.
 */
export function createAppAccessCheck(
  query: AppAccessQuery,
  opts: { ttlMs?: number } = {},
): (email: string) => Promise<AppAccess> {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const cache = new Map<string, { access: AppAccess; until: number }>();

  const cached = (key: string): AppAccess | null => {
    const hit = cache.get(key);
    if (!hit) return null;
    cache.delete(key);
    if (hit.until <= Date.now()) return null;
    cache.set(key, hit); // most recently used last
    return { ok: hit.access.ok, roles: [...hit.access.roles] };
  };
  const remember = (key: string, access: AppAccess) => {
    cache.delete(key);
    cache.set(key, { access, until: Date.now() + ttlMs });
    while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  };

  return async function checkAppAccess(rawEmail: string): Promise<AppAccess> {
    const mode = authMode();
    if (mode === "open") return { ok: true, roles: ["user", "admin"] };
    if (mode === "misconfigured") return denied();

    const email = rawEmail?.trim().toLowerCase();
    if (!email) return denied();

    if (authStack() === "unified") {
      const key = appKey();
      if (!key) return denied();
      const cacheKey = `unified\n${key}\n${email}`;
      const hit = cached(cacheKey);
      if (hit) return hit;
      let roles: unknown;
      try {
        roles = await query(email, key);
        if (!Array.isArray(roles) || roles.some((r) => typeof r !== "string")) {
          throw new Error("access.app_roles did not return text[]");
        }
      } catch (e) {
        console.warn(`[akka-auth] app access check failed for ${email} on ${key}:`, e);
        return denied();
      }
      const access: AppAccess = grantsAccess(roles as string[])
        ? { ok: true, roles: [...(roles as string[])] }
        : denied();
      remember(cacheKey, access);
      return { ok: access.ok, roles: [...access.roles] };
    }

    if (legacyAdapter() === "akkatools-zcmph") {
      const tool = appKey();
      if (!tool) return denied();
      const cacheKey = `zcmph\n${tool}\n${email}`;
      const hit = cached(cacheKey);
      if (hit) return hit;
      const hub = await getAccess(email);
      if (!hub || !hub.tools.includes(tool)) return denied();
      const access: AppAccess = { ok: true, roles: hub.is_admin ? ["user", "admin"] : ["user"] };
      remember(cacheKey, access);
      return { ok: true, roles: [...access.roles] };
    }

    // Legacy, akka-auth-domain: the 0.1.0 rule, the domain only.
    return isAllowedEmail(email) ? { ok: true, roles: ["user"] } : denied();
  };
}
