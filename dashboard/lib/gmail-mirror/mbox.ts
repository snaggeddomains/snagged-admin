// Self-contained MBOX + MIME parser for the Gmail mirror. Google Takeout exports each mailbox as
// an mboxrd file: messages separated by a line starting `From ` at column 0, with `>From `-escaped
// body lines. Takeout adds X-GM-THRID (thread id) and X-Gmail-Labels headers, which we use directly.
// We extract headers + the text/plain body only (no attachments), decoding quoted-printable / base64
// and walking multipart to the first text/plain part (falling back to html-stripped text/html).
// Pure functions — no network, no deps — so they're unit-testable in the sandbox.

export type MirrorMessage = {
  id: string;          // Gmail message id if known, else Message-ID, else a content hash
  threadId: string;    // X-GM-THRID if present, else Message-ID
  mid: string;         // RFC Message-ID
  from: string;        // bare lowercased address
  fromName: string;
  to: string;
  cc: string;
  subject: string;
  date: number;        // epoch ms
  snippet: string;
  body: string;        // text/plain, capped
  labels: string[];
  bulk: boolean;
  sizeEstimate: number;
};

const BODY_CAP = 200_000; // per-message body cap (chars) — plenty for any real email, bounds storage

function unfold(headerBlock: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Join continuation lines (leading whitespace) onto the previous header.
  const lines = headerBlock.split(/\r?\n/);
  const joined: string[] = [];
  for (const ln of lines) {
    if (/^[ \t]/.test(ln) && joined.length) joined[joined.length - 1] += " " + ln.trim();
    else joined.push(ln);
  }
  for (const ln of joined) {
    const i = ln.indexOf(":");
    if (i <= 0) continue;
    const k = ln.slice(0, i).trim().toLowerCase();
    const v = ln.slice(i + 1).trim();
    if (out[k] === undefined) out[k] = v; // first wins (except we special-case labels below)
    else if (k === "received") continue;
  }
  return out;
}

function decodeB64(s: string): string {
  try { return Buffer.from(s.replace(/[^A-Za-z0-9+/=]/g, ""), "base64").toString("utf8"); } catch { return s; }
}
function decodeQP(s: string): string {
  return s
    .replace(/=\r?\n/g, "")                                   // soft line breaks
    .replace(/=([A-Fa-f0-9]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
// RFC 2047 encoded-word decode for header values (=?utf-8?B?..?= / =?utf-8?Q?..?=).
function decodeHeaderWords(s: string): string {
  return s.replace(/=\?[^?]+\?([BbQq])\?([^?]*)\?=/g, (_, enc, data) => {
    try { return String(enc).toUpperCase() === "B" ? decodeB64(data) : decodeQP(data.replace(/_/g, " ")); }
    catch { return data; }
  });
}

const ENT: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;|&lt;|&gt;|&quot;|&#39;|&nbsp;/g, (m) => ENT[m] || m)
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCharCode(Number(n)); } catch { return " "; } })
    .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function decodeBody(raw: string, cte: string): string {
  const enc = (cte || "").toLowerCase();
  if (enc.includes("base64")) return decodeB64(raw);
  if (enc.includes("quoted-printable")) return decodeQP(raw);
  return raw;
}

const bareAddr = (s: string): string => (s.match(/[\w.\-+]+@[\w.\-]+/)?.[0] || "").toLowerCase();

// Extract the best text body from a (possibly multipart) MIME message body given its top headers.
function extractText(headers: Record<string, string>, body: string): string {
  const ct = headers["content-type"] || "text/plain";
  const boundaryMatch = ct.match(/boundary="?([^";]+)"?/i);
  if (/multipart\//i.test(ct) && boundaryMatch) {
    const boundary = boundaryMatch[1];
    const parts = body.split(new RegExp("--" + boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?:--)?\\r?\\n"));
    let htmlFallback = "";
    for (const part of parts) {
      const sep = part.indexOf("\n\n") >= 0 ? part.indexOf("\n\n") : part.indexOf("\r\n\r\n");
      if (sep < 0) continue;
      const ph = unfold(part.slice(0, sep));
      const pb = part.slice(sep).replace(/^\r?\n\r?\n/, "");
      const pct = (ph["content-type"] || "").toLowerCase();
      const cte = ph["content-transfer-encoding"] || "";
      if (pct.includes("multipart/")) { const nested = extractText(ph, pb); if (nested) return nested; continue; }
      if (pct.includes("text/plain")) return decodeBody(pb, cte).slice(0, BODY_CAP);
      if (pct.includes("text/html") && !htmlFallback) htmlFallback = stripHtml(decodeBody(pb, cte)).slice(0, BODY_CAP);
    }
    if (htmlFallback) return htmlFallback;
    return "";
  }
  const cte = headers["content-transfer-encoding"] || "";
  const decoded = decodeBody(body, cte);
  if (/text\/html/i.test(ct)) return stripHtml(decoded).slice(0, BODY_CAP);
  return decoded.slice(0, BODY_CAP);
}

// Parse ONE raw RFC822 message (already un-mbox-escaped) into a MirrorMessage.
export function parseRawMessage(raw: string): MirrorMessage {
  const sepIdx = (() => { const a = raw.indexOf("\r\n\r\n"); const b = raw.indexOf("\n\n"); if (a < 0) return b; if (b < 0) return a; return Math.min(a, b); })();
  const headerBlock = sepIdx >= 0 ? raw.slice(0, sepIdx) : raw;
  const bodyRaw = sepIdx >= 0 ? raw.slice(sepIdx).replace(/^\r?\n\r?\n/, "") : "";
  const h = unfold(headerBlock);

  const fromH = decodeHeaderWords(h["from"] || "");
  const subject = decodeHeaderWords(h["subject"] || "");
  const mid = (h["message-id"] || "").replace(/^<|>$/g, "").trim();
  const threadId = (h["x-gm-thrid"] || mid || "").trim();
  const dateMs = h["date"] ? Date.parse(h["date"]) : NaN;
  const labels = (h["x-gmail-labels"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  const body = extractText(h, bodyRaw);
  const id = mid || "sha:" + simpleHash(raw);

  return {
    id,
    threadId: threadId || id,
    mid,
    from: bareAddr(fromH),
    fromName: fromH.replace(/\s*<.*/, "").trim().replace(/^"|"$/g, ""),
    to: decodeHeaderWords(h["to"] || ""),
    cc: decodeHeaderWords(h["cc"] || ""),
    subject,
    date: Number.isFinite(dateMs) ? dateMs : 0,
    snippet: body.replace(/\s+/g, " ").trim().slice(0, 200),
    body,
    labels,
    bulk: Boolean(h["list-unsubscribe"] || h["list-id"] || /\bbulk\b/i.test(h["precedence"] || "")),
    sizeEstimate: Buffer.byteLength(raw, "utf8"),
  };
}

function simpleHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

// Un-escape mboxrd body lines: `>From ` → `From `, `>>From ` → `>From `, etc.
function unescapeMboxrd(block: string): string {
  return block.replace(/^(>+)From /gm, (_m, gt) => ">".repeat(gt.length - 1) + "From ");
}

// Split a full MBOX text buffer into raw message strings (each un-escaped). For very large files use
// the streaming ingester (ingest.ts) instead — this whole-buffer form is for tests / small inputs.
export function splitMbox(text: string): string[] {
  const out: string[] = [];
  // A message starts at a line beginning with "From " at column 0 (the mbox separator).
  const parts = text.split(/\r?\n(?=From )/);
  for (const p of parts) {
    // Drop the separator line itself (first line "From <sender> <date>").
    const nl = p.indexOf("\n");
    const body = p.startsWith("From ") && nl >= 0 ? p.slice(nl + 1) : p;
    if (body.trim()) out.push(unescapeMboxrd(body));
  }
  return out;
}
