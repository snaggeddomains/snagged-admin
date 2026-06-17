// Read-only HubSpot client (server-only). Authoritatively classifies our OUTBOUND
// pitches by reading the logged CRM email engagements via a private-app token
// (HUBSPOT_TOKEN, scopes sales-email-read + automation.sequences.read + content):
//   • an outbound send that carries an hs_sequence_id  → a SEQUENCE send (mass)
//   • an outbound logged 1:1 email (no sequence)       → individual
//   • an INCOMING_EMAIL                                → inbound (a buyer reply)
// The join key to Gmail is the RFC Message-ID: HubSpot stores it as
// `hs_email_message_id`, which equals our GmailMessage.mid. This replaces the
// fragile header-heuristic (lib/gmail.ts `looksBulk`) with the real signal.
// NEVER writes — read endpoints only.

const API = "https://api.hubapi.com";

export function hubspotConfigured(): boolean {
  return Boolean(process.env.HUBSPOT_TOKEN);
}

export type PitchKind = "mass" | "individual";
export type HubspotEmail = {
  direction: "outbound" | "inbound";
  sequenceId: string | null;
  sequenceName: string | null;
  // outbound → mass (sequence) | individual (1:1); inbound → null.
  kind: PitchKind | null;
};

// Normalize an RFC Message-ID to a stable join key: strip surrounding <>, trim,
// lowercase. Applied identically to both sides (HubSpot's hs_email_message_id and
// Gmail's mid) so a case/bracket difference can't break the match.
export function normMid(mid: string): string {
  return (mid || "").trim().replace(/^<|>$/g, "").trim().toLowerCase();
}

async function hget(path: string): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${process.env.HUBSPOT_TOKEN}` },
  });
  if (!res.ok) throw new Error(`hubspot GET ${path.split("?")[0]}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
async function hpost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`hubspot POST ${path.split("?")[0]}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// The private-app's associated user id — required by the sequences endpoint.
// Self-discovered from the token (override via HUBSPOT_USER_ID), cached.
let _userId: string | null = null;
async function getUserId(): Promise<string | null> {
  if (process.env.HUBSPOT_USER_ID) return process.env.HUBSPOT_USER_ID;
  if (_userId) return _userId;
  try {
    const info = (await hpost("/oauth/v2/private-apps/get/access-token-info", { tokenKey: process.env.HUBSPOT_TOKEN })) as { userId?: number | string };
    _userId = info?.userId != null ? String(info.userId) : null;
  } catch { _userId = null; }
  return _userId;
}

// Sequence id → name (e.g. "Domain Owner Initial Outreach Sequence"). Cached for
// the lambda's lifetime; best-effort (empty map on any failure).
let _seqCache: { map: Map<string, string>; at: number } | null = null;
const SEQ_TTL = 30 * 60 * 1000;
async function getSequenceNames(): Promise<Map<string, string>> {
  if (_seqCache && Date.now() - _seqCache.at < SEQ_TTL) return _seqCache.map;
  const map = new Map<string, string>();
  try {
    const uid = await getUserId();
    if (uid) {
      let after: string | undefined;
      do {
        const qs = new URLSearchParams({ userId: uid, limit: "100" });
        if (after) qs.set("after", after);
        const r = (await hget(`/automation/v4/sequences?${qs.toString()}`)) as {
          results?: { id: string; name: string }[]; paging?: { next?: { after?: string } };
        };
        for (const s of r.results || []) if (s?.id) map.set(String(s.id), s.name || "");
        after = r.paging?.next?.after;
      } while (after);
    }
  } catch { /* names are a nicety — classification still works without them */ }
  _seqCache = { map, at: Date.now() };
  return map;
}

// One external recipient's outbound engagement for a domain, aggregated across
// all of our sends naming that domain in the HubSpot CRM email log.
export type RecipientEngagement = {
  email: string;
  name: string | null;
  kind: PitchKind; // mass if ANY send was a sequence, else individual (1:1)
  sequenceName: string | null;
  sends: number;
  opened: number; // # of sends opened (open_count > 0)
  clicked: number;
  replied: number; // # of sends the recipient replied to
  lastSent: number; // epoch ms of the most recent send
};

// Pull every OUTBOUND send naming `domain` from the HubSpot CRM email log and
// aggregate it per external recipient — the full cold/1:1 audience with opens,
// clicks and replies. Powers the cold-outreach roster (kind === "mass") and the
// 1:1 pitched engagement metrics (looked up by recipient email). Best-effort:
// returns [] if HubSpot isn't configured or errors.
export async function recipientEngagementForDomain(domain: string): Promise<RecipientEngagement[]> {
  const d = domain.toLowerCase();
  if (!hubspotConfigured() || !d) return [];
  const props = [
    "hs_email_subject", "hs_email_to_email", "hs_email_to_firstname", "hs_email_to_lastname",
    "hs_sequence_id", "hs_email_open_count", "hs_email_click_count", "hs_email_reply_count",
    "hs_timestamp",
  ];
  type Agg = { email: string; name: string | null; seqId: string | null; sends: number; opened: number; clicked: number; replied: number; lastSent: number };
  const byEmail = new Map<string, Agg>();
  try {
    const seqNames = await getSequenceNames();
    let after: string | undefined;
    do {
      const body: Record<string, unknown> = {
        limit: 100,
        properties: props,
        // CONTAINS_TOKEN tokenizes "Domain.com" → matches the pitch subject; a
        // client-side literal-substring guard below removes any loose token match.
        filterGroups: [{ filters: [
          { propertyName: "hs_email_subject", operator: "CONTAINS_TOKEN", value: d },
          { propertyName: "hs_email_direction", operator: "EQ", value: "EMAIL" },
        ] }],
      };
      if (after) body.after = after;
      const r = (await hpost("/crm/v3/objects/emails/search", body)) as {
        results?: { properties: Record<string, string | null> }[]; paging?: { next?: { after?: string } };
      };
      for (const e of r.results || []) {
        const p = e.properties || {};
        if (!(p.hs_email_subject || "").toLowerCase().includes(d)) continue; // literal guard
        const email = (p.hs_email_to_email || "").toLowerCase();
        if (!email) continue;
        const a = byEmail.get(email) || { email, name: null, seqId: null, sends: 0, opened: 0, clicked: 0, replied: 0, lastSent: 0 };
        a.sends += 1;
        if (Number(p.hs_email_open_count) > 0) a.opened += 1;
        if (Number(p.hs_email_click_count) > 0) a.clicked += 1;
        if (Number(p.hs_email_reply_count) > 0) a.replied += 1;
        if (p.hs_sequence_id) a.seqId = p.hs_sequence_id;
        const nm = [p.hs_email_to_firstname, p.hs_email_to_lastname].filter(Boolean).join(" ").trim();
        if (nm && !a.name) a.name = nm;
        const ts = Date.parse(p.hs_timestamp || "") || 0;
        if (ts > a.lastSent) a.lastSent = ts;
        byEmail.set(email, a);
      }
      after = r.paging?.next?.after;
    } while (after);
    return [...byEmail.values()].map((a) => ({
      email: a.email,
      name: a.name,
      kind: (a.seqId ? "mass" : "individual") as PitchKind,
      sequenceName: a.seqId ? seqNames.get(String(a.seqId)) || null : null,
      sends: a.sends,
      opened: a.opened,
      clicked: a.clicked,
      replied: a.replied,
      lastSent: a.lastSent,
    }));
  } catch { return []; }
}

// Classify a set of RFC Message-IDs against HubSpot's logged emails. Returns a map
// keyed by normalized message-id → {direction, kind, sequenceName}. Only the ids
// HubSpot actually has are present (callers fall back to the Gmail heuristic for
// the rest). Best-effort: returns an empty map if HubSpot isn't configured or errors.
export async function classifyMessageIds(mids: string[]): Promise<Map<string, HubspotEmail>> {
  const out = new Map<string, HubspotEmail>();
  if (!hubspotConfigured() || !mids.length) return out;
  // Unique, non-empty, normalized — but query with the ORIGINAL form too (HubSpot
  // stores the bracketed form), so we send what HubSpot stored and key by normMid.
  const seen = new Set<string>();
  const queryMids: string[] = [];
  for (const raw of mids) {
    const n = normMid(raw);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    queryMids.push(raw); // send raw; HubSpot's stored value is the bracketed RFC id
  }
  try {
    const seqNames = await getSequenceNames();
    // HubSpot's IN operator caps at 100 values per filter — chunk.
    for (let i = 0; i < queryMids.length; i += 100) {
      const chunk = queryMids.slice(i, i + 100);
      let after: string | undefined;
      do {
        const body: Record<string, unknown> = {
          limit: 100,
          properties: ["hs_email_message_id", "hs_email_direction", "hs_sequence_id"],
          filterGroups: [{ filters: [{ propertyName: "hs_email_message_id", operator: "IN", values: chunk }] }],
        };
        if (after) body.after = after;
        const r = (await hpost("/crm/v3/objects/emails/search", body)) as {
          results?: { properties: Record<string, string | null> }[]; paging?: { next?: { after?: string } };
        };
        for (const e of r.results || []) {
          const p = e.properties || {};
          const mid = p.hs_email_message_id;
          if (!mid) continue;
          const key = normMid(mid);
          const inbound = p.hs_email_direction === "INCOMING_EMAIL";
          const seqId = p.hs_sequence_id || null;
          out.set(key, {
            direction: inbound ? "inbound" : "outbound",
            sequenceId: seqId,
            sequenceName: seqId ? seqNames.get(String(seqId)) || null : null,
            kind: inbound ? null : seqId ? "mass" : "individual",
          });
        }
        after = r.paging?.next?.after;
      } while (after);
    }
  } catch { /* fail-open — callers fall back to the Gmail heuristic */ }
  return out;
}
