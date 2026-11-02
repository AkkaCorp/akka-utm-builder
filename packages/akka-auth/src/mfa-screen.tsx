import Image from "next/image";
import { notFound } from "next/navigation";
import { authMode, authStack, safeNextUrl, supabaseConfig } from "./config";
import { AuthCardHeader, AuthPage, type ToolIdentity } from "./login-screen";
import { MfaForm } from "./mfa-form";
import type { AuthUi } from "./ui";

/**
 * The whole `/auth/mfa` page (unified stack): TOTP enrolment on a partner's
 * first sign-in, the challenge on every later one. The app's
 * `app/auth/mfa/page.tsx` renders it; the middleware only lets a session that
 * is waiting for its second factor reach it. Legacy stacks: 404.
 * Same page and card as the login screen, with the tool's `icon` (0.4); the
 * line under the name is the second-factor notice, not `description`.
 */
export function MfaScreen({
  productName,
  params,
  ui,
  icon,
}: {
  productName: string;
  params: { next?: string };
  ui?: AuthUi;
} & ToolIdentity) {
  const config = supabaseConfig();
  if (authStack() !== "unified" || authMode() !== "required" || !config) notFound();
  const next = safeNextUrl(params.next);

  const form = (
    <MfaForm
      supabaseUrl={config.url}
      supabaseKey={config.key}
      next={next}
      buttonClassName={ui?.buttonClassName}
      inputClassName={ui?.inputClassName}
    />
  );
  const signOut = (
    <form action="/auth/signout" method="post">
      <button type="submit" className={ui ? "akka-auth-signout" : "akka-auth-textbtn"}>
        Use another account
      </button>
    </form>
  );

  if (ui) {
    const { Card, CardHeader, CardTitle, CardDescription, CardContent } = ui;
    return (
      <main style={{ minHeight: "100svh", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
        <Card style={{ width: "100%", maxWidth: 400 }}>
          <CardHeader>
            <Image src="/akka-logo.png" alt="Akka" width={98} height={32} priority style={{ height: 32, width: "auto", marginBottom: 12 }} />
            <CardTitle>{productName}</CardTitle>
            <CardDescription>Second factor required for partner accounts.</CardDescription>
          </CardHeader>
          <CardContent style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {form}
            {signOut}
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <AuthPage>
      <AuthCardHeader
        title={productName}
        description="Second factor required for partner accounts."
        icon={icon}
        productName={productName}
      />
      <div className="akka-auth-stack">{form}</div>
      <div className="akka-auth-foot">{signOut}</div>
    </AuthPage>
  );
}
