# Akka UTM Link Builder

Internal tool for non-technical collaborators to generate correctly formatted UTM
tracking links for akka.app, without needing to know UTM syntax, and to turn them
into short links on go.akka.app (Short.io).

Live at https://utm-builder.marketing.akkatools.com. Vercel project
`akka-utm-builder` in the Akka team (`akkacorp`).

Stack: Next.js 16 (App Router) + the shared `@akka/auth` library + the Akka design
system (akka-brand tokens, Poppins, logo and favicon set).

## Access

**Google sign-in restricted to `@akka.app`**, through Supabase Auth, enforced on every
route by [src/proxy.ts](src/proxy.ts). The implementation is the shared `@akka/auth`
library, vendored under [packages/akka-auth](packages/akka-auth) (same code as
akka-release-tracker, ops-dashboard and akka-sales-ops-dashboard), resolved through
`tsconfig.json` paths. The domain is checked in the OAuth callback, in the proxy on every
request, and again in the page (`requireUser()`) and in `/api/shorten`
(`rejectUnauthenticated()`).

**With the Supabase variables unset**: open locally (`next dev`), **503 in production**,
so a configuration oversight cannot expose the tool.

Sign-in uses the Google provider of the Supabase project `nlkxabxubykllskwzknx` (the one
the ops dashboards sign in through). Its redirect allow list (Authentication → URL
Configuration) contains `https://utm-builder.marketing.akkatools.com/**` (added 2026-10-06); keep it there.

## Files

- [src/app/utm-builder.tsx](src/app/utm-builder.tsx): the builder (form, live UTM
  preview, copy buttons, short link). Countries, landing pages and channels are the
  lists at the top of the file.
- [src/app/api/shorten/route.ts](src/app/api/shorten/route.ts): the browser never talks
  to Short.io directly; this route holds the Short.io secret key server-side and
  forwards the request.
- [src/app/globals.css](src/app/globals.css): Akka tokens and the page styles.

## Environment (Vercel)

| Variable | Environments | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Production, Preview | `https://nlkxabxubykllskwzknx.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Production, Preview | `sb_publishable_…`, public by design |
| `SHORTIO_API_KEY` | Production | Short.io Secret Key (Settings → Integrations & API), type Secret |
| `SHORTIO_DOMAIN` | optional | Defaults to `go.akka.app` |
| `AUTH_ALLOWED_DOMAIN` | optional | Defaults to `akka.app` |

Until `SHORTIO_API_KEY` is set, "Create short link" shows an error explaining Short.io
isn't connected; the long UTM link and copy work regardless.

## Develop and deploy

```bash
npm install
npm run dev
```

Without the Supabase variables in `.env.local`, the local dev server is open (no
sign-in). Deploy with the Vercel CLI from the repo root:

```bash
vercel deploy --prod --scope akkacorp
```

The GitHub repository is not connected to the Vercel project yet, so a `git push` does
not redeploy on its own.
