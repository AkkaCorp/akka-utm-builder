import { isAllowedEmail } from "./config";

/**
 * The `akka` claim the InternalTools access token hook adds (CONTRAT.md,
 * « Hook de jeton »). The hook never refuses: an unknown user or a hook error
 * leaves the claim out, and the absence is what refuses here.
 */
export type AkkaClaim = {
  v: number;
  kind: "internal" | "external";
  status: "active" | "suspended" | "deleted";
  groups: string[];
  apps: Record<string, string[]>;
};

/** The JWT fields the rules read. Everything else in the token is ignored. */
export type SessionClaims = {
  email?: string;
  aal?: string;
  amr?: Array<{ method?: string } | string>;
  app_metadata?: { provider?: string; [key: string]: unknown };
  akka?: unknown;
  [key: string]: unknown;
};

export type AuthUser = {
  email: string | null;
  kind: "internal" | "external";
  groups: string[];
  /** `akka.apps[AKKA_APP_KEY]`: `user`, `admin`. */
  roles: string[];
};

export type DenyReason =
  | "not_configured" // no `akka` claim, unknown `v` or `kind` (rule 2)
  | "suspended" // status is not `active` (rule 3)
  | "provider" // wrong sign-in method for this kind of account (rules 4 and 5)
  | "no_app"; // no role on this app (rule 6)

export type Decision =
  | { kind: "allow"; user: AuthUser }
  | { kind: "login" }
  | { kind: "mfa" }
  | { kind: "deny"; reason: DenyReason; status: 403 };

/** The only claim shape this version reads. A newer one fails closed until the lib learns it. */
export const CLAIM_VERSION = 1;

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v !== "") : [];
}

/** Reads the claim defensively: anything malformed counts as no claim. */
export function readAkkaClaim(claims: SessionClaims): AkkaClaim | null {
  const raw = claims.akka;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  if (c.v !== CLAIM_VERSION) return null;
  if (c.kind !== "internal" && c.kind !== "external") return null;
  const apps: Record<string, string[]> = {};
  if (c.apps && typeof c.apps === "object" && !Array.isArray(c.apps)) {
    for (const [key, roles] of Object.entries(c.apps as Record<string, unknown>)) apps[key] = strings(roles);
  }
  return {
    v: CLAIM_VERSION,
    kind: c.kind,
    status: c.status as AkkaClaim["status"],
    groups: strings(c.groups),
    apps,
  };
}

/** The methods this session was authenticated with (`amr` comes in two shapes). */
function methods(claims: SessionClaims): string[] {
  if (!Array.isArray(claims.amr)) return [];
  return claims.amr.map((m) => (typeof m === "string" ? m : m?.method ?? "")).filter(Boolean);
}

/**
 * The unified rules, in the contract's order. Pure: the middleware, the server
 * helpers and the routes all ask this one function, so a page and its API can
 * never disagree on who gets in.
 *
 * `claims` is what `getClaims()` verified (null: no valid session).
 */
export function decide(claims: SessionClaims | null, appKey: string): Decision {
  // 1. No verified session.
  if (!claims || !claims.email) return { kind: "login" };

  // 2. Fail closed: the hook did not vouch for this account.
  const akka = readAkkaClaim(claims);
  if (!akka) return { kind: "deny", reason: "not_configured", status: 403 };

  // 3. Suspended or deleted in Google: out, whatever the token still says.
  if (akka.status !== "active") return { kind: "deny", reason: "suspended", status: 403 };

  const provider = claims.app_metadata?.provider;
  const internalEmail = isAllowedEmail(claims.email);

  // 4. An @akka.app account signs in with Google, never with a password, even
  // one an admin set: `provider` is the account's first provider, so the
  // session's own methods (`amr`) are checked as well.
  if (internalEmail && (provider !== "google" || methods(claims).includes("password"))) {
    return { kind: "deny", reason: "provider", status: 403 };
  }
  // An `internal` claim on a non-Akka address is a matrix error, not a pass.
  if (akka.kind === "internal" && !internalEmail) {
    return { kind: "deny", reason: "provider", status: 403 };
  }

  // 5. Partners: password account, second factor before anything else.
  if (akka.kind === "external") {
    if (provider !== "email") return { kind: "deny", reason: "provider", status: 403 };
    if (claims.aal !== "aal2") return { kind: "mfa" };
  }

  // 6. Signed in, but no role on this tool.
  const roles = akka.apps[appKey] ?? [];
  if (roles.length === 0) return { kind: "deny", reason: "no_app", status: 403 };

  return {
    kind: "allow",
    user: { email: claims.email.toLowerCase(), kind: akka.kind, groups: akka.groups, roles },
  };
}

/** What the login page says for each refusal. */
export const DENY_MESSAGES: Record<DenyReason, string> = {
  not_configured: "Access is not configured for this account yet. Ask the tech team.",
  suspended: "This account is suspended.",
  provider: "This account cannot sign in this way. Akka accounts sign in with Google; partners with their email and password.",
  no_app: "Your account does not have access to this tool.",
};
