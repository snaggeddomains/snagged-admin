"use client";

import { useState } from "react";
import {
  CATALOG,
  storageKey,
  isGranted,
  type AppUser,
  type CatalogEntry,
} from "@/lib/permissions";

const GROUPS = Array.from(new Set(CATALOG.map((c) => c.group)));

type Draft = { is_admin: boolean; grants: Record<string, boolean> };

function draftFor(u: AppUser): Draft {
  const grants: Record<string, boolean> = {};
  for (const c of CATALOG) grants[c.key] = isGranted(u.permissions, c.key);
  return { is_admin: u.is_admin, grants };
}

export default function UsersEditor({
  users,
  currentUserId,
}: {
  users: AppUser[];
  currentUserId: string;
}) {
  return (
    <main>
      <h1 style={{ fontSize: "1.25rem", marginBottom: 4 }}>Users &amp; permissions</h1>
      <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>
        Module access and per-action permissions. Admins pass every check
        automatically.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 20 }}>
        {users.map((u) => (
          <UserCard key={u.id} user={u} isSelf={u.id === currentUserId} />
        ))}
        {users.length === 0 && <p className="muted">No users found.</p>}
      </div>
    </main>
  );
}

function UserCard({ user, isSelf }: { user: AppUser; isSelf: boolean }) {
  const [draft, setDraft] = useState<Draft>(() => draftFor(user));
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function setGrant(key: string, value: boolean) {
    setDraft((d) => ({ ...d, grants: { ...d.grants, [key]: value } }));
  }

  async function save() {
    setSaving(true);
    setMsg(null);
    // Preserve unknown keys; overwrite catalog keys at their storage key.
    const permissions: Record<string, unknown> = { ...user.permissions };
    for (const c of CATALOG) permissions[storageKey(c.key)] = draft.grants[c.key];
    try {
      const res = await fetch("/api/users", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: user.id, is_admin: draft.is_admin, permissions }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setMsg({ ok: false, text: data.error || "Save failed" });
      else setMsg({ ok: true, text: "Saved" });
    } catch {
      setMsg({ ok: false, text: "Network error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ border: "1px solid #e3ddcf", borderRadius: 10, padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <strong>{user.email}</strong>
        {isSelf && <span className="muted" style={{ fontSize: 12 }}>(you)</span>}
        <label style={{ marginLeft: "auto", fontSize: 14, display: "flex", gap: 6 }}>
          <input
            type="checkbox"
            checked={draft.is_admin}
            disabled={isSelf}
            title={isSelf ? "You can't remove your own admin access" : undefined}
            onChange={(e) => setDraft((d) => ({ ...d, is_admin: e.target.checked }))}
          />
          Admin
        </label>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 12,
          opacity: draft.is_admin ? 0.5 : 1,
        }}
      >
        {GROUPS.map((group) => (
          <fieldset key={group} style={{ border: "1px solid #eee5d5", borderRadius: 8, padding: "8px 12px" }}>
            <legend className="muted" style={{ fontSize: 12, padding: "0 4px" }}>{group}</legend>
            {CATALOG.filter((c) => c.group === group).map((c: CatalogEntry) => (
              <label key={c.key} style={{ display: "flex", gap: 8, fontSize: 14, padding: "3px 0" }}>
                <input
                  type="checkbox"
                  checked={draft.is_admin || draft.grants[c.key]}
                  disabled={draft.is_admin}
                  onChange={(e) => setGrant(c.key, e.target.checked)}
                />
                <span>
                  {c.label}
                  {c.kind === "action" && (
                    <span className="muted" style={{ fontSize: 11 }}> · action</span>
                  )}
                </span>
              </label>
            ))}
          </fieldset>
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12 }}>
        <button onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        {msg && (
          <span style={{ fontSize: 13, color: msg.ok ? "#2a7" : "#b00" }}>{msg.text}</span>
        )}
      </div>
    </div>
  );
}
