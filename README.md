# Akka UTM Link Builder

Internal tool for non-technical collaborators to generate correctly formatted UTM
tracking links for akka.app, without needing to know UTM syntax, and to turn them
into short links on go.akka.app (Short.io).

Live at https://utm-builder.marketing.akkatools.com. Vercel project
`akka-utm-builder` in the Akka team (`akkacorp`), deployed by
[Akka Platform](https://github.com/AkkaCorp/akka-platform).

Stack: Next.js 16 (App Router) + the shared `@akka/auth` library (0.2.1) + the Akka design
system (akka-brand tokens, Poppins, logo and favicon set).

## Access

Sign-in through Supabase Auth (project InternalTools, `nlkxabxubykllskwzknx`), enforced on
every route by [src/proxy.ts](src/proxy.ts), again in the page (`requireUser()`) and in
`/api/shorten` (`rejectUnauthenticated()`). The implementation is the shared `@akka/auth`
library, vendored under [packages/akka-auth](packages/akka-auth) (a released copy, checked by
hash on every deploy: never edit it, replace it with the next release), resolved through
`tsconfig.json` paths.

The rules depend on `AUTH_STACK`, set by Akka Platform from the registry
(`projects/akka-utm-builder.json` → `authStack`, `appKey: "utm-builder"`):

- **`legacy`** (default, also when unset): Google sign-in restricted to `@akka.app`, exactly as
  in 0.1.0. `/auth/password` and `/auth/mfa` answer 404.
- **`unified`**: access by Google group, from the `access` app (key `utm-builder`). Google for
  `@akka.app`; invited partners sign in with email + password (`/auth/password`) and a TOTP
  second factor (`/auth/mfa`). Switching and rolling back = change `authStack`, redeploy.

**With the Supabase variables unset**: open locally (`next dev`), **503 in production**,
so a configuration oversight cannot expose the tool.

The InternalTools redirect allow list (Authentication → URL Configuration) covers the domain
(`https://*.*.akkatools.com/**`, plus `https://utm-builder.marketing.akkatools.com/**` added
2026-10-06); keep them there.

## Files

- [src/app/utm-builder.tsx](src/app/utm-builder.tsx): the builder (form, live UTM
  preview, copy buttons, short link). Countries, landing pages and channels are the
  lists at the top of the file.
- [src/app/api/shorten/route.ts](src/app/api/shorten/route.ts): the browser never talks
  to Short.io directly; this route holds the Short.io secret key server-side and
  forwards the request.
- [src/app/globals.css](src/app/globals.css): Akka tokens and the page styles.

## Environment (Vercel)

| Variable | Environments | Set by | Notes |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | all | Akka Platform | InternalTools URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | all | Akka Platform | `sb_publishable_…`, public by design |
| `AUTH_STACK`, `AKKA_APP_KEY` | Production, Preview | Akka Platform, from the registry | `legacy` / `unified`, `utm-builder` |
| `SHORTIO_API_KEY` | Production | an admin, by hand (sensitive) | Short.io Secret Key (Settings → Integrations & API) |
| `SHORTIO_DOMAIN` | optional | `akka-platform.json` if ever needed | Defaults to `go.akka.app` |

Until `SHORTIO_API_KEY` is set, "Create short link" shows an error explaining Short.io
isn't connected; the long UTM link and copy work regardless. Plain settings go in
[akka-platform.json](akka-platform.json) (committed, never a secret).

## Shipping a change

- Open a pull request: a preview deployment is built and its URL is commented on the PR.
- Merge into `main`: the change is verified (build, typecheck, lint) and deployed to
  production — https://utm-builder.marketing.akkatools.com.
- Every deploy goes through [Akka Platform](https://github.com/AkkaCorp/akka-platform)
  ([.github/workflows/deploy.yml](.github/workflows/deploy.yml), GitHub OIDC): it checks the
  code (no credential committed, dependencies, sign-in, `@akka/auth` release…), builds,
  deploys, and reports as the **akka-platform** check on the commit. If it refuses, the
  check's link says why. Nobody deploys from their own machine (`vercel deploy` is no longer
  used), and Vercel's Git integration stays off (`vercel.json`).

## Local development

```bash
npm install
npm run dev
```

Without the Supabase variables in `.env.local` (see [.env.example](.env.example)), the local
dev server is open (no sign-in). With a Vercel seat,
`vercel link --project akka-utm-builder --scope akkacorp` then `vercel env pull .env.local`.
Before pushing: `npm run build && npx tsc --noEmit && npx eslint .`.
