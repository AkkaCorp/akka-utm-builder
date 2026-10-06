import { rejectUnauthenticated } from "@akka/auth/server";

export const dynamic = "force-dynamic";

// Keeps the Short.io secret key server-side: it must never be shipped to the
// browser (the builder only ever calls this endpoint, never api.short.io directly).
export async function POST(request: Request) {
  const denied = await rejectUnauthenticated();
  if (denied) return denied;

  const apiKey = process.env.SHORTIO_API_KEY;
  const domain = process.env.SHORTIO_DOMAIN || "go.akka.app";

  if (!apiKey) {
    return Response.json(
      { error: "Short.io is not connected yet (missing SHORTIO_API_KEY in Vercel)." },
      { status: 500 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as { longUrl?: unknown; path?: unknown };
  const longUrl = body.longUrl;
  const path = typeof body.path === "string" && body.path ? body.path : undefined;

  if (typeof longUrl !== "string" || !longUrl) {
    return Response.json({ error: "Missing longUrl" }, { status: 400 });
  }

  try {
    const shortioRes = await fetch("https://api.short.io/links", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: apiKey,
      },
      body: JSON.stringify({ domain, originalURL: longUrl, path }),
    });

    const data = (await shortioRes.json().catch(() => ({}))) as { error?: string; shortURL?: string };

    if (!shortioRes.ok) {
      const message =
        data.error === "This path is already taken"
          ? "That short link is already in use, try a different name."
          : data.error || "Short.io rejected the request.";
      return Response.json({ error: message }, { status: shortioRes.status });
    }

    return Response.json({ shortURL: data.shortURL });
  } catch {
    return Response.json({ error: "Could not reach Short.io." }, { status: 502 });
  }
}
