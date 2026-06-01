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
  users: initialUsers,
  currentUserId,
}: {
  users: AppUser[];
  currentUserId: string;
}) {
  const [users, setUsers] = useState<AppUser[]>(initialUsers);

  return (
    <main>
      <h1 style={{ fontSize: "1.25rem", marginBottom: 4 }}>Users &amp; permissions</h1>
      <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>
        Module access and per-action permissions. Admins pass every check
        automatically.
      </p>

      <AddUser onAdded={(u) => setUsers((list) => [...list, u].sort((a, b) => a.email.localeCompare(b.email)))} />

      <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 20 }}>
        {users.map((u) => (
          <UserCard
            key={u.id}
            user={u}
            isSelf={u.id === currentUserId}
            onDeleted={() => setUsers((list) => list.filter((x) => x.id !== u.id))}
          />
        ))}
        {users.length === 0 && <p className="muted">No users found.</p>}
      </div>
    </main>
  );
}

function AddUser({ onAdded }: { onAdded: (u: AppUser) => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ ok: false, text: data.error || "Couldn't add user" });
        return;
      }
      onAdded(data.user);
      setEmail("");
      setMsg({
        ok: true,
        text: data.invited
          ? "Added — a set-password email is on its way."
          : "Added — couldn't send the email; have them use “Forgot password”.",
      });
    } catch {
      setMsg({ ok: false, text: "Network error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={add}
      style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 18, flexWrap: "wrap" }}
    >
      <input
        className="field"
        type="email"
        placeholder="new.user@email.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        style={{ maxWidth: 320 }}
      />
      <button className="btn btn--navy" type="submit" disabled={busy}>
        {busy ? "Adding…" : "Add user"}
      </button>
      {msg && (
        <span style={{ fontSize: 13, color: msg.ok ? "#2a7" : "var(--coral-deep)" }}>{msg.text}</span>
      )}
    </form>
  );
}

function UserCard({
  user,
  isSelf,
  onDeleted,
}: {
  user: AppUser;
  isSelf: boolean;
  onDeleted: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFor(user));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function setGrant(key: string, value: boolean) {
    setDraft((d) => ({ ...d, grants: { ...d.grants, [key]: value } }));
  }

  async function save() {
    setSaving(true);
    setMsg(null);
    const permissions: Record<string, unknown> = { ...user.permissions };
    for (const c of CATALOG) permissions[storageKey(c.key)] = draft.grants[c.key];
    try {
      const res = await fetch("/api/users", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: user.id, is_admin: draft.is_admin, permissions }),
      });
      const data = await res.json().catch(() => ({}));
      setMsg(res.ok ? { ok: true, text: "Saved" } : { ok: false, text: data.error || "Save failed" });
    } catch {
      setMsg({ ok: false, text: "Network error" });
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    // Double confirmation — deleting a user revokes access and is permanent.
    if (!confirm(`Delete ${user.email}? This removes their account and revokes access.`)) return;
    if (!confirm(`Are you sure you want to delete this user?\n\n${user.email} will be permanently removed. This can't be undone.`)) return;
    setDeleting(true);
    setMsg(null);
    try {
      const res = await fetch("/api/users", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: user.id }),
      });
      if (res.ok) {
        onDeleted();
        return;
      }
      const data = await res.json().catch(() => ({}));
      setMsg({ ok: false, text: data.error || "Delete failed" });
    } catch {
      setMsg({ ok: false, text: "Network error" });
    } finally {
      setDeleting(false);
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
        <button onClick={save} disabled={saving || deleting}>
          {saving ? "Saving…" : "Save"}
        </button>
        {!isSelf && (
          <button
            onClick={remove}
            disabled={saving || deleting}
            style={{ color: "var(--coral-deep)" }}
          >
            {deleting ? "Deleting…" : "Delete"}
          </button>
        )}
        {msg && (
          <span style={{ fontSize: 13, color: msg.ok ? "#2a7" : "var(--coral-deep)" }}>{msg.text}</span>
        )}
      </div>
    </div>
  );
}
