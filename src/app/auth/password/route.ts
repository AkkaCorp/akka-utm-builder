import { handlePasswordSignIn } from "@akka/auth/routes";

// Partner sign-in (email + password) posted by the login screen. Unified stack only:
// in legacy the handler answers 404.
export const dynamic = "force-dynamic";
export const POST = handlePasswordSignIn;
