// Verifies the `dr_auth` session cookie issued by research.snagged.com.
//
// The cookie is the SHARED session for the whole app.snagged.com umbrella:
// research signs it, the umbrella verifies it, both using the same AUTH_SECRET.
//
// Format (authoritative — research lib/auth.js `sign()`):
//   dr_auth = base64url(JSON payload) "." base64url(HMAC-SHA256(payloadSegment, AUTH_SECRET))
//   payload = { u: <user_id|"">, exp: <unix-seconds> }
//
// ⚠️  CONFIRM BEFORE DEPLOY: the HMAC here is computed over the base64url
//     *payload segment string* (the part left of the dot). If research's
//     `sign()` hashes something else (raw JSON, a different separator), this
//     will reject every real cookie. Port/verify against the research source
//     or test with a live cookie before relying on it.
//
// Edge-safe: uses Web Crypto + atob/btoa only (no Node Buffer / node:crypto),
// so it runs inside middleware.

export const COOKIE = "dr_auth";

export interface SessionPayload {
  u: string;
  exp: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function b64urlToBytes(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? 4 - (s.length % 4) : 0;
  s += "=".repeat(pad);
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return new Uint8Array(sig);
}

/** Length-checked constant-time-ish string compare. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a `dr_auth` token. Returns the payload if the signature is valid and
 * the token has not expired, otherwise null.
 */
export async function verifyCookie(
  token: string | undefined | null,
  secret: string,
): Promise<SessionPayload | null> {
  if (!token || !secret) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadSeg, sigSeg] = parts;
  if (!payloadSeg || !sigSeg) return null;

  const expectedSig = bytesToB64url(await hmacSha256(secret, payloadSeg));
  if (!safeEqual(expectedSig, sigSeg)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(decoder.decode(b64urlToBytes(payloadSeg)));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== "number") return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return { u: String(payload.u ?? ""), exp: payload.exp };
}

/** The signing secret, matching research's `AUTH_SECRET || APP_PASSWORD` fallback. */
export function authSecret(): string {
  return process.env.AUTH_SECRET || process.env.APP_PASSWORD || "";
}
