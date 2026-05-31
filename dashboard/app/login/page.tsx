"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

type Mode = "signin" | "reset";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/";

  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "login", email, password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Login failed");
        return;
      }
      router.replace(next);
      router.refresh();
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  }

  async function requestReset(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "reset-request", email }),
      });
      // Always confirm (don't leak which emails exist).
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.error) {
          setError(data.error);
          return;
        }
      }
      setNotice("If that email has an account, a reset link is on its way.");
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: "linear-gradient(180deg, var(--sky-soft) 0%, var(--sky) 100%)",
      }}
    >
      <div className="card" style={{ width: "100%", maxWidth: 420, textAlign: "center" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/brand/mascot-hero.png"
          alt=""
          style={{ width: 168, height: "auto", margin: "0 auto 4px", display: "block" }}
        />
        <div
          className="wordmark"
          style={{ justifyContent: "center", fontSize: "1.7rem", marginBottom: 4 }}
        >
          <span className="wm-a">Snagged</span> <span className="wm-b">Admin</span>
        </div>
        <p className="muted" style={{ marginTop: 0, marginBottom: 22 }}>
          {mode === "signin" ? "Sign in to continue." : "Reset your password."}
        </p>

        {mode === "signin" ? (
          <form
            onSubmit={signIn}
            style={{ display: "flex", flexDirection: "column", gap: 12, textAlign: "left" }}
          >
            <input
              className="field"
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
            />
            <input
              className="field"
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
            <button
              className="btn btn--primary btn--lg"
              type="submit"
              disabled={busy}
              style={{ width: "100%", justifyContent: "center", boxShadow: "0 2px 6px rgba(37, 66, 84, 0.15)" }}
            >
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
        ) : (
          <form
            onSubmit={requestReset}
            style={{ display: "flex", flexDirection: "column", gap: 12, textAlign: "left" }}
          >
            <input
              className="field"
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
            />
            <button
              className="btn btn--primary btn--lg"
              type="submit"
              disabled={busy}
              style={{ width: "100%", justifyContent: "center", boxShadow: "0 2px 6px rgba(37, 66, 84, 0.15)" }}
            >
              {busy ? "Sending…" : "Send reset link"}
            </button>
          </form>
        )}

        {error && (
          <p style={{ color: "var(--coral-deep)", margin: "14px 0 0", fontWeight: 600 }}>
            {error}
          </p>
        )}
        {notice && (
          <p style={{ color: "var(--teal-deep)", margin: "14px 0 0" }}>{notice}</p>
        )}

        <button
          type="button"
          onClick={() => {
            setMode(mode === "signin" ? "reset" : "signin");
            setError(null);
            setNotice(null);
          }}
          style={{
            display: "inline-block",
            marginTop: 18,
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--teal-deep)",
            fontFamily: "var(--body)",
            fontWeight: 700,
            fontSize: "0.95rem",
          }}
        >
          {mode === "signin" ? "Forgot password?" : "← Back to sign in"}
        </button>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
