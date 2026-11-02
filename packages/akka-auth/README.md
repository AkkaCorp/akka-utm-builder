# @akka/auth

Sign-in for Akka's internal Next.js apps, through Supabase Auth. Version 0.5.

- **Internal accounts** (`@akka.app`): Google only.
- **Partners** (a handful of invited external accounts): email + password, TOTP
  second factor required, accounts created by invitation only.
- **Rights by Google group**, read from the `akka` claim the InternalTools
  access token hook adds. The matrix lives in the `access` app.

The shared contract (in French) is `Tech/auth-unifiee/CONTRAT.md`. This
repository (`AkkaCorp/akka-auth`) is the single source; every app keeps a
vendored copy under `packages/akka-auth/`, checked by hash on the platform.

Version 0.5 makes one sign-in cover every tool on akkatools.com: the session
cookie is shared on `.akkatools.com`, a central sign-in page serves every
tool, and a refusal on one tool no longer signs the user out (see
[Shared session and central sign-in](#shared-session-and-central-sign-in-05)).
Version 0.4 redesigned the sign-in screens (see [Sign-in screen](#sign-in-screen-04)).

## Stacks

Each app picks its rules with one variable. Switching and rolling back are the
same operation: change the variable, redeploy.

| Variable | Values | Default |
|---|---|---|
| `AUTH_STACK` | `legacy`, `unified` | `legacy` (any other value is legacy) |
| `AUTH_LEGACY_ADAPTER` | `akka-auth-domain`, `akkatools-zcmph` | `akka-auth-domain` |
| `AKKA_APP_KEY` | the app's key (= its repo name in the platform registry) | required by `unified` and `akkatools-zcmph`: 503 without it |
| `AUTH_LOGIN_URL` (0.5) | the central sign-in page; empty = each app keeps its own `/login` | `https://access.tech.akkatools.com/login` |

Supabase: `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
(or `NEXT_PUBLIC_SUPABASE_ANON_KEY`). `AUTH_ALLOWED_DOMAIN` (default `akka.app`)
is the internal domain. The `akkatools-zcmph` adapter also reads
`AKKATOOLS_SERVICE_ROLE_KEY` (server only, Production only).

On the platform, `AUTH_STACK` and `AKKA_APP_KEY` are set by the `prepare` job
from `projects/<repo>.json` (`authStack`, `appKey`): do not set them by hand.

### `legacy` + `akka-auth-domain` (0.1.0, default)

The 0.1.0 rules: Google sign-in, the email domain checked in the callback, the
middleware and server code, with `getUser()`. The `akka` claim is ignored, so a
hook change cannot break these apps. 0.5: on akkatools.com it shares the
session cookie and the central sign-in page like `unified`. An account outside
the domain is refused (see the refusal table below): signed out (`signOut()`,
global, the 0.1.0 rule) on previews, localhost and akka.app; on akkatools.com
a 403 that keeps the session, since a partner of the unified tools holds the
same shared session.

### `legacy` + `akkatools-zcmph`

The akkatools.com SSO gate, ported from akka-qa: the session cookie on
`.akkatools.com` issued by the central login, the `akkatools_access` RPC of the
identity project (service role) decides, the tool key is `AKKA_APP_KEY`. Not
signed in → `https://akkatools.com/login?next=…`; signed in without the tool →
the hub. A pass is remembered 60 s per session cookie. Open in `next dev`
whatever the config (the cookie never reaches localhost). Sign-out happens on
the hub. Unchanged in 0.5: neither the shared-session migration nor
`AUTH_LOGIN_URL` applies to it.

### `unified`

On every request the middleware sends here, and again in server helpers, in
this order (`src/decision.ts`):

1. Session verified locally with `getClaims()`. None → `/login?next=…`, or the
   central sign-in page on akkatools.com (0.5).
2. No `akka` claim, or an unknown `v` or `kind` → 403 "access not configured" (fail closed).
3. `status` not `active` → refused.
4. `@akka.app` address: provider must be `google` (`app_metadata.provider`),
   and the session must not have been opened with a password (`amr`).
5. `kind = external`: provider `email` and `aal2` required; in `aal1` → `/auth/mfa`.
6. No role in `akka.apps[AKKA_APP_KEY]` → 403 "no access to this tool".

A refusal shows this app's login page with the reason (`/login?error=…`, the
403 screen); on `/api/*` it is a JSON 401 (no session, second factor missing)
or 403. 0.5: the session is shared by every tool, so whether it survives
depends on the reason:

| Reason | Kind | Session |
|---|---|---|
| `no_app`, `not_configured` | authorization: this tool only | **kept**: 403 screen with "Use another account", the other tools keep working |
| `suspended`, `provider` | identity: the session must not count anywhere | ended (`signOut({ scope: "local" })`: this session, so every tool in this browser) |
| `mfa` (partner in `aal1`) | second factor missing | kept, `/auth/mfa` (unchanged) |
| `domain` (legacy `akka-auth-domain`, account outside the domain) | on akkatools.com: this tool only | **kept** on `*.akkatools.com`: 403 screen (`/login?error=domain`, Google and "Use another account"), JSON 403 on `/api/*`; elsewhere signed out (0.1.0, global), `/login?error=domain`, 401 |

The same split applies in the middleware, the server helpers, the OAuth
callback and the partner sign-in route (`endsSession(reason)` in unified; the
host in legacy). An unverified Google address is still signed out in the
legacy callback. `getClaims()`
verifies the JWT locally when the project signs with asymmetric keys; with a
symmetric secret it falls back to a call to Supabase.

## Shared session and central sign-in (0.5)

**Cookie domain.** Every Supabase client of the lib (middleware, server
helpers, routes, the Google button and the MFA form in the browser) writes its
cookies on `.akkatools.com` when the app is served on `akkatools.com` or a
subdomain (`cookieDomain(host)`; in the browser, from
`window.location.hostname`). Anywhere else (Vercel previews, localhost,
`*.akka.app`) the cookie stays limited to the host, as in 0.4. One Google
sign-in therefore covers every tool on the InternalTools project, for as long
as the session is valid.

**Migration of the 0.4 cookies** (`src/shared-session.ts`). 0.4 left
`sb-<ref>-auth-token` (its chunks `.0`, `.1`…, and the PKCE verifier) on each
app's host, under the same names as the shared ones. On an akkatools.com host:

1. Every auth cookie written on `.akkatools.com` comes with an expiry of its
   host-only namesake (`Set-Cookie` without `Domain`, `Max-Age=0`), so the
   browser never sends a stale copy next to the shared one (a refresh token
   reused after rotation can get the session revoked).
2. On a browser's first request to a host after the upgrade (the host-only
   marker `akka-auth-migrated` is absent) that carries auth cookies, or on any
   request carrying the same auth cookie twice, each auth cookie is written
   again on `.akkatools.com` with the value the server reads, its host-only
   namesake is expired, and the host is marked:
   - only the host cookie exists (a 0.4 session): it is **copied** to the
     domain, then expired on the host; the user stays signed in, now
     everywhere;
   - both exist: the server reads the last one sent, i.e. the newest
     (browsers order same-path cookies by creation time), which is the shared
     one; it is **kept**, the host one expired;
   - a cookie Supabase renews in the same response is not copied: the renewed
     value wins.
3. The apex `akkatools.com` (the hub) is left alone.

**Central sign-in page.** `AUTH_LOGIN_URL`, by default
`https://access.tech.akkatools.com/login`; empty = none. When the app is served
on `*.akkatools.com` and there is no session, a page goes to
`<central page>?next=<absolute URL asked for>`, `/login` included (its `next`
made absolute); an `/api/*` route stays a JSON 401. A `/login?error=…` (the
403 screen) always renders locally. On any other host, and on the app whose
own host is the central page's, the local `/login` as before.

The flow: tool → central page → Google → the central app's `/auth/callback`
→ the absolute `next`. The cookie is on `.akkatools.com`, so the tool sees the
session. Partners: the password form and `/auth/mfa` of the central app, then
the tool. The central app does not decide access for the tool: a user without
a role on the central app itself (`no_app`, `not_configured`) is still sent on
when `next` is another tool, which applies its own rules on arrival; an
identity refusal ends the session there.

**Absolute `next`** (`safeNextUrl`): a same-site path as before (`safeNext`),
or an `https://` URL on `akkatools.com` or a subdomain, without user info,
port, backslash, space or control character. Anything else becomes `/`. The
callback, the partner sign-in route, the MFA page and the signed-in `/login`
all go through it. 0.5 also closes a hole in `safeNext`: a tab or a newline
(`/<tab>/evil.example`), which URL parsers drop, is refused.

**No redirect loop.** When the central page sends a signed-in user back to a
tool, it sets `akka-auth-bounce` on `.akkatools.com` for 60 s. A tool that
still sees no session (another Supabase project, a misconfiguration) then shows
its own `/login` instead of bouncing back; the mark is cleared once the user
gets in.

**Sign-out** (`handleSignOut`): global, so every tool and every device, then
the central page (`?next=` the app's home) on akkatools.com, the local
`/login` elsewhere.

**Supabase (InternalTools project), Authentication → URL Configuration.** The
nominal flow only needs the central app's callback
(`https://access.tech.akkatools.com/auth/callback**`). Keep every app's own
callback on the list too: the local `/login` still has its Google button (the
loop fallback, the 403 and identity-refusal screens, previews). In Supabase's
patterns `*` stops at a dot, so `https://*.akkatools.com/**` does not match
`tool.tech.akkatools.com`: list `https://*.tech.akkatools.com/auth/callback**`
(or each app) explicitly.

## API

| Entry point | Exports |
|---|---|
| `@akka/auth` | config helpers (`authStack`, `legacyAdapter`, `appKey`, `safeNext`, 0.5: `safeNextUrl`, `cookieDomain`, `centralLoginUrl`…), `decide`, `endsSession` (0.5), types `AuthUser`, `AkkaClaim` |
| `@akka/auth/middleware` | `authMiddleware(request, { publicPaths })` |
| `@akka/auth/server` | `requireUser()`, `requireRole(role)`, `currentUser()`, `rejectUnauthenticated({ role? })`, `createServerSupabase()`, `createAppAccessCheck(query, { ttlMs? })`, `APP_ROLES_SQL` (0.3) |
| `@akka/auth/routes` | `handleAuthCallback`, `handlePasswordSignIn`, `handleSignOut` |
| `@akka/auth/login-screen` | `LoginScreen`, `AccountChip`; types `ToolIdentity`, `ToolIcon`, `ToolCategory`, `TOOL_TINTS` (0.4) |
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

`requireRole("admin")` sends a user without the role to `/login?error=role`
(0.5: the 403 screen, session kept); in a route handler use
`rejectUnauthenticated({ role: "admin" })` (403).

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
  // 0.4, optional: description="What the tool is for" icon={{ category: "platform" }}
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

### Long-lived tokens: re-check access on each call (0.3)

The checks above read the session token, renewed every 15 minutes at most, so
removing someone from a Google group reaches the browser within that delay. A
credential the app issues itself (MCP OAuth refresh token, named bearer token)
never goes through that renewal: re-check its owner on each call with
`createAppAccessCheck`. The lib does not talk to Postgres; the app passes the
query, run with its own database role:

```ts
// lib/access.ts — server only
import { createAppAccessCheck } from "@akka/auth/server";
import { db } from "./db";

// select access.app_roles($1, $2) as roles  (APP_ROLES_SQL, for other clients)
export const checkAppAccess = createAppAccessCheck(async (email, appKey) => {
  const [row] = await db()<{ roles: string[] }[]>`select access.app_roles(${email}, ${appKey}) as roles`;
  return row.roles;
});

// lib/mcp.ts, in authorize(), once the token has resolved to a grant:
const grant = await verifyAccessToken(token);
if (!grant) return null;
if (!(await checkAppAccess(grant.user_email)).ok) return null; // removed from the app's groups
```

Tokens that belong to no person (`MCP_TOKENS` from the environment) skip it.

| Stack | `check(email)` |
|---|---|
| `next dev` without config | `{ ok: true, roles: ["user", "admin"] }`, no query |
| misconfigured production build | refused |
| `unified` | `query(email lowercased, AKKA_APP_KEY)`; `ok` when the roles hold `user` or `admin` (admin implies user). No `AKKA_APP_KEY` → refused |
| `akka-auth-domain` | the domain rule, `["user"]`, no query |
| `akkatools-zcmph` | the hub's `akkatools_access` RPC, as the gate (`AKKA_APP_KEY` in the tools; `admin` for a hub admin), no query |

Answers are cached per email for `ttlMs` (default 60 000), granted and refused
alike, 500 emails at most (least recently used out): a removal takes effect
within `ttlMs` of the matrix change. A failing query refuses and is not cached
(fail closed), with a `console.warn("[akka-auth] …")` naming the email. In
`akkatools-zcmph` only grants are cached: the RPC does not tell an error from
a refusal.

Requirements (`unified`), outside this lib: the `access` migration that
creates `access.app_roles(p_email text, p_app_key text) returns text[]`
(`{}` without access) in InternalTools, and the platform granting the app's
database role the `akka_access_check` group role. Without them the query fails,
so every call is refused.

### Sign-in screen (0.4)

One card on a static background (two soft green halos, no animation): the
Akka logo and "Internal tools", the tool's name as the title, then
**Continue with Google** with "For @akka.app accounts" under it. In `unified`
a single footer, "Partner? Sign in with email", leads to the partner form.
Legacy shows the same card without that footer. A refusal (`?error=…`) shows
in a red box under the title, before any button, with what to do next.

Optional props of `LoginScreen` (and `icon` on `MfaScreen`). Without them the
card has no icon and no description line; nothing else changes:

| Prop | Type | Effect |
|---|---|---|
| `description` | `string` | One line under the tool's name. |
| `icon` | `{ initials?, category?, tint? }` | A 40 px initials square left of the name. `initials`: 1 to 3 characters, default from the name ("Access" → "AC", "Bot analytics" → "BA"). `category`: `platform`, `data`, `product`, `ops`, `community`, `neutral` (default), see `TOOL_TINTS`. `tint`: a `#RRGGBB` that wins over `category`. `icon={{}}` gives the default initials in the neutral tint. |

```tsx
<LoginScreen
  productName="Access"
  description="Who opens which internal tool"
  icon={{ category: "platform" }}
  params={await searchParams}
/>
```

**Preview badge.** "PREVIEW · not production" sits at the top of the login and
MFA pages when `VERCEL_ENV=preview`, i.e. on a Vercel preview deployment
(branch or PR URL). Vercel sets that variable on every deployment, so no app
setting is needed; production, `next dev` and non-Vercel hosts show nothing.

**Tokens.** The card reads the usual `:root` tokens, plus optional ones it
falls back on when an app lacks them: `--bg-deep` (`#0A2825`), `--surface2`
(`#12403A`), `--muted` (`#A9C0B9`), `--faint` (`#8FA9A1`), `--line2`
(`rgba(159,179,172,.26)`), `--grey` (`#F0F0F0`), `--amber` (`#F2C46D`),
`--gutter` (`16px`).

### Partners

The login page shows a **Partner? Sign in with email** footer under the Google
button (`unified` only). It opens an email + password form (`?partner=1`, titled "Partner sign-in", which
announces the authenticator-app step and links back to Google) posted to
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

## Upgrading from 0.4

Replace `packages/akka-auth/` with this version's `src/` and `package.json`
(0.5 adds `src/shared-session.ts`). No signature changes, no new app file:
`proxy.ts`, the routes and the pages stay as they are, and so do `publicPaths`.

What changes once deployed on `*.akkatools.com`:

- the session moves to `.akkatools.com` on the first request (users already
  signed in stay signed in, see the migration rule above), and one sign-in
  then opens every tool on 0.5;
- without a session, pages go to the central sign-in page (`AUTH_LOGIN_URL`);
- `no_app` / `not_configured` keep the session and show the 403 screen with
  "Use another account" (was: signed out); the sign-in buttons are not shown
  there;
- legacy `akka-auth-domain`: an account outside the domain (a partner signed
  in to the unified tools) gets a 403 and keeps its session instead of being
  signed out everywhere; previews, localhost and akka.app keep the 0.1.0
  sign-out;
- sign-out lands on the central page.

The central app (`access`, on `access.tech.akkatools.com`) needs the
`unified` stack and its usual files (`/login`, `/auth/callback`,
`/auth/password`, `/auth/mfa`), which it has. Upgrade it first: until it runs
0.5, its `/login` ignores an absolute `next` and lands on its own home.
Previews, localhost and `*.akka.app` apps see no change but the 403 rule.
To keep an app on its own `/login`, set `AUTH_LOGIN_URL` to an empty value.

## Upgrading from 0.3

Replace `packages/akka-auth/` with this version's `src/` and `package.json`.
No signature changes: the login and MFA screens take the new look as they
are. Optionally pass `description` and `icon` (above). Visible changes: the
button reads "Continue with Google" (was "Login with your Akka Account"), the
partner link reads "Partner? Sign in with email" (was "Partner access"), and
error texts are reworded (same `?error=` codes).

## Upgrading from 0.2

Replace `packages/akka-auth/` with this version's `src/` and `package.json`.
Nothing changes until the app calls `createAppAccessCheck` (above).

## Migrating an app from 0.1.0

1. Replace `packages/akka-auth/` with this version's `src/` and `package.json`.
   With no other change, the app behaves exactly as before (`AUTH_STACK`
   absent = `legacy` + `akka-auth-domain`). `requireUser()` returns more
   fields; `{ email }` is unchanged.
2. Add `app/auth/password/route.ts` and `app/auth/mfa/page.tsx` (above).
3. Register `appKey` and set `authStack: "unified"` in the platform registry,
   once the "who has access before / after" report is approved. Redeploy.
4. Check: `/` → 307 to `/login`; `/login` shows Google and "Partner? Sign in with email";
   an `/api` route without a session → 401 JSON.

An akka-qa style app (zcmph gate) sets `AUTH_LEGACY_ADAPTER=akkatools-zcmph`
and `AKKA_APP_KEY=<tool key>`, and replaces its own gate with `authMiddleware`.

## Rollback

Set `authStack` back to `legacy` in the registry (or `AUTH_STACK=legacy`) and
redeploy. Unified sessions stay valid Supabase sessions on the same project, so
internal users stay signed in; legacy simply stops reading the claim.
Partners lose access in legacy (`akka-auth-domain` admits `@akka.app` only).

## Changelog

- **0.5.0**: shared session on `.akkatools.com` (every client of the lib; the
  0.4 host-only cookies are moved over and expired), central sign-in page
  (`AUTH_LOGIN_URL`, default `https://access.tech.akkatools.com/login`, with
  an absolute `next` validated by `safeNextUrl` and a loop guard), a refusal
  no longer signs out: `no_app` and `not_configured` keep the session (403
  screen with "Use another account"), `suspended` and `provider` end it;
  sign-out goes to the central page. Legacy `akka-auth-domain` on
  akkatools.com: an account outside the domain gets a 403, session kept
  (signed out elsewhere, as in 0.1.0). `safeNext` refuses control characters
  (a tab in `next` could lead off site). The legacy `akka-auth-domain`
  middleware's sign-out cookies now reach the browser on its redirect, and its
  `/login?error=…` renders instead of bouncing. `akkatools-zcmph` unchanged.

- **0.4.1**: the screen's text tiers, amber, strong line and deep ground use their own
  `--akka-auth-*` variables instead of the app's `--muted` / `--faint` / `--amber` /
  `--line2` / `--bg-deep` (shadcn apps define `--muted` as a background: the partner link
  was dark on dark). No API change.
- **0.4.0**: sign-in screens redesigned (ambient background, translucent card,
  tool name as title, error box under the title, partner screen announcing the
  second factor, preview badge on Vercel previews); optional `description` and
  `icon` props; MFA screen on the same card. No behaviour change.
- **0.3.0**: `createAppAccessCheck`, `APP_ROLES_SQL`.
- **0.2.0**: `unified` stack, partner sign-in, TOTP.
- **0.1.0**: Google sign-in for @akka.app.

## Development

```bash
npm install
npm test          # vitest, no network: Supabase and fetch are faked
npm run typecheck
npm run hash      # sha256:<hex> of src/ + package.json, as the platform computes it
```
