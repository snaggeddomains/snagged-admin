// Minimal transactional email sender (Resend HTTP API, no dependency). Used for
// the weekly pitch-scan digest. Best-effort + graceful: a no-op (returns false)
// when RESEND_API_KEY isn't configured, so callers never throw on a missing key.
//
// Env: RESEND_API_KEY (required to actually send) · EMAIL_FROM (optional, defaults
// to "Snagged <noreply@snagged.com>" — the from-domain must be verified in Resend).

export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

export async function sendEmail(opts: { to: string | string[]; subject: string; html: string; from?: string }): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return false; // not configured — caller logs/skips
  const from = opts.from || process.env.EMAIL_FROM || "Snagged <noreply@snagged.com>";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to: Array.isArray(opts.to) ? opts.to : [opts.to], subject: opts.subject, html: opts.html }),
    });
    if (!res.ok) {
      console.error(`[email] Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[email] send failed: ${String((e as Error)?.message || e)}`);
    return false;
  }
}
