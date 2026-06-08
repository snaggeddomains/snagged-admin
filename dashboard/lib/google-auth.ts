// Shared Google service-account auth — mints a signed JWT and exchanges it for an
// access token, no google-auth-library dependency (Node's crypto signs RS256).
// Used by both the GA4 Data API (lib/ga.ts) and the Sheets API (lib/sheets.ts).
//
// Env: GOOGLE_SA_KEY (service-account JSON, one line) OR GOOGLE_SA_KEY_B64
// (base64 of that JSON). Tokens are cached per-scope until ~1 min before expiry.

import crypto from "node:crypto";

type ServiceAccount = { client_email: string; private_key: string; token_uri?: string };

function serviceAccount(): ServiceAccount {
  const raw =
    process.env.GOOGLE_SA_KEY ||
    (process.env.GOOGLE_SA_KEY_B64 ? Buffer.from(process.env.GOOGLE_SA_KEY_B64, "base64").toString("utf8") : "");
  if (!raw) throw new Error("GOOGLE_SA_KEY (or GOOGLE_SA_KEY_B64) is not set");
  const sa = JSON.parse(raw) as ServiceAccount;
  if (!sa.client_email || !sa.private_key) throw new Error("service-account JSON missing client_email / private_key");
  return sa;
}

// True when the deployment has a service-account key configured.
export function googleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_SA_KEY || process.env.GOOGLE_SA_KEY_B64);
}

const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const cache: Record<string, { value: string; exp: number }> = {};

export async function googleAccessToken(scope: string): Promise<string> {
  const hit = cache[scope];
  if (hit && hit.exp > Date.now() + 60_000) return hit.value;
  const sa = serviceAccount();
  const tokenUri = sa.token_uri || "https://oauth2.googleapis.com/token";
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope, aud: tokenUri, iat: now, exp: now + 3600 }));
  const signingInput = `${header}.${claims}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const assertion = `${signingInput}.${b64url(signer.sign(sa.private_key))}`;

  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = (await res.json()) as { access_token: string; expires_in?: number };
  cache[scope] = { value: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return j.access_token;
}
