import { loadFullRegistry, type FilterProfile } from "../../lib/sources";
import { editFile, viewFile, sourceModulePathFor } from "../../lib/github-links";

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
      style={{
        fontSize: 12,
        color: "#3b82f6",
        textDecoration: "none",
        marginLeft: 12,
        whiteSpace: "nowrap",
      }}
    >
      {label} →
    </a>
  );
}

function Kv({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "200px 1fr",
        padding: "6px 0",
        fontSize: 14,
        borderBottom: "1px solid #f3f4f6",
      }}
    >
      <div style={{ color: "#6b7280" }}>{k}</div>
      <div>{v}</div>
    </div>
  );
}

function ProfileCard({ p }: { p: FilterProfile }) {
  const tlds = (p.allowed_tlds ?? []).join("  ");
  return (
    <article
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 8,
        padding: "16px 20px",
        marginBottom: 16,
        background: "#fafafa",
      }}
    >
      <h3
        style={{
          margin: 0,
          fontSize: 15,
          fontFamily: "ui-monospace, Menlo, monospace",
        }}
      >
        {p.name}
        <EditLink path="sources.yaml" />
      </h3>
      <div style={{ marginTop: 12 }}>
        <Kv k="Allowed TLDs" v={<code style={{ fontSize: 13 }}>{tlds || "—"}</code>} />
        {p.sld_length_min != null && (
          <Kv
            k="SLD length"
            v={
              <span>
                {p.sld_length_min}–{p.sld_length_max ?? "∞"} chars
              </span>
            }
          />
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
                    <span style={{ color: "#6b7280" }}>
                      {" "}
                      (overrides:{" "}
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
                style={{
                  color: "#3b82f6",
                  textDecoration: "none",
                  fontFamily: "ui-monospace, Menlo, monospace",
                  fontSize: 13,
                }}
              >
                {p.legacy_module} →
              </a>
            }
          />
        )}
      </div>
    </article>
  );
}

export default async function ConfigPage() {
  const hasToken = !!process.env.GITHUB_TOKEN;
  if (!hasToken) {
    return (
      <div
        style={{
          background: "#fef3c7",
          border: "1px solid #f59e0b",
          padding: 16,
          borderRadius: 6,
          fontSize: 14,
        }}
      >
        <strong>GITHUB_TOKEN not set.</strong> Configure to load registry.
      </div>
    );
  }

  const reg = await loadFullRegistry();

  // Map source -> sheet destinations
  const sheetDest = reg.sources
    .filter((s) => s.enabled !== false && s.sheet_destinations?.length)
    .map((s) => ({
      source_id: s.source_id,
      product: s.product,
      destinations: s.sheet_destinations ?? [],
    }));

  return (
    <>
      <p style={{ color: "#6b7280", fontSize: 14, marginTop: 0, marginBottom: 32 }}>
        All configuration is read-only here — every section has an{" "}
        <strong>Edit on GitHub →</strong> link that opens the right file in
        GitHub's web editor. Changes commit on save and take effect on the next
        scheduled run.
      </p>

      {/* ---------------- Filter profiles ---------------- */}
      <section style={{ marginBottom: 48 }}>
        <h2 style={{ fontSize: 18, marginBottom: 4, fontWeight: 600 }}>
          Filter profiles
        </h2>
        <p style={{ color: "#6b7280", fontSize: 13, margin: "4px 0 16px" }}>
          Two profiles coexist:{" "}
          <code style={{ fontSize: 12 }}>standard_listings</code> picks names
          for Slack/Sheets (strict);{" "}
          <code style={{ fontSize: 12 }}>universe_ingest</code> is the broader
          filter that lets names into the R2 name universe used for the
          brand-naming workflow.
        </p>
        {reg.filter_profiles.map((p) => (
          <ProfileCard key={p.name} p={p} />
        ))}
      </section>

      {/* ---------------- Sheet destinations ---------------- */}
      <section style={{ marginBottom: 48 }}>
        <h2 style={{ fontSize: 18, marginBottom: 4, fontWeight: 600 }}>
          Sheet destinations
          <EditLink path="sources.yaml" />
        </h2>
        <p style={{ color: "#6b7280", fontSize: 13, margin: "4px 0 16px" }}>
          Per-source ownership semantics for shared destination tabs.
        </p>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#6b7280", fontSize: 12 }}>
              <th style={{ padding: "8px 0" }}>source</th>
              <th style={{ padding: "8px 0" }}>tab</th>
              <th style={{ padding: "8px 0" }}>ownership mode</th>
            </tr>
          </thead>
          <tbody>
            {sheetDest.flatMap((s) =>
              s.destinations.map((d, i) => (
                <tr
                  key={`${s.source_id}-${i}`}
                  style={{ borderTop: "1px solid #f3f4f6" }}
                >
                  <td
                    style={{
                      padding: "8px 0",
                      fontFamily: "ui-monospace, Menlo, monospace",
                    }}
                  >
                    {s.source_id}
                  </td>
                  <td style={{ padding: "8px 0" }}>{d.tab}</td>
                  <td style={{ padding: "8px 0", color: "#6b7280" }}>
                    <code style={{ fontSize: 13 }}>{d.mode}</code>
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </section>

      {/* ---------------- Slack routing ---------------- */}
      <section style={{ marginBottom: 48 }}>
        <h2 style={{ fontSize: 18, marginBottom: 4, fontWeight: 600 }}>
          Slack routing
          <EditLink path="sources.yaml" />
        </h2>
        <div style={{ marginTop: 12 }}>
          <Kv
            k="#snap channel"
            v={
              <code style={{ fontSize: 13 }}>
                {reg.products.snap?.slack_channel_env ?? "—"}
              </code>
            }
          />
          <Kv
            k="#auctions channel"
            v={
              <code style={{ fontSize: 13 }}>
                {reg.products.auctions?.slack_channel_env ?? "—"}
              </code>
            }
          />
        </div>
      </section>

      {/* ---------------- Storage ---------------- */}
      <section style={{ marginBottom: 48 }}>
        <h2 style={{ fontSize: 18, marginBottom: 4, fontWeight: 600 }}>
          Storage
          <EditLink path="sources.yaml" />
        </h2>
        <div style={{ marginTop: 12 }}>
          <Kv
            k="Pipeline Raw Cache folder"
            v={
              <code style={{ fontSize: 13 }}>
                {reg.storage.pipeline_raw_cache_folder_id ?? "—"}
              </code>
            }
          />
          <Kv
            k="Retention (days)"
            v={reg.storage.pipeline_raw_cache_retention_days ?? "—"}
          />
        </div>
      </section>

      {/* ---------------- Per-source quirks ---------------- */}
      <section style={{ marginBottom: 48 }}>
        <h2 style={{ fontSize: 18, marginBottom: 4, fontWeight: 600 }}>
          Per-source code & quirks
        </h2>
        <p style={{ color: "#6b7280", fontSize: 13, margin: "4px 0 16px" }}>
          Scoring formulas, TLD-weight overrides, and source-specific
          minimums live in each source's Python module.
        </p>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#6b7280", fontSize: 12 }}>
              <th style={{ padding: "8px 0" }}>source</th>
              <th style={{ padding: "8px 0" }}>product</th>
              <th style={{ padding: "8px 0" }}>kind</th>
              <th style={{ padding: "8px 0", textAlign: "right" }}></th>
            </tr>
          </thead>
          <tbody>
            {reg.sources.map((s) => (
              <tr key={s.source_id} style={{ borderTop: "1px solid #f3f4f6" }}>
                <td
                  style={{
                    padding: "8px 0",
                    fontFamily: "ui-monospace, Menlo, monospace",
                  }}
                >
                  {s.source_id}
                </td>
                <td style={{ padding: "8px 0", color: "#6b7280" }}>
                  {PRODUCT_LABEL[s.product] ?? s.product}
                </td>
                <td style={{ padding: "8px 0", color: "#6b7280" }}>{s.kind}</td>
                <td style={{ padding: "8px 0", textAlign: "right" }}>
                  <a
                    href={viewFile(sourceModulePathFor(s.source_id))}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      fontSize: 12,
                      color: "#3b82f6",
                      textDecoration: "none",
                    }}
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
