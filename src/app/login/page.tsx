import { LoginScreen, type LoginSearchParams } from "@akka/auth/login-screen";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<LoginSearchParams> }) {
  return (
    <LoginScreen
      productName="UTM Link Builder"
      description="UTM tracking links for akka.app, and go.akka.app short links"
      icon={{ initials: "UTM" }}
      params={await searchParams}
    />
  );
}
