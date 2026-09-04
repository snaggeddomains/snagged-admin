// Granola public-API client (https://public-api.granola.ai/v1) — dependency-free, fail-open.
// Powers the Email → Follow-up tool: list recent meeting notes, match one to a Gmail thread by
// attendee email, and pull its AI summary/transcript into a follow-up draft.
//
// Auth: a single bearer key `GRANOLA_API_KEY` (a `grn_…` personal key, or a workspace key on a
// Business/Enterprise plan that sees team notes). One shared key = v1 (per-user keys are a later add).
// NB the key must live in the snagged-admin (app.snagged.com) Vercel project — this route runs there,
// not in the research project — and Vercel only picks up env changes on the NEXT deploy.
//
// ⚠️ VERIFY FIELD SHAPES ON THE FIRST LIVE RUN. The public API's exact JSON field names aren't fully
// documented and the key is Vercel-only (can't be probed from the sandbox). The list envelope is
// known to be `{ notes: [...] }`; every per-note field below is read DEFENSIVELY across the likely
// aliases, so a naming surprise degrades to a blank field rather than an exception. Adjust the alias
// lists here once a real response is seen.

const BASE = "https://public-api.granola.ai/v1";

export type GranolaAttendee = { name: string; email: string };
export type GranolaNote = {
  id: string;
  title: string;
  createdAt: number; // epoch ms (0 if unknown)
  attendees: GranolaAttendee[];
  summary: string; // markdown/plain AI summary ("" if not requested/available)
  transcript: string; // "" unless requested
};

export function granolaConfigured(): boolean {
  return !!process.env.GRANOLA_API_KEY;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.GRANOLA_API_KEY || ""}`,
    Accept: "application/json",
  };
}

// -------- defensive field readers (tolerant of the exact public-API naming) --------
type Obj = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
function pick(o: Obj, ...keys: string[]): string {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}
function parseTs(v: unknown): number {
  if (typeof v === "number" && v > 0) return v < 1e12 ? v * 1000 : v; // sec → ms
  if (typeof v === "string" && v.trim()) {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}
function ts(o: Obj, ...keys: string[]): number {
  for (const k of keys) {
    const t = parseTs(o[k]);
    if (t) return t;
  }
  return 0;
}
// Shape-agnostic timestamp: try the known keys, else DEEP-SCAN the object (+ one level of nesting)
// for any created/start-like key that parses as a date. Prefers a "created/started" key over
// "updated/modified/ended" so a re-sort is by when the meeting HAPPENED. The public-API field name
// isn't guaranteed, so this keeps the newest-first sort working regardless of exact naming.
function deepCreatedAt(o: Obj): number {
  const known = ts(o, "created_at", "createdAt", "started_at", "start_time", "start", "date", "created", "timestamp", "meeting_date");
  if (known) return known;
  // Deep-scan (self + one level of nested objects) for a date-ish key. A "created/started" key
  // beats a generic "date/time" key; "updated/modified/ended" keys are ignored.
  const PREFER = /creat|start|begin|held|record/i;
  const OK = /(_at$|at$|date|time|when|on$)/i;
  const AVOID = /updat|modif|edit|end|finish|delete|last/i;
  let preferred = 0;
  let fallback = 0;
  const scan = (obj: Obj, depth: number) => {
    for (const [k, v] of Object.entries(obj)) {
      if ((typeof v === "string" || typeof v === "number") && !AVOID.test(k)) {
        const t = parseTs(v);
        if (t) {
          if (PREFER.test(k) && t > preferred) preferred = t;
          else if (OK.test(k) && t > fallback) fallback = t;
        }
      } else if (v && typeof v === "object" && !Array.isArray(v) && depth < 1) {
        scan(v as Obj, depth + 1);
      }
    }
  };
  scan(o, 0);
  return preferred || fallback;
}
function toAttendee(p: unknown): GranolaAttendee | null {
  if (typeof p === "string") {
    const s = p.trim();
    if (!s) return null;
    return s.includes("@") ? { name: "", email: s.toLowerCase() } : { name: s, email: "" };
  }
  const a = (p || {}) as Obj;
  // email may be nested (e.g. { email: { address } } or { emailAddress })
  let email = pick(a, "email", "email_address", "emailAddress", "address").toLowerCase();
  if (!email && a.email && typeof a.email === "object") email = pick(a.email as Obj, "address", "value").toLowerCase();
  const name = pick(a, "name", "display_name", "displayName", "full_name", "fullName");
  return name || email ? { name, email } : null;
}
function attendees(o: Obj): GranolaAttendee[] {
  let raw: unknown[] =
    (Array.isArray(o.attendees) && o.attendees) ||
    (Array.isArray(o.participants) && o.participants) ||
    (Array.isArray(o.people) && o.people) ||
    (Array.isArray(o.guests) && o.guests) ||
    [];
  // Shape-agnostic fallback: no known key hit → find the first array of person-ish objects/strings
  // anywhere on the note (self + one nesting level), so attendee search keeps working if the field
  // is named differently (e.g. "invitees", or nested under "meeting"/"event"/"calendar").
  if (!raw.length) {
    const looksPeople = (arr: unknown[]) =>
      arr.length > 0 && arr.every((x) => typeof x === "string" ? true : !!(x && typeof x === "object" && ((x as Obj).email || (x as Obj).name || (x as Obj).display_name)));
    const find = (obj: Obj, depth: number): unknown[] | null => {
      for (const [k, v] of Object.entries(obj)) {
        if (Array.isArray(v) && looksPeople(v) && /attend|particip|people|guest|invit|member/i.test(k)) return v;
      }
      if (depth < 1) for (const v of Object.values(obj)) if (v && typeof v === "object" && !Array.isArray(v)) { const f = find(v as Obj, depth + 1); if (f) return f; }
      return null;
    };
    raw = find(o, 0) || [];
  }
  return raw.map(toAttendee).filter((a): a is GranolaAttendee => !!a);
}
function summaryOf(o: Obj): string {
  // Nested { summary: { markdown|text } } OR flat summary_markdown/summary_text/overview.
  const s = o.summary;
  if (s && typeof s === "object") {
    const so = s as Obj;
    return pick(so, "markdown", "text", "content") || "";
  }
  return pick(o, "summary_markdown", "summary_text", "summary", "overview", "notes_markdown");
}
function transcriptOf(o: Obj): string {
  const t = o.transcript;
  if (typeof t === "string") return t;
  if (Array.isArray(t)) {
    return (t as unknown[])
      .map((seg) => {
        const s = (seg || {}) as Obj;
        const who = pick(s, "speaker", "speaker_name", "source");
        const text = pick(s, "text", "content");
        return text ? (who ? `${who}: ${text}` : text) : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (t && typeof t === "object") return str((t as Obj).text);
  return "";
}
function normalizeNote(o: Obj): GranolaNote {
  return {
    id: pick(o, "id", "note_id", "document_id", "documentId", "uuid"),
    title: pick(o, "title", "name", "subject", "document_title", "documentTitle", "heading") || "(untitled meeting)",
    createdAt: deepCreatedAt(o),
    attendees: attendees(o),
    summary: summaryOf(o),
    transcript: transcriptOf(o),
  };
}

async function gget(path: string): Promise<Obj | null> {
  if (!granolaConfigured()) return null;
  try {
    const res = await fetch(`${BASE}${path}`, { headers: authHeaders() });
    if (!res.ok) return null; // 401/403/404/429 → fail-open
    return (await res.json()) as Obj;
  } catch {
    return null;
  }
}

// Recent meeting notes, newest first. Follows the cursor across several pages and unions them, so a
// recent meeting isn't missed just because the first page's default order/size didn't include it.
// (Granola only returns notes that HAVE a generated AI summary + transcript, so a meeting recorded
// in the last little while may still be absent until Granola finishes processing it — nothing we can
// fetch changes that.) `createdAfter` (epoch ms) filters server-side when supported.
export async function listNotes(opts: { limit?: number; createdAfter?: number; maxPages?: number } = {}): Promise<GranolaNote[]> {
  const perPage = Math.min(Math.max(opts.limit || 100, 1), 100);
  const maxPages = Math.min(Math.max(opts.maxPages || 6, 1), 20);
  const byId = new Map<string, GranolaNote>();
  let cursor = "";
  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams({ limit: String(perPage) });
    if (opts.createdAfter) qs.set("created_after", new Date(opts.createdAfter).toISOString());
    if (cursor) qs.set("cursor", cursor);
    const body = await gget(`/notes?${qs.toString()}`);
    if (!body) break;
    const arr: Obj[] = (Array.isArray(body.notes)
      ? body.notes
      : Array.isArray((body as Obj).data)
        ? ((body as Obj).data as unknown[])
        : []) as Obj[];
    for (const o of arr) {
      const n = normalizeNote(o);
      if (n.id) byId.set(n.id, n);
    }
    // next cursor lives under a few possible keys; stop when the API says there's no more, when there's
    // no cursor, or the page was empty.
    const meta = (body.meta as Obj) || {};
    const hasMore = body.has_more ?? body.hasMore ?? meta.has_more ?? meta.hasMore;
    cursor = String(body.cursor || body.next_cursor || meta.cursor || meta.next_cursor || "");
    if (hasMore === false || !cursor || !arr.length) break;
  }
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
}

// Debug helper (admin-gated caller only): the RAW first-page shape, so we can verify the real
// public-API field names on a live run without guessing. Returns the envelope keys, the first note's
// keys, and small samples of the fields we read (id/title/created/attendees) — NO bodies/transcripts.
export async function rawNotesShape(): Promise<Obj | null> {
  const body = await gget(`/notes?limit=3`);
  if (!body) return null;
  const arr = (Array.isArray(body.notes) ? body.notes : Array.isArray((body as Obj).data) ? (body as Obj).data : []) as Obj[];
  const first = (arr[0] || {}) as Obj;
  const att = (first.attendees || first.participants || first.people) as unknown;
  const attSample = Array.isArray(att) ? att.slice(0, 2) : att;
  return {
    envelope_keys: Object.keys(body),
    note_count: arr.length,
    first_note_keys: Object.keys(first),
    sample: {
      id: first.id ?? first.note_id ?? first.document_id ?? null,
      title: first.title ?? first.name ?? null,
      created_raw: first.created_at ?? first.createdAt ?? first.started_at ?? first.created ?? null,
      normalized_createdAt: normalizeNote(first).createdAt,
      attendees: attSample,
    },
  };
}

// One note WITH its AI summary (and optionally the transcript) for the drafting context.
export async function getNote(id: string, opts: { transcript?: boolean } = {}): Promise<GranolaNote | null> {
  if (!id) return null;
  const include = ["summary"].concat(opts.transcript ? ["transcript"] : []).join(",");
  let body = await gget(`/notes/${encodeURIComponent(id)}?include=${include}`);
  if (!body) return null;
  // Some APIs wrap the object as { note: {...} } / { data: {...} }.
  const inner = (body.note as Obj) || (body.data as Obj) || body;
  let note = normalizeNote(inner);
  // If the transcript was asked for but came back empty, try the dedicated endpoint.
  if (opts.transcript && !note.transcript) {
    const tb = await gget(`/notes/${encodeURIComponent(id)}/transcript`);
    if (tb) note = { ...note, transcript: transcriptOf((tb.transcript ? tb : (tb.data as Obj)) || tb) };
  }
  return note;
}
