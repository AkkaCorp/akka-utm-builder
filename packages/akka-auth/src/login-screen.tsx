import Image from "next/image";
import { ALLOWED_DOMAIN, authMode, safeNext, supabaseConfig } from "./config";
import { GoogleSignInButton } from "./google-button";

export type LoginSearchParams = {
  error?: string;
  error_code?: string;
  error_description?: string;
  next?: string;
};

const ERRORS: Record<string, string> = {
  domain: `That account is not on @${ALLOWED_DOMAIN}. Sign in with your Akka Google account.`,
  oauth: "Google sign-in did not complete. Try again.",
};

/**
 * The whole `/login` page. The app's `app/login/page.tsx` renders it with its
 * product name; the logo is read from `/akka-logo.png` in the app's `public/`.
 */
export function LoginScreen({
  productName,
  params,
}: {
  productName: string;
  params: LoginSearchParams;
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
