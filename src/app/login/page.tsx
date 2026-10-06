import { LoginScreen, type LoginSearchParams } from "@akka/auth/login-screen";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<LoginSearchParams> }) {
  return <LoginScreen productName="UTM Link Builder" params={await searchParams} />;
}
