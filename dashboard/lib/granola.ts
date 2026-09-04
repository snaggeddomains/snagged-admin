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
function ts(o: Obj, ...keys: string[]): number {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && v > 0) return v < 1e12 ? v * 1000 : v; // sec → ms
    if (typeof v === "string" && v) {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return t;
    }
  }
  return 0;
}
function attendees(o: Obj): GranolaAttendee[] {
  const raw =
    (Array.isArray(o.attendees) && o.attendees) ||
    (Array.isArray(o.participants) && o.participants) ||
    (Array.isArray(o.people) && o.people) ||
    [];
  return (raw as unknown[])
    .map((p): GranolaAttendee => {
      if (typeof p === "string") return p.includes("@") ? { name: "", email: p.toLowerCase() } : { name: p, email: "" };
      const a = (p || {}) as Obj;
      return { name: pick(a, "name", "display_name", "full_name"), email: pick(a, "email", "email_address").toLowerCase() };
    })
    .filter((a) => a.name || a.email);
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
    id: pick(o, "id", "note_id", "document_id"),
    title: pick(o, "title", "name", "subject") || "(untitled meeting)",
    createdAt: ts(o, "created_at", "createdAt", "started_at", "start_time", "date", "created"),
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
    // next cursor lives under a few possible keys; stop when there isn't one or the page was empty.
    const meta = (body.meta as Obj) || {};
    cursor = String(body.cursor || body.next_cursor || meta.cursor || meta.next_cursor || "");
    if (!cursor || !arr.length) break;
  }
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
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
