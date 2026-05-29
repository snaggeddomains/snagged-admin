import { loadFullRegistry, type FilterProfile } from "../../lib/sources";
import { editFile, viewFile, sourceModulePathFor } from "../../lib/github-links";
import KindPill from "../kind-pill";

export const revalidate = 60;

const PRODUCT_LABEL: Record<string, string> = {
  snap: "SNAP",
  auctions: "Auctions",
  aux: "Aux feeds",
};

function EditLink({ path, label = "Edit on GitHub" }: { path: string; label?: string }) {
  return (
    <a
      href={editFile(path)}
      target="_blank"
      rel="noopener noreferrer"
      className="link-out"
    >
      {label} →
    </a>
  );
}

function Kv({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="kv">
      <div className="kv-key">{k}</div>
      <div>{v}</div>
    </div>
  );
}

function ProfileCard({ p }: { p: FilterProfile }) {
  const tlds = (p.allowed_tlds ?? []).join("  ");
  return (
    <article className="profile-card">
      <h3>
        {p.label ?? p.name}
        {p.label && (
          <span
            style={{
              marginLeft: 8,
              color: "var(--navy-3)",
              fontWeight: 400,
              fontSize: 12,
              fontFamily: "ui-monospace, Menlo, monospace",
            }}
          >
            {p.name}
          </span>
        )}
        <EditLink path="sources.yaml" />
      </h3>
      <Kv k="Allowed TLDs" v={<code>{tlds || "—"}</code>} />
      {p.sld_length_min != null && (
        <Kv k="SLD length" v={`${p.sld_length_min}–${p.sld_length_max ?? "∞"} chars`} />
      )}
      {p.allow_digits != null && (
        <Kv k="Digits in SLD" v={p.allow_digits ? "allowed" : "rejected"} />
      )}
      {p.allow_hyphens != null && (
        <Kv k="Hyphens" v={p.allow_hyphens ? "allowed" : "rejected"} />
      )}
      {p.require_vowel != null && (
        <Kv k="Require vowel" v={p.require_vowel ? "yes" : "no"} />
      )}
      {p.max_consecutive_consonants != null && (
        <Kv k="Max consonant run" v={p.max_consecutive_consonants} />
      )}
      {p.dedup_by_domain != null && (
        <Kv k="Dedup by domain" v={p.dedup_by_domain ? "yes" : "no"} />
      )}
      {p.zipf_min != null && (
        <Kv
          k="Zipf threshold"
          v={
            <span>
              ≥ {p.zipf_min}
              {p.zipf_overrides_by_tld &&
                Object.keys(p.zipf_overrides_by_tld).length > 0 && (
                  <span style={{ color: "var(--navy-3)" }}>
                    {" "}(overrides:{" "}
                    {Object.entries(p.zipf_overrides_by_tld)
                      .map(([t, v]) => `${t} ${v}`)
                      .join(", ")}
                    )
                  </span>
                )}
            </span>
          }
        />
      )}
      {p.allow_three_letter_com && (
        <Kv k="3-letter .com" v="allowed (bypasses zipf)" />
      )}
      {p.legacy_module && (
        <Kv
          k="Legacy reference"
          v={
            <a
              href={viewFile(p.legacy_module)}
              target="_blank"
              rel="noopener noreferrer"
              className="link-out"
              style={{ marginLeft: 0 }}
            >
              {p.legacy_module} →
            </a>
          }
        />
      )}
    </article>
  );
}

export default async function ConfigPage() {
  const hasToken = !!process.env.GITHUB_TOKEN;
  if (!hasToken) {
    return (
      <div className="warn-callout">
        <strong>GITHUB_TOKEN not set.</strong> Configure to load registry.
      </div>
    );
  }

  const reg = await loadFullRegistry();

  const sheetDest = reg.sources
    .filter((s) => s.enabled !== false && s.sheet_destinations?.length)
    .map((s) => ({
      source_id: s.source_id,
      product: s.product,
      destinations: s.sheet_destinations ?? [],
    }));

  return (
    <>
      <p style={{ color: "var(--navy-3)", fontSize: 14, marginTop: 0, marginBottom: 32 }}>
        All configuration is read-only here — every section has an{" "}
        <strong>Edit on GitHub →</strong> link that opens the right file in
        GitHub's web editor. Changes commit on save and take effect on the next
        scheduled run.
      </p>

      <section>
        <h2>Filter profiles</h2>
        <p className="section-blurb">
          Two profiles coexist: <code>standard_listings</code> is the strict
          word-frequency filter used for both the SNAP Slack/Sheets feed and
          the auctions watchlist (single English dictionary words plus a
          3-letter .com bypass); <code>universe_ingest</code> is the broader
          filter that ingests names into the R2 universe for the brand-naming
          workflow.
        </p>
        {reg.filter_profiles.map((p) => (
          <ProfileCard key={p.name} p={p} />
        ))}
      </section>

      <section>
        <h2>
          Sheet destinations
          <EditLink path="sources.yaml" />
        </h2>
        <p className="section-blurb">
          Per-source ownership semantics for shared destination tabs.
        </p>
        <table className="dash">
          <thead>
            <tr>
              <th>source</th>
              <th>tab</th>
              <th>ownership mode</th>
            </tr>
          </thead>
          <tbody>
            {sheetDest.flatMap((s) =>
              s.destinations.map((d, i) => (
                <tr key={`${s.source_id}-${i}`}>
                  <td className="mono">{s.source_id}</td>
                  <td>{d.tab}</td>
                  <td className="muted">
                    <code>{d.mode}</code>
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </section>

      <section>
        <h2>
          Slack routing
          <EditLink path="sources.yaml" />
        </h2>
        <Kv
          k="#snap channel"
          v={<code>{reg.products.snap?.slack_channel_env ?? "—"}</code>}
        />
        <Kv
          k="#auctions channel"
          v={<code>{reg.products.auctions?.slack_channel_env ?? "—"}</code>}
        />
      </section>

      <section>
        <h2>
          Storage
          <EditLink path="sources.yaml" />
        </h2>
        <Kv
          k="Pipeline Raw Cache folder"
          v={<code>{reg.storage.pipeline_raw_cache_folder_id ?? "—"}</code>}
        />
        <Kv
          k="Retention (days)"
          v={reg.storage.pipeline_raw_cache_retention_days ?? "—"}
        />
      </section>

      <section>
        <h2>Per-source code & quirks</h2>
        <p className="section-blurb">
          Scoring formulas, TLD-weight overrides, and source-specific minimums
          live in each source's Python module.
        </p>
        <table className="dash">
          <thead>
            <tr>
              <th>source</th>
              <th>product</th>
              <th>kind</th>
              <th className="right"></th>
            </tr>
          </thead>
          <tbody>
            {reg.sources.map((s) => (
              <tr key={s.source_id}>
                <td className="mono">{s.source_id}</td>
                <td className="muted">{PRODUCT_LABEL[s.product] ?? s.product}</td>
                <td><KindPill kind={s.kind} /></td>
                <td className="right">
                  <a
                    href={viewFile(sourceModulePathFor(s.source_id))}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="link-out"
                  >
                    view module →
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
