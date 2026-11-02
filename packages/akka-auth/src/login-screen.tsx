import Image from "next/image";
import type { CSSProperties, ReactNode } from "react";
import {
  ALLOWED_DOMAIN,
  PASSWORD_PATH,
  authMode,
  authStack,
  isPreviewDeployment,
  safeNextUrl,
  supabaseConfig,
} from "./config";
import { DENY_MESSAGES } from "./decision";
import { GoogleSignInButton } from "./google-button";
import type { AuthUi } from "./ui";

export type { AuthUi } from "./ui";

export type LoginSearchParams = {
  error?: string;
  error_code?: string;
  error_description?: string;
  next?: string;
  /** `1`: the partner (email + password) form instead of Google. Unified only. */
  partner?: string;
};

/**
 * Tint keys for the tool icon (0.4). Each is a colour that reads on the dark
 * card; `tint` on {@link ToolIcon} takes any other `#RRGGBB`.
 */
export const TOOL_TINTS = {
  platform: "#BBA8F7",
  data: "#8EC5FF",
  product: "#69EA9B",
  ops: "#F2C46D",
  community: "#F5A3C7",
  neutral: "#A9C0B9",
} as const;

export type ToolCategory = keyof typeof TOOL_TINTS;

/** The initials square next to the tool's name (0.4). Every field is optional. */
export type ToolIcon = {
  /** One to three characters. Default: from the product name ("Access" → "AC", "Bot analytics" → "BA"). */
  initials?: string;
  /** Picks the tint from {@link TOOL_TINTS}. Default: `neutral`. */
  category?: ToolCategory;
  /** `#RRGGBB`, wins over `category`. */
  tint?: string;
};

/** Optional tool identity shown on the sign-in screens (0.4). */
export type ToolIdentity = {
  /** One line under the tool's name, e.g. "Who opens which internal tool". */
  description?: string;
  /** Without it, no icon. */
  icon?: ToolIcon;
};

type Message = { lead: string; detail?: string };

const ERRORS: Record<string, Message> = {
  domain: {
    lead: `Use your @${ALLOWED_DOMAIN} Google account.`,
    detail: `The account you picked is not on @${ALLOWED_DOMAIN}.`,
  },
  oauth: { lead: "Google sign-in did not complete.", detail: "Try again." },
  // Unified stack.
  not_configured: { lead: DENY_MESSAGES.not_configured },
  suspended: { lead: DENY_MESSAGES.suspended, detail: "Ask the tech team if you think this is a mistake." },
  provider: {
    lead: "Sign in the way your account allows.",
    detail: "Akka accounts sign in with Google; partners with their email and password.",
  },
  no_app: { lead: DENY_MESSAGES.no_app, detail: "Ask the tool's owner to add you. You stay signed in to your other tools." },
  role: {
    lead: "Your account does not have the role this page needs.",
    detail: "Ask the tool's owner for it, or go back to the home page.",
  },
  use_google: {
    lead: "Use Google for this address.",
    detail: `@${ALLOWED_DOMAIN} accounts sign in with Google, not with a password.`,
  },
  credentials: { lead: "Wrong email or password.", detail: "Check both and try again." },
};

/**
 * Refusals of a signed-in user on this tool only (0.5): the session is kept,
 * so the screen offers to switch account instead of a sign-in button.
 */
const SIGNED_IN_REFUSALS = new Set(["no_app", "not_configured", "role"]);

const SWITCH_NOTE = "Signing out ends your session on every internal tool.";

function errorMessage(params: LoginSearchParams): Message | null {
  if (!params.error) return null;
  // Supabase bounces its own failures back here (an unconfigured provider, a
  // redirect URL that is not on the allow list). Surface them instead of
  // dropping the user on a login page that looks like nothing happened.
  return (
    ERRORS[params.error] ??
    (params.error_description
      ? { lead: "Sign-in failed.", detail: params.error_description.replace(/\+/g, " ") }
      : { lead: `Sign-in failed (${params.error_code || params.error}).`, detail: "Try again." })
  );
}

/**
 * The whole `/login` page. The app's `app/login/page.tsx` renders it with its
 * product name; the logo is read from `/akka-logo.png` in the app's `public/`.
 * Pass `ui` (see ui.ts) to build it from the app's shadcn components;
 * without it, the module's own CSS is used.
 *
 * Optional (0.4): `description` and `icon` describe the tool on the card.
 *
 * Unified stack: a « Partner? Sign in with email » footer leads to an
 * email + password form (`?partner=1`) for invited partners. Legacy: Google
 * only, as in 0.1.0.
 *
 * 0.5: it is also the 403 screen. For a refusal on this tool only (`no_app`,
 * `not_configured`, `role`) the session is kept, and the card shows the reason
 * with « Use another account » (a sign-out) instead of the sign-in buttons.
 * Legacy `domain` keeps the sign-in buttons (off akkatools.com the session is
 * already ended) and adds « Use another account » (on akkatools.com it is kept).
 * `next` may be another tool's URL on akkatools.com (central sign-in page).
 */
export function LoginScreen({
  productName,
  params,
  ui,
  description,
  icon,
}: {
  productName: string;
  params: LoginSearchParams;
  ui?: AuthUi;
} & ToolIdentity) {
  const mode = authMode();
  const config = supabaseConfig();
  const error = errorMessage(params);
  const next = safeNextUrl(params.next);
  const unified = authStack() === "unified";
  const refused = mode === "required" && !!params.error && SIGNED_IN_REFUSALS.has(params.error);
  const partner = unified && params.partner === "1" && mode === "required" && !refused;
  const switchToo = mode === "required" && params.error === "domain";

  if (ui) {
    return (
      <DesignSystemLogin
        ui={ui}
        productName={productName}
        description={description}
        mode={mode}
        config={config}
        next={next}
        error={error}
        unified={unified}
        partner={partner}
        refused={refused}
        switchToo={switchToo}
      />
    );
  }

  return (
    <AuthPage>
      <AuthCardHeader
        title={partner ? "Partner sign-in" : productName}
        description={partner ? `${productName} · for invited partners` : description}
        icon={icon}
        productName={productName}
      />
      {error && <ErrorBox message={error} />}
      {refused ? (
        <>
          <SwitchAccount />
          <p className="akka-auth-hint">{SWITCH_NOTE}</p>
        </>
      ) : partner ? (
        <PartnerForm next={next} />
      ) : mode === "required" && config ? (
        <>
          <GoogleSignInButton supabaseUrl={config.url} supabaseKey={config.key} domain={ALLOWED_DOMAIN} next={next} />
          <p className="akka-auth-hint">For @{ALLOWED_DOMAIN} accounts</p>
          {unified && (
            <p className="akka-auth-foot">
              Partner?{" "}
              <a className="akka-auth-link" href={partnerHref(next)}>
                Sign in with email
              </a>
            </p>
          )}
          {switchToo && (
            <form action="/auth/signout" method="post" className="akka-auth-foot">
              <button type="submit" className="akka-auth-textbtn">
                Use another account
              </button>
            </form>
          )}
        </>
      ) : (
        <NotConfigured mode={mode} />
      )}
    </AuthPage>
  );
}

/**
 * Page shell shared by the sign-in and MFA screens: the ambient background,
 * the preview badge, the translucent card. Module CSS only.
 */
export function AuthPage({ children }: { children: ReactNode }) {
  return (
    <main className="akka-auth-page">
      {isPreviewDeployment() && <PreviewBadge />}
      <div className="akka-auth-card">{children}</div>
    </main>
  );
}

function PreviewBadge() {
  return <p className="akka-auth-badge">PREVIEW · not production</p>;
}

/** Brand line, then the tool's icon, name and description. */
export function AuthCardHeader({
  title,
  description,
  icon,
  productName,
}: {
  title: string;
  description?: string;
  icon?: ToolIcon;
  /** For the icon's default initials. */
  productName: string;
}) {
  return (
    <>
      <div className="akka-auth-brand">
        <Image src="/akka-logo.png" alt="Akka" width={49} height={16} priority style={{ height: 16, width: "auto" }} />
        <span aria-hidden="true">/</span>
        <span>Internal tools</span>
      </div>
      <div className="akka-auth-title">
        {icon && <ToolIconSquare icon={icon} productName={productName} />}
        <div>
          <h1>{title}</h1>
          {description && <p className="akka-auth-desc">{description}</p>}
        </div>
      </div>
    </>
  );
}

function ToolIconSquare({ icon, productName }: { icon: ToolIcon; productName: string }) {
  const tint = /^#[0-9a-f]{6}$/i.test(icon.tint ?? "")
    ? (icon.tint as string)
    : TOOL_TINTS[icon.category ?? "neutral"] ?? TOOL_TINTS.neutral;
  const style: CSSProperties = {
    color: tint,
    background: rgba(tint, 0.12),
    borderColor: rgba(tint, 0.28),
  };
  return (
    <span className="akka-auth-appicon" style={style} aria-hidden="true">
      {(icon.initials?.trim() || initialsOf(productName)).slice(0, 3).toUpperCase()}
    </span>
  );
}

/** "Access" → "AC", "Bot analytics" → "BA". */
export function initialsOf(name: string) {
  const words = name.trim().split(/[\s\-_]+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2);
  return words[0][0] + words[1][0];
}

function rgba(hex: string, alpha: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function ErrorBox({ message }: { message: Message }) {
  return (
    <div className="akka-auth-alert" role="alert">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v5M12 16h.01" />
      </svg>
      <span>
        <b>{message.lead}</b>
        {message.detail && <> {message.detail}</>}
      </span>
    </div>
  );
}

function DesignSystemLogin({
  ui,
  productName,
  description,
  mode,
  config,
  next,
  error,
  unified = false,
  partner = false,
  refused = false,
  switchToo = false,
}: {
  ui: AuthUi;
  productName: string;
  description?: string;
  mode: ReturnType<typeof authMode>;
  config: ReturnType<typeof supabaseConfig>;
  next: string;
  error: Message | null;
  unified?: boolean;
  partner?: boolean;
  refused?: boolean;
  switchToo?: boolean;
}) {
  const { Card, CardHeader, CardTitle, CardDescription, CardContent, Alert, AlertDescription } = ui;
  const sub = partner ? `${productName} · for invited partners` : (description ?? `For @${ALLOWED_DOMAIN} accounts`);
  return (
    <main style={{ minHeight: "100svh", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      {isPreviewDeployment() && <PreviewBadge />}
      <Card style={{ width: "100%", maxWidth: 400 }}>
        <CardHeader>
          <Image src="/akka-logo.png" alt="Akka" width={98} height={32} priority style={{ height: 32, width: "auto", marginBottom: 12 }} />
          <CardTitle>{partner ? "Partner sign-in" : productName}</CardTitle>
          <CardDescription>{sub}</CardDescription>
        </CardHeader>
        <CardContent style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>
                <strong>{error.lead}</strong>
                {error.detail && <> {error.detail}</>}
              </AlertDescription>
            </Alert>
          )}
          {refused ? (
            <>
              <SwitchAccount buttonClassName={ui.buttonClassName} />
              <p style={{ fontSize: 13, opacity: 0.8 }}>{SWITCH_NOTE}</p>
            </>
          ) : partner ? (
            <PartnerForm next={next} ui={ui} />
          ) : mode === "required" && config ? (
            <>
              <GoogleSignInButton
                supabaseUrl={config.url}
                supabaseKey={config.key}
                domain={ALLOWED_DOMAIN}
                next={next}
                className={ui.buttonClassName}
              />
              {unified && (
                <p style={{ fontSize: 13, opacity: 0.8 }}>
                  Partner?{" "}
                  <a href={partnerHref(next)} style={{ textDecoration: "underline" }}>
                    Sign in with email
                  </a>
                </p>
              )}
              {switchToo && (
                <form action="/auth/signout" method="post">
                  <button type="submit" className="akka-auth-signout">
                    Use another account
                  </button>
                </form>
              )}
            </>
          ) : (
            <Alert variant={mode === "open" ? undefined : "destructive"}>
              <AlertDescription>
                {mode === "open"
                  ? "Authentication is not configured, so this development build is open. Set the Supabase variables to enable it."
                  : "Authentication is not configured on this deployment. Set NEXT_PUBLIC_SUPABASE_URL and the publishable key."}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </main>
  );
}

/** « Use another account »: signs out (everywhere), then back to a sign-in page. */
function SwitchAccount({ buttonClassName }: { buttonClassName?: string }) {
  return (
    <form action="/auth/signout" method="post" style={{ width: "100%" }}>
      <button
        type="submit"
        className={buttonClassName ?? "akka-auth-btn"}
        style={buttonClassName ? { width: "100%" } : undefined}
      >
        Use another account
      </button>
    </form>
  );
}

function partnerHref(next: string) {
  return `/login?partner=1${next !== "/" ? `&next=${encodeURIComponent(next)}` : ""}`;
}

function NotConfigured({ mode }: { mode: ReturnType<typeof authMode> }) {
  return mode === "open" ? (
    <p className="akka-auth-note">
      Authentication is not configured, so this development build is open.
      Set the Supabase variables to enable it.
    </p>
  ) : (
    <p className="akka-auth-error">
      Authentication is not configured on this deployment. Set
      NEXT_PUBLIC_SUPABASE_URL and the publishable key.
    </p>
  );
}

function LockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

const MFA_NOTICE = "Next step: a 6-digit code from your authenticator app. First time? You will scan a QR code.";

/**
 * Email + password for invited partners. A plain form posted to the server
 * route (routes.ts, handlePasswordSignIn): no account is ever created here,
 * and there is no sign-up link. Akka addresses are sent back to Google.
 */
function PartnerForm({ next, ui }: { next: string; ui?: AuthUi }) {
  const input = ui?.inputClassName ?? (ui ? undefined : "akka-auth-input");
  const inputStyle = ui && !ui.inputClassName ? { width: "100%", height: 42, padding: "0 12px" } : undefined;
  const back = next !== "/" ? `/login?next=${encodeURIComponent(next)}` : "/login";
  if (ui) {
    return (
      <form action={PASSWORD_PATH} method="post" style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%" }}>
        <input type="hidden" name="next" value={next} />
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
          Email
          <input className={input} style={inputStyle} type="email" name="email" autoComplete="username" required />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
          Password
          <input className={input} style={inputStyle} type="password" name="password" autoComplete="current-password" required />
        </label>
        <button type="submit" className={ui.buttonClassName} style={{ width: "100%" }}>
          Sign in
        </button>
        <p style={{ fontSize: 13, opacity: 0.8 }}>{MFA_NOTICE}</p>
        <a style={{ fontSize: 13, textDecoration: "underline", opacity: 0.8 }} href={back}>
          ← Back to Google sign-in
        </a>
      </form>
    );
  }
  return (
    <form action={PASSWORD_PATH} method="post" className="akka-auth-form">
      <input type="hidden" name="next" value={next} />
      <label className="akka-auth-field">
        <span>Email</span>
        <input className={input} type="email" name="email" autoComplete="username" required />
      </label>
      <label className="akka-auth-field">
        <span>Password</span>
        <input className={input} type="password" name="password" autoComplete="current-password" required />
      </label>
      <button type="submit" className="akka-auth-btn akka-auth-btn-submit">
        Sign in
      </button>
      <p className="akka-auth-mfa">
        <LockIcon />
        <span>{MFA_NOTICE}</span>
      </p>
      <a className="akka-auth-back" href={back}>
        ← Back to Google sign-in
      </a>
    </form>
  );
}

/** The signed-in email and a sign-out button, for the app's header. */
export function AccountChip({ email }: { email: string | null }) {
  if (!email) return null;
  return (
    <div className="akka-auth-account">
      <span>{email}</span>
      <form action="/auth/signout" method="post">
        <button type="submit" className="akka-auth-signout">
          Sign out
        </button>
      </form>
    </div>
  );
}
