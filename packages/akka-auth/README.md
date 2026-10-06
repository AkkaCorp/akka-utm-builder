# @akka/auth

Google sign-in restricted to `@akka.app`, through Supabase Auth, for Akka's
internal Next.js apps. Extracted from akka-sales-ops-dashboard so every internal
tool shares one implementation of the same rules.

## The rules it enforces

- Supabase configured → sign-in required. Not configured → open in
  `next dev` only; a production build **fails closed** (503), never open.
  Public paths (`/login`, the auth callbacks, and any `publicPaths` the app
  adds, such as signed webhooks) still answer, since they do not use the session.
- The domain is checked in three places: the OAuth callback, the middleware on
  every request, and `requireUser()` / `rejectUnauthenticated()` in server code.
  Google's `hd` parameter is only a hint.
- Server code always calls `getUser()` (revalidates the token), never
  `getSession()` (trusts a cookie).

## Using it in an app

Today it lives in this repo and is resolved through `tsconfig.json`:

```json
"paths": {
  "@akka/auth": ["./packages/akka-auth/src/index.ts"],
  "@akka/auth/*": ["./packages/akka-auth/src/*"]
}
```

Then five small files:

```ts
// middleware.ts — Next reads `config` statically, so the matcher stays literal here.
import type { NextRequest } from "next/server";
import { authMiddleware } from "@akka/auth/middleware";
export async function middleware(request: NextRequest) {
  return authMiddleware(request);
}
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.png|apple-icon.png|akka-logo.png|akka-logo.svg).*)"],
};

// app/auth/callback/route.ts
import { handleAuthCallback } from "@akka/auth/routes";
export const dynamic = "force-dynamic";
export const GET = handleAuthCallback;

// app/auth/signout/route.ts
import { handleSignOut } from "@akka/auth/routes";
export const dynamic = "force-dynamic";
export const POST = handleSignOut;

// app/login/page.tsx
import { LoginScreen, type LoginSearchParams } from "@akka/auth/login-screen";
export const dynamic = "force-dynamic";
export default async function LoginPage({ searchParams }: { searchParams: Promise<LoginSearchParams> }) {
  return <LoginScreen productName="My tool" params={await searchParams} />;
}

// app/layout.tsx
import "@akka/auth/auth.css";
```

In pages and route handlers:

```ts
import { requireUser, rejectUnauthenticated } from "@akka/auth/server";
const { email } = await requireUser();          // Server Component
const denied = await rejectUnauthenticated();    // Route handler
if (denied) return denied;
```

`AccountChip` (from `@akka/auth/login-screen`) renders the signed-in email and a
sign-out button. The CSS reads the Akka tokens on `:root` (`--surface`,
`--line`, `--green`…) and the login page reads `/akka-logo.png` from `public/`.

Environment: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
`AUTH_ALLOWED_DOMAIN` (default `akka.app`). Each app's URL must be in the
Supabase project's redirect allow list (`https://<app>/auth/callback`).

## Extracting it

The `exports` map in `package.json` already matches the import paths. To share
it: move this folder to its own repo (or the internal marketplace repo),
publish it to GitHub Packages as `@akka/auth`, add it as a dependency with
`transpilePackages: ["@akka/auth"]` in `next.config.ts`, and delete the two
`paths` entries. App code does not change.
