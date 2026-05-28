import {
  loadAllSourcesWithStatus,
  loadReferences,
  type Reference,
  type SourceWithStatus,
} from "../lib/sources";
import {
  editFile,
  viewFile,
  sourceModulePathFor,
  workflowPathFor,
  runWorkflowPage,
} from "../lib/github-links";

export const revalidate = 60;

const PRODUCT_LABEL: Record<string, string> = {
  snap: "SNAP",
  auctions: "Auctions",
  aux: "Aux feeds",
};

type StatusKey = "ok" | "stale" | "failed" | "never_run" | "todo" | "disabled";

function statusInfo(s: SourceWithStatus): { key: StatusKey; color: string; label: string } {
  if (s.enabled === false) return { key: "disabled", color: "#9ca3af", label: "disabled" };
  if (!s.wired) return { key: "todo", color: "#e5e7eb", label: "TODO — not wired" };
  if (!s.runStatus) return { key: "never_run", color: "#cbd5e1", label: "wired · never run" };
  if (s.runStatus.status === "failed") return { key: "failed", color: "#dc2626", label: "failed" };
  if (s.runStatus.status === "ok") {
    const ageHours =
      (Date.now() - new Date(s.runStatus.generated_at).getTime()) / 1000 / 3600;
    if (ageHours < 26) return { key: "ok", color: "#10b981", label: "ok" };
    return { key: "stale", color: "#f59e0b", label: `stale (${Math.round(ageHours)}h)` };
  }
  return { key: "never_run", color: "#9ca3af", label: s.runStatus.status };
}

function relativeTime(iso: string): string {
  const ageSec = (Date.now() - new Date(iso).getTime()) / 1000;
  if (ageSec < 60) return `${Math.round(ageSec)}s ago`;
  if (ageSec < 3600) return `${Math.round(ageSec / 60)}m ago`;
  if (ageSec < 86400) return `${Math.round(ageSec / 3600)}h ago`;
  return `${Math.round(ageSec / 86400)}d ago`;
}

function LinkOut({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        fontSize: 12,
        color: "#3b82f6",
        textDecoration: "none",
        marginLeft: 8,
        whiteSpace: "nowrap",
      }}
    >
      {label} →
    </a>
  );
}

function SourceRow({ s }: { s: SourceWithStatus }) {
  const info = statusInfo(s);
  const dim = info.key === "todo" || info.key === "disabled";
  return (
    <tr style={{ borderTop: "1px solid #f3f4f6", opacity: dim ? 0.65 : 1 }}>
      <td style={{ padding: "10px 0", width: 24 }}>
        <span
          title={info.label}
          style={{
            display: "inline-block",
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: info.color,
            border:
              info.key === "todo" || info.key === "never_run"
                ? "1px solid #9ca3af"
                : "none",
            boxSizing: "border-box",
          }}
        />
      </td>
      <td
        style={{
          padding: "10px 0",
          fontFamily: "ui-monospace, Menlo, monospace",
        }}
      >
        {s.source_id}
        {info.key === "todo" && (
          <span
            style={{
              marginLeft: 8,
              padding: "1px 6px",
              fontSize: 10,
              border: "1px solid #d1d5db",
              borderRadius: 4,
              color: "#6b7280",
              fontFamily: "system-ui, sans-serif",
              fontWeight: 600,
              letterSpacing: 0.4,
              textTransform: "uppercase",
            }}
          >
            todo
          </span>
        )}
      </td>
      <td style={{ padding: "10px 0", color: "#6b7280" }}>{s.kind}</td>
      <td
        style={{
          padding: "10px 0",
          color: "#6b7280",
          fontFamily: "ui-monospace, Menlo, monospace",
        }}
      >
        {s.schedule_utc ?? "—"}
      </td>
      <td style={{ padding: "10px 0", color: "#6b7280" }}>
        {s.runStatus ? relativeTime(s.runStatus.generated_at) : "—"}
      </td>
      <td
        style={{
          padding: "10px 0",
          textAlign: "right",
          fontVariantNumeric: "tabular-nums",
          whiteSpace: "nowrap",
        }}
      >
        {s.runStatus?.new_count ?? "—"}
      </td>
      <td style={{ padding: "10px 0", textAlign: "right", whiteSpace: "nowrap" }}>
        {s.wired && <LinkOut href={runWorkflowPage(s.source_id)} label="run" />}
        {s.wired && (
          <LinkOut href={viewFile(sourceModulePathFor(s.source_id))} label="code" />
        )}
        {!s.wired && (
          <LinkOut
            href={editFile("sources.yaml")}
            label="edit registry"
          />
        )}
      </td>
    </tr>
  );
}

function SourceTable({ items }: { items: SourceWithStatus[] }) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
      <thead>
        <tr style={{ textAlign: "left", color: "#6b7280", fontSize: 12 }}>
          <th style={{ padding: "8px 0", width: 24 }}></th>
          <th style={{ padding: "8px 0" }}>source_id</th>
          <th style={{ padding: "8px 0" }}>kind</th>
          <th style={{ padding: "8px 0" }}>schedule (UTC)</th>
          <th style={{ padding: "8px 0" }}>last run</th>
          <th style={{ padding: "8px 0", textAlign: "right" }}>new&nbsp;today</th>
          <th style={{ padding: "8px 0", textAlign: "right" }}></th>
        </tr>
      </thead>
      <tbody>
        {items.map((s) => (
          <SourceRow key={s.source_id} s={s} />
        ))}
      </tbody>
    </table>
  );
}

function ReferencesSection({ refs }: { refs: Reference[] }) {
  if (!refs.length) return null;
  return (
    <section style={{ marginBottom: 36 }}>
      <h2 style={{ fontSize: 18, marginBottom: 12, fontWeight: 600 }}>
        References{" "}
        <span style={{ color: "#9ca3af", fontWeight: 400 }}>· {refs.length}</span>
      </h2>
      <p style={{ color: "#6b7280", fontSize: 13, marginTop: 0, marginBottom: 12 }}>
        Read-only data stores queried ad-hoc during naming workflows. Not on a
        schedule.
      </p>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
        <thead>
          <tr style={{ textAlign: "left", color: "#6b7280", fontSize: 12 }}>
            <th style={{ padding: "8px 0" }}>ref_id</th>
            <th style={{ padding: "8px 0" }}>kind</th>
            <th style={{ padding: "8px 0" }}>table / endpoint</th>
            <th style={{ padding: "8px 0" }}>cadence</th>
          </tr>
        </thead>
        <tbody>
          {refs.map((r) => (
            <tr key={r.ref_id} style={{ borderTop: "1px solid #f3f4f6" }}>
              <td
                style={{
                  padding: "10px 0",
                  fontFamily: "ui-monospace, Menlo, monospace",
                }}
              >
                {r.ref_id}
              </td>
              <td style={{ padding: "10px 0", color: "#6b7280" }}>{r.kind}</td>
              <td
                style={{
                  padding: "10px 0",
                  color: "#6b7280",
                  fontFamily: "ui-monospace, Menlo, monospace",
                }}
              >
                {r.table ?? "—"}
              </td>
              <td style={{ padding: "10px 0", color: "#6b7280" }}>
                {r.cadence ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export default async function SourcesPage() {
  const hasToken = !!process.env.GITHUB_TOKEN;
  const [sources, refs] = hasToken
    ? await Promise.all([loadAllSourcesWithStatus(), loadReferences()])
    : [[] as SourceWithStatus[], [] as Reference[]];

  const byProduct: Record<string, SourceWithStatus[]> = {};
  for (const s of sources) {
    (byProduct[s.product] ||= []).push(s);
  }

  const ORDER: Record<StatusKey, number> = {
    ok: 0,
    stale: 1,
    failed: 2,
    never_run: 3,
    disabled: 4,
    todo: 5,
  };
  for (const p of Object.keys(byProduct)) {
    byProduct[p].sort((a, b) => ORDER[statusInfo(a).key] - ORDER[statusInfo(b).key]);
  }

  const counts: Record<StatusKey, number> = {
    ok: 0, stale: 0, failed: 0, never_run: 0, todo: 0, disabled: 0,
  };
  for (const s of sources) counts[statusInfo(s).key]++;
  const total = sources.length;
  const wiredCount = sources.filter((s) => s.wired && s.enabled !== false).length;

  return (
    <>
      {!hasToken && (
        <div
          style={{
            background: "#fef3c7",
            border: "1px solid #f59e0b",
            padding: 16,
            borderRadius: 6,
            marginBottom: 24,
            fontSize: 14,
          }}
        >
          <strong>GITHUB_TOKEN not set.</strong> Set GITHUB_TOKEN as an env var
          (fine-grained PAT with Contents: Read on this repo) to see live data.
        </div>
      )}

      {hasToken && (
        <section
          style={{
            display: "flex",
            gap: 24,
            marginBottom: 32,
            padding: "12px 16px",
            background: "#f9fafb",
            border: "1px solid #e5e7eb",
            borderRadius: 6,
            fontSize: 14,
            flexWrap: "wrap",
          }}
        >
          <span>
            <strong>{wiredCount} / {total}</strong> wired
          </span>
          <span style={{ color: "#10b981" }}>
            ● <strong>{counts.ok}</strong> ok
          </span>
          <span style={{ color: "#f59e0b" }}>
            ● <strong>{counts.stale}</strong> stale
          </span>
          <span style={{ color: "#dc2626" }}>
            ● <strong>{counts.failed}</strong> failed
          </span>
          <span style={{ color: "#9ca3af" }}>
            ● <strong>{counts.never_run}</strong> never run
          </span>
          <span style={{ color: "#9ca3af" }}>
            <span
              style={{
                display: "inline-block",
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "#e5e7eb",
                border: "1px solid #9ca3af",
                marginRight: 4,
              }}
            />
            <strong>{counts.todo}</strong> todo
          </span>
          <span style={{ color: "#9ca3af" }}>
            ● <strong>{counts.disabled}</strong> disabled
          </span>
        </section>
      )}

      {(["snap", "auctions", "aux"] as const).map((product) => {
        const items = byProduct[product] ?? [];
        if (!items.length) return null;
        const wired = items.filter((s) => s.wired && s.enabled !== false).length;
        return (
          <section key={product} style={{ marginBottom: 36 }}>
            <h2 style={{ fontSize: 18, marginBottom: 12, fontWeight: 600 }}>
              {PRODUCT_LABEL[product]}{" "}
              <span style={{ color: "#9ca3af", fontWeight: 400 }}>
                · {wired}/{items.length} wired
              </span>
            </h2>
            <SourceTable items={items} />
          </section>
        );
      })}

      <ReferencesSection refs={refs} />

      <footer
        style={{
          marginTop: 48,
          paddingTop: 16,
          borderTop: "1px solid #e5e7eb",
          fontSize: 12,
          color: "#9ca3af",
        }}
      >
        Page revalidates every 60 seconds · <a
          href={editFile("sources.yaml")}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "#3b82f6", textDecoration: "none" }}
        >
          Edit sources.yaml on GitHub →
        </a>
      </footer>
    </>
  );
}
