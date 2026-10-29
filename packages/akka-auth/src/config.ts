/**
 * Only Google Workspace accounts on this domain may sign in. The `hd` parameter
 * we hand Google is a hint the user could strip, so the domain is re-checked
 * server side on every request — that check, not `hd`, is the control.
 */
export const ALLOWED_DOMAIN = (process.env.AUTH_ALLOWED_DOMAIN || "akka.app").toLowerCase();

/** Paths the middleware lets through without a session. */
export const PUBLIC_PATHS = ["/login", "/auth/callback", "/auth/signout"];

/** The partner (email + password) sign-in form posts here. Unified stack only. */
export const PASSWORD_PATH = "/auth/password";

/** Second factor screen (TOTP enrolment or challenge). Unified stack only. */
export const MFA_PATH = "/auth/mfa";

/** Unified adds the partner sign-in route; legacy keeps the 0.1.0 list as is. */
export const UNIFIED_PUBLIC_PATHS = [...PUBLIC_PATHS, PASSWORD_PATH];

export function supabaseConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return url && key ? { url, key } : null;
}

export type AuthStack = "legacy" | "unified";
export type LegacyAdapter = "akka-auth-domain" | "akkatools-zcmph";

/**
 * Which rules the app runs. Read on every call, not at import, so a redeploy
 * with a new value is the whole switch (and the whole rollback).
 * Anything but `unified` is legacy: an app that never heard of 0.2 keeps 0.1.0.
 */
export function authStack(): AuthStack {
  return process.env.AUTH_STACK?.trim().toLowerCase() === "unified" ? "unified" : "legacy";
}

export function legacyAdapter(): LegacyAdapter {
  return process.env.AUTH_LEGACY_ADAPTER?.trim().toLowerCase() === "akkatools-zcmph"
    ? "akkatools-zcmph"
    : "akka-auth-domain";
}

/** The app's key in the access matrix (= its repo name). Required by unified and by the zcmph gate. */
export function appKey(): string | null {
  return process.env.AKKA_APP_KEY?.trim() || null;
}

export type AuthMode = "required" | "open" | "misconfigured";

/**
 * Configured -> auth is enforced. Not configured -> open in development only,
 * so the app still boots in a sandbox; a production build with no Supabase
 * config fails closed and serves nothing rather than serving internal data
 * to anyone who finds the URL.
 *
 * The zcmph gate keeps akka-qa's rule instead: open in `next dev` whatever the
 * config, since its session cookie lives on `.akkatools.com` and never reaches
 * localhost. Vercel sets NODE_ENV=production on previews too, so this only
 * opens `next dev`.
 */
export function authMode(): AuthMode {
  if (authStack() === "legacy" && legacyAdapter() === "akkatools-zcmph") {
    if (process.env.NODE_ENV !== "production") return "open";
  }
  if (supabaseConfig()) return "required";
  return process.env.NODE_ENV === "production" ? "misconfigured" : "open";
}

export function isAllowedEmail(email: string | undefined | null) {
  if (!email) return false;
  const at = email.lastIndexOf("@");
  return at !== -1 && email.slice(at + 1).toLowerCase() === ALLOWED_DOMAIN;
}

/**
 * Only same-site paths, so a crafted link cannot bounce a fresh session off site.
 * `/\host` is refused too: browsers read it as `//host`.
 */
export function safeNext(next: string | null | undefined) {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}
