/**
 * Only Google Workspace accounts on this domain may sign in. The `hd` parameter
 * we hand Google is a hint the user could strip, so the domain is re-checked
 * server side on every request — that check, not `hd`, is the control.
 */
export const ALLOWED_DOMAIN = (process.env.AUTH_ALLOWED_DOMAIN || "akka.app").toLowerCase();

/** Paths the middleware lets through without a session. */
export const PUBLIC_PATHS = ["/login", "/auth/callback", "/auth/signout"];

export function supabaseConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return url && key ? { url, key } : null;
}

export type AuthMode = "required" | "open" | "misconfigured";

/**
 * Configured -> auth is enforced. Not configured -> open in development only,
 * so the app still boots in a sandbox; a production build with no Supabase
 * config fails closed and serves nothing rather than serving internal data
 * to anyone who finds the URL.
 */
export function authMode(): AuthMode {
  if (supabaseConfig()) return "required";
  return process.env.NODE_ENV === "production" ? "misconfigured" : "open";
}

export function isAllowedEmail(email: string | undefined | null) {
  if (!email) return false;
  const at = email.lastIndexOf("@");
  return at !== -1 && email.slice(at + 1).toLowerCase() === ALLOWED_DOMAIN;
}

/** Only same-site paths, so a crafted link cannot bounce a fresh session off site. */
export function safeNext(next: string | null | undefined) {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}
