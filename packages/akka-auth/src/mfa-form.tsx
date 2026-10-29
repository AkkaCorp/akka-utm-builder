"use client";

import { createBrowserClient } from "@supabase/ssr";
import { useEffect, useRef, useState, type FormEvent } from "react";

type Step =
  | { kind: "loading" }
  | { kind: "enroll"; factorId: string; qr: string; secret: string }
  | { kind: "challenge"; factorId: string }
  | { kind: "failed"; message: string };

/**
 * TOTP second factor for partner accounts, in the browser (supabase.auth.mfa.*):
 * first sign-in enrols an authenticator app (QR code + first code), every later
 * one answers a challenge. Verifying upgrades the session to aal2 and rewrites
 * the session cookies; the middleware then lets the user through.
 */
export function MfaForm({
  supabaseUrl,
  supabaseKey,
  next,
  buttonClassName,
  inputClassName,
}: {
  supabaseUrl: string;
  supabaseKey: string;
  next: string;
  /** The app's classes (shadcn); default: auth.css. */
  buttonClassName?: string;
  inputClassName?: string;
}) {
  const [step, setStep] = useState<Step>({ kind: "loading" });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    // StrictMode runs effects twice in development: enrol once only.
    if (started.current) return;
    started.current = true;
    (async () => {
      try {
        const supabase = createBrowserClient(supabaseUrl, supabaseKey);
        const { data, error } = await supabase.auth.mfa.listFactors();
        if (error) throw error;
        const verified = data.totp[0];
        if (verified) return setStep({ kind: "challenge", factorId: verified.id });

        // An enrolment left half-done (tab closed before the first code) is
        // dropped, so the QR code shown is always the one that will count.
        for (const f of data.all) {
          if (f.factor_type === "totp" && f.status === "unverified") {
            await supabase.auth.mfa.unenroll({ factorId: f.id });
          }
        }
        const enrolled = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: "Akka tools" });
        if (enrolled.error) throw enrolled.error;
        const qr = enrolled.data.totp.qr_code;
        setStep({
          kind: "enroll",
          factorId: enrolled.data.id,
          qr: qr.startsWith("data:") ? qr : `data:image/svg+xml;utf-8,${encodeURIComponent(qr)}`,
          secret: enrolled.data.totp.secret,
        });
      } catch (e) {
        setStep({ kind: "failed", message: e instanceof Error ? e.message : "Second factor unavailable" });
      }
    })();
  }, [supabaseUrl, supabaseKey]);

  async function verify(e: FormEvent) {
    e.preventDefault();
    if (step.kind !== "enroll" && step.kind !== "challenge") return;
    setBusy(true);
    setError(null);
    try {
      const supabase = createBrowserClient(supabaseUrl, supabaseKey);
      const { error } = await supabase.auth.mfa.challengeAndVerify({
        factorId: step.factorId,
        code: code.replace(/\s/g, ""),
      });
      if (error) throw error;
      // A full navigation, so the middleware reads the upgraded session.
      window.location.assign(next);
    } catch {
      setError("That code did not work. Check the time on your phone and try the current code.");
      setBusy(false);
    }
  }

  if (step.kind === "loading") return <p className="akka-auth-note">Loading…</p>;
  if (step.kind === "failed") {
    return (
      <p className="akka-auth-error" role="alert">
        {step.message}
      </p>
    );
  }

  return (
    <form onSubmit={verify} style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%" }}>
      {step.kind === "enroll" ? (
        <>
          <p className="akka-auth-note">
            Scan this code with an authenticator app (Google Authenticator, 1Password…), then enter the
            6-digit code it shows.
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element -- a data: URI, nothing to optimise */}
          <img className="akka-auth-qr" src={step.qr} alt="QR code for your authenticator app" />
          <details>
            <summary className="akka-auth-note">Can&apos;t scan it?</summary>
            <p className="akka-auth-secret">{step.secret}</p>
          </details>
        </>
      ) : (
        <p className="akka-auth-note">Enter the 6-digit code from your authenticator app.</p>
      )}
      <input
        className={inputClassName ?? "akka-auth-input"}
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9 ]{6,7}"
        maxLength={7}
        required
        autoFocus
        value={code}
        onChange={(e) => setCode(e.target.value)}
        aria-label="6-digit code"
      />
      <button
        type="submit"
        className={buttonClassName ?? "akka-auth-btn"}
        style={buttonClassName ? { width: "100%" } : undefined}
        disabled={busy}
      >
        {busy ? "Checking…" : "Verify"}
      </button>
      {error && (
        <p className="akka-auth-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
