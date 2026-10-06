import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { authMode, isAllowedEmail, supabaseConfig } from "./config";

export async function createServerSupabase() {
  const config = supabaseConfig();
  if (!config) throw new Error("Supabase is not configured");
  const cookieStore = await cookies();

  return createServerClient(config.url, config.key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component: the middleware refreshes the
          // session cookies instead, so this is safe to ignore.
        }
      },
    },
  });
}

/**
 * Defence in depth behind the middleware: a Server Component that renders
 * internal data re-checks the session itself, so a matcher gap or a
 * middleware change cannot quietly expose a page.
 *
 * Always getUser(), never getSession(): getUser revalidates the token with
 * Supabase, getSession trusts a cookie.
 */
export async function requireUser(): Promise<{ email: string | null }> {
  const mode = authMode();
  if (mode === "open") return { email: null };
  if (mode === "misconfigured") redirect("/login");

  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !isAllowedEmail(user.email)) redirect("/login");
  return { email: user.email ?? null };
}

/**
 * The signed-in user, for route handlers that need to know who acts.
 * `open` is true in a development build without Supabase config, where there
 * is no user at all.
 */
export async function currentUser(): Promise<{ open: boolean; email: string | null }> {
  const mode = authMode();
  if (mode === "open") return { open: true, email: null };
  if (mode === "misconfigured") return { open: false, email: null };
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { open: false, email: user && isAllowedEmail(user.email) ? (user.email ?? null) : null };
}

/**
 * Route-handler equivalent: returns a 401 response to return as-is, or null
 * when the caller may proceed.
 */
export async function rejectUnauthenticated(): Promise<Response | null> {
  const mode = authMode();
  if (mode === "open") return null;
  if (mode === "misconfigured") {
    return Response.json({ error: "Authentication is not configured" }, { status: 503 });
  }

  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !isAllowedEmail(user.email)) {
    return Response.json({ error: "Not signed in" }, { status: 401 });
  }
  return null;
}
