// Shared types for the Client Domain corpus builder.

/** One contribution about one domain from one upstream source row. */
export type RawHit = {
  domain: string; // canonical apex (already run through canonicalApex)
  client?: string | null; // human client/contact label, if the source has one
  source: string; // provenance tag, e.g. "[Payments]" / "[Gmail:rob@snagged.com]"
  note?: string | null; // one tagged note block for the Notes field
  date?: string | null; // ISO date (YYYY-MM-DD) of the useful date on this row
};

/** Accumulated in-memory record keyed by canonical apex before it's written out. */
export type CorpusRecord = {
  domain: string;
  sld: string;
  tld: string;
  clients: string[];
  sources: string[]; // distinct source tags
  notes: string[]; // tagged note blocks, one per contributing row
  dates: string[]; // all parsed ISO dates seen
};

/** The final shape written to the client_domains table (and mirrored to the sheet). */
export type CorpusRow = {
  domain: string;
  sld: string;
  tld: string;
  clients: string[];
  sources: string[];
  notes: string | null;
  last_contact_date: string | null; // ISO
  first_source_date: string | null; // ISO
  date_added: string; // ISO — spec continuity field (earliest source date)
  first_ingested_at: string; // ISO — the day this builder first wrote the row (net-new)
};

/** Per-domain add-date + continuity date read back from the table before a rebuild. */
export type ExistingMeta = { date_added: string; first_ingested_at: string | null };
