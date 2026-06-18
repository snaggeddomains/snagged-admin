// One-shot LLM recap for a domain's deal threads: a one-line "what happened"
// outcome per thread + the real negotiated buyer OFFER (distinguished from our
// ask price, which regex can't do). One Anthropic call per report generation;
// the report is cached, so page loads never pay for it. Server-only.
//
// Model: DEAL_RECAP_MODEL (default Haiku — cheap, plenty for short extraction).

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.DEAL_RECAP_MODEL || "claude-haiku-4-5-20251001";

export type QuoteKind = "interest" | "objection" | "price" | "praise" | "other";
export type ThreadRecap = { offer: string | null; outcome: string; quote: string | null; quoteKind: QuoteKind | null };

// A concrete offer pulled out of the free-text broker notes (off-platform deals
// the broker logged — text/WhatsApp/phone/verbal). Folded into the report's
// offers table alongside the email/CRM offers.
export type NoteOffer = { party: string; amount: string; date: string; channel: string; outcome: string };

// Extract concrete dollar offers stated in the broker notes for a domain. Returns
// [] on no key / no notes / nothing concrete. Server-only; one small Anthropic call.
export async function extractNoteOffers(domain: string, notesText: string, env: NodeJS.ProcessEnv): Promise<NoteOffer[]> {
  const key = env.ANTHROPIC_API_KEY;
  const notes = (notesText || "").trim();
  if (!key || !notes) return [];
  const system =
    `From the broker notes about ${domain} (a domain we sell), extract ONLY concrete dollar OFFERS — where someone offered, or was explicitly willing to pay, a specific $ amount. ` +
    `Return STRICT JSON: an array [{"party":"","amount":"$X","date":"","channel":"","outcome":""}]. ` +
    `party = the buyer/investor name if given (else ""); amount = "$X" as written; date = as written (else ""); ` +
    `channel = how it came in if stated (e.g. "WhatsApp","Phone","Text","Email") else ""; outcome = what happened (e.g. "declined — too low", "open, awaiting follow-up"). ` +
    `Include every distinct named offer. Do NOT include vague interest, budgets/ranges with no offer, or our asking price. Return [] if no concrete offer is stated.`;
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1200, system, messages: [{ role: "user", content: notes.slice(0, 4000) }] }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text || "").join("");
    const arr = parseArray(text);
    return arr
      .filter((o): o is Record<string, unknown> => !!o && typeof o === "object" && /\d/.test(String((o as Record<string, unknown>).amount || "")))
      .slice(0, 20)
      .map((o) => ({
        party: String(o.party || "").trim().slice(0, 120),
        amount: String(o.amount || "").trim().slice(0, 24),
        date: String(o.date || "").trim().slice(0, 24),
        channel: String(o.channel || "").trim().slice(0, 24),
        outcome: String(o.outcome || "").trim().slice(0, 160),
      }));
  } catch {
    return [];
  }
}
export type RecapItem = { idx: number; party: string; origin: "inbound" | "pitched"; subject: string; transcript: string };

const SYSTEM = (domain: string) =>
  `You analyze email threads about ${domain}, a domain we (Snagged, a domain broker) REPRESENT FOR SALE. ` +
  `Each thread is either an inbound buyer inquiry or our outbound pitch to a prospective buyer. ` +
  `For each thread, return:\n` +
  `- "outcome": a single factual clause (max 14 words) describing what happened / the current state — e.g. ` +
  `"Offered $8k, we countered at $20k, awaiting reply", "Went quiet after our reply", "Asked for price, no follow-up", ` +
  `"Declined — over budget", "Said our price was too high", "Not interested", "Agreed terms, moved to escrow". ` +
  `Capture the real result: did they make an offer, decline, balk at the price, or go quiet? No fluff, no quotes of email text.\n` +
  `- "offer": the BUYER's specific dollar offer if they named one, as "$12,000". This is what the BUYER offered to PAY — ` +
  `NEVER our asking/list price that we quoted them. null if the buyer never named an offer.\n` +
  `- "quote": the single most telling VERBATIM sentence or phrase from the OTHER PARTY's own words (lines NOT tagged "US:") ` +
  `that best conveys their stance — genuine interest in the name, an objection, a reaction to price, or praise of the domain. ` +
  `Copy their wording exactly (you may trim to the key clause, max ~28 words). Strip any names, emails, phone numbers, signatures, and links. ` +
  `Prefer something a domain owner would find revealing about real demand or pricing. null if the other party said nothing substantive ` +
  `(e.g. a bare form submission, "interested", or only our own words exist). Never quote our ("US:") side. Never invent words.\n` +
  `- "quoteKind": one of "interest" | "objection" | "price" | "praise" | "other" classifying that quote, or null when quote is null.\n` +
  `Return ONLY a JSON array: [{"idx":0,"outcome":"...","offer":"$X"|null,"quote":"..."|null,"quoteKind":"price"|null}, ...] for every thread given.`;

function parseArray(text: string): unknown[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return []; }
}

export async function recapThreads(domain: string, items: RecapItem[], env: NodeJS.ProcessEnv): Promise<Map<number, ThreadRecap>> {
  const out = new Map<number, ThreadRecap>();
  const key = env.ANTHROPIC_API_KEY;
  if (!key || !items.length) return out;

  // Keep the payload bounded — cap threads and per-thread transcript length.
  const slice = items.slice(0, 40);
  const user =
    `Threads for ${domain}:\n\n` +
    slice
      .map((it) => `### idx ${it.idx} · ${it.origin} · party: ${it.party}\nSubject: ${it.subject}\n${it.transcript.slice(0, 1400)}`)
      .join("\n\n");

  let text = "";
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 3000, system: SYSTEM(domain), messages: [{ role: "user", content: user }] }),
    });
    if (!res.ok) return out;
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text || "").join("");
  } catch {
    return out;
  }

  const KINDS = new Set<QuoteKind>(["interest", "objection", "price", "praise", "other"]);
  for (const row of parseArray(text)) {
    if (!row || typeof row !== "object") continue;
    const r = row as { idx?: number; outcome?: string; offer?: string | null; quote?: string | null; quoteKind?: string | null };
    if (typeof r.idx !== "number") continue;
    const offer = r.offer && /\d/.test(String(r.offer)) ? String(r.offer).trim() : null;
    const outcome = (r.outcome || "").toString().trim().slice(0, 140);
    // Verbatim buyer quote: trim surrounding quotes/whitespace, bound the length,
    // and drop anything that's too short to be meaningful.
    let quote = (r.quote == null ? "" : String(r.quote)).trim().replace(/^["“”']+|["“”']+$/g, "").trim();
    if (quote.length < 8) quote = "";
    quote = quote.slice(0, 240);
    const kind = (r.quoteKind && KINDS.has(r.quoteKind as QuoteKind) ? (r.quoteKind as QuoteKind) : null);
    const quoteKind = quote ? kind || "other" : null;
    if (outcome || offer || quote) out.set(r.idx, { offer, outcome, quote: quote || null, quoteKind });
  }
  return out;
}
