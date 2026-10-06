"use client";

import { useEffect, useRef, useState } from "react";

const BASE = "https://www.akka.app";

const COUNTRIES = [
  { value: "it", label: "Italy", prefix: "/it" },
  { value: "es", label: "Spain", prefix: "/es" },
  { value: "no", label: "Norway", prefix: "" },
  { value: "fi", label: "Finland", prefix: "" },
  { value: "se", label: "Sweden", prefix: "" },
  { value: "dk", label: "Denmark", prefix: "" },
  { value: "fr", label: "France", prefix: "/fr" },
  { value: "de", label: "Germany", prefix: "/de" },
  { value: "nl", label: "Netherlands", prefix: "" },
  { value: "other", label: "Others", prefix: "" },
];

const LANDINGS = [
  { value: "home", label: "Home", path: "" },
  { value: "vsl", label: "VSL", path: "/discover" },
  { value: "drop", label: "Drop (Pre-IPO)", path: "/invest-pre-ipo" },
  { value: "webinar", label: "Webinar", path: "/2day-challenge" },
  { value: "join", label: "Join Akka", path: "/join" },
  { value: "portfolio", label: "Portfolio", path: "/our-portfolio" },
];

const CHANNELS = [
  { value: "instagram", label: "Instagram" },
  { value: "tiktok", label: "TikTok" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "reddit", label: "Reddit" },
  { value: "x", label: "X" },
  { value: "youtube", label: "YouTube" },
  { value: "pr", label: "PR" },
  { value: "email", label: "Email" },
  { value: "referral", label: "Referral" },
  { value: "google", label: "Google" },
  { value: "meta", label: "Meta" },
  { value: "paid-pr", label: "Paid PR" },
  { value: "other", label: "Other" },
];

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

function copyText(text: string) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).catch(() => {});
  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
  return Promise.resolve();
}

/** Button label that flips to "Copied" for 1.5s after a click. */
function useCopied() {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const flash = () => {
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };
  return [copied, flash] as const;
}

type ShortState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "ok"; url: string; forLongUrl: string }
  | { kind: "error"; message: string; forLongUrl: string };

export function UtmBuilder({ shortDomain }: { shortDomain: string }) {
  const [country, setCountry] = useState("");
  const [landing, setLanding] = useState("home");
  const [where, setWhere] = useState("");
  const [whoRaw, setWhoRaw] = useState("");
  const [whatRaw, setWhatRaw] = useState("");
  const [slugRaw, setSlugRaw] = useState<string | null>(null); // null = follows "Who?"
  const [short, setShort] = useState<ShortState>({ kind: "idle" });
  const [copiedLong, flashLong] = useCopied();
  const [copiedShort, flashShort] = useCopied();

  const prefix = COUNTRIES.find((c) => c.value === country)?.prefix ?? "";
  const landingPath = LANDINGS.find((l) => l.value === landing)?.path ?? "";
  const path = prefix + landingPath || "/";
  const who = slugify(whoRaw);
  const what = slugify(whatRaw);
  const longUrl = `${BASE}${path}?utm_source=${where}&utm_medium=${who}&utm_campaign=${what}`;

  const slugInput = slugRaw ?? who;
  const slug = slugify(slugInput);

  const issues: string[] = [];
  if (!country) issues.push("Select a country");
  if (!where) issues.push('Select a channel under "Where?"');
  if (!whoRaw.trim()) issues.push('Enter a collaborator name under "Who?"');
  else if (!who) issues.push('"Who?" has no valid characters left after cleanup');
  if (!whatRaw.trim()) issues.push('Enter a placement under "What?"');
  else if (!what) issues.push('"What?" has no valid characters left after cleanup');
  const ready = issues.length === 0;

  // A short link only belongs to the long URL it was made from.
  const shortForThis =
    (short.kind === "ok" || short.kind === "error") && short.forLongUrl === `${longUrl}#${slug}` ? short : null;
  const busy = short.kind === "busy";

  async function createShortLink() {
    const forLongUrl = `${longUrl}#${slug}`;
    setShort({ kind: "busy" });
    try {
      const res = await fetch("/api/shorten", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ longUrl, path: slug }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; shortURL?: string };
      if (res.status === 401) throw new Error("Your session expired. Reload the page to sign in again.");
      if (!res.ok || !body.shortURL) throw new Error(body.error || "Could not create the short link.");
      setShort({ kind: "ok", url: body.shortURL, forLongUrl });
    } catch (err) {
      setShort({
        kind: "error",
        message: err instanceof Error ? err.message : "Could not create the short link.",
        forLongUrl,
      });
    }
  }

  return (
    <div className="builder">
      <div className="builder-form">
        <div className="card">
          <div className="fields">
            <div className="row-2">
              <Field id="country" label="Country">
                <select id="country" required value={country} onChange={(e) => setCountry(e.target.value)}>
                  <option value="" disabled>
                    Select a country…
                  </option>
                  {COUNTRIES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id="landing" label="Landing page">
                <select id="landing" value={landing} onChange={(e) => setLanding(e.target.value)}>
                  {LANDINGS.map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <Field id="where" label="Where? (Channel)">
              <select id="where" required value={where} onChange={(e) => setWhere(e.target.value)}>
                <option value="" disabled>
                  Select a channel…
                </option>
                {CHANNELS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              id="who"
              label="Who? (Collaborator's full name)"
              error={whoRaw.trim() && !who ? "Enter a name using letters and numbers only." : undefined}
            >
              <input
                type="text"
                id="who"
                placeholder="e.g. Nicolas Nati"
                autoComplete="off"
                value={whoRaw}
                onChange={(e) => setWhoRaw(e.target.value)}
              />
            </Field>

            <Field
              id="what"
              label="What? (Placement / campaign)"
              error={whatRaw.trim() && !what ? "Enter a placement using letters and numbers only." : undefined}
            >
              <input
                type="text"
                id="what"
                placeholder="e.g. Bio, DM, Evergreen"
                autoComplete="off"
                value={whatRaw}
                onChange={(e) => setWhatRaw(e.target.value)}
              />
            </Field>
          </div>
        </div>

        <div className="card">
          <Field id="slug" label="Want a shorter link to share? (optional)" hint="Leave it blank and we'll use the collaborator's name.">
            <div className="prefixed">
              <span className="prefixed-label">{shortDomain}/</span>
              <input
                type="text"
                id="slug"
                placeholder="javi"
                autoComplete="off"
                value={slugInput}
                onChange={(e) => setSlugRaw(e.target.value)}
              />
            </div>
          </Field>
        </div>
      </div>

      <aside className="card result" aria-live="polite">
        <div className={`chip ${ready ? "ok" : "warn"}`}>
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            {ready ? (
              <path d="M5 10.5l3.2 3.2L15 7" strokeLinecap="round" strokeLinejoin="round" />
            ) : (
              <>
                <path d="M10 6v5M10 14h.01" strokeLinecap="round" />
                <circle cx="10" cy="10" r="8.3" />
              </>
            )}
          </svg>
          {ready ? "Ready to use" : "Missing a few fields"}
        </div>
        {issues.length > 0 && (
          <ul className="issues">
            {issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        )}

        <div className="block">
          <p className="label">Link</p>
          <div className="url">
            {BASE + path}?<span className="qp">utm_source={where}</span>&amp;
            <span className="qp">utm_medium={who}</span>&amp;
            <span className="qp">utm_campaign={what}</span>
          </div>
        </div>

        <button
          type="button"
          className="btn primary"
          disabled={!ready}
          onClick={() => copyText(longUrl).then(flashLong)}
        >
          <CopyIcon />
          {copiedLong ? "Copied" : "Copy link"}
        </button>

        <div className="block divided">
          <p className="label">Short link ({shortDomain})</p>
          <div className="actions">
            <button type="button" className="btn secondary" disabled={!ready || !slug || busy} onClick={createShortLink}>
              {busy ? "Creating…" : "Create short link"}
            </button>
            <button
              type="button"
              className="btn secondary"
              disabled={shortForThis?.kind !== "ok"}
              onClick={() => shortForThis?.kind === "ok" && copyText(shortForThis.url).then(flashShort)}
            >
              <CopyIcon />
              {copiedShort ? "Copied" : "Copy short link"}
            </button>
          </div>
          {shortForThis?.kind === "ok" && <p className="note success">{shortForThis.url}</p>}
          {shortForThis?.kind === "error" && (
            <p className="note error" role="alert">
              {shortForThis.message}
            </p>
          )}
        </div>

        <dl className="breakdown divided">
          <div>
            <dt>source (Where?)</dt>
            <dd>{where || "—"}</dd>
          </div>
          <div>
            <dt>medium (Who?)</dt>
            <dd>{who || "—"}</dd>
          </div>
          <div>
            <dt>campaign (What?)</dt>
            <dd>{what || "—"}</dd>
          </div>
        </dl>
      </aside>
    </div>
  );
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`field${error ? " invalid" : ""}`}>
      <label htmlFor={id}>{label}</label>
      {children}
      {error ? <p className="field-error">{error}</p> : hint ? <p className="field-hint">{hint}</p> : null}
    </div>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="6.5" y="6.5" width="10" height="11" rx="1.6" />
      <path d="M4.5 13.5h-1a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1" strokeLinecap="round" />
    </svg>
  );
}
