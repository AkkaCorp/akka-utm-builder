# @akka/auth

Sign-in for Akka's internal Next.js apps, through Supabase Auth. Version 0.2.

- **Internal accounts** (`@akka.app`): Google only.
- **Partners** (a handful of invited external accounts): email + password, TOTP
  second factor required, accounts created by invitation only.
- **Rights by Google group**, read from the `akka` claim the InternalTools
  access token hook adds. The matrix lives in the `access` app.

The shared contract (in French) is `Tech/auth-unifiee/CONTRAT.md`. This
repository (`AkkaCorp/akka-auth`) is the single source; every app keeps a
vendored copy under `packages/akka-auth/`, checked by hash on the platform.

## Stacks

Each app picks its rules with one variable. Switching and rolling back are the
same operation: change the variable, redeploy.

| Variable | Values | Default |
|---|---|---|
| `AUTH_STACK` | `legacy`, `unified` | `legacy` (any other value is legacy) |
| `AUTH_LEGACY_ADAPTER` | `akka-auth-domain`, `akkatools-zcmph` | `akka-auth-domain` |
| `AKKA_APP_KEY` | the app's key (= its repo name in the platform registry) | required by `unified` and `akkatools-zcmph`: 503 without it |

Supabase: `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
(or `NEXT_PUBLIC_SUPABASE_ANON_KEY`). `AUTH_ALLOWED_DOMAIN` (default `akka.app`)
is the internal domain. The `akkatools-zcmph` adapter also reads
`AKKATOOLS_SERVICE_ROLE_KEY` (server only, Production only).

On the platform, `AUTH_STACK` and `AKKA_APP_KEY` are set by the `prepare` job
from `projects/<repo>.json` (`authStack`, `appKey`): do not set them by hand.

### `legacy` + `akka-auth-domain` (0.1.0, default)

Exactly 0.1.0: Google sign-in, the email domain checked in the callback, the
middleware and server code, with `getUser()`. The `akka` claim is ignored, so a
hook change cannot break these apps.

### `legacy` + `akkatools-zcmph`

The akkatools.com SSO gate, ported from akka-qa: the session cookie on
`.akkatools.com` issued by the central login, the `akkatools_access` RPC of the
identity project (service role) decides, the tool key is `AKKA_APP_KEY`. Not
signed in → `https://akkatools.com/login?next=…`; signed in without the tool →
the hub. A pass is remembered 60 s per session cookie. Open in `next dev`
whatever the config (the cookie never reaches localhost). Sign-out happens on
the hub.

### `unified`

On every request the middleware sends here, and again in server helpers, in
this order (`src/decision.ts`):

1. Session verified locally with `getClaims()`. None → `/login?next=…`.
2. No `akka` claim, or an unknown `v` or `kind` → 403 "access not configured" (fail closed).
3. `status` not `active` → refused.
4. `@akka.app` address: provider must be `google` (`app_metadata.provider`),
   and the session must not have been opened with a password (`amr`).
5. `kind = external`: provider `email` and `aal2` required; in `aal1` → `/auth/mfa`.
6. No role in `akka.apps[AKKA_APP_KEY]` → 403 "no access to this tool".

A refusal signs out **this app only** (`scope: "local"`) and shows the login
page with the reason (`/login?error=…`); on `/api/*` it is a JSON 401 (no
session, second factor missing) or 403. `getClaims()` verifies the JWT locally
when the project signs with asymmetric keys; with a symmetric secret it falls
back to a call to Supabase.

## API

| Entry point | Exports |
|---|---|
| `@akka/auth` | config helpers (`authStack`, `legacyAdapter`, `appKey`, `safeNext`…), `decide`, types `AuthUser`, `AkkaClaim` |
| `@akka/auth/middleware` | `authMiddleware(request, { publicPaths })` |
| `@akka/auth/server` | `requireUser()`, `requireRole(role)`, `currentUser()`, `rejectUnauthenticated({ role? })`, `createServerSupabase()` |
| `@akka/auth/routes` | `handleAuthCallback`, `handlePasswordSignIn`, `handleSignOut` |
| `@akka/auth/login-screen` | `LoginScreen`, `AccountChip` |
| `@akka/auth/mfa-screen` | `MfaScreen` |
| `@akka/auth/ui` | type `AuthUi` |
| `@akka/auth/auth.css` | the module's own styles |

`requireUser()` returns `{ email, kind, groups, roles }`:

| Stack | `roles` | `groups` |
|---|---|---|
| `unified` | `akka.apps[AKKA_APP_KEY]` (`user`, `admin`) | the claim's groups |
| `akka-auth-domain` | `["user"]` | `[]` |
| `akkatools-zcmph` | `["user"]`, plus `admin` for a hub admin (`is_admin`) | `[]` |
| `next dev` without config | `["user", "admin"]`, `email: null` | `[]` |

`requireRole("admin")` sends a user without the role to `/login?error=role`;
in a route handler use `rejectUnauthenticated({ role: "admin" })` (403).

## Installation (vendored)

1. Copy `src/` and `package.json` of a released version to the app's
   `packages/akka-auth/`. Nothing else, and do not edit them: the platform
   compares the copy's hash with the released ones (`npm run hash` here,
   `checks/akka-auth-hash.mjs` there).
2. `tsconfig.json`:
   ```json
   "paths": {
     "@akka/auth": ["./packages/akka-auth/src/index.ts"],
     "@akka/auth/*": ["./packages/akka-auth/src/*"]
   }
   ```
3. Dependencies: `@supabase/ssr` (>= 0.12), `@supabase/supabase-js` (>= 2.100), Next >= 16, React >= 19.
4. App files (Next 16: `src/proxy.ts` exporting `proxy`; Next 15: `middleware.ts`):

```ts
// src/proxy.ts — Next reads `config` statically, so the matcher stays literal here.
import type { NextRequest } from "next/server";
import { authMiddleware } from "@akka/auth/middleware";
export async function proxy(request: NextRequest) {
  return authMiddleware(request);
}
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|icon|apple-icon|akka-logo).*)"],
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

For `unified`, two more files (harmless in legacy: the route answers 404, the page `notFound()`):

```ts
// app/auth/password/route.ts — the partner sign-in form posts here
import { handlePasswordSignIn } from "@akka/auth/routes";
export const dynamic = "force-dynamic";
export const POST = handlePasswordSignIn;

// app/auth/mfa/page.tsx — TOTP enrolment, then challenge
import { MfaScreen } from "@akka/auth/mfa-screen";
export const dynamic = "force-dynamic";
export default async function MfaPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  return <MfaScreen productName="My tool" params={await searchParams} />;
}
```

In pages and route handlers:

```ts
import { requireUser, requireRole, rejectUnauthenticated } from "@akka/auth/server";
const { email, roles } = await requireUser();          // Server Component
const admin = await requireRole("admin");               // admin-only page
const denied = await rejectUnauthenticated();           // Route handler
if (denied) return denied;
```

### Partners

The login page shows a **Partner access** link under the Google button
(`unified` only). It opens an email + password form posted to
`/auth/password`, which refuses `@akka.app` addresses before asking Supabase,
gives one generic error for any failure, and refuses cross-site posts. There is
no sign-up and no "forgot password" link: partner accounts are invited from the
`access` app. After the password, `/auth/mfa` enrols an authenticator app (QR
code + first code) on the first sign-in, and asks for a code afterwards
(`supabase.auth.mfa.*`, in the browser). Supabase project settings needed: TOTP
MFA enabled.

### With shadcn/ui (optional)

`LoginScreen` and `MfaScreen` take `ui` (type `AuthUi`): Card parts, Alert, the
button classes, and in 0.2 optional `inputClassName` for the form inputs. The
module never imports shadcn itself.

## Migrating an app from 0.1.0

1. Replace `packages/akka-auth/` with this version's `src/` and `package.json`.
   With no other change, the app behaves exactly as before (`AUTH_STACK`
   absent = `legacy` + `akka-auth-domain`). `requireUser()` returns more
   fields; `{ email }` is unchanged.
2. Add `app/auth/password/route.ts` and `app/auth/mfa/page.tsx` (above).
3. Register `appKey` and set `authStack: "unified"` in the platform registry,
   once the "who has access before / after" report is approved. Redeploy.
4. Check: `/` → 307 to `/login`; `/login` shows Google and "Partner access";
   an `/api` route without a session → 401 JSON.

An akka-qa style app (zcmph gate) sets `AUTH_LEGACY_ADAPTER=akkatools-zcmph`
and `AKKA_APP_KEY=<tool key>`, and replaces its own gate with `authMiddleware`.

## Rollback

Set `authStack` back to `legacy` in the registry (or `AUTH_STACK=legacy`) and
redeploy. Unified sessions stay valid Supabase sessions on the same project, so
internal users stay signed in; legacy simply stops reading the claim.
Partners lose access in legacy (`akka-auth-domain` admits `@akka.app` only).

## Development

```bash
npm install
npm test          # vitest, no network: Supabase and fetch are faked
npm run typecheck
npm run hash      # sha256:<hex> of src/ + package.json, as the platform computes it
```
