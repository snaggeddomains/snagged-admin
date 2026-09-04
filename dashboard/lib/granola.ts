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

// Pull the notes array out of the {notes:[...]} envelope (shape-tolerant fallback to data/results/items).
function extractNotes(body: Obj | null): Obj[] {
  if (!body) return [];
  for (const k of ["notes", "data", "results", "items"]) {
    const v = (body as Obj)[k];
    if (Array.isArray(v)) return v as Obj[];
  }
  return [];
}
// Per the OpenAPI spec the list envelope is { notes, hasMore, cursor } (cursor = the value to pass on
// the NEXT request). Read camelCase first, tolerate snake_case aliases.
function pageMeta(body: Obj): { cursor: string; hasMore: boolean | undefined } {
  const cursor = String(body.cursor || body.next_cursor || body.nextCursor || "");
  const hm = body.hasMore ?? body.has_more;
  return { cursor, hasMore: typeof hm === "boolean" ? hm : undefined };
}

const GRANOLA_PAGE_SIZE = 30; // API maximum (page_size 1..30, default 10)
const NOTES_CAP = 1500; // soft ceiling so folder traversal can't run away

export type GranolaFolder = { id: string; name: string };

// List the workspace folders (GET /v1/folders), cursor-paginated. Meetings are organized into folders,
// and the default /notes only returns un-foldered/owner notes — so we enumerate folders and pull each
// folder's notes to see the full set.
export async function listFolders(maxPages = 6): Promise<GranolaFolder[]> {
  const out: GranolaFolder[] = [];
  let cursor = "";
  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams({ page_size: String(GRANOLA_PAGE_SIZE) });
    if (cursor) qs.set("cursor", cursor);
    const body = await gget(`/folders?${qs.toString()}`);
    if (!body) break;
    const arr = (Array.isArray(body.folders) ? body.folders : extractNotes(body)) as Obj[];
    if (!arr.length) break;
    for (const f of arr) {
      const id = pick(f, "id", "folder_id");
      if (id) out.push({ id, name: pick(f, "name", "title") });
    }
    const { cursor: next, hasMore } = pageMeta(body);
    if (hasMore === false || !next || next === cursor) break;
    cursor = next;
  }
  return out;
}

// Page /notes with a set of query params into a shared map (cursor pagination, page_size=30).
async function pageNotesInto(extra: Record<string, string>, maxPages: number, into: Map<string, GranolaNote>): Promise<void> {
  let cursor = "";
  for (let page = 0; page < maxPages && into.size < NOTES_CAP; page++) {
    const qs = new URLSearchParams({ page_size: String(GRANOLA_PAGE_SIZE), ...extra });
    if (cursor) qs.set("cursor", cursor);
    const body = await gget(`/notes?${qs.toString()}`);
    if (!body) break;
    const arr = extractNotes(body);
    if (!arr.length) break;
    for (const o of arr) {
      const n = normalizeNote(o);
      if (n.id) into.set(n.id, n);
    }
    const { cursor: next, hasMore } = pageMeta(body);
    if (hasMore === false || !next || next === cursor) break;
    cursor = next;
  }
}

// Recent meeting notes, newest first. The default /notes only returns un-foldered/owner notes (≈a
// handful), so we ALSO enumerate the workspace folders and union in each folder's notes — that's how
// the bulk of meetings are reachable. Cursor pagination at page_size=30 (the API max — NOT `limit`,
// which it ignores). `createdAfter` (epoch ms) narrows the window; `includeFolders:false` skips the
// folder sweep. Soft-capped at NOTES_CAP. (Granola only exposes notes with a generated summary, so a
// just-recorded meeting may be absent until Granola finishes processing it.)
export async function listNotes(opts: { limit?: number; createdAfter?: number; maxPages?: number; includeFolders?: boolean } = {}): Promise<GranolaNote[]> {
  const maxPages = Math.min(Math.max(opts.maxPages || 20, 1), 80);
  const byId = new Map<string, GranolaNote>();
  const base: Record<string, string> = {};
  if (opts.createdAfter) base.created_after = new Date(opts.createdAfter).toISOString();
  await pageNotesInto(base, maxPages, byId); // top-level (un-foldered) notes
  if (opts.includeFolders !== false) {
    const folders = await listFolders();
    await pool(folders, 3, async (f) => {
      if (byId.size >= NOTES_CAP) return;
      await pageNotesInto({ ...base, folder_id: f.id }, Math.min(maxPages, 8), byId);
    });
  }
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
}

// -------- content hydration (list → per-note detail) --------
// The note LIST endpoint returns only id/title/created (verified live: no attendees, no summary, and
// titles are participant-based like "Rob / Judy"). So searching by a person or topic that isn't in the
// title needs the per-note DETAIL (attendees + AI summary). hydrateNotes fetches the detail for the most
// recent `limit` notes — bounded, cached, fail-open — and merges attendees + summary onto each.
const detailCache = new Map<string, { at: number; note: GranolaNote }>();
const DETAIL_TTL = 10 * 60 * 1000; // 10 min — a best-effort warm-instance speed cache

async function pool<T, R>(items: T[], concurrency: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    }),
  );
  return out;
}

function mergeDetail(list: GranolaNote, detail: GranolaNote): GranolaNote {
  return {
    ...list,
    title: list.title && list.title !== "(untitled meeting)" ? list.title : detail.title || list.title,
    createdAt: list.createdAt || detail.createdAt,
    attendees: detail.attendees.length ? detail.attendees : list.attendees,
    summary: detail.summary || list.summary,
  };
}

export async function hydrateNotes(notes: GranolaNote[], limit = 60): Promise<GranolaNote[]> {
  const top = notes.slice(0, limit);
  const now = Date.now();
  const hydrated = await pool(top, 5, async (n) => {
    if (!n.id) return n;
    const cached = detailCache.get(n.id);
    if (cached && now - cached.at < DETAIL_TTL) return mergeDetail(n, cached.note);
    const detail = await getNote(n.id); // summary + attendees (no transcript)
    if (detail) {
      detailCache.set(n.id, { at: now, note: detail });
      return mergeDetail(n, detail);
    }
    return n; // fail-open: keep the list-level fields
  });
  return [...hydrated, ...notes.slice(limit)];
}

// Debug helper (admin-gated caller only): the RAW shape + how pagination actually behaves on a live
// run, so we can see WHY the list is short (page size honored? cursor present? does paging advance?).
// Fetches page 1 at limit=100 and follows up to 5 pages, reporting per-page counts + the cursor/hasMore
// it saw — NO bodies/transcripts.
export async function rawNotesShape(): Promise<Obj | null> {
  const p1 = await gget(`/notes?page_size=${GRANOLA_PAGE_SIZE}`);
  if (!p1) return null;
  const arr1 = extractNotes(p1);
  const first = (arr1[0] || {}) as Obj;
  const nonNote: Obj = {};
  for (const [k, v] of Object.entries(p1)) {
    if (k === "notes" || k === "data" || k === "results" || k === "items") continue;
    nonNote[k] = Array.isArray(v) ? `array[${v.length}]` : v && typeof v === "object" ? JSON.stringify(v).slice(0, 200) : (v as unknown as string);
  }
  const pages: Obj[] = [];
  let { cursor, hasMore } = pageMeta(p1);
  pages.push({ page: 1, count: arr1.length, cursor_seen: cursor.slice(0, 48), hasMore });
  for (let i = 0; i < 5 && cursor && hasMore !== false; i++) {
    const qs = new URLSearchParams({ page_size: String(GRANOLA_PAGE_SIZE), cursor });
    const pn = await gget(`/notes?${qs.toString()}`);
    const arrn = extractNotes(pn);
    const m = pageMeta(pn || {});
    pages.push({ page: i + 2, count: arrn.length, cursor_seen: m.cursor.slice(0, 48), hasMore: m.hasMore });
    if (!arrn.length || !m.cursor || m.cursor === cursor) break;
    cursor = m.cursor;
    hasMore = m.hasMore;
  }
  // Folders: raw /folders envelope (in case listFolders parses 0 due to a shape surprise) + a direct
  // test that GET /notes?folder_id=<id> returns notes for this key. Kept light so it never times out.
  const rawFolders = await gget(`/folders?page_size=${GRANOLA_PAGE_SIZE}`);
  const folders = await listFolders();
  const folderProbe: Obj[] = [];
  for (const f of folders.slice(0, 4)) {
    const fb = await gget(`/notes?page_size=${GRANOLA_PAGE_SIZE}&folder_id=${encodeURIComponent(f.id)}`);
    const fa = extractNotes(fb);
    folderProbe.push({ folder: f.name || f.id, note_count: fa.length, hasMore: pageMeta(fb || {}).hasMore, sample_title: (fa[0] as Obj)?.title ?? null });
  }
  return {
    envelope_keys: Object.keys(p1),
    non_note_keys: nonNote,
    page1_count: arr1.length,
    first_note_keys: Object.keys(first),
    pages,
    folders_envelope_keys: rawFolders ? Object.keys(rawFolders) : "NULL (no /folders response — 404/403/unsupported?)",
    folders_raw_first: rawFolders ? (extractNotes(rawFolders)[0] ?? (Array.isArray(rawFolders.folders) ? rawFolders.folders[0] : null)) ?? "empty" : null,
    folder_count: folders.length,
    folder_names: folders.slice(0, 15).map((f) => f.name || f.id),
    folder_note_probe: folderProbe,
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
