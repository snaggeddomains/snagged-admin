# app.snagged.com consolidation spec

Status: **approved architecture, pre-implementation**
Owner: consolidation agent (this repo)
Last updated: 2026-05-31

Unifies two existing Vercel apps under one umbrella at `app.snagged.com` with a
single login and a two-tier (module + action) permission model:

- **snagged-admin dashboard** (this repo, `dashboard/`) — Next.js 14 App Router.
  Becomes the **umbrella shell** and serves the `/admin` module natively.
- **research.snagged.com** (separate repo `domain-research`) — vanilla Node
  serverless + no-build static SPA on Vercel. Becomes the **`/research`
  module**, proxied under the umbrella.

## Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Identity / session | **Reuse research's custom `dr_auth` HMAC cookie.** No Supabase Auth migration. |
| 2 | Nesting | **True path nesting** — `app.snagged.com/research/*` via Vercel proxy rewrite. |
| 3 | RBAC storage | **Extend the existing `permissions` JSONB** into a codified module+action catalog. No normalized roles tables. |
| 4 | Where the umbrella lives | **This repo** — `dashboard/` grows into the `app.snagged.com` shell. |

## Shared contract (the seam)

Three things both apps must agree on:

1. **`AUTH_SECRET`** — identical value set in *both* Vercel projects. Signs/verifies `dr_auth`.
2. **Cookie domain `.snagged.com`** — so the cookie is sent to the umbrella and every module.
3. **Permission catalog** — the canonical list of valid module + action keys (below),
   kept as a small constant duplicated in each app (it is data, not logic).

### `dr_auth` cookie format (authoritative — from research `lib/auth.js`)

```
dr_auth = base64url(JSON payload) "." base64url(HMAC-SHA256(payloadSegment, AUTH_SECRET))
payload = { u: <user_id|"">, exp: <unix-seconds> }   // 7-day max-age, HttpOnly; Secure; SameSite=Lax
```

> **Do not re-derive the signing scheme.** Port `sign()` / `verify()` verbatim
> from research `lib/auth.js` into the umbrella so the two never drift. The
> HMAC is computed over the base64url payload **segment string**, compared
> timing-safe. Confirm exact byte inputs against the research source before
> shipping.

### Permission catalog (v1)

Extends today's flat keys; `admin` is promoted to a first-class module.
`is_admin: true` continues to auto-pass every check.

```
modules (gate: can you ENTER):
  admin                      # the pipeline dashboard (this repo)
  research.domain_owner
  research.trademark
  research.appraisal
  research.naming

actions (gate: can you DO X within a module):
  research.report_deep       # deep vs shallow report tier  (existing: report_deep/report_shallow)
  admin.users.manage         # user + permission administration
  admin.sources.edit         # edit source registry / schedules
```

Back-compat: existing rows use flat keys (`domain_owner`, `trademark`,
`appraisal`, `naming`, `report_shallow`, `report_deep`). The new `userCan` /
`userCanAction` must read both the namespaced and legacy flat keys during
transition.

## Identity store

One table, shared by both apps, read via the Supabase **service-role key**
(RLS stays enabled with no policies — backend-only). No link to `auth.users`.

- Table: `domain_research_users` (rename to `app_users` is **optional/deferred** —
  not required for v1; if renamed, update both apps + the two FKs in
  `domain_research_runs.user_id` and `domain_research_naming_runs.user_id`).
- Columns of interest: `id uuid pk`, `email`, `password_hash` (scrypt),
  `is_admin bool`, `permissions jsonb`.

## Routing topology

```
app.snagged.com  (Next.js umbrella)
├── /                 redirect → /admin (or a landing tile grid)
├── /login            shared login form
├── /admin            pipeline dashboard  (existing Sources/Config/Schedule, gated by module "admin")
├── /admin/users      user + permission management  (gated by action "admin.users.manage")
└── /research/:path*  → Vercel rewrite/proxy → research deployment (re-pathed under /research)
```

Auth flow: cookie on `.snagged.com` → middleware verifies HMAC+exp → request
reaches the right module → module loads the user and enforces module/action
permission. Because the cookie is domain-wide, proxied research functions read
`dr_auth` unchanged.

---

## Implementation — file-level, by phase

Each phase is independently shippable. Phases 1, 3, 5 contain **research-repo**
work (marked ⟶R) that requires a session scoped to `domain-research`.

### Phase 0 — Env wiring (no code)
- Set in **both** Vercel projects: `AUTH_SECRET` (same value).
- Set in the **umbrella** project: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
  (to read `domain_research_users`). These already exist in research.
- Add `app.snagged.com` as a domain on the umbrella project; point DNS.

### Phase 1 — Shared session (umbrella verifies the cookie)
New files in `dashboard/`:
- `lib/auth.ts` — port `sign`/`verify`/`COOKIE` constants from research
  `lib/auth.js`; export `verifyCookie(token): {u, exp} | null` (Web Crypto
  HMAC so it runs on the Edge middleware runtime).
- `lib/supabase.ts` — service-role client (`createClient`, `persistSession:false`).
- `lib/users.ts` — `getUser(id)` reading `domain_research_users`.
- `lib/permissions.ts` — the catalog constant + `userCan(user, moduleKey)` and
  `userCanAction(user, actionKey)` (mirror research semantics: `is_admin ||
  perms[key]`, with legacy-flat-key fallback).
- `middleware.ts` — **Edge**: read `dr_auth`, `verifyCookie`, check `exp`. No
  cookie/invalid → 302 `/login?next=…`. Valid → continue. (DB/permission load
  happens in the server component, not middleware.)
- `app/login/page.tsx` + `app/api/login/route.ts` — login form; the route
  **proxies to research's existing `/api/login`** (which owns scrypt verify,
  reset, bootstrap) and re-emits the returned `Set-Cookie` with
  `Domain=.snagged.com`. Keeps one source of truth for credential logic.

⟶R **research:** change `setAuthCookie` to add `Domain=.snagged.com`
(`lib/auth.js`). One line. Ship to research first so both sides agree.

*Shippable result:* one login works across `app.snagged.com` and
`research.snagged.com` even before re-pathing.

### Phase 2 — Umbrella shell + `/admin`
- `app/nav.tsx` — replace the three flat tabs with module-aware nav: an
  "Admin" group (Sources/Config/Schedule) + a "Research" link, each hidden
  unless `userCan`. Pass the user/permissions from a server layout.
- `app/layout.tsx` — load the current user (server) and provide it to nav.
- Move existing pages under `/admin`: `app/page.tsx`→`app/admin/page.tsx`,
  `app/config`→`app/admin/config`, `app/schedule`→`app/admin/schedule`.
  Add `app/page.tsx` that redirects `/`→`/admin`.
- Gate the `/admin/*` segment on module `admin` (in its `layout.tsx`; 403 page
  if lacking).

### Phase 3 — Nest research under `/research`

**Contract: keep-prefix proxy.** Research becomes an app served at base path
`/research` — SPA, assets, AND api all carry the `/research` prefix. The umbrella
proxies the prefix through unchanged. This keeps browser URL, asset URLs, and api
URLs all consistent (a strip-prefix proxy would break root-relative asset/api
resolution against `app.snagged.com`).

Target URL shape:
```
research.snagged.com/appraisal/Orbie.ai   →   app.snagged.com/research/appraisal/Orbie.ai
research.snagged.com/api/lookup           →   app.snagged.com/research/api/lookup
```

**Umbrella (this repo) — done at cutover, after research re-paths:**
1. `next.config.mjs` rewrite (keep-prefix):
   ```js
   async rewrites() {
     const r = process.env.RESEARCH_ORIGIN || "https://research.snagged.com";
     return [{ source: "/research/:path*", destination: `${r}/research/:path*` }];
   }
   ```
2. `app/nav.tsx` — flip the Research link from the research subdomain to `/research`.
3. `app/api/login/route.ts` — update the proxy target from `${RESEARCH_ORIGIN}/api/login`
   to `${RESEARCH_ORIGIN}/research/api/login` (research's auth endpoints move under
   the prefix too).

⟶R **research** — re-path the whole app under `/research`:
1. `vercel.json` rewrites — serve the SPA shell, assets, and api under `/research/*`.
2. `index.html` — make asset/script/img `src`/`href` `/research`-prefixed (or set a
   `<base href="/research/">`).
3. `public/app.js` `currentToolRoute()` regex — accept `/research/(trademark|appraisal|naming)…`.
4. Client `/api` fetch base — prefix so calls resolve under `/research/api/*`.
5. Hardcoded `https://research.snagged.com` defaults in `lib/auth.js`, `api/login.js`,
   `api/users.js` (email links etc.) — point at `https://app.snagged.com/research`.
6. **Old-link redirects (required):** `vercel.json` `redirects` (301) from the old
   root paths to the new canonical URLs, so bookmarks/shared links survive:
   ```json
   { "redirects": [
       { "source": "/", "destination": "https://app.snagged.com/research", "permanent": true },
       { "source": "/:tool(trademark|appraisal|naming)/:rest*",
         "destination": "https://app.snagged.com/research/:tool/:rest*", "permanent": true }
   ]}
   ```

**Cutover sequence (avoid a broken window):** research ships the re-path + redirects
first (so `research.snagged.com/research/*` works and old paths 301 out) → then the
umbrella merges the 3 umbrella changes above. The Research nav link and login proxy
flip in the same umbrella deploy.

*Shippable result:* `app.snagged.com/research/appraisal/Orbie.ai` serves the app;
old `research.snagged.com/appraisal/Orbie.ai` links 301 to the new URL.

### Phase 4 — Two-tier RBAC catalog
- Land `lib/permissions.ts` catalog as the canonical key set; enforce on
  umbrella routes (`/admin` module, `/admin/users` action, etc.).
⟶R **research** — refactor `userCan` / `userCanReportPhase` (`lib/auth.js`) to
  read the namespaced catalog with legacy-flat-key fallback. No behavior change
  for existing rows.

### Phase 5 — Promote user/permission admin to the umbrella
- `app/admin/users/page.tsx` + `app/api/users/route.ts` — user list + create +
  permission editing, gated by `admin.users.manage`. Reads/writes
  `domain_research_users` via the service client. The permission editor renders
  toggles **from the catalog**, so adding a future module = one catalog entry.
⟶R **research** — retire its in-SPA `/admin` user-management view (or leave
  read-only) once the umbrella owns it; `api/users.js` can stay as the backend
  or be superseded by the umbrella route.

## Open items / watch-outs

- **Edge vs Node runtime:** HMAC verify in `middleware.ts` must use Web Crypto
  (Edge). scrypt password checks stay server-side (login proxy → research).
- **Hobby plan function cap:** research is at the 12-function Vercel limit; the
  proxy adds none to research, and the umbrella is a separate project — fine.
- **Proxy latency / cold starts:** acceptable for an admin-only tool; revisit
  if research API calls feel slow through the proxy.
- **Cross-repo execution:** umbrella work happens here; ⟶R steps need a session
  scoped to `domain-research`. Sequence: ship the Phase-1 ⟶R cookie-domain
  change first, then umbrella Phase 1.
- **Supabase naming-universe overlap:** research's Naming module reads
  `name_universe` from the same `SUPABASE_NAMING_*` project this repo's pipeline
  writes — no change needed, just noted as confirmation the apps are one system.
