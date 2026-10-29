import Image from "next/image";
import { ALLOWED_DOMAIN, PASSWORD_PATH, authMode, authStack, safeNext, supabaseConfig } from "./config";
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

const ERRORS: Record<string, string> = {
  domain: `That account is not on @${ALLOWED_DOMAIN}. Sign in with your Akka Google account.`,
  oauth: "Google sign-in did not complete. Try again.",
  // Unified stack.
  ...DENY_MESSAGES,
  role: "Your account does not have the role this page needs.",
  use_google: `@${ALLOWED_DOMAIN} accounts sign in with Google, not with a password.`,
  credentials: "Wrong email or password.",
};

/**
 * The whole `/login` page. The app's `app/login/page.tsx` renders it with its
 * product name; the logo is read from `/akka-logo.png` in the app's `public/`.
 * Pass `ui` (see ui.ts) to build it from the app's shadcn components;
 * without it, the module's own CSS is used.
 *
 * Unified stack: a « Partner access » link under the Google button leads to an
 * email + password form (`?partner=1`) for invited partners. Legacy: 0.1.0 as is.
 */
export function LoginScreen({
  productName,
  params,
  ui,
}: {
  productName: string;
  params: LoginSearchParams;
  ui?: AuthUi;
}) {
  const mode = authMode();
  const config = supabaseConfig();
  // Supabase bounces its own failures back here (an unconfigured provider, a
  // redirect URL that is not on the allow list). Surface them instead of
  // dropping the user on a login page that looks like nothing happened.
  const error =
    (params.error && ERRORS[params.error]) ||
    params.error_description?.replace(/\+/g, " ") ||
    (params.error ? `Sign-in failed (${params.error_code || params.error}).` : null);

  const next = safeNext(params.next);
  const unified = authStack() === "unified";
  const partner = unified && params.partner === "1" && mode === "required";

  if (ui) return <DesignSystemLogin ui={ui} productName={productName} mode={mode} config={config} next={next} error={error} unified={unified} partner={partner} />;

  if (unified) {
    return (
      <main className="akka-auth-page">
        <div className="akka-auth-card">
          <Image src="/akka-logo.png" alt="Akka" width={98} height={32} priority style={{ height: 32, width: "auto" }} />
          <h1>{productName}</h1>
          <p className="akka-auth-sub">
            {partner ? "Partner access, for invited accounts." : `Reserved for @${ALLOWED_DOMAIN} accounts and invited partners.`}
          </p>
          {partner ? (
            <PartnerForm next={next} />
          ) : mode === "required" && config ? (
            <>
              <GoogleSignInButton supabaseUrl={config.url} supabaseKey={config.key} domain={ALLOWED_DOMAIN} next={next} />
              <a className="akka-auth-link" href={partnerHref(next)}>
                Partner access
              </a>
            </>
          ) : (
            <NotConfigured mode={mode} />
          )}
          {error && (
            <p className="akka-auth-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="akka-auth-page">
      <div className="akka-auth-card">
        <Image
          src="/akka-logo.png"
          alt="Akka"
          width={98}
          height={32}
          priority
          style={{ height: 32, width: "auto" }}
        />
        <h1>{productName}</h1>
        <p className="akka-auth-sub">Reserved for @{ALLOWED_DOMAIN} accounts.</p>

        {mode === "required" && config ? (
          <GoogleSignInButton
            supabaseUrl={config.url}
            supabaseKey={config.key}
            domain={ALLOWED_DOMAIN}
            next={safeNext(params.next)}
          />
        ) : mode === "open" ? (
          <p className="akka-auth-note">
            Authentication is not configured, so this development build is open.
            Set the Supabase variables to enable it.
          </p>
        ) : (
          <p className="akka-auth-error">
            Authentication is not configured on this deployment. Set
            NEXT_PUBLIC_SUPABASE_URL and the publishable key.
          </p>
        )}

        {error && (
          <p className="akka-auth-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}

function DesignSystemLogin({
  ui,
  productName,
  mode,
  config,
  next,
  error,
  unified = false,
  partner = false,
}: {
  ui: AuthUi;
  productName: string;
  mode: ReturnType<typeof authMode>;
  config: ReturnType<typeof supabaseConfig>;
  next: string;
  error: string | null;
  unified?: boolean;
  partner?: boolean;
}) {
  const { Card, CardHeader, CardTitle, CardDescription, CardContent, Alert, AlertDescription } = ui;
  const description = !unified
    ? `Reserved for @${ALLOWED_DOMAIN} accounts.`
    : partner
      ? "Partner access, for invited accounts."
      : `Reserved for @${ALLOWED_DOMAIN} accounts and invited partners.`;
  return (
    <main style={{ minHeight: "100svh", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <Card style={{ width: "100%", maxWidth: 400 }}>
        <CardHeader>
          <Image src="/akka-logo.png" alt="Akka" width={98} height={32} priority style={{ height: 32, width: "auto", marginBottom: 12 }} />
          <CardTitle>{productName}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {partner ? (
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
                <a href={partnerHref(next)} style={{ fontSize: 13, textDecoration: "underline", opacity: 0.8 }}>
                  Partner access
                </a>
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
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </main>
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

/**
 * Email + password for invited partners. A plain form posted to the server
 * route (routes.ts, handlePasswordSignIn): no account is ever created here,
 * and there is no sign-up link. Akka addresses are sent back to Google.
 */
function PartnerForm({ next, ui }: { next: string; ui?: AuthUi }) {
  const input = ui?.inputClassName ?? (ui ? undefined : "akka-auth-input");
  const inputStyle = ui && !ui.inputClassName ? { width: "100%", height: 40, padding: "0 12px" } : undefined;
  return (
    <form
      action={PASSWORD_PATH}
      method="post"
      style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%" }}
    >
      <input type="hidden" name="next" value={next} />
      <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
        Email
        <input className={input} style={inputStyle} type="email" name="email" autoComplete="username" required />
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
        Password
        <input className={input} style={inputStyle} type="password" name="password" autoComplete="current-password" required />
      </label>
      <button
        type="submit"
        className={ui ? ui.buttonClassName : "akka-auth-btn"}
        style={ui ? { width: "100%" } : undefined}
      >
        Sign in
      </button>
      <a
        className={ui ? undefined : "akka-auth-link"}
        style={ui ? { fontSize: 13, textDecoration: "underline", opacity: 0.8 } : undefined}
        href={next !== "/" ? `/login?next=${encodeURIComponent(next)}` : "/login"}
      >
        Akka account? Sign in with Google
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
