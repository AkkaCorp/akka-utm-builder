import { MfaScreen } from "@akka/auth/mfa-screen";

// Partner second factor (TOTP enrolment, then challenge). Unified stack only:
// in legacy the screen calls notFound().
export const dynamic = "force-dynamic";

export default async function MfaPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  return <MfaScreen productName="UTM Link Builder" params={await searchParams} />;
}
