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

/** The akkatools.com hub's own gate (legacy `akkatools-zcmph`): it keeps its 0.4 cookie and sign-in rules in 0.5. */
export function isZcmph() {
  return authStack() === "legacy" && legacyAdapter() === "akkatools-zcmph";
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

/**
 * A Vercel preview deployment (a branch or PR URL), not the production one.
 * Vercel sets VERCEL_ENV on every deployment ("production", "preview",
 * "development") and the platform never overrides it, so this needs no
 * per-app setting and does not depend on the domain the page is served from.
 * Local `next dev` and any non-Vercel host: false.
 */
export function isPreviewDeployment() {
  return process.env.VERCEL_ENV?.trim().toLowerCase() === "preview";
}

export function isAllowedEmail(email: string | undefined | null) {
  if (!email) return false;
  const at = email.lastIndexOf("@");
  return at !== -1 && email.slice(at + 1).toLowerCase() === ALLOWED_DOMAIN;
}

/** Tab, newline, other control characters, spaces: URL parsers drop or mangle them. */
const UNSAFE_URL_CHARS = /[\u0000-\u0020\u007f-\u009f\u2028\u2029]/;

/**
 * Only same-site paths, so a crafted link cannot bounce a fresh session off site.
 * `/\host` is refused too: browsers read it as `//host`. So is any control
 * character or space (0.5): the URL parser drops a tab or a newline, and
 * `/<tab>/evil.example` would become `//evil.example`.
 */
export function safeNext(next: string | null | undefined) {
  if (!next || UNSAFE_URL_CHARS.test(next)) return "/";
  return next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}

/** The shared cookie domain and the central sign-in page live under this name (0.5). */
export const SHARED_SITE = "akkatools.com";

/** `akkatools.com` or any `*.akkatools.com`, port ignored. */
export function isAkkatoolsHost(host: string | null | undefined) {
  if (!host) return false;
  const h = host.split(":")[0].toLowerCase();
  return h === SHARED_SITE || h.endsWith(`.${SHARED_SITE}`);
}

/**
 * Where the session cookies go (0.5): `.akkatools.com` when the app is served
 * on akkatools.com or a subdomain, so one sign-in covers every internal tool.
 * Anywhere else (Vercel previews, localhost, *.akka.app): undefined, a cookie
 * limited to the host, as before.
 */
export function cookieDomain(host: string | null | undefined): string | undefined {
  return isAkkatoolsHost(host) ? `.${SHARED_SITE}` : undefined;
}

/**
 * Where a sign-in may lead (0.5): a same-site path (see {@link safeNext}), or
 * an absolute `https://` URL on akkatools.com or a subdomain, which is how the
 * central sign-in page sends people back to the tool they came from. No other
 * scheme, no user info, no explicit port, no control character, no backslash.
 * Anything else: `/`. This is the open-redirect guard: every redirect after a
 * sign-in goes through it.
 */
export function safeNextUrl(next: string | null | undefined): string {
  if (!next) return "/";
  if (next.startsWith("/")) return safeNext(next);
  if (UNSAFE_URL_CHARS.test(next) || next.includes("\\")) return "/";
  // The scheme exactly, with both slashes: `https:host` or `HTTPS:/host` are
  // read differently by different parsers.
  if (!next.startsWith("https://")) return "/";
  let url: URL;
  try {
    url = new URL(next);
  } catch {
    return "/";
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return "/";
  if (!isAkkatoolsHost(url.hostname)) return "/";
  return url.href;
}

/** True when `next` (already through {@link safeNextUrl}) leads to another host than `host`. */
export function leadsElsewhere(next: string, host: string | null | undefined) {
  if (!next.startsWith("https://")) return false;
  return new URL(next).host !== (host ?? "").toLowerCase();
}

/** The central sign-in page when AUTH_LOGIN_URL is not set (0.5). */
export const DEFAULT_LOGIN_URL = "https://access.tech.akkatools.com/login";

/**
 * The central sign-in page (0.5): AUTH_LOGIN_URL, or {@link DEFAULT_LOGIN_URL}
 * when the variable is absent. Set but empty: none, every app keeps its own
 * `/login`. A value that is not an `https://` URL on akkatools.com counts as
 * none too, so a typo cannot send people to a foreign sign-in page.
 */
export function centralLoginUrl(): string | null {
  const raw = process.env.AUTH_LOGIN_URL;
  if (raw === undefined) return DEFAULT_LOGIN_URL;
  const value = raw.trim();
  if (!value) return null;
  const safe = safeNextUrl(value);
  return safe.startsWith("https://") ? safe.split(/[?#]/)[0] : null;
}

/**
 * The central sign-in page to send an unauthenticated visitor of `host` to,
 * or null: the app is not on akkatools.com (preview, localhost, akka.app), no
 * central page is configured, or the app is the central page itself.
 */
export function centralLoginFor(host: string | null | undefined): string | null {
  const url = centralLoginUrl();
  if (!url || !isAkkatoolsHost(host)) return null;
  if (new URL(url).host === (host ?? "").toLowerCase()) return null;
  return url;
}

/** `<central login>?next=<absolute URL>`. */
export function centralLoginHref(login: string, next: string) {
  return `${login}?next=${encodeURIComponent(next)}`;
}
