# Internal Google-Sheet builder for the research app (2026-08-27)

`app/api/internal/naming-sheet/route.ts` — lets the **research** app (which holds NO Google
creds) create a real Google Sheet via admin's service account. Auth = `x-internal-secret ==
RESEARCH_INTERNAL_SECRET` (same pattern as email-threads/sales-comps; `middleware.ts` excludes
`api/internal`). `POST {title, values:string[][], shareWith?:email}` → `{ok, url, warning?}`.
- **Lib** `lib/gsheets.ts` `createSheetInSharedDrive({title, values, shareWith})` — raw-fetch +
  `googleAccessToken` (no googleapis dep, mirrors `lib/sheets.ts`). ⚠️ The SA has **no personal
  Drive** (quota 0), so the file is created via the **Drive API inside the "Snagged Pipeline"
  shared drive** (`parents:[0ACKJ-QAwIhwLUk9PVA]` + `supportsAllDrives=true`) — a plain Sheets
  `spreadsheets.create` / My-Drive create 403s. Then Sheets `values/A1?valueInputOption=RAW` writes
  the rows (gid 0), a batchUpdate bolds the header (cosmetic), and a Drive `permissions.create`
  shares to the requester as writer (best-effort → `warning`). Live-verified end-to-end against the
  real API (create+write+share+trash all 200).
- **Consumed by** research `api/naming.js` "Export to Google Sheet" (see that repo's CLAUDE.md).
  No new env — reuses `RESEARCH_INTERNAL_SECRET` (both projects) + `GOOGLE_SA_KEY` (admin, already
  set for GA/Sheets). This is the "app integration" the Google-Docs/Sheets working-agreement noted
  as not-yet-built; now built (research→admin internal call, not creds-in-research).
- **Optional `formats` directives (2026-09-01).** The endpoint + `createSheetInSharedDrive` accept
  `formats: { currencyColumns?: number[], dimRows?: number[] }` (both sanitized to non-negative ints,
  fully optional + cosmetic). `currencyColumns` = 0-based cols whose DATA rows get a **USD, no-decimals**
  number format (`type:CURRENCY, pattern:'"$"#,##0'` — text cells like "TBD" are unaffected); `dimRows` =
  0-based **DATA-row** indices (header excluded) that get **gray background + strikethrough** (coalesced
  into contiguous ranges, one `repeatCell` per run). All fold into the SAME best-effort header-bold
  `batchUpdate`. Used by research's naming export to format the Price column + strike the off-brief
  ("Cull off-brief") names. Backward-safe: omit `formats` → identical to before.
  - **`formats.filter?:boolean` (2026-09-01)** → adds a **`setBasicFilter`** over the full data range so the
    header row gets filter dropdowns. (Research's naming export passes `filter:true` and also sorts off-brief
    rows to the bottom on its side before sending, so the culled block is contiguous.)

# Feedback / Feature Requests — one central queue, all users submit, Rob-only queue (2026-09-01)

Any logged-in user can log a tweak/addition/new-module idea at **`/feedback`** (a 💡 link in the
TopBar, visible to everyone); it lands in one queue. **On a new submission ONLY rob@snagged.com gets
a bell + email**; **only Rob** (admin / `admin.feedback.manage`) sees + manages the whole queue.
- **Data** (`scripts/feature_requests.sql`, `domain-owner-research` project, run once): `feature_requests`
  (submitted_by/name, module, kind addition|tweak|new_module|bug|other, title, body, status
  open|planned|in_progress|shipped|declined, admin_notes, **attachments jsonb**). RLS enabled. Fail-soft on missing table.
- **Screenshots (2026-09-01).** The submit form takes image uploads — 📎 button, paste, or drag-drop into
  the form/textarea. Uploaded via `POST /api/feedback/upload` (any auth user) → `uploadDealImage("feedback", …)`
  (reuses the public `deal-attachments` bucket, image-only ≤10MB) → `{url,name,type}` stored in
  `feature_requests.attachments`; thumbnails render on each queue row (click = full size). `createFeedback`
  strip-and-retries the `attachments` column so it degrades pre-migration. **Area/module is OPTIONAL** (only
  the title is required).
- **Lib** `lib/feedback.ts`: `createFeedback` (→ `notifyRob`: bell via `createNotification` to rob@'s
  user id + email via `sendEmail` to rob@, both best-effort), `listFeedback({mine|status|q})`,
  `updateFeedback`, and **`feedbackModules()`** — the area picklist DERIVED from the nav tab registry
  (RESEARCH/SNAP/REPORTS/DEALS/ADMIN_TABS labels + "New module / other") so it auto-covers every tool.
- **API** `app/api/feedback/route.ts` (GET `?scope=mine|all` — non-managers forced to `mine`; POST any
  auth user) + `[id]/route.ts` (PATCH status/notes, gated `admin.feedback.manage`).
- **UI** `app/feedback/{page,feedback-client}.tsx` — a standalone page (own TopBar, not in a section):
  submit form (area + type + title + details) + the list. TopBar 💡 link (`app/top-bar.tsx`) opens it.
  **Manager view is the whole queue, no Mine/Full-queue toggle (2026-09-01)** — for Rob there's no
  meaningful "mine", so the toggle is gone; the role decides the set server-side (never sends `scope`:
  a manager gets the full queue with the status filter + search shown; everyone else gets their own
  submissions + threads they've joined). Each row shows the **submitter prominently** (colored initials
  avatar + big name + date) for a manager. `statusF` default `open`. The page uses the STANDARD header
  back/refresh/share — `TopBar`'s `NavControls` now also renders on `/feedback` (not just section pages),
  so the standalone page matches every module.
- **Clarification thread — comments + @mention tagging + screenshots (2026-09-01).** Every ticket has an
  expandable 💬 thread (like the deal comment module) so questions can be sorted out as requests come in.
  Table **`feature_request_comments`** (request_id FK cascade, author_email/name, body, `mentions text[]`,
  **`attachments jsonb`**, created_at + index + RLS — in the same `feature_requests.sql`). `lib/feedback.ts`:
  `listComments`, `addComment({body,mentions,attachments}, author)` (→ `notifyFeedbackComment`: tagged
  teammates get a stronger "tagged you" bell+email, every other **participant** — submitter + Rob + past
  commenters/mentioned — is kept in the loop, minus the author; strip-and-retries the `attachments` column
  pre-migration), `participantTicketIds(email)` (tickets a user commented on OR was tagged in), `getFeedback`.
  **`listFeedback` mine-scope now UNIONs the user's own submissions with tickets they've joined** (so a
  tagged teammate/commenter sees the ticket in their list without being the submitter), and attaches a
  **`comment_count`** per row. **Two ways to tag (both loop the person in, exactly like Deals):** type
  **`@Name`** in the comment body (a type-ahead over the assignee pool + `resolveMentions` resolves the
  tokens on Post — first name / squished full name / email handle) OR click a **Tag chip**; the two are
  merged (`mentionEmails`) and the chips light up to reflect what the @tokens already caught. The @-typeahead
  is keyboard-driven — **↑/↓ move the highlight, Enter/Tab picks it** (no newline / no submit), Escape closes
  — mirrored in the Deals comment composer (`deal-client.tsx`) so both behave the same. **Screenshots
  in comments** (📎 button / paste / drop into the composer) reuse `POST /api/feedback/upload` →
  `deal-attachments` bucket → thumbnails on the posted comment. `@mention pool = assignableUsers()`
  (deals.assignable), returned as `assignees` on the main `/api/feedback` GET. API
  `app/api/feedback/[id]/comments/route.ts` (GET+POST {body,mentions,attachments}, access = manager ||
  submitter || participant). A comment notification links `/feedback?ticket=<id>` → the client auto-expands
  that thread. All comment reads/writes fail-soft on the missing table (thread just doesn't show pre-migration).
- **Permission** `admin.feedback.manage` (ACTION, group Admin) gates the queue + PATCH; submitting +
  commenting need only auth (+ thread access). Rob passes via is_admin. **Setup:** run
  `scripts/feature_requests.sql` on the **`domain-owner-research`** project (the PRODUCTION one with the
  other `domain_research_*` tables — NOT snagged-naming-universe) —
  https://github.com/snaggeddomains/snagged-admin/blob/main/dashboard/scripts/feature_requests.sql —
  it's idempotent, so re-run it to add the `feature_request_comments` table. No new env (reuses the
  notifications table + `sendEmail`). Research-SPA-only users can't reach it yet (admin-app page) — a
  research nav link is a possible follow-up.

# Memory cadence (READ FIRST) — commit CLAUDE.md with the code

When you ship a feature/fix, add/update its `CLAUDE.md` section **in the same commit as
the code**. The chat transcript is NOT a backup — if a session dies or an account is
suspended, only what's committed to GitHub survives. Don't let more than one shippable
change go by without a memory note. Keep it concise: what it does · key files · gotchas ·
one-time setup (SQL/env). Same rule in the research repo's CLAUDE.md.

---

# Deals — native buy-side CRM (Pipedrive DROPPED) (2026-07-21)

Replaced the Pipedrive integration with an in-house buy-side CRM — Pipedrive was too
bloated + per-seat. **Deals is now a top-level module** (peer to Research/Admin/SNAP/Reports)
with a drag-drop board, deal detail, ownership + per-user permissions, notes/activity, a
comment timeline with @mentions, and per-deal Gmail ingestion. The old Pipedrive libs
(`lib/pipedrive*.ts`) are **dormant, not deleted** — nothing imports them now.

- **Data (main project — `scripts/deals.sql`, run once):** `deals` (fields + owner_email +
  stage + status + tags + position), `deal_activity` (timeline: note/comment/stage_change/
  status_change/assignment/created; @mentions in meta), `deal_emails` (ingested Gmail threads,
  unique per deal+thread). RLS enabled (service key bypasses). Idempotency: unique on
  (lower(domain), lower(buyer_email)) — same buyer+domain never duplicates across convert surfaces.
- **Core libs** (`lib/deals/`): `stages.ts` (7 STAGES + STATUSES open|won|lost + PRIORITIES +
  SOURCES; `entryStage(hasOwner)` → Assigned/Inbox), `store.ts` (createDeal find-or-create,
  listDeals owner-scoped, updateDeal w/ auto activity logging, addActivity/listActivity,
  upsert/listDealEmails, boardStats), `notify.ts` (bell+email+Slack for assignment + stage-change;
  bell+email for @mention; Slack → `SLACK_CHANNEL_DEALS`; `dealUrl` = `DASHBOARD_BASE`/deals/<id>),
  `emails.ts` (`ingestDealEmails` — matches deal mailboxes by buyer address / buyer COMPANY
  email-domain (colleagues, non-free-mail) / the target domain name, filters noise senders
  (namejet/marketplace/no-reply/our own notifications) — `isNoise(from,subject,body)` checks
  `NOISE_FROM`/`NOISE_SUBJECT`/**`NOISE_BODY`**; the body check (2026-07-30) drops **transactional
  monitoring alerts** like DomainScout "<domain> has been updated. The EPP Status Codes have been
  changed…" that show as `rob → rob` (so the sender filter alone misses them) — then EXPANDS each matched thread via
  `getThread` and stores **one row per MESSAGE** (`msg_id` = RFC Message-ID) so the full
  back-and-forth shows like Pipedrive — not just the latest per thread; `replaceDealEmails`
  prunes stale on re-pull. **Migration:** `deal_emails.msg_id` + drop the old (deal_id,thread_id)
  unique + a new (deal_id,msg_id) unique index — see `scripts/deals.sql`; pre-migration it
  degrades to newest-per-thread). **Auto-ingested hourly** by cron `app/api/cron/deal-emails`
  (`vercel.json` `15 * * * *`, CRON_SECRET, open deals newest-first, capped) — the manual "Pull
  emails" button on the deal stays for on-demand.
- **API** (gated `deals` module; `deals.all` action sees everyone's, else own + Inbox):
  `app/api/admin/deals/route.ts` GET list (+stats+assignees) / POST create;
  `app/api/admin/deals/[id]/route.ts` GET detail (deal+activity+emails+assignees) / PATCH
  (editable-field whitelist; fires assignment+stage notifications) / POST action=comment|note|ingest.
  `mayTouch` = admin/deals.all or own/Inbox.
- **UI:** `app/deals/layout.tsx` (SectionChrome), `app/deals/page.tsx` + `board-client.tsx`
  (**full-width** kanban — columns `flex:1 0 210px` grow to fill the window; native drag-drop;
  **per-owner color** dot/left-border via `ownerColor(email)`; My/All + Open/Won/Lost/All filters;
  New-deal modal), `app/deals/[id]/page.tsx` + `deal-client.tsx` (**read-first / locked** — fields
  show as text with an **✎ Edit** toggle → Save/Cancel, so nobody's nagged to change things; owner
  shown by NAME; budget = a band `<select>`; a **type-ahead @mention** note box (type `@` → the
  eligible-user autocomplete, chips removed; `resolveMentions` maps @tokens→emails on Post);
  Pipedrive-style **email timeline** rows (envelope, subject, from→to, relative time, expandable snippet)).
- **Assignees + budget (2026-07-21):** every assignee dropdown + the @mention list = `assignableUsers()`
  (`lib/deals/assignees.ts`) — users with the **`deals.assignable`** permission ("can receive deals"),
  shown by **first+last name** (kills the "all app users" dupes like rob@ + rschutz@gmail). Budget is a
  fixed band set (`BUDGET_BANDS` in stages.ts: Under $5k / $5k–$25k / $25k–$50k / $50k–$100k / $100k+),
  stored canonical + a `budget_max` numeric (band ceiling) for sort/search; `normalizeBudget()` maps a
  free-text/inquiry budget → the band; `budgetMaxFor()` → the ceiling. **Migration:** `budget_max`
  column added to `deals.sql` (+ `add column if not exists` for existing tables).
- **Sub-nav + Reporting (2026-07-21):** `DEALS_TABS` = **Board** (`/deals`), **List**
  (`/deals/list` — sortable table, click a row → the deal), **Reporting** (`/deals/reports`,
  gated by **`deals.reports`**). Reporting = filter across ALL deals by any permutation
  (status/owner/stage/source/priority/budget band/asking min-max/date/search) via
  `store.reportDeals` + `reportAggregates` (`app/api/admin/deals/report`), with count/total/by-
  status/by-owner rollups + CSV export. The top-bar back/refresh/**share** controls now render on
  the `deals` + `snap` sections too (`NavControls`), and **share on desktop copies the URL** (the
  native share sheet is used only on touch/mobile — was wrongly firing on desktop for Admin/Reports).
  The research SPA header gained a **Deals** link (`#topbar-deals`, gated by deals access).
- **"How did you hear about us?" → `deals.heard_about` (2026-08-02).** The contact-form attribution
  field (e.g. "X / Twitter") is now a first-class deal column, threaded end-to-end. Research
  `api/lead-enrich.js` `readForm` captures `heard_about` (fallbacks incl. "How Did You Hear About Us?")
  into the lead `form` jsonb → `inquiries.ts` `mapRow` reads `form.heard_about` onto the Inquiry (shown
  in the triage row + passed by the convert modal) → `createDeal({heardAbout})` stores `deals.heard_about`.
  Also accepted by the internal `pipedrive-deal` endpoint (research dossier convert) + on the deal-detail
  EDITABLE whitelist (sidebar "Heard about" read/edit). **Reporting**: a "Heard about" filter (ilike,
  partial match), table column, and CSV column; `reportDeals` also includes `heard_about` in the free-text
  search `.or()`. Both `createDeal` (insert strip-retry over budget_max + heard_about) and `reportDeals`
  (retry without the heard_about clauses) **degrade gracefully pre-migration**. **Migration:** `deals.sql`
  `alter table deals add column if not exists heard_about text;` — until it runs, the field just reads "—".
  - **Where HDYHAU is set (2026-08-02):** AUTO-populated on converts (no re-typing), a small OPTIONAL
    field only where there's no inquiry behind it. Inquiry triage convert (`inquiries-client`) + research
    lead-dossier "Add to Deal" drawer (research `pipedriveCtxFromLead`→`submitPipedrive` passes
    `heardAbout`; `api/pipedrive.js` forwards it; report-surface converts send `''`→null) carry it
    silently; the manual **New deal** board modal (`board-client` NewDealModal) has an optional "Heard
    about" input. Deal detail sidebar shows + edits it.
  - **Inquiry message → deal Notes (2026-08-04):** the buyer's own inquiry MESSAGE (the richest context —
    why they want it, their situation) was making it onto the deal only buried in the ingested email
    preview. Now on convert the buyer's `message` (+ `location`) is carried into the deal's **Notes** so the
    assignee sees it in Details. Both convert paths: triage (`inquiries-client` assembles `📩 Buyer's
    inquiry:\n<message>` → `notes`, route passes it to `createDeal`) and the research lead-dossier drawer
    (`pipedriveCtxFromLead` carries `message`/`location`, `submitPipedrive` → `notes`, `api/pipedrive.js`
    forwards, internal `pipedrive-deal` route passes to `createDeal`). `createDeal` already had `notes`;
    RVal renders it `pre-wrap`. Report-surface converts (no lead) send empty → notes stays blank.
    **Backfill:** `app/api/admin/deals/backfill-inquiry-notes/route.ts` (admin-only; GET dry-run, `?apply=1`)
    fills blank Notes on existing inquiry deals — matches each deal to its lead by `lead_key` (fallback
    buyer email) → `domain_research_leads.form.message` (+ location), writes only where notes is empty.
  - **Backfill (2026-08-02):** `app/api/admin/deals/backfill-heard-about/route.ts` (admin-only; GET =
    dry-run, `?apply=1` writes). Old deals/leads never stored the attribution (readForm only began
    capturing it 2026-08-02), so it re-parses ~3 yrs of contact-form submissions via `leadsReport()`
    (`Lead.source` = the HDYHAU answer), maps buyer email → attribution, and writes `heard_about` where
    still null. One-time; run after the migration.
  - **Reporting sort + group-by (2026-08-02):** `reports-client.tsx` — every results column is
    click-to-sort (`COLS`/`sort` state, blanks last, numeric cols default desc, active header coral +
    ▲/▼; CSV respects the sort). A **Group by** dropdown (Heard about / Budget / Source / Stage / Status
    / Owner / Priority) renders a breakdown table (value · deals · % · total asking, count-desc) computed
    CLIENT-SIDE over the already-filtered/date-ranged result set, with its own Export. So "in this date
    range, break down by Heard About" is one dropdown, no new query.
  - **Date range = one preset dropdown (2026-08-02):** the two From/To date inputs were replaced by a
    single **Date range** select (`DATE_PRESETS`/`presetRange`: All time / Last 7·30·90 days / This month /
    Last month / YTD / Last 12 months / Custom…). A preset fills `f.from`/`f.to`; "Custom…" reveals the two
    date inputs for exact picks. Clear resets it to All time.
- **Nav/perms:** `deals` (MODULE) + `deals.all` + `deals.inbox` + `deals.assignable` +
  `deals.reports` (ACTIONS) + `DEALS_TABS` +
  `canEnterDeals` in `permissions.ts`; `'deals'` SectionKey + SECTIONS entry in `navigation.ts`
  (hub card + header + sub-nav all derive automatically). CATALOG group "Deals". **Visibility
  model:** `deals` = your OWN deals only (strict); `+deals.inbox` = also the unassigned Inbox
  (claim new work); `deals.all` (or admin) = everyone's. `listDeals({all,inbox,me})` +
  `mayTouch` enforce it.
- **Pipedrive→native importer** (`app/api/admin/deals/import-pipedrive`, admin-only): GET =
  dry-run preview, GET `?apply=1` imports every deal in the PD "Buy-Side Deal Flow" pipeline
  (maps custom fields via the field-key/enum-option maps, stage id→name, user_id→email, preserves
  stage/status). Idempotent (createDeal dedupes). One-time migration; reuses the dormant PD client.
- **Triage + research buttons rewired:** the **Buy-Side Inquiries** convert (Deals tab)
  (`app/api/admin/inquiries`) and the research app's **Add-to-Pipedrive** internal endpoint
  (`app/api/internal/pipedrive-deal`, path kept for the research client) both now call
  `createDeal` (native) + `notifyAssignment` instead of Pipedrive. The research button label
  still reads "Add to Pipedrive" — cosmetic rename is a pending cross-repo follow-up.
- **Notifications = per-user preferences (2026-07-21).** `notify.ts` `deliver()` sends each
  recipient only on THEIR enabled channels — **in-app bell / email / Slack DM** — from
  `notif_prefs.deal = {in_app,email,slack}` (default all on; `lib/deals/prefs.ts`). Slack is now a
  **per-user DM** (`lib/deals/slack-dm.ts`, `users.lookupByEmail`+`chat.postMessage`, best-effort —
  needs bot scopes `users:read.email`+`chat:write`+`im:write`; no longer the shared #deals channel).
  **@mentions get the full flow** (bell+email+Slack, per prefs), same as assignment + stage-change.
  Users set their own prefs via the **🔔** modal on the board (`/api/deals/notif-prefs` GET/POST).
  Assignment email subject = clean `📥 Deal assigned: <domain>`; the body doesn't repeat the emoji
  (so the inbox preview isn't a double emoji). **All deal notification emails send FROM
  `Snagged Deals <deals@snagged.com>`** (2026-08-04; `DEALS_FROM` in `notify.ts`, env `DEALS_EMAIL_FROM`)
  — snagged.com is already Resend-verified (domain-level) so no extra setup; covers assignment /
  stage-change / @mention / comment / share since they all route through `deliver()`.
- **Participant notifications on every comment (2026-08-03).** Once you're involved in a deal you
  stay in the loop on ALL future comments, both directions — not just when re-@mentioned. On a comment
  POST (`app/api/admin/deals/[id]/route.ts`) the handler builds the PARTICIPANT set = deal owner +
  everyone shared/tagged (`listSharesForDeal`, which includes every past @mention since a mention
  auto-shares) + every past comment/note author (`listActivity`), then `notifyComment` (`notify.ts`)
  pings them on their enabled channels (bell/email/Slack, per `notif_prefs`), EXCLUDING the author and
  anyone @mentioned in THIS comment (they get the stronger "💬 mentioned you" ping via `notifyMention`).
  So Sam @rob once → both are participants → every later comment from either notifies the other.
  Best-effort (wrapped in try/catch — never fails the comment). No new table/env.
- **Assignment email carries the full deal context + the create-comment (2026-08-06).** The
  `deals@snagged.com` "📥 Deal assigned" email used to show only Assigned-to / Buyer / Budget / Source.
  `notifyAssignment(deal, comment?)` (`notify.ts`) now also includes **Owner contact** (`owner_contact`
  ‖ `likely_owner`, capped 300), the deal **Notes** (the buyer's inquiry message + location — capped
  1500), and the **free-text comment added at deal creation** (`💬 Comment: …`, capped 600) — so the
  assignee gets the whole picture in the email, not just after opening the deal. The comment is threaded
  from all three convert surfaces that already collect it: board New-deal (`deals/route.ts`), inquiry
  triage (`inquiries/route.ts`), and the research Add-to-Deal drawer (`internal/pipedrive-deal/route.ts`)
  — each passes its in-scope `comment` to `notifyAssignment`. The re-assign PATCH path passes none (no
  comment there). The comment still lands as the deal's first timeline comment too (unchanged). No new
  table/env.
- **One-time setup:** run `scripts/deals.sql` on the main project (creates the 3 deal tables +
  `deals.budget_max` + `domain_research_users.notif_prefs`). Reuses the Gmail layer +
  `RESEARCH_INTERNAL_SECRET` + `SLACK_BOT_TOKEN` (for DMs). Grant `deals` per-user, `deals.assignable`
  to deal-takers, `deals.inbox`/`deals.all` as needed; admins auto-pass. Optional `DASHBOARD_BASE`
  (default app.snagged.com).
- **Auto-research + dossier links + convert cleanup (2026-07-22).** Three follow-ups so a deal
  always ties back to its research/lead:
  - **Auto-kick a FREE research report for report-less deals.** Rule: "if a Domain Owner report
    has been run, auto-link it" — now extended so a manually-added deal (or any domain we've never
    researched) *gets* a report. `lib/deals/research-link.ts` `kickResearchRun(domain)` POSTs the
    research app's new internal endpoint `POST /api/internal/kick-research` (`x-internal-secret`,
    `RESEARCH_INTERNAL_BASE` default `https://research.snagged.com`) which dedupes + `createRun` +
    fires the SHALLOW (free pre-flight) pass — no paid credits. Called on **create** (deals POST)
    and once from the **detail GET** when there's still no run (so existing report-less deals like
    donuts.com start one on view); `researchReportLink` (accepts queued/running/done) then fills
    the link on a later view. Fail-open (no secret / down → link just fills later or never).
  - **Lead dossier link on the deal detail.** The detail GET returns `dossierUrl` =
    `${RESEARCH_APP_BASE}/#/lead/<lead_key>` when the deal carries a `lead_key` (i.e. it came from a
    Buy-Side inquiry); `deal-client.tsx` header shows a **👤 Lead dossier ↗** link next to the
    research report. Manually-added deals have no lead_key → no dossier link (nothing to link).
  - **Convert drops the inquiry immediately.** `inquiries-client.tsx` `onDone` now optimistically
    removes the converted row from the queue (server already auto-dismisses it) instead of leaving
    it as "Added — open" until a manual refresh — unless "Show dismissed" is on.
  - **Dossier convert also dismisses + converted inquiries self-hide (2026-07-24).** A deal created
    from the research **lead dossier** ("Add to deal" → internal `/api/internal/pipedrive-deal`) now
    calls `setInquiryDismissed(leadKey,…)` after `createDeal` — same as the in-app triage convert —
    so it drops off the Buy-Side Inquiries queue + the Inbox pointer count (it previously only did
    this on the triage-tab convert, so a dossier-created deal like catalist.com lingered in the
    queue). Belt-and-suspenders: `listBuyInquiries` now also EXCLUDES any inquiry whose `lead_key`
    already has a deal (`deals.lead_key` lookup, active view only, fail-open) — so an inquiry that's
    been converted by ANY path self-hides even if the dismiss flag wasn't set (fixes existing rows
    without a DB write). `countBuyInquiries` inherits the filter → the Inbox count stays accurate.
  - **Dedup also by buyer-email + domain (2026-07-30).** The `lead_key`-only match missed a deal
    created OUTSIDE the queue that didn't carry the lead_key (a dossier "Add to deal", a manual add,
    another surface) — the inquiry lingered in the queue even though its deal was on the board (e.g.
    theventure.com / Stephanie Grant). `listBuyInquiries` now excludes an inquiry when EITHER a deal
    carries its `lead_key` OR a deal exists for its **buyer email + one of its domains** (`deals`
    `domain`+`buyer_email` are stored lowercased == the idempotency key, so a lowercased `.in()` match
    is exact). Two parallel `deals` queries (by lead_key, by buyer_email), fail-open. `countBuyInquiries`
    inherits it → the Inbox pointer stays accurate. Display-layer only (no DB write); works for existing
    rows regardless of how the deal was created.
  - **Free-text Comment on ANY deal-create surface (2026-08-05).** Every place a deal is created now
    takes an optional free-text **Comment** → posted as the deal's FIRST comment on the timeline
    (`addActivity` kind=comment), separate from Notes, so pretext reaches whoever picks it up. Surfaces:
    (1) board **New deal** modal (`board-client` NewDealModal `comment` field → `/api/admin/deals` POST,
    which `addActivity`s it, authored by the creator); (2) **inquiry triage** convert modal (already had
    it — `inquiries-client` → `/api/admin/inquiries`, meta `{via:'triage'}`); (3) the **research
    Add-to-Deal drawer** (research `#pd-comment` → `api/pipedrive.js` sends `comment`+`actorEmail` →
    internal `pipedrive-deal` route `addActivity`s it, authored by the research user). All best-effort
    (a failed comment never blocks deal creation). No new table/env (reuses `deal_activity`).
  - **Buyer-name typeahead (returning clients).** New-deal modal buyer-name field type-aheads
    against prior deals: `GET /api/admin/deals?buyers=<q>` → `searchBuyers` (store.ts, distinct
    known buyers by name/email ilike) → pick fills buyer name/email/company. No new table/env.
- **Sidebar auto-fill from research + link cleanup (2026-07-22).** Two deal-detail polish items:
  - **Auto-fill Likely owner / Owner contact / Appraisal $ from research.** Once a report/appraisal
    has run, the detail GET pulls the structured findings into the sidebar so they're not typed by
    hand. `research-link.ts` `researchReportSummary(domain)` → research `GET /api/internal/report-
    summary?domain=` (`{likely_owner, owner_type, owner_contact, summary, appraisal:{mid,low,high}}`
    from the newest DONE run's report PART-1 via `summarizeReport` + cache-first Appraise.net).
    (Superseded 2026-07-27 — now AUTO-SYNCS, see below.)
  - **Auto-sync owner/appraisal from research + manual-freeze (2026-07-27).** The GET now refreshes
    `likely_owner`/`owner_contact`/`appraisal_value` to the report's CURRENT findings on EVERY view
    (only writing when a value actually changed), so a **re-run report** whose likely owner changed
    flows into the deal on its own. A field the user has **manually edited** is FROZEN and never
    overwritten — tracked in **`deals.owner_manual` jsonb** (`{likely_owner:true,…}`): the PATCH marks
    a field manual only when its incoming value actually DIFFERS from the current one (so an unchanged
    field submitted by the edit form doesn't freeze it); a domain change resets `owner_manual` to null.
    Existing deals have no `owner_manual` → all three auto-sync (which is why tealhealth.com updates on
    next view). Cost: `researchReportSummary` is fetched per deal-detail view (bounded internal DB read;
    add a throttle column later if needed).
  - **"↻ Re-sync from research" button** (deal sidebar, shown when `report_link` exists): POSTs
    `action:'resync-research'` → re-pulls + OVERWRITES the three fields AND clears `owner_manual`
    (un-freezes everything so it resumes auto-syncing) + logs a timeline note. `deal-client.tsx`
    `resyncResearch`; route action in `app/api/admin/deals/[id]/route.ts`.
    **Migration:** `deals.owner_manual jsonb` (`scripts/deals.sql`, `add column if not exists`);
    `updateDeal` strip-retries so auto-sync works pre-migration (only the manual-freeze needs the column).
  - **Header links → sidebar.** Dropped the two header icon-links; `deal-client.tsx` now shows the
    **Buyer name as the 👤 lead-dossier link** (when `dossierUrl` exists) and a compact **📄 Research
    report "Open report ↗"** row (replacing the long raw URL). `RVal` gained `href`/`emoji` props.
  - **Editable PRIMARY domain (2026-07-22).** The deal-edit form gained a **Target domain** input
    (`domain` is on the EDITABLE whitelist). Changing it (e.g. client now wants electron.ai, not
    electron.net) is normalized (lowercase/trim) and — since the linked report/owner/appraisal were
    for the OLD name — the PATCH **resets `report_link`/`likely_owner`/`owner_contact`/`appraisal_value`
    to null** so the next GET re-links + re-fills + kicks research for the new domain. Blank/unchanged
    domain is ignored.
  - **Current offer vs asking, side by side (Sam, 2026-08-07).** The deal-detail Details card now
    leads its price row with **Current offer $** (latest CLIENT offer) next to **Asking $** (latest
    OWNER asking) so the negotiation gap reads at a glance — plus a small **Δ** chip = `asking −
    offer` when both are set. Appraisal $ dropped out of that headline pair to its own line below.
    New nullable `deals.current_offer numeric` (`scripts/deals.sql` create + `add column if not
    exists`); on the EDITABLE whitelist + the edit form (its own input) + the save payload. Purely
    MANUAL (never auto-synced from research, unlike appraisal_value). `updateDeal`'s generic
    missing-column strip-retry degrades it gracefully pre-migration. **Setup: run the `current_offer`
    line in `scripts/deals.sql` on the main project.** Not added to the New-deal/convert create
    surfaces (deal-page field only, per the ask).
  - **Board card shows offer → asking when both set (Rob, 2026-09-01).** `board-client.tsx` card price
    line: when a deal has BOTH `current_offer` and `asking_price`, it renders **`$offer → $asking`**
    (green offer · muted arrow · navy asking) so the negotiation gap reads at a glance; otherwise it
    falls back to `budget_range || usd(asking||appraisal)` as before. `current_offer` added to the board
    Deal type (the list GET already `select("*")`).
    - **Compact money on the card (Rob, 2026-09-01).** `usdK()` renders the card price line as
      **$80k / $52.2k / $1.5M / $500** (no long zeros) to save space; the exact `$80,000` value is in the
      cell's `title` tooltip. Used for the offer→asking pair AND the asking/appraisal fallback; the deal
      DETAIL page still shows full `usd()`.
- **"Didn't proceed" status + link cleanup (2026-07-22).** New terminal status `not_proceeded`
  (STATUSES in stages.ts) — the BUYER bailed before we engaged the owner (didn't pay to pursue),
  distinct from a negotiation Lost. Its own board **drop zone** ("🚫 Didn't proceed", like Mark
  Lost / Archive) → a reason picker (`NOT_PROCEEDED_REASONS`: range wasn't high enough / decided on
  another name / went dark / …) stored in `lost_reason`. Generic `ReasonModal` (LostModal now wraps
  it). `statusLabel()` maps the raw value → "Didn't proceed" everywhere (board badge + filters +
  list + reports). Status filter option added on board/list/reports; no new stage column (behaves
  like Archive — off the open board, visible via the filter). Reopen clears it back to open.
  - **Same-window links.** `RVal` report/dossier links dropped `target=_blank` — the desktop app
    spawned a new window (losing the session) on internal `app.snagged.com` links.
- **Board stages: Transaction added, Closed-Lost column removed (2026-07-24).** `STAGES` (stages.ts)
  is now …In Contact · Negotiating · **Transaction** · **Closed - Won** — added a `Transaction` stage
  (escrow/transfer, after Negotiating & before the Won column) and REMOVED the `Closed - Lost` column
  (redundant with the bottom **✗ Mark Lost** drop-zone). Lost now has no column: `store.ts` no longer
  relocates a lost deal to a "Closed - Lost" stage — it keeps its working stage + a LOST badge, like
  not_proceeded/archived (0 deals had the old stage, so no migration). `board-client.tsx`: dropped the
  dead Closed-Lost column drop-handler AND the redundant bottom "✓ Close Won" zone (Won = drop on the
  Closed-Won column, which fires the confirm-details modal). `CLOSED_LOST_STAGE`/`isClosedStage` kept
  so any legacy row still reads as closed.
- **Inbox column → Buy-Side Inquiries pointer (2026-07-24).** The (usually empty) "Unassigned / Inbox"
  column now surfaces the pending buy-side opportunity queue: the board GET returns `inquiryCount`
  (`countBuyInquiries()` in `lib/inquiries.ts` — buy-side, not-dismissed leads; fail-open 0), only for
  users with `research.pipedrive`; `board-client.tsx` renders a dashed **"📥 N buy-side inquiries to
  triage →"** card in that column linking to `/deals/inquiries`. So the empty Inbox points to where new
  buy-side opportunities actually land (the enriched inquiry@ queue) rather than reading as dead space.
- **Comments UI (Asana-style) + collapsed emails (2026-07-23).** The deal-detail right column was
  reworked: **Comments** (renamed from Activity) now sits ABOVE Emails and renders as an
  Asana-style thread — per row a circular initials `Avatar` (colored by email) + name + relative
  time + body, with @mentions highlighted (`renderMentionBody`), chronological (oldest→newest),
  composer at the BOTTOM ("Comment" button + "N will be notified" hint). System events
  (created/stage/status/assignment) render as compact muted one-liners. **Emails are collapsed by
  default** (▸ toggle) — a deal can have 47+ messages and blew up the page; expand to view the
  chain + the "Pull emails" button. `deal-client.tsx` only.
  - **Per-user comment colors + deep-link (2026-07-23).** Each distinct commenter gets a
    clearly-different color (avatar + name), assigned by order-of-appearance over `OWNER_PALETTE`
    (`commentColor`), so it's easy to see who said what (hash-based `ownerColor` was colliding).
    The Comments card has `id="comments"`; arriving with `…/deals/<id>#comments` scrolls to it. A
    **@mention notification** now links to `dealUrl(id) + "#comments"` (`notify.ts` `deliver` gained
    a `hash` param) so clicking the bell jumps straight into the thread.
- **NEXT (Ph3):** email sequences (outbound) + richer pipeline reporting. Existing Pipedrive
  test deals are NOT migrated (day-one) — start fresh natively.

## SNAP Deal Board — lean internal acquisition tracker (2026-08-28; renamed 2026-08-30)

**Renamed "SNAP Deals" → "SNAP Deal Board" (Rob, 2026-08-30)** — all user-facing labels (SNAP_TABS
label + CATALOG + board H1 / back-link / permission-denied messages; research-SPA nav link + chips).
The perm key `snap.deals`, route `/snap-deals`, and `scripts/snap_deals.sql` are UNCHANGED. Also the
research-SPA SNAP nav was missing the board link entirely (admin nav had it from SNAP_TABS) — added
`#nav-snap-deals` there (research repo). Auto-kicked free reports on add now run BACKGROUND/low-priority
(see research repo `runResearch` concurrency+priority; both `api/internal/kick-research.js` and the
research `snap-research` add_deal send `RUN_REQUESTED data.background:true`).

### Original notes (2026-08-28)

A SEPARATE, deliberately-lean board under the **SNAP** menu (submodule) for tracking names
**we're trying to ACQUIRE** (Sam runs point). NOT the buy-side `deals` CRM — its own table, its
own single permission, a **shared** board (everyone with the perm sees + edits the same deals; no
owner-scoping / assignment / Inbox / notifications / email ingestion / reporting). Rob's spec:
"basically view/edit a single checkbox," manual entry, Sam-internal.
- **Permission:** ONE module key **`snap.deals`** (view+edit; stored flat as `snap.deals` since
  `storageKey` only strips a `research.` prefix). In `dashboard/lib/permissions.ts` MODULES +
  CATALOG (group SNAP) + **SNAP_TABS** (`{href:'/snap-deals', label:'SNAP Deals'}`). `canTab`
  routes it through MODULE_SET→`userCan`; `canEnterSection('snap')` admits a snap.deals-only user
  (sectionTabs>0). Admins auto-pass. Grant per-user in the Users editor.
- **Stages** (`lib/snap-deals/stages.ts`): Qualifying → Research & Outreach → In Contact →
  Negotiating → Transaction → **Closed - Won** (the one terminal COLUMN). No Inbox/Assigned. Statuses
  `open|won|dropped`: dropping a card on the bottom **"🚫 Dropped"** zone (with a reason picker,
  `DROP_REASONS`) sets status=dropped (keeps its working stage + a DROPPED badge); moving to the Won
  column auto-sets status=won (moving back out reopens). Priorities Top/High/Normal/Low (sort within a
  column).
- **Fields per deal** (Rob picked): `domain`, **`owner_info`** (the name's owner / who we're
  negotiating with — free text name+contact), `point_person` (who's running point), `asking_price`
  (asking/target), `current_offer` (shows the gap vs asking), `priority`, `notes`. Plus a
  **progress log** (`snap_deal_activity`) — timestamped manual notes + auto stage/status entries, so
  Sam can see how each name moved over time.
- **Data** (`dashboard/scripts/snap_deals.sql`, run once on the MAIN project): `snap_deals` +
  `snap_deal_activity` (RLS enabled; service key bypasses). Store `lib/snap-deals/store.ts` is
  fail-soft — a missing table (migration not run) returns `[]` / a "not set up" note instead of
  erroring (42P01/PGRST205 guard).
- **API** `app/api/admin/snap-deals/route.ts` (GET list+stats / POST create) + `[id]/route.ts` (GET
  deal+activity / PATCH edit·move·mark / POST `action:'note'` / DELETE) — all gated by `userCan(me,
  'snap.deals')`.
- **UI** `app/snap-deals/`: `layout.tsx` (SectionChrome → resolves to SNAP section from the URL;
  `data-deals-fullbleed` for full width), `page.tsx`+`board-client.tsx` (kanban, drag-drop between
  stages, New-deal modal, Dropped drop-zone, search + status filter), `[id]/page.tsx`+`detail-client.tsx`
  (read-first fields with an ✎ Edit toggle + the progress log + note composer + Delete). Inline styles,
  same conventions as the deals board.
- **One-time setup:** run `scripts/snap_deals.sql` on the main project; grant `snap.deals` to Sam (+
  anyone else who should see it). No new env. **Minor known gap:** the SNAP section's top-level header
  link still points at `/research/evaluate`, so a user with ONLY `snap.deals` (no SNAP Eval) clicking the
  bare "SNAP" header lands on a denied page — they reach the board via the **SNAP Deals sub-tab / hub
  card** instead. Fine for Sam (has other SNAP perms); revisit if a snap.deals-only user needs the header
  link to land here.

## Owner intelligence directory + email-cron heartbeat (2026-07-23)

Two additions to the Deals CRM.

**Owner directory (Deals → Owners).** A persistent record of every domain owner we work
with — contact info, a general dossier, and **how they've negotiated over time** — built up
across deals so we accrue a robust view of who owns what and how they deal. Confirmed at the
**Negotiating** stage (when we're confident who truly owns the name).
- **Data** (`scripts/deals.sql`, run once): `deal_owners` (name, kind person|company|unknown,
  company, emails[]/phones[]/links[], reachability, notes, **negotiation_notes**, created_by) +
  `deals.domain_owner_id uuid → deal_owners(id) on delete set null`. RLS enabled (service key
  bypasses). Emails stored **lowercased** so dedup (array overlap) is reliable.
- **Lib** `lib/deals/owners.ts`: `listOwners({q})` (+ deal counts), `getOwner`/`ownerDeals`,
  `findOwner` (dedup by shared email, else exact name), `createOwner`/`updateOwner` (array
  `*_add` merge; `negotiation_append` appends a `[date · user] …` line so history accrues),
  `linkDealOwner`, **`confirmOwnerForDeal`** (find-or-create + link + merge contacts + append a
  neg note — idempotent), `searchOwnersTypeahead`.
- **API** `app/api/admin/deals/owners/route.ts` (gated `deals`): GET list / `?id=` detail (owner
  + every linked deal) / `?typeahead=`; POST `{action: save|confirm|link|unlink}`.
- **UI**: `app/deals/owners/{page,owners-client}.tsx` (searchable card grid + New-owner modal),
  `app/deals/owners/[id]/{page,owner-client}.tsx` (contact/dossier + editable **negotiation
  history** + the names we've worked with them → each links to its deal). Tab added to
  `DEALS_TABS` ("Owners", perm `deals`). No new permission — `deals` gates it.
- **Confirm-owner modal** `app/deals/confirm-owner-modal.tsx` (shared by board + detail): fires
  when a deal **moves to Negotiating** — board drag into the Negotiating column OR the deal-detail
  stage change (post-save transition). Prefilled from the deal's `likely_owner` + `owner_contact`
  (contact string auto-split into emails/phones), with a **typeahead to link an existing owner**
  (avoid dupes) + a first negotiation note. Skips if the deal already has `domain_owner_id`; a
  "👤 Confirm owner" button on the detail sidebar re-opens it if skipped. Deal detail GET returns
  `ownerRecord {id,name}` → sidebar "👤 Owner record ↗" link.

## Owner Review queue — confirm "who we bought from" per Master Txn (2026-09-01)

A human-in-the-loop backlog to confirm the OWNER we acquired each closed Master Txn name FROM
(the seller — NOT the buyer we later sold to, NOT the broker/escrow), surfaced from the
acquisition emails. Rob/Brian/Sam each get a per-user queue + an Admin banner; **Confirm →
upsert into `deal_owners` + link every deal for that domain** (reuses the Owners directory). New
Master Txn rows create a new pending card (Increment 2 cron — not built yet; the in-app LLM+Gmail
miner over all 477 txns is also Increment 2).
- **Why human-confirm:** direction (buyer vs seller) can only be read from the thread. Calibration
  proved 3 outcomes — a direct seller found (~1/3), broker/escrow-hidden (owner not in email),
  or auction/registration/inbound-sale where only the BUYER is in email. So each card is
  Confirm / Edit-then-confirm / Reject (surfaced candidate is WRONG) / Skip (decide later) /
  **Dismiss** (all non-confirm terminals reopenable). **Skip is pure NAVIGATION (Rob, 2026-09-02):**
  it just advances to the next card and leaves this one **pending/open** — it does NOT set a `skipped`
  status or move it out of the queue (client-side `onSkip` = bump the index; no API call). The
  backend `setCardStatus('skipped')` + the "Skipped" filter tab remain for any historically-skipped
  cards, but the review flow no longer creates them. **netz.com gotcha:** Uzi was the BUYER, not
  the seller — the heuristic that only saw escrow.com got it backwards; direction matters, hence the
  manual gate.
- **The whole point is a DB of ACTUAL owners (Rob).** When we bought through a broker / marketplace /
  auction / registration (GoDaddy, Spaceship, Afternic, Sedo, Escrow, DropCatch auction, a
  registration…) there's genuinely no owner to record → **Dismiss** is the right call, NOT Confirm.
  The client's `isNoOwner(card)` (no candidate surfaced AND (confidence broker/none OR the channel
  matches `NO_OWNER_CHANNEL`)) makes **Dismiss the PRIMARY (purple) button** on those cards + shows a
  hint bar ("no actual owner to record — we only log real sellers"), and de-emphasizes Confirm.
  **Reject** is reserved for a mis-identified candidate (e.g. the buyer named as the seller); **Dismiss**
  is "no real owner exists here." A real named seller on the card → it's a normal Confirm card again.
- **Owner is saved as FIRST + LAST (Rob).** The card carries `candidate_first_name` + `candidate_last_name`
  (added `candidate_last_name` via `alter … add column if not exists`); `candidate_name` is the computed
  "First Last" display/owner name (kept for search + back-compat). The edit form has **First name / Last
  name** inputs; `nameParts()` (lib) resolves first/last from the explicit fields, else splits
  `candidate_name` (first token = first, remainder = last). Confirm writes the owner's `name` = "First
  Last", and the Owners list splits it back into its own First/Last columns. Full name comes from the
  Gmail From/To display header (`"Marc Hadfield <marc@vital.ai>"`) — seed rows patched from the real
  headers via idempotent `update … where status='pending'` (harbor.ai → **Marc Hadfield**, was "Marc
  (Vital.ai)"); a generic role account (`domainnetcontact@gmail.com`) is left name-blank. Increment 2's
  miner extracts first+last the same way at scale. Reviewer can edit name + all contact fields inline (✎).
- **Owners directory (Deals → Owners) is a SORTABLE TABLE, not cards (Rob).** Columns First / Last /
  Company / Email / Phone / Deals / Notes / Updated (house sort pattern — numeric desc, string asc, blanks
  last; default Deals desc); row click → detail. First/Last derived from the owner's `name`. The owner
  DETAIL page (`owner-client.tsx`) gained a **🗑 Delete** button in edit mode (confirm dialog →
  `POST /api/admin/deals/owners {action:'delete',id}` → `deleteOwner`; the FK `on delete set null` clears
  linked deals' `domain_owner_id`, deals otherwise untouched).
- **Deal/domain count = union of `deals` AND confirmed Owner Review cards (Rob, 2026-09-01).** An
  Owner-Review-confirmed seller of a Master-Txn acquisition often has NO buy-side `deals` row (dale.org /
  lfg.ai), so `listOwners` counted 0. Fixed: `deal_count` + a new `domains[]` are the DISTINCT domains
  from BOTH `deals.domain_owner_id` AND `owner_review_cards` (deal_owner_id, status=confirmed) — so a
  confirmed owner shows their acquisition even with no deal. The directory table gained a **"Domains
  closed"** column (first 3 + "+N"); the owner DETAIL lists card acquisitions (`ownerAcquisitions(id)`,
  confirmed cards not already a deal) alongside linked deals under "Names we've worked with them". Both
  reads fail-open if `owner_review_cards` isn't there yet.
- **UI = ONE card at a time** (Rob's call): a single large centered card with a `N of M` counter +
  ← Prev / Next → nav; Confirm/Reject/Skip/Dismiss advance to the next card, so it's a clean triage flow
  (not a grid).
- **Data** (`dashboard/scripts/owner_review.sql`, run once on the **main** project —
  https://github.com/snaggeddomains/snagged-admin/blob/main/dashboard/scripts/owner_review.sql):
  `owner_review_cards` (domain unique(lower), txn_date/price, candidate_name/first_name/email/phone,
  channel, buyer_context, confidence, evidence, notes, status pending|confirmed|rejected|skipped|dismissed,
  assigned_to (per-card reviewer email), reviewed_by/at, deal_owner_id → deal_owners on delete set
  null, source). RLS enabled. **Seeded with the 15 calibrated cards** (`on conflict do nothing`),
  assigned per-card to whoever was most active in the thread. Grant nothing new — gated by `deals`.
- **Lib** `lib/deals/owner-review.ts`: `listCards({assigned_to,status,q})`, `countPending(email)`
  (banner), `getCard`, `updateCard` (editable candidate fields), `setCardStatus`
  (reject/skip/reopen), `reassignCard`, **`confirmCard(id, patch, by)`** = apply edits →
  `findOwner`/`createOwner`/`updateOwner` (merge emails/phones + append a provenance negotiation
  note) → link ALL `deals` rows for `lower(domain)` to the owner → mark confirmed + stamp
  `deal_owner_id`. `upsertCardForDomain` (Increment 2 hook). Fail-soft on the missing table
  (42P01/PGRST205 → []/0) so Admin/Deals stay usable pre-migration.
- **API** (gated `deals`; `userCan(deals)` or `deals.all`): `app/api/admin/deals/owner-review/route.ts`
  GET (`?status=&scope=mine|all&q=` → cards + `myPending` + assignable `reviewers`);
  `[id]/route.ts` POST `{action: confirm|edit|reject|skip|reopen|reassign, patch?, assigned_to?}`.
- **UI** `app/deals/owner-review/{page,owner-review-client}.tsx` — a **DEALS_TABS** tab
  ("Owner Review", perm `deals`, next to Owners). Card grid with status/scope filters
  (Pending·Confirmed·Rejected·Skipped·All × Assigned-to-me/Everyone), inline Edit of the candidate
  fields, Confirm/Reject/Skip/Reopen, a per-card reassign dropdown (`assignableUsers`), and a link
  to the created Owner record. **Per-user banner** `app/owner-review-banner.tsx` mounted in
  `app/section-chrome.tsx` (so it shows across Admin/Deals/Reports/SNAP, honoring "banner at the top
  of admin") — self-fetches `myPending`, hidden on the queue page itself + dismissable.
- **Increment 2 — acquisition-email MINER (2026-09-01, shipped).** `lib/deals/owner-review-mine.ts`:
  - **`resolveNameFromThread(domain, email)`** — DETERMINISTIC full-name pull: the seller's full name is
    the display name attached to their address in the deal-mailbox From/To/Cc headers ("Marc Hadfield
    <marc@vital.ai>"). No LLM. Powers the card's **"⤓ Pull full name from email"** button (shown on a
    pending card that has an email but no last name yet → API action `resolve_name` on `[id]`).
  - **`mineOwnerForDomain(domain)`** — one Anthropic call (`OWNER_REVIEW_MODEL`||`DEAL_RECAP_MODEL`||haiku)
    over the gathered acquisition threads; direction-aware SELLER extraction (NOT the buyer/broker/escrow/
    auction) → `{seller_found, first_name, last_name, email, phone, channel, confidence, buyer_context,
    evidence}`. Fail-open to a "none" result.
  - **⚠️ WHOLE-THREAD gather — was missing the real owner (Rob, 2026-09-02).** The first cut read the first
    ~10 individual messages matching `"<domain>"`, which on a real buy got **swamped by the escrow/broker
    thread** (many transaction/notification emails) so it never reached the SEPARATE direct-negotiation thread
    with the actual owner → tons of false "broker / no candidate seller" cards (e.g. cerebro.ai: escrow.com
    agent surfaced, but the real seller **Alex Garcia <alex@ennube.solutions>** — "50k is the price… otherwise
    it's going to power my LLM app" — was in another thread, missed). Fix in `gatherMessages`: collect the
    **distinct THREADS** mentioning the domain (≤`maxThreads` 6 across mailboxes) and pull **each whole thread**
    via `getThreadCapped` (quota-safe; oldest `perThread` 8 non-bulk msgs/thread so a noisy escrow thread can't
    crowd out the owner thread), dedup by Message-ID. `transcript()` now renders **per-thread blocks** (not one
    date-merged blur) so the model sees escrow AND direct-owner as distinct conversations. SYSTEM prompt gained
    a "look across ALL threads; PREFER the direct human seller who quotes their own price / reveals a personal
    stake / replies from a real address (incl. a person replying THROUGH a privacy relay) over the escrow/broker
    intermediary; only broker/none if NO direct seller in ANY thread" rule. Input cap 12k→16k.
  - **Per-card "↻ Re-mine from email" (2026-09-02).** Existing cards were mined with the OLD (first-10) logic
    and `mineAllTxns` skips domains that already have a card, so they don't self-correct. Added action **`remine`**
    on `[id]` (maxDuration 60): re-runs `mineOwnerForDomain(card.domain)` with the new whole-thread logic and
    OVERWRITES the candidate fields (stays pending). Button on the review card next to Skip; message says whether
    a direct seller was found. Use it on any card that looks wrong / reads "broker · no candidate seller."
  - **`mineAllTxns({limit,dry})`** — reads the Master Txns List (`SNAGGED_TRACKER_SHEET_ID`, tab auto-detected
    domain/date/price cols), newest first, skips domains that already have a card, mines + `upsertCardForDomain`
    each. Bounded per run (Gmail quota + 300s); returns `{created, existing, remaining, note}`. **HARD GUARD:**
    no `ANTHROPIC_API_KEY` → creates NOTHING and returns a `note` (would otherwise flood the queue with empty
    "none" cards). `mineOwnerForDomain` also runs the deterministic `resolveNameFromThread` backstop when the LLM
    gives an email but no last name, so **every auto-created card carries first+last without a click**. API
    `POST /api/admin/deals/owner-review/mine {limit,dry}` (gated deals.all/admin) + a **"⛏ Mine backlog" button**
    on the Owner Review page (shown when `canMine`; runs a **12-txn** batch/click — client aborts at 150s so it
    never hangs; shows created/remaining) + **cron `/api/cron/owner-review-mine` daily `0 15 * * *`** (CRON_SECRET)
    that drains the ~460 backlog over days AND picks up any NEW txn row as its own card. `gatherMessages` is
    globally capped (`maxFetch` 10 reads/domain) so a batch stays under the function budget + easy on Gmail quota.
  - **Assignment + scope (2026-09-01, Rob).** Button-mined cards are **assigned to whoever clicked Mine**
    (`mineAllTxns({assignTo})` → `me.email`); cron-mined cards land **unassigned**. The queue's scope is now a
    **dropdown** (`scope` = "mine" default | "all" | a specific reviewer email), replacing the me/everyone
    buttons. **"Assigned to me" also surfaces UNCLAIMED cards** (`listCards({include_unassigned})` → `.or(assigned_to.eq.me,assigned_to.is.null)`),
    so cron-mined + any unassigned cards show in the default view instead of hiding under "Everyone".
  - **Setup:** needs `ANTHROPIC_API_KEY` in the ADMIN Vercel project (the miner runs there; the sandbox has no
    key). Reuses `GOOGLE_SA_KEY` (Gmail SA, deal mailboxes) + `SNAGGED_TRACKER_SHEET_ID` (both set). Run the
    backfill on demand via the mine endpoint, or let the daily cron accrue it.
- **One-time setup:** run `owner_review.sql` on the main project (idempotent — the last-name column + the
  named-row name corrections re-apply on re-run; the correction guard is `status <> 'confirmed'` so a
  skipped/dismissed card still gets fixed). No new permission. `ANTHROPIC_API_KEY` (admin) unlocks the miner.

## Known-owner match for the Domain Owner report (2026-09-01)

"Have we worked with this owner before?" — surfaced as a banner on the research **Domain Owner
report** (free + full pass) so we lead with the relationship. Cross-app: the report is in research,
`deal_owners` is here.
- **Matcher** `lib/deals/owner-match.ts` `matchOwnersForResearch({domain,email,name})` → `OwnerMatch[]`
  with the owner + **domains closed with them** (union of `deals` + confirmed `owner_review_cards`) +
  the Snagged **point(s) of contact** (deals.owner_email + card.reviewed_by/assigned_to → display
  names) + a `/deals/owners/<id>` link + `matched_by`. Precedence: exact **domain** (a deal or a
  confirmed card for this name) > **email** overlap on `deal_owners.emails` > exact specific **name**.
  Fail-soft (missing table/column → no match).
- **Endpoint** `app/api/internal/owner-match/route.ts` (x-internal-secret == RESEARCH_INTERNAL_SECRET):
  `GET ?domain=&email=&name=` → `{ok, owners}`. Fail-soft to `owners:[]` so it never breaks the report.
  Research side: `api/owner-known.js` + the `#owner-known` banner (see research CLAUDE.md).
- **No new table/env** — reuses `deal_owners` + `owner_review_cards` + `RESEARCH_INTERNAL_SECRET`.

**Email-cron heartbeat.** Rob couldn't tell if the hourly `deal-emails` cron was actually
firing (manual "Pull emails" always worked). Added `cron_heartbeats` (name pk, last_run_at,
last_result) + `lib/cron-heartbeat.ts` (`recordHeartbeat`/`getHeartbeat`, best-effort). The
`deal-emails` cron upserts its row at the end of a run; the board GET returns `emailSync` and the
board header shows **"📥 Email auto-sync: N min ago"** (or "not run yet") so you can see at a
glance whether the cron ran. If it says "not run yet" long after a deploy, the cron isn't firing
(check the Vercel project's cron settings / plan), not a code bug.

**One-time setup:** run the updated `scripts/deals.sql` (adds `deal_owners`, `deals.domain_owner_id`,
`cron_heartbeats`). No new env/permission.

## Comment image uploads + board search-all (2026-07-23)

- **Image attachments in deal comments.** Paste a screenshot into the comment box, drop a file,
  or use the **📎 Image** button → staged as thumbnails (removable) → posted with the comment and
  rendered inline (click = full-size in a new tab). `lib/deals/attachments.ts` uploads to a PUBLIC
  Supabase Storage bucket **`deal-attachments`** (auto-created on first use, unguessable UUID
  paths, 10MB image-only cap) via the service key. Upload route
  `app/api/admin/deals/[id]/upload/route.ts` (multipart `file`, gated like the deal). The
  comment/note POST now accepts `attachments:[{url,name,type}]` → stored on `deal_activity.meta`
  (`meta.attachments`); the URL list is sanitized (http(s) only, ≤10). `deal-client.tsx`: composer
  paste/drop/button + pending thumbnails; `CommentImages` renders `meta.attachments`. **No SQL** —
  reuses the `deal_activity.meta` jsonb; the bucket self-creates. A comment can now be image-only
  (no text required).
- **Board search spans ALL deals for an all-viewer.** The board's "My deals" checkbox no longer
  hides other people's deals from a **search** — when a user who `canSeeAll` types a query, the
  results span everyone's deals even with "My deals" checked (so any deal is findable by
  domain/buyer). Without a search, "My deals" still scopes. `board-client.tsx` `deals` memo
  (`searchingAll` guard; `q` added to deps).

## Deal sharing + My Tasks (2026-07-28)

Two additions to the Deals CRM: share a deal with a colleague, and a personal "My Tasks" to-do list.

- **Sharing = VIEW + COMMENT (not edit).** A shared user can read the whole deal and reply in
  comments / @mention, but can't edit fields, move stages, or reassign — the owner stays in control.
  - **Data** (`scripts/deals.sql`, run once): `deal_shares` (deal_id, user_email lowercased,
    shared_by, unique per deal+user). Lib `lib/deals/sharing.ts` (`listSharesForDeal`, `isSharedWith`,
    `sharedDealIdsFor`, `sharesFor`, `shareDeal` idempotent, `unshareDeal`). RLS enabled.
  - **Two ways to share:** (1) the **🤝 Share** button on the deal detail (pick from `assignableUsers`);
    (2) **@mentioning** someone in a comment AUTO-shares the deal with them (the mention handler in
    `[id]/route.ts` calls `shareDeal` then `notifyMention`). Explicit share fires `notifyShare`
    (bell+email+Slack, `notify.ts`).
  - **Access split** (`[id]/route.ts`): `mayEdit` (admin/deals.all/owner/inbox) vs `mayView` (mayEdit
    OR shared). GET/comment/snooze/share use `mayView`; PATCH + ingest + resync-research require
    `mayEdit` (a shared viewer gets a 403 "view but not edit"). GET returns `shares`, `reminder`,
    `canEdit`; `deal-client.tsx` hides ✎ Edit / Close-won for a shared viewer + shows a "🔗 Shared with
    you · view & comment" badge, and a Share panel (chips + add).
  - **Board scope dropdown (2026-07-28).** The board header's My-deals + Shared-with-me checkboxes +
    the All-owners dropdown were consolidated into ONE **scope `<select>`** (`board-client.tsx`
    `scope` state): `""`=All deals (all-viewers) / `__mine__`=My deals / `__shared__`=🤝 Shared with me
    / `__inbox__`=Unassigned / `<owner-email>`=that owner. All-viewers default to `__mine__`; non-all
    viewers see only My deals + Shared. `__shared__` is a server scope (`GET
    /api/admin/deals?scope=shared` → `sharedDealIdsFor` + `getDealsByIds`, view-only/drag-disabled);
    the rest filter client-side. Budget filter kept as its own select. Search by an all-viewer still
    spans everyone even in `__mine__`.
  - **Hide snoozed (on the BOARD, 2026-07-28).** A **"Hide snoozed (N)"** checkbox in the board
    header (default ON, `localStorage['dealsHideSnoozed']`) drops deals the current user has snoozed to
    a FUTURE date off the board until the revisit date arrives (then it resurfaces as a boomerang on
    their My Tasks). The board GET returns `snoozedIds` (`pendingReminders(me.email)` filtered to
    future); the checkbox only shows when the user has something snoozed. A search overrides it so a
    snoozed deal is still findable. (This lives on the Board, not My Tasks.)
- **My Tasks** (`/deals/tasks`, the **FIRST/default** Deals tab — `SECTIONS.deals.href` = `/deals/tasks`
  so the header/hub "Deals" link lands here; gated `deals`) — a person's Deals to-do list,
  computed LIVE from existing data (no task table to maintain): `lib/deals/tasks.ts` `myTasks(email)`
  → 4 buckets: **replies** (a comment @mentioned me and I haven't replied since — from deal_activity),
  **assignments** (my open deals I haven't touched yet = freshly handed to me), **boomerangs** (deals I
  snoozed whose date arrived), **shared** (deals shared with me). Each clears itself as the condition
  resolves. API `app/api/admin/deals/tasks/route.ts`; UI `app/deals/tasks/{page,tasks-client}.tsx`
  (Asana-style grouped list, click a row → the deal). (A future-snoozed deal is hidden on the BOARD,
  not here — see the board "Hide snoozed" note above; My Tasks surfaces a snooze only once it comes
  due, as a boomerang.)
- **Boomerangs** (`lib/deals/reminders.ts` + `deal_reminders` table): a **⏰ Snooze** control on the
  deal detail sets a PERSONAL revisit date (Tomorrow / 3d / week / custom + a "why" note); it surfaces
  in My Tasks when due. One active reminder per (deal,user). Detail actions `snooze`/`unsnooze`.
- **Degrades gracefully pre-SQL:** the sharing/reminder lib fns fail-open (missing table → [] / null),
  so My Tasks still shows replies + assignments and the deal detail works; sharing + boomerangs light
  up once `deal_shares` + `deal_reminders` are created. **One-time setup:** run the updated
  `scripts/deals.sql`. No new permission (the `deals` module gates it) — a shared user just needs `deals`.

---

# Webflow CMS — Marketplace listings (pull + edit) (2026-07-23)

snagged.com is a Webflow CMS site; the Marketplace listings are a CMS collection (we used to
only SCRAPE `snagged.com/marketplace` HTML — see `lib/snap-names.ts` `snaggedMarketplaceSet`).
This adds a real Webflow **Data API v2** integration to pull every listing and edit it.

- **Client** `lib/webflow.ts` (dependency-free, mirrors hubspot/pipedrive shape — every call →
  `{ok,status,data,error}`, never throws, fail-open when unconfigured). Base
  `https://api.webflow.com/v2`, 429-retry. **Separate token envs so a READ-ONLY token can pull
  without granting writes:** a write token (`WEBFLOW_API_KEY` / `WEBFLOW_API_TOKEN` /
  `WEBFLOW_SITE_TOKEN`, CMS read+write) is preferred for everything; a read-only token
  (`WEBFLOW_API_TOKEN_CMS_READ_ONLY`) serves reads only.
  `webflowCanWrite()` is true only when a write token is set — the API blocks POST writes (403
  "read-only") and the UI hides editing + shows a 🔒 read-only banner otherwise. Covers sites, collections
  (+ field schema), items (`listItems`/`listAllItems` paginated, `getItem`, `createItem`,
  `updateItem`, `deleteItem`, `publishItems`, `publishSite`). Staged vs live via the `/items` vs
  `/items/live` suffix (`live:true`).
- **API** `app/api/admin/webflow/route.ts` (gated `admin.webflow`): GET → connection status +
  sites + the resolved site's collections + a best-guess `marketplaceCollectionId`
  (env `WEBFLOW_MARKETPLACE_COLLECTION_ID` wins, else name/slug regex); GET `?collection=` →
  field schema + ALL items; POST `{action: update|publish|delete}` (update sends only CHANGED
  fields, `publish:true` writes live). `guessMarketplace` picks the collection by name.
- **Admin → Webflow CMS tab REMOVED (2026-07-23)** — editing moved to Reports → Marketplace Master
  (below), so `app/admin/webflow/` was deleted and its `ADMIN_TABS` entry removed. The
  `/api/admin/webflow` **write endpoint stays** (Master's edit modal POSTs to it) and `admin.webflow`
  stays as the write-gate permission (relabeled + regrouped to Reports in CATALOG; no longer an
  Admin tab). The Admin tab had also hit `OAuthForbidden: missing sites:read` on its overview
  (it enumerated sites/collections) — Master sidesteps that by pinning the collection id.
- **Reports → Marketplace "Live listings" section** (`app/reports/marketplace/marketplace-client.tsx`
  `LiveListings`): pulls the PUBLISHED (live) items of the marketplace collection straight from the
  CMS and lists them (count + search + CSV) under the GA traffic table. Fed by
  `app/api/admin/marketplace/live/route.ts` (gated `reports.marketplace`, read-only) →
  `resolveMarketplaceCollectionId` + `listAllItems`. `?all=1` returns the FULL set (published +
  draft); default returns published only. This is the read-only surface a read-only token lights
  up (no editing here — editing lives on the Admin → Webflow CMS tab).
- **Reports → Marketplace Master tab** (`/reports/marketplace-master`, `REPORTS_TABS`, gated
  `reports.marketplace`): a CURATED table of the Domains listings — columns Name · Published ·
  Asking price · Min offer · One-liner · Description · Featured · Premium · Hand-picked ·
  Extension · Categories (Extension/Categories rendered as **pills**, switches as Yes pills,
  descriptions HTML-stripped). Sticky Name column, **Status filter defaulting to Published**
  (+ draft/archived/all with counts), search, CSV, collection picker. Full-window width via a
  generic `[data-wide-page]` marker (`body:has([data-wide-page]) .wrap{max-width:none}` in
  snagged-brand.css, same trick as the deals board). Columns matched flexibly by slug/displayName
  so small CMS renames survive. A "◆ Source: Webflow CMS" badge marks the origin. Reads
  `…/marketplace/live?all=1`. `app/reports/marketplace-master/`.
- **Per-row editing on Master** (one at a time): an ✎ Edit modal for **every** curated field —
  Name, asking/min-offer, one-liner/description (RichText edited as plain text, re-wrapped in `<p>`),
  the switches, AND the **references** (Extension = single `<select>`, Categories = multi-select
  pills) chosen from their option lists. The `marketplace/live` route returns `refOptions`
  (id→name per ref field) + stashes each item's raw ref `refIds` (so display keeps names but the
  editor has/sends ids). Number→number, Switch→bool, only CHANGED fields sent. POSTs to the
  `/api/admin/webflow` update endpoint (publishes live by default). Gated:
  `canEdit = webflowCanWrite() && canAdmin(admin.webflow)`.
- **⚠️ Webflow item live-route gotcha:** for a SINGLE item, `/live` goes AFTER the item id
  (`PATCH /collections/{cid}/items/{itemId}/live`), NOT after `/items` — the collection-level
  list/create use `/items/live`. Getting this wrong = `RouteNotFoundError 404`. Fixed in
  `updateItem`/`deleteItem`.
- **Publish / Unpublish + sort + filters (2026-07-23).** Marketplace CMS edit modal has
  **Unpublish** (`DELETE …/items/{id}/live` — off the live site, kept in the CMS; webflow route
  action `unpublish`) / **Publish live** (`publishItems`) buttons. The `delete` action now does a
  TRUE delete (`live:false`). The table: **every column is click-to-sort** (money numeric, bool,
  else string) and a filter row filters by **extension / category / each flag**. Header blurb
  trimmed to "The Marketplace domains from Webflow CMS."

## Reports → Content — Webflow blog posts (2026-07-23)

New permission-gated Reports tab **Content** (`/reports/content`, `reports.content` in
ACTIONS+CATALOG+REPORTS_TABS) listing the Webflow **Blog Posts** collection (env
`WEBFLOW_BLOG_POSTS_ID`). Read-only: Title (+ ↗ to `snagged.com/post/<slug>`), Summary
(ellipsis), Author, Category. Endpoint `app/api/admin/content/blog/route.ts` (gated
`reports.content`) → `loadCollectionResolved(id,{live:true})` — a **new shared webflow.ts helper**
that fetches a collection's items with Reference/Multi-reference fields resolved to labels (Author,
Category). UI `app/reports/content/{page,content-client}.tsx`; fields located by slug/displayName
regex so small CMS renames survive. **Setup: `WEBFLOW_BLOG_POSTS_ID` set; grant `reports.content`.**

## Content → Crosslinking — SEO internal-link opportunities (2026-07-23)

A sub-view on the Content tab (Posts / Crosslinking toggle in `content-client.tsx`) that stack-ranks
the best INTERNAL cross-link opportunities across the blog (source post → target post) for SEO —
highly-relevant only, with the exact anchor phrase to link.
- **Engine** `lib/content/crosslinks.ts` `analyzeCrosslinks(by)`: pulls ALL posts (published + draft
  — `loadCollectionResolved(WEBFLOW_BLOG_POSTS_ID,{live:false})`), strips HTML, parses existing
  `/post/<slug>` links to skip them. Stage 1 = deterministic **tf-idf term-overlap** shortlists
  `CANDIDATES_PER_POST=8` targets per post (excludes self / already-linked / down-voted). Stage 2 =
  one **LLM call per post** (`CONTENT_CROSSLINK_MODEL`||Haiku) picks ≤4 opportunities: target,
  **anchor phrase copied verbatim from the source body** (validated to actually appear — drops
  hallucinations), context sentence, score 0-100, rationale. Runs with concurrency 6, inserts
  per-post so partial progress persists; `maxDuration=300`.
- **Never anchor on a HEADING (2026-07-23).** Calibration surfaced that many suggested anchors were
  section headers ("Get Smart with Domain Valuations", "Always Use Escrow (Non-Negotiable)") — we
  don't turn headings into links, we want body prose that reads naturally. `stripHtml` had flattened
  headings into the body text, so a header passed the verbatim-appears check. Fix in `crosslinks.ts`:
  `extractHeadings(bodyHtml)` pulls `<h1>–<h6>` **and** a standalone bold paragraph (`<p><strong>…`,
  a Webflow mini-heading) BEFORE stripping → `Post.headings[]`. Those are fed to the LLM ("SOURCE
  HEADINGS — never use as the anchor; pick body prose, or skip the candidate") AND hard-filtered
  post-hoc: an anchor whose normalized text equals or is contained in any heading is dropped
  (`normPhrase`). So even if the model slips, a heading anchor never persists. (Phase 2's link
  INSERTION can then place the body-prose anchor, or add a sentence, without ever editing a header.)
  - **RULE (Rob, 2026-07-23): a header is NEVER the anchor, but the header spot is not lost.** If the
    BEST place for a relevant link falls on/near a heading, we ADD a relevant sentence to make room
    for the link rather than drop the opportunity.
  - **`add_sentence` opportunity kind — SHIPPED in the analysis pass (2026-07-23).** Each opportunity
    now carries a `kind`: **`anchor`** (default — link an existing body phrase, the header-safe path
    above) or **`add_sentence`** (a highly-relevant target with NO natural existing body anchor). For
    `add_sentence` the LLM returns a NEW `new_sentence` (factual, in the post's voice, must not repeat
    existing text) with the `anchor` phrase INSIDE it, plus `insert_after` (a verbatim heading/paragraph
    tail = placement hint, stored in `context`). Validation: anchor must be inside new_sentence + the
    sentence must be genuinely new (not already in the body). The model is told to PREFER `anchor` and
    use `add_sentence` sparingly for high-value links only. UI (`crosslinks-view.tsx`): an `add_sentence`
    row shows a **＋ Add sentence** badge + the proposed sentence (anchor highlighted) + "after: …"
    placement. **Migration:** `content_crosslinks.kind`/`new_sentence` (`scripts/content_crosslinks.sql`,
    `add column if not exists`); `insertOpps` degrades gracefully pre-migration (drops add_sentence rows,
    inserts the anchor rows column-free) so a reanalyze before the SQL still lands the clean anchor set.
- **Feedback trains it:** `content_crosslink_feedback` (pk `source_id,target_id`) — 👍 up (boost +25,
  fed to the LLM as "prefer") / 👎 down (suppressed from output AND from candidate gen AND fed as
  "avoid"). Persists across re-runs.
- **Data** `scripts/content_crosslinks.sql` (run once): `content_crosslink_runs`,
  `content_crosslinks` (the ranked opps), `content_crosslink_feedback`. RLS enabled.
- **API** `app/api/admin/content/crosslinks/route.ts` (gated `reports.content`): GET latest run +
  opps (down-voted/dismissed filtered out) + `canInsert`; POST `{action: analyze|feedback|dismiss|insert}`.
- **UI** `app/reports/content/crosslinks-view.tsx`: Analyze button (heavy, minutes), ranked table
  (score · source ↗ · anchor/＋add-sentence · → target ↗ · why · Insert · 👍/👎/✕), search + min-score filter.
- **Setup:** run the SQL; needs `ANTHROPIC_API_KEY` + `WEBFLOW_BLOG_POSTS_ID` (already set). Optional
  `CONTENT_CROSSLINK_MODEL` (default Haiku — bump to sonnet for sharper relevance).
- **Ph2 — one-click INSERT into the post (SHIPPED v1, 2026-07-23).** `lib/content/insert.ts`
  `applyCrosslink(id,{publish})` writes the link into the actual Webflow blog body.
  `wrapAnchor(html,anchor,slug)` is **HTML-token-aware** (`tokenizeHtml`) — it wraps the first
  occurrence of the anchor in ordinary body text and NEVER links inside a heading (`<h1>–<h6>`) or an
  existing `<a>`, preserving the body's own casing; returns null if the phrase only lives in a heading
  or straddles inline tags (→ "insert manually"). `insertSentence(...)` (add_sentence kind) linkifies
  the new sentence (`linkifySentence`, HTML-escaped) and inserts it as a `<p>` after the block
  containing the `insert_after` hint (fallback: after the first block). Resolves the body RichText
  field per-item (`resolveBodySlug`), `getItem`→rewrite→`updateItem` staged, then `publishItems` if
  `publish`. `status='inserted'` (idempotent — won't re-apply). **Anchor matching is normalized, not
  raw-substring (2026-07-23 fix):** `flatten()` builds a lowercased, whitespace-collapsed,
  entity-decoded view of the body with each flat char mapped back to its raw byte range — the SAME
  normalization stripHtml/the analysis used — so a valid anchor with an `&amp;`/apostrophe entity,
  collapsed whitespace, or an inline `<strong>` inside it is found and wrapped (splicing into the raw
  html; inline tags inside the span survive). Guard rejects a span that would cross a block/heading/
  existing-link boundary → "insert manually". (The first cut matched raw HTML and errored on most
  rows.) **Precise failure reasons + already-linked auto-complete (2026-07-23):** `anchorPlacement`
  reports WHY a phrase can't be placed (edited-out / only-in-a-heading / already-a-link / spans-
  formatting) so the UI error is specific, not one vague line. And `alreadyLinkedToTarget` detects
  when the phrase is ALREADY hyperlinked to that exact target (e.g. an episode-list item whose domain
  name already links to the post) → the cross-link already exists, so `applyCrosslink` marks it
  `inserted` (flips to ✓) instead of erroring/double-linking.
  - **Analysis only proposes INSERTABLE anchors (2026-07-23).** The analysis pass now gates each
    `anchor`-kind opportunity on `anchorPlacement(src.html, anchor)` (the SAME engine the inserter
    uses; `Post.html` carries the raw body) — so a phrase that's only in a heading, already a link,
    or spans formatting is dropped at analysis time, not surfaced then failed at insert. Every anchor
    row shown is one-click insertable. (Re-analyze to clear old un-insertable rows.)
  - **Repoint an existing link (2026-07-23).** If the anchor phrase is ALREADY a link but to a
    worse/external target, we don't skip — `repointAnchorLink` replaces that `<a>`'s href with our
    internal post (only when the whole phrase is the link's visible text AND the current href is NOT
    already an internal `/post/` link, so a deliberate internal cross-link is never hijacked;
    attributes preserved). `computeRewrite` tries body-prose wrap first, then repoint. The analysis
    gate KEEPS an already-a-link anchor only when it's repointable (whole-phrase, non-internal, not
    already our target). Response carries `repointed`; UI notes "↪ Repointed an existing link."
  - **Done rows hide (2026-07-23).** The GET drops `inserted` rows (returns `insertedCount`) and the
    UI removes a row the moment it's inserted/repointed — the screen shows only what needs attention.
    A truly un-insertable click (already-a-link partial / heading / edited) auto-dismisses the row
    with a note instead of a persistent error. Header shows "✓ N inserted".
  - **Bulk insert (2026-07-23).** A checkbox in the first column + a header select-all; when any are
    selected a toolbar shows **Insert staged** / **＋ Insert & publish live** / Clear. `insert_bulk`
    action → `applyCrosslinksBulk(ids,{publish})` GROUPS ids by source post so multiple links into
    one post apply to a single body and write/publish ONCE (no read-modify-write clobber); returns
    per-id results (ok / alreadyLinked / error reason). 200-id cap. UI flips done rows to ✓ and
    summarizes skips. **Gated by `admin.webflow`** (write
  token + permission) — the GET returns `canInsert`; the UI shows **Insert** (staged draft, safe/
  calibration default) + **＋ Live** (publish now) per row, or "✓ Inserted". Env `CONTENT_POST_BASE`
  (default `https://www.snagged.com/post`). Tested: token-walk wrap/insert verified on heading/
  existing-link/escaping cases (10/10). **ROADMAP:** bulk-apply once calibrated; a **light weekly
  cron** scanning only newly-published posts for new backlink spots (vs the full-corpus heavy lift).
- **BACKLOG — NamePros "buy/wanted" sweep (Rob, 2026-07-23):** add the NamePros **Buy Domains /
  wanted** board (`namepros.com/marketplace/buy-domains/?prefix_id=325`) as a section in the SNAP +
  auction sweeps (Python pipeline — `auctions/` + the SNAP `namepros_marketplace` source). Not built.
- **The Marketplace collection is Webflow "Domains"** — collection id `6998a906939f81e325694dc9`
  (slug `domains`, 149 items; fields: Name/Slug, Domain Logo, One-liner Description + Description
  (RichText), Is Featured/Premium/Hand-picked (Switch), **Extension (Reference)**, **Categories
  (Multi-reference)**, …). A **read-only CMS token can't list Sites/collections** (needs Sites-read),
  so auto-detect fails → **pin `WEBFLOW_MARKETPLACE_COLLECTION_ID=6998a906939f81e325694dc9`** in the
  admin Vercel project. Reading the collection's items works on CMS-read alone.
- **Reference fields resolved to labels** (`marketplace/live` route): Extension/Categories come back
  as item IDs; the route fetches each referenced collection once (Domain Extensions / Categories),
  maps id→`name`, and swaps ids for readable "com" / "Tech, Finance". RichText (descriptions) is
  HTML — the Master client strips tags (`plain`) for display/CSV/search. The condensed Live-listings
  + Admin tables prioritize asking-price + min/make-offer columns (`pickColumns` / broadened regex).
- **Permission** `admin.webflow` (MODULE + CATALOG, group Reports) gates EDITING (the write
  endpoint + the Master edit button); the read surfaces are gated by `reports.marketplace`.
  Admins auto-pass.
- **One-time setup:** in Webflow → Site settings → Apps & integrations → API access → **Generate
  API token** with CMS read+write (+ Sites read) → set `WEBFLOW_API_TOKEN` in the ADMIN Vercel
  project → redeploy. Optional `WEBFLOW_SITE_ID` / `WEBFLOW_MARKETPLACE_COLLECTION_ID` to pin
  (else auto-discovered). **NB Site API tokens are scoped to one site.**
- **Follow-up idea:** replace the `snaggedMarketplaceSet` HTML scrape with `listAllItems` (the
  API is the authoritative live set), and/or push SNAP inventory → new listings via `createItem`.

---

# Pipedrive buy-side deal flow — bridge + setup + create-deal core (2026-07-20) — SUPERSEDED

**Superseded 2026-07-21 by the native Deals CRM above — Pipedrive dropped.** Kept for history;
`lib/pipedrive*.ts` are dormant (unimported).

Buy-side inquiries (someone wants us to ACQUIRE a domain for them) are tracked in
**Pipedrive** — a NEW, separate system of record from the HubSpot **sell**-side. Snagged
Admin is the orchestrator/bridge; the research app is the enrichment engine. We do NOT
mirror deals into our own DB — Pipedrive is authoritative. Buy-side stays fully separate
from HubSpot (`lib/hubspot.ts` is the sell-side mirror; the two are independent by design).

- **API client** (`dashboard/lib/pipedrive.ts`) mirrors `lib/hubspot.ts`. Auth =
  `PIPEDRIVE_API_TOKEN` (classic token → `?api_token=` query param, Pipedrive convention),
  base `https://api.pipedrive.com/v1`. `pd()` returns `{ok,data,error}` so nothing throws.
  Read: `getPipelines/getStages/getDealFields/getUsers/getMe`. Write: `searchPersonByEmail/
  createPerson/createOrganization/createDeal/updateDeal/searchDeals/addNote`. **Gotchas:**
  custom deal fields have OPAQUE hash keys (resolve by name at runtime); enum values are
  OPTION IDs (not labels); **Won/Lost are native deal STATUSES, not stages**.
- **One-time setup** (`dashboard/lib/pipedrive-setup.ts` + `app/api/admin/pipedrive/setup/
  route.ts`, admin-gated): `runSetup(dryRun)` idempotently creates the **"Buy-Side Deal
  Flow"** pipeline + **7 stages** (Unassigned / Inbox → Assigned → Qualifying → Invoice /
  Awaiting Payment → Research & Outreach → In Contact → Negotiating) + **18 §8 deal custom
  fields** (Target Domain*, Source / Channel*, Client Name/Contact, Budget Range, Appraisal
  Value $, Priority, Research Report Link, Likely Owner, Owner Contact, Asking/Target Price $,
  Deal Status Marker, Auction Handle, Reachability, Last Buyer/Owner-Contact dates, Deal BCC).
  `GET …/setup` = dry-run preview; `…/setup?apply=1` creates. **APPLIED 2026-07-20** — all
  created ok (verified: only user is Rob; Brian & Sam still need Pipedrive invites for
  assignment to map). Diag: `app/api/admin/pipedrive/diag/route.ts` (read-only).
- **Field/stage resolver** (`dashboard/lib/pipedrive-fields.ts`): `resolvePipedrive(force)`
  (cached ~10min) maps stable field NAMES → hash keys, enum `Name||Label` → option id, stage
  names → ids, + `companyDomain` (from `/users/me`) for `dealUrl(r,id)` →
  `https://<companyDomain>.pipedrive.com/deal/<id>`. Fail-open: an unresolved name is skipped,
  never throws — that's why we don't persist a config table.
- **Create-deal core** (`dashboard/lib/pipedrive-deals.ts`): `upsertBuyDeal(input)`.
  **Idempotency key = deterministic title `${domain} — ${buyerEmail}`** (same buyer+domain
  never duplicates across research surfaces; a different buyer for the same domain is a
  separate deal). Searches deals by domain, matches exact title → returns existing else
  creates. Resolves `assigneeEmail` → a Pipedrive owner (by email, active only) → entry stage
  **"Assigned"** if an owner resolved, else **"Unassigned / Inbox"**. Find-or-create person +
  optional org. `customFields()` maps input → `{key:value}` (enum → option id), skipping
  unresolved (fail-open).
- **Internal endpoint** (`dashboard/app/api/internal/pipedrive-deal/route.ts`): the research
  app's "Add to Pipedrive" button POSTs here. Auth = `x-internal-secret == RESEARCH_INTERNAL_
  SECRET` (same pattern as sales-comps/email-threads; `middleware.ts` excludes `api/internal`).
  `POST {domain*, source*, buyerEmail?, assigneeEmail?, budgetRange?, appraisalValue?, …}` →
  `upsertBuyDeal`; on a NEW deal WITH an assignee, fires the assignment notification (bell via
  `createNotification` + email via `sendEmail` + Slack via `slackAlert(…, SLACK_CHANNEL_DEALS)`)
  — best-effort. Returns `{ok, dealId, created, url, notified}`.
- **One-time setup/env:** `PIPEDRIVE_API_TOKEN` (admin Vercel — DONE), `RESEARCH_INTERNAL_
  SECRET` (already set both apps), optional `SLACK_CHANNEL_DEALS` (buy-side alerts; falls back
  to default channel). Run `…/pipedrive/setup?apply=1` once (DONE 2026-07-20).
- **Phase 1c — SHIPPED 2026-07-20 (research-app "Add to Pipedrive" button).** The internal
  endpoint gained a **GET** returning the drawer metadata the research app needs — the ASSIGNABLE
  Pipedrive owners (active users only, so you never offer an unroutable assignee) + the
  Source/Channel enum labels. New permission is **`research.pipedrive`** (module, group Research;
  stored flat as `pipedrive` — so the research app reads it via `userCan(user,'pipedrive')`),
  NOT `admin.pipedrive` as originally sketched: the button lives on research surfaces and research
  gates by flat keys. Research side (button + drawer + `api/pipedrive.js` proxy) is in the
  domain-owner-research repo (see that repo's CLAUDE.md "Add to Pipedrive"). Brian & Sam invited
  to Pipedrive 2026-07-20, so assignment routing now maps for all three.
- **Buy-Side triage queue — SHIPPED 2026-07-20 (Deals → Buy-Side Inquiries; moved from Admin 2026-07-21).** Intake channel
  is the **inquiry@snagged.com** contact form: Zapier already POSTs each "New Submission" to the
  research app's `POST /api/lead-enrich` (x-internal-secret), which enriches the lead (person
  deep-dive + Apollo firmographics + a free Domain Owner report per named domain) into
  `domain_research_leads` (shared main project). The queue **reads that enriched table directly**
  (`lib/inquiries.ts` `listBuyInquiries` via `getDb()` — admin SUPABASE_URL == research main) and
  shapes it: buyer, company, VIP band, intent/budget, the research triage route (VIP→Rob /
  Notable→Brian / Standard→team), + the dossier link. Buy-side only by default (`looksBuySide`
  on the "Acquire or Sell?" intent; a "Show sell-side too" toggle reveals the rest). Per-row
  **human-click convert** (Rob's discretion — no auto-create) opens a modal → `POST
  /api/admin/inquiries` → `upsertBuyDeal` + `notifyBuyDealAssignment`. Page `app/deals/inquiries/`
  (`page.tsx` gated `userCan(research.pipedrive)` + `inquiries-client.tsx`), tab in DEALS_TABS
  ("Buy-Side Inquiries", perm `research.pipedrive`; `canEnterDeals` admits a pipedrive-only user
  via the tab loop, `canTab` routes it to `userCan`). The convert action + the internal endpoint now
  share `lib/pipedrive-notify.ts` `notifyBuyDealAssignment` (bell+email+Slack, extracted). The
  research **lead dossier** (`#/lead/<key>`) ALSO got an Add-to-Pipedrive button (see research repo).
  - **Setup/env:** optional `RESEARCH_APP_BASE` (default `https://app.snagged.com/research`) for the
    dossier deep-link. **DEPENDENCY:** the queue only populates if the Zapier "New Submission" zap
    POSTs to research `/api/lead-enrich` (with `x-internal-secret`) — verify that zap exists;
    without it inquiry@ emails still arrive but the enriched table stays empty. A lead shows with
    basic fields immediately and fills in VIP/firmographics as enrichment completes.
- **NEXT:** Phase 2 webhooks (needs Advanced tier); per-deal BCC email logging; optional
  auto-convert for high-confidence Acquire leads (currently human-click only).

---

# Client Domain Overlap — Gmail sweep precision (2026-07-21)

The Client Domain corpus (`lib/domain-corpus/`) harvests client domains from the deal
mailboxes to match against new marketplace/auction names. The Gmail sweep was too eager
and polluted the tracked list. Three fixes in `sources/gmail.ts` + `canonical.ts`:
- **Dropped the sender-email-address harvest.** It used to add `canonicalApex(msg.from)` —
  the counterparty's own email domain — so an email FROM a @theverge.com person made
  theverge.com a tracked client domain. Removed; a domain that's genuinely part of a deal
  is still caught via the body-mention path.
- **Gated body-mention harvest on a real domain-deal signal** (`looksDomainDeal`): only
  harvest mentioned domains from emails actually about a domain TRANSACTION (buy/acquire/
  offer/price/inquiry/valuation…). Kills incidental mentions (e.g. isaiahhouse.org in a
  donation email).
- **Sell-intent gate** (`looksSellIntent`): an email offering to SELL us a domain (incl. the
  contact form's "Acquire or Sell?: Sell") is skipped entirely — we track names a client
  OWNS or is HUNTING to BUY, never a seller's offer (e.g. agentstore.io). Both helpers are
  pure regexes in `canonical.ts`; tune the term lists there.
- **Going-forward only** — existing polluted rows in `client_domains` persist (upsert never
  deletes); dismiss them in the report or prune manually.
- **Email distribution (2026-07-23):** the daily overlap email (`app/api/cron/client-overlap`)
  goes to the `reports.client_overlap`-permissioned users PLUS an always-include set —
  `CLIENT_OVERLAP_EXTRA_EMAILS` (comma-separated, default `brian@snagged.com`), deduped into the
  `to`. So Brian gets the email regardless of his report permission (the bell notification stays
  permission-gated). Slack still → `SLACK_CHANNEL_CLIENT_OVERLAP`.
- **⚠️ Dictionary-word anchors are RESTRICTED, not dropped (Rob, 2026-08-31).** The matcher's noise
  guard (`lib/domain-overlap/match.ts` `buildIndex`) used to DROP any anchor whose SLD was ≤3 chars OR
  a dictionary word — which silently suppressed the highest-signal case: a premium **dictionary-word
  .com a client owns** (e.g. `giggle.com`, client Rob) getting its exact word on a liquid TLD
  (`giggle.io` at auction) never flagged, because "giggle" is in `english_words`. Fix: **short SLDs
  (≤3) still fully drop** (noisy even on a major TLD — `go`), but **dictionary-word SLDs (>3) are KEPT
  and RESTRICTED** to **T1 exact-SLD on a MAJOR TLD only** (`MAJOR_TLDS` = com/net/org/co/io/ai). Their
  T2 affix (`getgiggle.com`) and minor-TLD (`giggle.xyz`) matches stay suppressed. `MatchIndex` gained
  `restrictedSlds:Set`; `matchCandidate` skips T1 for a restricted SLD on a non-major TLD and skips T2
  when the core is restricted; `run.ts` skips affix candidate-generation for restricted SLDs +
  surfaces `restrictedSlds` count. Verified: giggle.io/giggle.co FLAG, giggle.xyz/getgiggle.com/go.io
  don't; a client holding `dream.ai` now flags the `dream.com` upgrade. This unlocks a whole class of
  overlaps (many client names are dictionary words — giggle/sword/dreaming/beams).

---

# SNAP Opportunities — valued "worth a look" picks + per-channel Slack (2026-07-18)

Daily top picks, appraised and ranked, surfaced in Reports → SNAP Opportunities + Slack.

- **Picks** (`dashboard/lib/opportunities-picks.ts` `buildPicks`): top-5 **new-snap** +
  top-5 **auctions expiring TODAY** (America/New_York day) by our internal `quality_score`,
  each valued via the research app (Appraise.net value + TLD-demand count), ranked by
  **value ÷ cost** descending (best deal first). `formatBucketSlack(heading, rows)` renders
  one bucket per channel.
- **Cross-app valuation** (`dashboard/lib/research-valuation.ts` `valuateDomains`): POSTs to
  the research app's `POST /api/internal/valuate` (`x-internal-secret` == `RESEARCH_INTERNAL_SECRET`,
  which admin already has). Env `RESEARCH_INTERNAL_BASE` (default `https://research.snagged.com`).
  **The appraisal/TLD keys live ONLY in research — admin calls out instead of duplicating them.**
  Fail-open → unvalued picks (still shows the quality shortlist).
- **UI**: "🔎 Worth a look" section in `app/reports/opportunities/opportunities-client.tsx`
  (lazy-loaded via `app/api/admin/opportunities/picks/route.ts` so the main list stays instant).
- **Priced-only + appraisal deep-link (2026-07-21):** `buildPicks` now requires a real price
  (`hasPrice`, price>0) BEFORE the top-5 select for BOTH buckets — a value-÷-cost pick with no
  cost isn't actionable (drops the unpriced Efty-partner feed rows). The Appraisal cell links to
  the research appraisal tool `/research/appraisal/<domain>` (opens/auto-runs the appraisal run
  for that name; cached run loads instantly).
- **Daily Slack**: `app/api/cron/opportunity-picks` posts the two buckets to their channels + warms
  the research appraisal cache for the day. `?dry=1` builds without posting.
- **CACHED per ET day — instant load (2026-08-28, Rob).** SNAP Opportunities is now the default SNAP
  landing, so re-valuing the shortlist (`buildPicks` → ~10 research appraisals, the slow/straining part)
  on every click was wrong. `lib/picks-cache.ts` caches the built `PicksReport` per **America/New_York
  day**, reusing the existing **`cron_heartbeats`** table (name `opportunity-picks-cache`, `last_result =
  {day, picks}`) so **NO migration**. `getPicksCachedOrBuild(refresh)`: serve today's cache instantly,
  else build once + cache. The **daily cron `setCachedPicks(picks)`** after building, so the first page
  view of the day is instant + valued. The picks route reads `?refresh=1` (force rebuild); the client's
  **Refresh button** now also refetches picks with `refresh=1` (re-values), and the Worth-a-look header
  shows "valued <time>" so it's clear it's cached, not recomputed. Cache goes stale at ET midnight
  (day-key mismatch) → next load rebuilds. No client cache-bust (Next app).
- **Fires RIGHT AFTER the full lists, not on a 9 AM cron (2026-08-27, Rob).** The picks used to run on
  their own Vercel cron `0 13 * * *` (= 9 AM ET), hours after the SNAP + auction lists published.
  Now the **SNAP Orchestrator triggers it as its FINAL step** — after `namecheap_bin`/`auctions_publish`
  post the full lists AND after `commit-state` pushes (so the endpoint's `newOpportunities` →
  `getFile` reads the just-committed `new_today`/`snapshot` from `@main` via the GitHub API). Wiring:
  a "Post 'worth a look' picks" step in `snap-orchestrator.yml` curls `"$PICKS_BASE/api/cron/opportunity-picks"`
  with `Authorization: Bearer $CRON_SECRET`, best-effort (never fails the orchestrator; no-ops if
  `CRON_SECRET` is unset). The `0 13` cron was **removed** from `vercel.json` (would double-post).
  **Setup: add `CRON_SECRET` as a GitHub Actions secret** on snagged-admin (same value as the Vercel
  `CRON_SECRET` the endpoint already checks) — until then the step logs "skipping" and no picks post.
  Optional repo var `DASHBOARD_BASE` (default `https://app.snagged.com`).
- **Cream of the crop, not a fixed top-5 (2026-08-27, Rob).** `buildPicks` (`opportunities-picks.ts`)
  no longer caps each bucket at 5. It now VALUES a wider **POOL** (default 25/bucket by quality, priced
  only), then `creamOfCrop` keeps only the genuine bargains — **appraisal ÷ cost ≥ CREAM_RATIO** (default
  3), best first, capped at **MAX_PICKS** (default 15) as a flood guard. If the research valuation service
  didn't run (every ratio null) it falls back to the top **FALLBACK_N** (5) by quality so the digest isn't
  silently empty; if it DID run but nothing clears the bar, that bucket is empty (no post that day — correct
  for "cream only", not filler). Tune via env `OPPORTUNITY_PICKS_POOL`/`_RATIO`/`_MAX` (needs a redeploy).
  **⚠️ CREAM_RATIO 3 is an un-calibrated first guess** — watch a few days of live picks and raise/lower it.
- **Looser bar + min-5 + never-silent + VISUAL standout (2026-08-28, Rob).** Two live-run findings drove
  this: CREAM_RATIO 3 was too tight (one day = 2 snap picks, 0 auctions → the auctions bucket posted
  NOTHING, and the plain-text post got lost in the busy channel). Fixes in `opportunities-picks.ts`:
  (1) **CREAM_RATIO default 3→2** (looser — a 2× deal now qualifies). (2) `creamOfCrop(rows)` (dropped the
  `valued` arg) now **always surfaces ≥ MIN_PICKS (default 5)** — keeps every bargain ≥ CREAM_RATIO but tops
  up from the next-best so a thin day still shows the day's best 5 (never a silent/empty bucket unless there
  are zero priced candidates), capped at MAX_PICKS 15. (3) A new **`GEM_RATIO` (default 3)** marks the
  exceptional bargains with a **💎** in the line (plain `•` otherwise) so standouts pop within the list.
  (4) **Visual standout:** `bucketSlackPayload(heading, rows, color)` posts each bucket as a **COLORED Slack
  attachment** (green `#2eb67d` snap / amber `#e8912d` auctions) with a **header block** — the colored left
  bar + big header make it scannable among the day's other messages. `slackPost` (`lib/orchestrator.ts`)
  gained an optional `opts.{attachments,blocks}` arg (text still sent as the notification fallback); the
  `opportunity-picks` route builds the payload per bucket. New env knobs `OPPORTUNITY_PICKS_MIN`/`_GEM`.
  `formatBucketSlack` kept as the plain-text fallback.
- **Live-BIN re-price for afternic picks — kills stale-feed false bargains (2026-09-01, Rob).** A pick
  showed sauce.ai at cost **$75,000 → appr $177,500 → "2.4× value/cost"**, but Afternic's LIVE storefront
  BIN was **$295,000** (the real ratio 0.6× — not a bargain at all, shouldn't have surfaced). Root cause:
  our afternic FEED price for sauce.ai was **stale** (a seller raised the BIN after our last feed snapshot
  captured $75k; `name_universe.best_price` still read $75k), and `buildPicks` ranks value/cost on that
  feed price — a stale-LOW cost INFLATES the ratio and manufactures a false bargain. Verified it's a
  stale-row issue, not systemic (firing.ai/rheumatoid.co feed prices matched their live BINs exactly).
  Fix: `lib/afternic-bin.ts` `afternicBin(domain)` / `afternicBins(domains)` — a dependency-free live read
  of the Afternic lander's embedded `"buyNow":<micros>` (÷1e6), bounded concurrency 8, 6s timeout,
  fail-open (mirrors the research app's sweep.js parse). `buildPicks` (`opportunities-picks.ts`) re-prices
  every AFTERNIC-sourced candidate in the valued pool against the live BIN BEFORE computing the ratio +
  ranking (`costOf(d)` → live BIN when readable, else the feed price). Only the small pool is checked
  (≤POOL/bucket), so it fits the 60s route / 120s cron. sauce.ai now re-prices to $295k → ratio 0.6× →
  drops out of the cream. Auctions keep their bid price (real auction sources aren't "afternic"); other
  marketplaces (sedo/atom) keep their feed price for now — extend `costOf` if they show the same drift.
  Underlying staleness self-heals on the next afternic feed refresh; this guards the surfaced picks in the
  meantime. No new env/table/migration.
- **Single-seller portfolio de-flood (2026-07-24).** One owner listing `<name>+word` permutations
  (e.g. julianadvice/julianpartners/juliancorp… from the Efty Partner feed, all unpriced) was
  flooding the SNAP list. `defloodSnap()` in `lib/opportunities.ts` clusters UNPRICED names within a
  source by their leading token (first 5 chars of the SLD); a cluster of ≥5 keeps only the top 3 by
  quality and drops the rest. Priced names are never touched. Report carries `snapCollapsed`; the Snap
  header shows "· N portfolio dupes hidden" (non-silent). Display-layer only (doesn't touch
  state/universe) so it's immediate + affects the SNAP screen + Worth-a-look. Tunable: MIN_PREFIX 5 /
  FLOOD 5 / CAP 3.
- **Per-row quick appraisal (2026-07-24).** Every Auctions + Snap row has an **Appraise** button
  (`AppraiseCell` in `opportunities-client.tsx`) → `GET /api/admin/opportunities/valuate?domain=`
  (gated `reports.opportunities`) → `valuateDomains([d])` (research `/api/internal/valuate`, cached
  there) → shows the Appraise.net **value + TLD-demand count** (+band) inline. Cached per-domain in
  component state (survives filter/sort). POST `{domains}` (≤40) also supported for a future
  appraise-all. Uses the existing `RESEARCH_INTERNAL_SECRET` — no new env.
- **Per-publisher Slack routing** (`lib/orchestrator.ts`): `slackAlert(text, channel?)` +
  `slackPost(text, channel?)` (returns `{ok,error}` for diagnostics). Auctions →
  `SLACK_CHANNEL_AUCTIONS`, snap → `SLACK_CHANNEL_SNAP`, client-overlap →
  `SLACK_CHANNEL_CLIENT_OVERLAP` (client-overlap cron updated to pass it). `slackAlert`
  **auto-joins PUBLIC channels** on `not_in_channel` (needs `channels:join`) and retries once;
  private channels must be `/invite`d manually.
- **⚠️ ENV LESSON (cost us an hour):** ALL Slack env (`SLACK_BOT_TOKEN` + the channel vars) must
  live in the **ADMIN/dashboard Vercel project** (the one serving `app.snagged.com`), NOT research.
  They were mistakenly in research → every `slackAlert` silently returned `no_token` (overlap +
  picks never posted). Vercel env changes need a **fresh deployment** to take effect (an empty
  commit is skipped — push a real change or click Redeploy). Verified live 2026-07-18:
  `slack:{auctions:{ok:true},snap:{ok:true}}`.

---

# Quality scoring — demote `<first name> + <business word>` portfolios (2026-07-24)

Root fix for the julian* flood (a seller listing `<their name> + <business word>` permutations
— julianfirm/juliancorp/julianadvice/… — on Efty). The two-word compound scorer `quality_zipf`
(`filters/universe.py`) rescues real two-word brandables (`lunchmoney`) from a 0 whole-SLD zipf by
scoring the weaker half; but "julian" is a real token to wordfreq (zipf 3.99), so a personal-brand
portfolio scored ~3.4 like any good 2-word .com and the whole batch cleared the SNAP floor at once.
- **`is_name_portfolio(left,right)`** = leading half ∈ a common **first-names** set
  (`filters/data/first_names.txt`, 6,772 SSA names incl. julian/grace, len≥3, `_first_names()` cached)
  AND trailing half ∈ **`BIZ_SUFFIXES`** (corp/inc/llc/ventures/finance/firm/services/advisory/…).
- `quality_zipf` tracks whether the WINNING split is a name-portfolio and, if so, multiplies by
  **`NAME_SUFFIX_PENALTY` 0.15** instead of `COMPOUND_FACTOR` 0.85 → 3.99×0.15 = **0.60**, below the
  SNAP quality floor (1.0), so they drop off the SNAP list. Only the business-suffix shape is hit —
  `gracewell` (name+non-business word) and `markdown` and real compounds (`freshcoffee`) are untouched.
- **Reaches the display via** `supabase_writer.py` (stored `name_universe.quality_score` = `quality_zipf`
  × tld_weight) + `backfill_structural.py` (both call `quality_zipf`). So FUTURE ingests store ~0.6;
  a **structural backfill re-scores existing rows** to purge the current ones (the admin de-flood
  already hides today's). Tests: `tests/test_universe.py`. Tunable: names file, `BIZ_SUFFIXES`, penalty.

---

# Reddit r/Domains SNAP — only mine VERY CLEARLY for-sale posts (2026-07-30)

r/Domains is mostly appraisal / "how would you value X" / "rate my name" posts, not sales, so the
`reddit_domains` source was surfacing names from valuation-request posts (e.g. "What is the rating of
a domain name for apartments?", "How would you value Finals.io?"). Rob's rule: a Reddit post only
hits SNAP if it's **very clearly for sale**. Fix in `sources/reddit_domains.py` `_is_sale_post`,
inverted from a permissive scan to require an explicit signal:
- **Flair-first:** a NON-sale flair (`Appraisal`/`Discussion`/`Help`/`Question`/`Opinion`/…) → never a
  sale (even with a quoted price); a sale flair (`For Sale`/`Auction`/`Selling`) → trust it.
- **No decisive flair:** require an EXPLICIT sale phrase (`STRONG_SALE_RE`: for sale / selling / BIN /
  buy now / make offer / taking offers / asking / OBO / auction / firm / `$N obo|firm|bin|net`) — a lone
  `$` or "offer" is deliberately NOT enough (appraisal posts say "any offers?" / quote what they paid).
  A strong keyword still loses to `APPRAISAL_RE` when there's no firm `LISTING_MARKER_RE` (real price /
  for-sale/selling/BIN/asking) — so "is auction the best way? what's it worth" stays out, while
  "selling X $5k, thoughts?" stays in. Tests: `tests/test_reddit_domains.py` (incl. the two flagged posts).

# Email Health — MXToolbox deliverability report (2026-07-31)

Reports → Email Health (`/reports/email-health`, gated `reports.email_health`) monitors our SENDING
domains' deliverability via the MXToolbox API: **MX / SPF / DKIM / DMARC / blacklist / DNS** per domain,
each distilled to pass/warn/fail + the record value + the specific issues (with MXToolbox deep-links),
and an A/B/F domain grade.
- **Client** `lib/email-health/mxtoolbox.ts` — dependency-free, `{ok,status,data,error}`, fail-open. Base
  `https://api.mxtoolbox.com/api/v1`; auth = `MXTOOLBOX_API_KEY` (plain UUID) as the **`Authorization`
  header, NO "Bearer"**. `Lookup/{command}/?argument=` (DKIM arg = `domain:selector`); `/Usage` for quota.
  **DNS commands use DnsRequests; network (blacklist) uses NetworkRequests — the FREE plan has 0 network,
  so blacklist needs a paid key** (a 429/quota there → the check reads "unavailable", never an error).
  429 retried once. Verified response shape live (no-key test `…/lookup/dns/example.com`): Passed/Failed/
  Warnings/Timeouts arrays, each item `{ID,Name,Info,Url}`.
- **Analysis · Action Items (computed every run).** `checkDomain` also parses the **DMARC policy** (`p=`
  none/quarantine/reject) + whether aggregate reporting (`rua=`) is on, tests **every** DKIM selector
  (not just the best — so a missing Resend key can't hide behind a passing Google key), and
  `buildActions()` derives prioritized (high/med/low) **action items** from the checks: publish/fix DKIM
  (with the exact Google-Workspace `google._domainkey.<domain>` vs Resend `resend._domainkey` guidance),
  add/tighten DMARC (`p=none → quarantine → reject`), turn on `rua` reporting, delist blacklists, fix
  SPF/MX. A records-valid domain that ISN'T enforcing DMARC (`p=none`) grades **B, not A** (spoofable +
  misses inbox trust). Stored on the report jsonb (`dmarc_policy/dmarc_reporting/dkim_selectors/actions`)
  → the UI shows a DMARC-policy chip, per-selector DKIM ✓/✗, and an "Analysis · Action items" block per
  domain; items self-clear as fixed. DNS-SOA warnings are deliberately NOT action items (cosmetic).
- **Report + cache** `lib/email-health/report.ts` — `checkDomain`, `refreshHealth` (sequential, respects
  DNS quota), cached in **`email_health_checks`** (main project; `scripts/email_health.sql`; the action
  items ride the `report` jsonb — no schema change). GET reads cache (no quota); a Refresh button + daily cron re-run.
  Domains via `EMAIL_HEALTH_DOMAINS` (default `snagged.com,snagged.co,email.snagged.com`).
- **Per-domain DKIM selectors (2026-07-31).** Each sending domain signs with a DIFFERENT selector set,
  so a single global list false-flagged "missing DKIM" everywhere. `selectorsForDomain(domain)` +
  `DEFAULT_DKIM_SELECTORS` map (verified live): `snagged.com` → google + k2/k3 (Mailchimp is authed on
  root too); `snagged.co` → google only (its resend/k2/k3/s1/s2 all hit a Porkbun wildcard CNAME with
  NO key — not real selectors); `email.snagged.com` → k2/k3 (the Mailchimp marketing subdomain, added
  this session for reputation isolation of the weekly newsletter). Override/extend via
  `EMAIL_HEALTH_DKIM_MAP="domain:sel/sel, domain2:sel"`. `dkimSelectors()` (`EMAIL_HEALTH_DKIM_SELECTORS`,
  default `google,resend`) is now just the fallback for an unmapped domain.
- **Send-only subdomains + DMARC action wording (2026-08-04).** `sendOnlyDomains()` (env
  `EMAIL_HEALTH_SEND_ONLY`, default `email.snagged.com`) marks a marketing/transactional subdomain
  (no inbox) so its **MX** and **DNS-health** "failures" (no MX, no own SOA — both expected) are set to
  N/A (`unavailable`) instead of failing the grade or spawning "Fix MX" action items. Also fixed
  `buildActions`: a DMARC record at **p=none EXISTS** → it's a "**tighten** (p=none→quarantine)" item,
  not "**add** a DMARC record" (the DMARC check reads p=none as a fail, but `dmarc_policy` is present, so
  the add branch now gates on `!dmarcPolicy` only). Keeps the marketing subdomain from showing false
  red flags during Mailchimp warm-up (real gap there is just SPF: `email` TXT `v=spf1 include:servers.mcsv.net ~all`).
- **API** `app/api/admin/email-health/route.ts` (GET cached report + quota / POST `{action:'refresh',domain?}`).
  **Cron** `app/api/cron/email-health` (vercel.json `30 12 * * *`, CRON_SECRET) re-runs + **alerts on NEWLY-
  failing checks only** (diff vs stored `failing`) via bell + email (`reports.email_health` users) + Slack
  (`SLACK_CHANNEL_EMAIL_HEALTH`). `?dry=1` to preview. Heartbeat `email-health`.
- **UI** `app/reports/email-health/{page,email-health-client}.tsx` — per-domain card (grade chip + per-check
  status pills + record value + failures/warnings with deep-links + quota indicator + per-domain/all Refresh).
- **Permission** `reports.email_health` (ACTIONS + REPORTS_TABS + CATALOG group Reports); admins auto-pass.
- **Setup:** run `scripts/email_health.sql` on the main project; set `MXTOOLBOX_API_KEY` (done). Degrades
  gracefully pre-SQL (a live Refresh still returns results; only caching needs the table). Blacklist needs a
  paid MXToolbox plan (free = 0 network requests).

# SEO report — high-intent keyword rank tracking + weekly action loop (2026-08-10)

Reports → SEO (`/reports/seo`, gated `reports.seo`) — a weekly-cadence report that actively tracks where
we rank for the non-brand MONEY terms (domain broker / domain acquisition / domain appraisal / sell a
domain …), which are gaining/losing distance week-over-week, and the action list to close the gap vs
**MediaOptions** (the two SEO strategy docs Rob shared drove the target list). Combines THREE data sources,
all already wired: **GSC** (`lib/gsc.ts` — SA has `siteFullUser` on snagged.com; real position/impr/clicks/CTR
per term + top movers), **GA4** (`lib/ga.ts` — organic sessions + conversions on the money pages), and
**Ahrefs** (new `lib/ahrefs.ts`, ported from the research Ahrefs client — search VOLUME + our vs competitor
position, incl. terms GSC has no impressions for + the DR/traffic head-to-head).

- **Data model** (`scripts/seo.sql`, MAIN project, run once): `seo_target_keywords` (the curated money-term
  list — seeded from the plan), `seo_keyword_snapshots` (weekly per-keyword GSC/Ahrefs metrics; `scope='target'`
  = the list for WoW deltas, `scope='query'` = the week's top queries for the movers view; unique per
  week+scope+keyword), `seo_actions` (the to-do loop, status todo|doing|done, seeded with the plan's top
  actions). RLS enabled. All reads fail-open pre-migration so the report renders empty until the SQL runs.
- **Volume = the keyword's OWN search volume, source-independent (2026-08-10).** The Volume column was
  blank for terms we don't rank for because it read only OUR org-keyword volume. Now it resolves in order:
  **Ahrefs Keywords Explorer** (`ahrefsKeywordVolumes` — authoritative volume+difficulty for ANY keyword,
  the keyword-planner source, metered separately, fail-open, ⚠️ verify endpoint shape on first run) →
  our org-keyword volume → the **competitor's** org-keyword volume (MediaOptions ranks for the money
  terms, so their data carries each term's volume) → the stored `t.volume`. Guaranteed to populate for
  the money terms via the competitor fallback even if KE's shape needs tweaking. Applied in both
  `buildSeoReport` + `snapshotWeek`.
- **Libs** `lib/seo/`: `store.ts` (CRUD + `weekStart` Monday-anchored + snapshot read/write), `report.ts`
  (`buildSeoReport` — per-term GSC via an `includingRegex` query filter → impression-weighted position;
  Ahrefs volume/competitor via `ahrefsKeywordMap`; GA money-page organic sessions/keyEvents; WoW delta +
  status = gaining/losing/holding/new/not_ranking vs the prior stored week; top movers across all queries;
  and `snapshotWeek()` persisting the trailing-7-day week), `digest.ts` (weekly Slack + email digest).
- **API** `app/api/admin/seo/route.ts` (gated `reports.seo`): GET the live report; POST `add_action`/
  `update_action` (status cycle), `add_target`/`remove_target`, `snapshot`.
- **Cron** `app/api/cron/seo-weekly` (vercel.json **`0 14 * * 1`** = Mondays, CRON_SECRET): `snapshotWeek()`
  then the digest → bell + email (`reports.seo` users + always `rob@`, env `SEO_DIGEST_EXTRA_EMAILS`) + Slack
  (`SLACK_CHANNEL_SEO`, falls back to default). `?dry=1` preview, `?nosnap=1` skip the snapshot. Heartbeat `seo-weekly`.
- **UI** `app/reports/seo/{page,seo-client}.tsx`: head-to-head tiles (DR/traffic/value/keywords us vs
  MediaOptions), the **money-terms table** (keyword · page · position · WoW ▲/▼ distance · status pill ·
  impr/clicks/CTR · volume · competitor position), biggest-movers (gaining/losing, all queries), money-page
  GA performance, and the **action loop** (add + a **checkbox**: checked = Done section, unchecked =
  To-do; OPTIMISTIC — patches local state + background POST, never rebuilds the ~25s report).
  Wide-page layout.
- **Action drill-downs / build kits (2026-08-10).** Each seeded action expands (▸ click) to a full
  **build kit** — slug, title tag, meta, H1, complete page copy, FAQ, JSON-LD schema, internal links —
  rendered from a `seo_actions.playbook` markdown column via a tiny inline safe MD renderer in
  `seo-client.tsx` (headings/bold/code/fenced-code/links/lists). Playbooks live in
  **`scripts/seo_playbooks.sql`** (run AFTER seo.sql; idempotent UPDATE-by-title). The /domain-broker
  kit is verbatim from Rob's Build Kit doc; sell/buy/appraisal/brokered-hub are authored to the same
  template. The **internal-linking action does NOT duplicate a manual playbook — it points to the
  existing Crosslinking engine** (Reports → Content → Crosslinking tab, `lib/content/crosslinks.ts`,
  which already finds + inserts the links). `playbook` is on the `upsertAction` editable whitelist.
- **Permission** `reports.seo` (ACTIONS + REPORTS_TABS + CATALOG group Reports) — nav/hub/sub-nav derive
  automatically from REPORTS_TABS via `navigation.ts`. Grant per-user; admins auto-pass.
- **⚠️ Setup (one-time):** (1) run `scripts/seo.sql` on the MAIN project; (2) **set `AHREF_API_KEY` in the
  ADMIN Vercel project** (it currently lives only in research — without it volume/competitor columns are blank,
  everything else works); (3) grant `reports.seo`; (4) optional `SLACK_CHANNEL_SEO`. GSC + GA already configured
  (SA `siteFullUser` on snagged.com, `GA4_PROPERTY_ID` set). WoW deltas start after the first weekly snapshot
  (click "Snapshot week" or wait for the Monday cron). **Verify Ahrefs `organic-keywords` field shapes on the
  first live run** (ported from the research client, probed against v3 docs but not run from the admin env).
  Optional env: `SEO_COMPETITOR_DOMAIN` (default mediaoptions.com), `SEO_SITE_DOMAIN` (default snagged.com).

# NamePros SNAP — require a real for-sale/auction POST (2026-07-24)

The `namepros_marketplace` source was flagging names that were merely mentioned/"listed" on the
buy-domains page but that we couldn't tie to a specific thread — those fell back to a generic
"find on NamePros" Google `site:namepros.com` search link (not an actual for-sale post). Rob's rule:
a name only qualifies if it's a **specific post under auctions or the buy tab** (someone actively
liquidating it), not just present on a landing page. Fix: after `backfill_links`, `require_post_url`
(`sources/namepros_marketplace.py`) drops any candidate without a captured NamePros listing-thread
URL in `links` — so a domain must be tied to a real buy-domains/auction thread to be surfaced (Slack
+ new_today + snapshot). The `SEARCH_URL` "find on NamePros" fallback is now effectively dead (no
qualifying domain lacks a URL). Tests: `tests/test_namepros.py`.

**Mis-binding fixed (2026-07-27).** `backfill_links` bound a link-less domain (info-widget / fallback
scan) to the NEAREST preceding thread row — even when that row was a different name, manufacturing a
bogus post URL that then survived `require_post_url` (e.g. **aftershock.org $53 → the xfun.xyz thread**,
because aftershock.org only appeared on the page in a "similar threads" box). Fix: backfill now binds
only to the nearest preceding thread **whose slug actually NAMES the domain** (`_url_names_domain` — the
SLD is a token in `/threads/<slug>`). A stray domain under an unrelated thread is left unbound →
`require_post_url` drops it. Keeps the legit widget-only case (lourdes.net → `/threads/lourdes-net.222`,
whose slug names it). Regression test `test_backfill_does_not_bind_stray_domain_to_unrelated_thread`.

**Mis-binding pt.2 — compound-word SLD collision (2026-08-02).** `_url_names_domain` matched the bare
**SLD token**, so a common word buried in a compound false-matched: **green.sh $179 bound to a sodio
thread** whose slug was `sodio-ai-sodio-green-sodioai-com-…` ("green" is a token inside "sodio-green",
a product name — green.sh isn't in the thread at all). Fix: require the domain's WHOLE label sequence
(sld + tld) to appear in the slug as a contiguous token run (`green-sh`) or joined (`greensh`), not the
lone SLD. NamePros renders a listed domain with its extension (lourdes.net → `lourdes-net`, sodioai.com
→ `…-sodioai-com-…`), so legit binds keep working while the compound collisions drop. Regression test
`test_backfill_does_not_bind_on_a_compound_word_slug_collision`.

---

# Atom feed — ignore pending-verification (fake) listings (2026-07-24)

Atom's partner feed (`atom_daily`) lets a submitter LIST a name they don't actually own — it
shows as **"Pending Verification"** on atom.com and is effectively a fake listing. The feed marks
real ones with a **`verified` column** (`1` = ownership-verified; `0`/blank = pending). `_is_verified(row)`
in `src/marketplace_pipeline/sources/atom_daily.py` now gates BOTH the SNAP filter (`entry_from_row`)
and the naming-universe path (`_universe_entries_from_rows`) — a row with `verified != 1` is skipped
everywhere. Backward-safe: a row/feed with NO `verified` column is treated as verified (so legacy
`domain`-column feeds + tests never get dropped). Live feed 2026-07-24: 18,730 verified · ~89 pending.
Tests in `tests/test_atom_daily.py`.

**Cloudflare challenge → scrape.do fallback (2026-08-11).** The daily orchestrator run "failed"
because `atom.com/public/feeds/partner.csv` started returning **403** (`cf-mitigated: challenge`,
`server: cloudflare` — atom.com put the feed behind a Cloudflare challenge). The fetch was a bare
`requests.get(...).raise_for_status()` with no UA → it threw hard, and since atom_daily is the only
non-fail-open source in the orchestrator it flipped the whole run to "failure" (SNAP watchdog +
auto-fix fired). Fix in `atom_daily.py`: `_fetch_feed(url)` tries a direct fetch (browser UA) first,
and on a 403 / Cloudflare-challenge shell falls back to `_fetch_via_scrape_do` (scrape.do super proxy,
no-render, returns raw CSV bytes — same proven pattern as `markmonitor.py`; 3 retries; meters
`scrape_do.request`). Needs **`SCRAPE_DO_TOKEN`** (already in `snap-orchestrator.yml`; **added to the
standalone `source-atom-daily.yml`** in the same commit). Direct path stays the default (no scrape.do
credit unless Cloudflare blocks). Tests still pass (18). **Verified live 2026-08-11** (manual
`source-atom-daily.yml` dispatch): feed fetched **127 MB / 515,769 rows / 263,384 universe entries**
— the 403 is gone. Also **bumped `source-atom-daily.yml` `timeout-minutes` 15→45**: atom_daily upserts
~260K universe rows sequentially (~25 min with transient-retry backoffs), so 15 min cancelled the
standalone manual re-run mid-upsert; the orchestrator's 120-min budget already accommodated it.
- **Retry hardening (2026-08-11).** Cloudflare challenges the runner IP only INTERMITTENTLY — one
  dispatch fetched 127 MB directly (no challenge), the next got a 403 challenge AND scrape.do 502'd
  (its residential super proxy 502s on the ~127 MB download). So `_fetch_feed` now **retries the
  direct fetch 3× over a persistent `requests.Session`** (the `__cf_bm` bot-management cookie set on a
  challenged response can let a follow-up through) before falling back, and `_fetch_via_scrape_do`
  retries **5× with exponential backoff** on transient 5xx/timeouts. Direct-first keeps the big
  download off the flaky proxy whenever the runner isn't challenged. **scrape.do 502s CONSISTENTLY on
  the residential `super` proxy** for the 127 MB file (it can't stream it), so `_fetch_via_scrape_do`
  now tries the **DATACENTER proxy first** (super off — handles the big download; scrape.do still
  bypasses Cloudflare on it), then `super`, against the **https** URL directly. NB the fetch is still
  fundamentally at the mercy of Cloudflare + scrape.do infra — when the runner IP is challenged AND
  scrape.do 502s, the run now FAILS SAFELY (no snapshot write) rather than corrupting state.
- **curl_cffi (TLS impersonation) is the PRIMARY fetch (2026-08-11).** Live testing showed scrape.do
  **502s on the 127 MB download in BOTH datacenter and super modes** (it can't stream a file that
  large), and the plain-`requests` direct fetch gets Cloudflare-challenged (403) because its TLS/JA3
  fingerprint is flagged by Cloudflare Bot Management. Fix: `_fetch_via_curl_cffi` (new dep `curl_cffi`,
  in `pyproject.toml`) fetches with `impersonate="chrome"` — a REAL Chrome TLS fingerprint that passes
  the managed challenge AND pulls the full 127 MB directly (no proxy). `_fetch_feed` order is now
  **curl_cffi → plain requests direct → scrape.do**. curl_cffi is imported lazily (tests + module import
  don't need it) and returns None on failure so the fallback chain still runs. This is the reliable path;
  the earlier direct/scrape.do work stays as fallbacks.
- **Headless-Chromium LAST-RESORT backup (2026-08-11).** When Cloudflare serves a hard **JS managed
  challenge** (a 403 challenge page — verified live: even curl_cffi's real-Chrome TLS fingerprint got a
  5.9 KB 403, because TLS impersonation doesn't SOLVE a JS challenge), the fetch now has a final fallback:
  `_fetch_via_playwright` drives a real headless Chromium (which auto-clears the managed challenge),
  lifts the **`cf_clearance` cookie + the browser UA**, then downloads the 127 MB CSV over plain HTTP with
  those (a browser handles a 127 MB download poorly; the cookie handoff is the reliable part). cf_clearance
  is IP+UA-bound, so it reuses the browser's exact UA + the same runner egress IP. `_fetch_feed` order is
  now **curl_cffi → direct → scrape.do → Playwright**, then raises (safely — the snapshot guards mean a
  total failure never corrupts state). Only engages as a BACKUP when the normal chain is blocked (Rob's
  call). **Needs Chromium in the workflow** — `snap-orchestrator.yml` already installs it; added the same
  `playwright install --with-deps chromium chromium-headless-shell` step to the standalone
  `source-atom-daily.yml`. Playwright is imported lazily + returns None if Chromium is absent, so it
  degrades gracefully. ⚠️ Whether a headless browser clears atom's specific challenge is best-effort —
  verify on the first run that engages it.
- **⚠️ Undersized-response guard — a truncated fetch once WIPED the snapshot (2026-08-11).** A manual
  run got a **10,917-byte** body from scrape.do (425 rows) that passed the challenge-marker check but
  was NOT the real ~127 MB feed. The pipeline treated it as a valid *empty* feed and SAVED an empty
  snapshot, deleting ~263K `universe_snapshot.json` entries + ~2,971 `snapshot.json` diff rows on
  `main` (commit `175690d`) — which would make the next real run flag everything as new. Restored the
  four `state/atom_daily/*.json` files (commit after `175690d`). **Fix so it can't recur:**
  `_is_valid_feed(body)` requires the body be non-empty, not a challenge shell, AND **≥ `MIN_FEED_BYTES`
  (5 MB, env `ATOM_MIN_FEED_BYTES`)** — both fetch paths now reject an undersized body (retry → fall
  back → fail loudly, never return garbage). Belt-and-suspenders: `run()` **raises before writing the
  snapshot** if the parse yields < `MIN_FEED_ROWS` (1,000, env `ATOM_MIN_FEED_ROWS`) rows. So a
  partial/garbage feed now fails the run (visible, recoverable) instead of silently corrupting state.
  Tests: `_is_valid_feed` + direct-undersized-fallback (20 total).
- **✅ Partnership API is now the PRIMARY source — the Cloudflare CSV fight is over (2026-08-12).** After
  Cloudflare hardened atom.com to where the runner IP got a 403 JS-challenge that curl_cffi (real-Chrome
  TLS), direct, scrape.do (502s on the 134 MB download), AND headless Playwright ("challenge did not
  clear / no cf_clearance") ALL failed on — reddening the whole orchestrator (atom_daily is the only
  non-fail-open source) — we switched to Atom's authenticated **Partnership API**, which lives on the
  `/api/` path and is NOT behind the bot-challenge. `GET https://www.atom.com/api/marketplace/partnership-search?api_token=&user_id=&page=&page_size=`
  returns the FULL live marketplace as JSON (`{success, total_records ~277K, total_pages, data:[{domain_name,
  status:"Approved", full_price, selling_price, primary_category, discount, description, purchase_url, …}]}`)
  — richer than the CSV and no 134 MB parse. `_fetch_via_partnership_api()` pages through everything
  (`page_size` 600, ~460 requests, 0.25s pacing) and maps each record onto the CSV row shape
  (`title`←domain_name, `verified`←status=="Approved", `price`←selling_price, `link`←purchase_url — which
  carries our `/rm/<user_id>` partner-referral marker) so ALL downstream parse/filter/score/diff/universe
  code is unchanged. **Completeness guard:** a truncated pull (mid-crawl rate-limit) RAISES rather than
  writing a short snapshot (which would flag thousands as "dropped"). `run()` uses the API as PRIMARY when
  `_partnership_configured()` (both env vars set), **falling back to the old CSV/curl_cffi/scrape.do/Playwright
  chain** on any API error or when unconfigured — so the fetch saga above is still there as a backstop.
  **Auth:** `api_token` = the account's **general/Partnership API key** (NOT the appraisal key — that's
  appraisal-scoped and 403s here), `user_id` = the Atom account id (2660072). **Setup:** secrets
  **`ATOM_PARTNERSHIP_KEY` + `ATOM_USER_ID`** in snagged-admin GitHub Actions (added to `snap-orchestrator.yml`
  + `source-atom-daily.yml` env; done 2026-08-12). Rate limit: `partnership-search` showed no cap in testing
  (the hard 10/day limit is on the separate AI `semantic-search` endpoint); if a full daily crawl ever trips
  one, juan@atom.com (our partnership contact, who already raised the appraisal limit to 100/day) can lift it.
  Optional env `ATOM_API_PAGE_SIZE` (600) / `ATOM_API_DELAY_S` (0.25). API key ≠ appraisal key ≠ homes:
  appraisal key lives in **research Vercel** (appraisal tool); partnership key lives in **admin GH Actions**
  (feed). Verified: mapping + parse + score run clean on a real 600-record sample. Docs:
  https://apidocs.atom.com/api-reference/parnership_apis/partnership_search.
  - **⚠️ Partnership API pagination CAPS at ~10K records (2026-08-13).** Live CI run confirmed: auth works
    and `total_records` reports the full ~277K, but paging stops after **~9,700 records** (empty `data`
    beyond ~16 pages) — a deep-pagination cap, and the only filter param is `query` so there's no clean way
    to partition around it. So the API **cannot export the full catalog as-is**. The completeness guard
    caught the truncation and fell back to the CSV chain (which succeeded that run — the runner IP wasn't
    challenged). **Emailed juan@atom.com (2026-08-13) to lift the cap / provide a bulk export** — wire the
    full API pull once granted. Until then the API attempt just fails fast → CSV fallback.
  - **atom_daily is now FAIL-OPEN (2026-08-13).** Since the feed is only intermittently reachable (CSV
    Cloudflare block is per-IP; API caps at 10K), a fetch failure no longer reds the whole SNAP
    orchestrator. `run()` wraps fetch+parse+rowcount in `_load_inventory()`; on ANY failure it calls
    `_skip_fail_open()` → posts a Slack "⚠️ Atom feed skipped" alert, writes `run_status.json`
    status=`skipped`, and **returns 0 WITHOUT touching the snapshot** (prior baseline preserved, so the
    next good run diffs correctly). `pipeline run atom_daily` exit code = `run()`'s return (`cli.py`
    `return mod.run()`), so returning 0 keeps the orchestrator green. Set **`ATOM_FAIL_OPEN=0`** to restore
    the old hard-fail (raise) behavior. The corruption guards still raise inside `_load_inventory` (caught
    by fail-open → skip, never a partial write). Tests: mapping + `_partnership_configured` + tiny-feed
    reject + skip-returns-0 (26 total).

---

# Google Sheets reader — transient-timeout retry (2026-08-26)

A single **`TimeoutError: The read operation timed out`** on `read_tab_as_dicts`'s `.execute()`
(reading the *'SNAP Domains'* tab) reddened the whole **SNAP Orchestrator** run #90 — because
`snagged_snap_sheet` is a REQUIRED orchestrator source (any required-source failure → `exit 1`),
even though every OTHER source (incl. the other sheet reads) succeeded and state committed clean.
Root cause: the Sheets reader was the one hot path with **no transient retry** (the universe
upserts + gmail `gget()` already back off + retry). Fix in `src/marketplace_pipeline/google_sheets_reader.py`:
a `_execute(request, what)` wrapper with **exponential-backoff retry (2/4/8/16s, 4 attempts)** on
transient errors (`socket.timeout`/`TimeoutError`/`ConnectionError`/`ssl.SSLError`/`OSError` + HttpError
408/429/5xx); a NON-transient error (bad range 400, 403 auth) still raises immediately so
`read_tab_as_dicts`'s "available tabs" helper message is preserved. All three `.execute()` calls
(`list_tabs`/`tab_name_for_gid`/`read_tab_as_dicts`) route through it. Read is idempotent, so retry is
safe. No new dep/env. **The failed run itself was harmless** — a transient Google blip, safe to
re-dispatch; this just stops one Sheets hiccup from failing the orchestrator again.

# Afternic download — transient-403 retry (2026-08-28)

The `afternic` source (its own workflow `source-afternic.yml`, dispatched by `/api/cron/afternic`)
hard-failed one morning: `broker/all?id=…` 302-redirects to a **time-limited pre-signed S3 URL**, and
on mornings when Afternic hasn't regenerated the daily inventory file yet, S3 returns **403** (the key
doesn't exist). The download was a bare `requests.get(...).raise_for_status()` with **no retry**, so one
403 reddened the run (+ tripped the watchdog). No state corruption (it failed before parsing → the prior
snapshot is intact; the UI just shows "new today —"). Fix in `sources/afternic.py`: `_download_with_retry(url)`
— **exponential-backoff retry (30s/60s/120s, 4 attempts)** on transient failures (403 / 408 / 429 / 5xx /
connection / timeout — 403 included because it means "file not ready yet"); a non-transient 4xx (401/404)
is fatal immediately. `import time` added. Same class of fix as the Google Sheets reader retry above.
- **Now FAIL-OPEN (2026-08-28, Rob).** Live diagnosis of the persistent failure: `broker/all?id=…`
  302-redirects to a **bare, UNSIGNED S3 URL** (no `X-Amz-Signature` query string), so anonymous access
  to the private partner bucket returns `403 AccessDenied` on every retry — an **Afternic-side signing
  failure**, not transient, so retry can't recover it (the runner log showed all 3 backoffs firing then
  a 403 traceback). Since the feed is only intermittently reachable, a fetch failure no longer hard-fails
  the run: `run()` wraps `_download_with_retry` in a try/except → `_skip_fail_open(err, slack_channel)`
  (mirrors atom_daily) which posts a Slack "⚠️ Afternic feed skipped" alert, writes `run_status.json`
  status=`skipped`, and **returns 0 WITHOUT touching the snapshot** (prior baseline preserved → next good
  run diffs correctly). The retry stays (it recovers the genuinely-transient mornings). Set
  **`AFTERNIC_FAIL_OPEN=0`** to restore the old hard-fail. When the 403 persists across days it's an
  Afternic partner-side issue (unsigned link / stale partner id `zt5nchodbseszkp`) — contact Afternic
  support; nothing on our side fixes a missing S3 signature.

---

# NameClub — one-time dictionary-gated .com pull into Universe (2026-07-20)

Evaluated NameClub (nameclub.com/marketplace) as a Universe feed. **Verdict: NOT a feed**
— its ~5.5M inventory is 31% overlap (98% of that via **Afternic**, which we already pull;
Dynadot = 0) and the 69% "net-new" is overwhelmingly auto-generated/numeric/CJK junk. Only
the **dictionary-word .com** slice is worth having.

- **Data access:** public sitemaps — `nameclub.com/domains.xml` → 112 gzipped shards
  (`oss.nameclub.com/.../en_sitemap_domainsN.xml.gz`), ~49.5K domains each. **No price API**
  (the `/api/*` endpoints 401); price is only in each listing page's `application/ld+json`
  `Product.offers.price` (USD), ~460KB into the page → a real crawl, not an API.
- **The pull (done once):** enumerated all 112 shards → 3.58M letters-only .com SLDs →
  intersected with the 238K-word `english_words` dict → **13,640 dictionary .com listings**
  (**8,512 net-new**, 5,128 already ours). Crawled prices (ld+json), 97% hit → CSV
  `domain,price` handed to Rob for the **Imports tool**. NB the dict is Scrabble-grade so some
  are obscure/plural (ferlie, oxeyes) — downstream `quality_score` ranks those down.
- **Routing:** added `nameclub` to `UNIVERSE_EXTRA_SOURCES`
  (`app/api/admin/imports/route.ts`) so `source=nameclub` writes to **name_universe** (tier-2),
  not Master. This is a **one-time manual import**, NOT a recurring pipeline source.

---

# Social Sweep — X + Reddit engagement-lead skim (2026-07-18)

Skims Reddit + X for domain posts from OUTSIDE the domainer echo chamber (founders/VCs/
investors), scores them into two buckets, drafts a suggested reply in Snagged's voice, and
delivers to Slack + email + a Reports tab. NOT the same as `reddit-domains` (that's the SNAP
marketplace deal-finder).

- **Scoring** (`dashboard/lib/reddit-sweep/score.ts`): two buckets — **high-signal** (actively
  seeking a broker / to buy = a lead) vs **maybe** (founder/VC discussing domains where we add
  expert authority). Insiders/sellers/brokers excluded; requires a real domain-topic phrase
  (bare `.com`/TLD tokens don't qualify — that caused an engage-flood). `HIGH_QUALITY_SCORE_MIN`
  6, `MAYBE_MIN` 3.
- **Store** (`store.ts`): `social_sweep_posts` + `social_sweep_runs` (main admin project;
  `scripts/social_sweep.sql`). `vipBand(followers,verified)` flags high-profile X authors.
  `clean()` strips C0 controls + **lone UTF-16 surrogates** (Reddit decodes high `&#NNNN;` →
  the JSON layer rejects lone surrogates as "invalid input syntax for type json").
- **Reply drafting** (`reply.ts` + `voice.ts`): LLM draft, channel-aware (X terse ≤2 sentences,
  Reddit substantive), grounded in snagged.com/blog voice (sitemap → /post/ pages, cached 12h).
  Thoughtful/critical, NOT sycophantic, NO emdashes. `SOCIAL_REPLY_MODEL`||`DEAL_RECAP_MODEL`||Haiku.
- **X fetch** (`x-fetch.ts`): X API v2 recent search needs **Basic tier** ($200/mo; Free 403s).
  Bearer minted from `X_API_KEY`/`X_API_SECRET`. Reddit IP-blocks cloud egress → `SCRAPE_DO_API_KEY`.
- **Runs** (`run.ts`/`x-run.ts` inline in cron routes `app/api/cron/{reddit,x}-sweep`), UI
  `app/reports/social-sweep-client.tsx` (VIP-sorted, suggested-reply copy), digest `digest.ts`.
  Permission `reports.social_sweep`.
- **Slack:** posts via `slackAlert(digest.slack, process.env.SLACK_CHANNEL_CONTENT_SWEEP)` — its
  own **content-sweep** channel (2026-07-22); falls back to `SLACK_CHANNEL_SNAP` when the var is
  unset. Both cron routes (reddit-sweep + x-sweep). Set `SLACK_CHANNEL_CONTENT_SWEEP` in the
  ADMIN Vercel project (same place as the other Slack channel vars).
- **⏰ Schedule (2026-07-18):** `reddit-sweep` + `x-sweep` now run **3×/day at 13/18/23 UTC**
  (`vercel.json`) — added after calibration sign-off (they'd been manual-only during tuning).
- **TIGHTENED to buy-side leads ONLY — dropped the "worth engaging" bucket (Rob, 2026-08-29).** The
  channel was flooding with low-intent noise (r/smallbusiness "Best Coffee Cart POS System?", r/webdev
  storefront show-and-tell) because the **`maybe`** bucket surfaced ANY outsider (founder/VC sub) merely
  discussing domains. Rob's call: surface a post ONLY when the author is very clearly seeking help to
  **ACQUIRE** a domain — a **buy-side broker ask, first-person buy intent, or an unreachable owner**. Fix
  in `score.ts`: removed the `else if (outsider && score >= MAYBE_MIN) bucket = "maybe"` branch (→ now
  `ignore`), so `high-signal` (the `HIGH_INTENT` set — broker asks / "I/we want/need to buy" / "how do I
  buy the .com" / owner-not-responding) is the ONLY surfacing bucket. Everything downstream that referenced
  `maybe` (digest Slack + email sections, run/store counts) is guarded on `maybe.length`/`arr.length`, so
  those sections just go empty — no other file needed changing (the `Bucket` type keeps `maybe` for
  compatibility, it's simply never emitted). A quiet run now sends NO digest (newPosts empty → `buildDigest`
  returns null) — far fewer messages, on purpose. Verified: coffee-cart/hot-dog → ignore; "looking for a
  domain broker to help me acquire… owner isn't responding" + "how do I buy the .com for our startup" →
  high-signal; a rebrand-discussion post (high score, no acquire intent) now → ignore (the deliberate cut).
  To re-widen, restore the maybe branch. No new env/table/migration.

---

# SNAP Names — Atom column removed (2026-07-21)

Dropped the **Atom** marketplace column from the SNAP Names table (`snap-names-client.tsx`)
— we aren't using Atom. Removed the header, the per-row `MarketCell`, the `atom` sort case +
SortKey member, the `atom_listed`/`atom_price` CSV columns, and the footer-note mention. The
`atom_price` field on the row type is left (harmless; server may still send it).

# SNAP Names — registrar OPERATOR unification + new-name alerts (2026-07-11)

Two additions to Reports → SNAP Names:

- **Drop-catch shells collapse to their true OPERATOR (not their whimsical name).** Newfold/
  Network Solutions accredits ~526 whimsically-named registrar shells (Hanging Curve Domains,
  Abbey Road Domains, Catch Domains, Register.com, Domain.com, …); TurnCommerce/NameBright
  runs ~1252 (NameBake, GlamDomains, DropCatch.com ### LLC); park.io a couple (Zhuimi). A
  name-by-name list can't keep up, so grouping is by **operator**, detected from the RDAP
  **IANA Registrar ID** (publicIds) — `dashboard/lib/registrar/operator-ids.json` maps every
  known shell's IANA id → operator label, generated from IANA's `registrar-ids.xml` grouped by
  each registrar's RDAP endpoint (`rdap.snapnames.com`/`rdap.networksolutions.com` → "Network
  Solutions"; `rdap.namebright.com` → "NameBright/DropCatch"; `rdap.park.io` → "park.io").
  `registry.ts` `operatorForIanaId(id)` + `operatorFromRegistrarUrl(url)` (backstop for the
  WHOIS path via the Registrar URL / abuse email → newfold.com/networksolutions.com etc.).
  `domain-dns.ts` `registrarFromRdap` reads `publicIds` IANA id FIRST (→ operator) then falls
  back to the vcard fn name; `registrarFromWhois` reads `Registrar IANA ID` / `Registrar URL` /
  abuse email first. **NB the user's premise was half-wrong — NameBake is NOT Network Solutions;
  it's NameBright/DropCatch (TurnCommerce).** Regenerate `operator-ids.json` from a fresh
  `registrar-ids.xml` when Newfold/TurnCommerce mint new shells (script snippet in the session
  transcript). `REG_CANON` keeps the operator labels canonical + a coarse name fallback.
- **"New untracked name" banner + bell + email.** When a **✓ Verify accounts** rebuild finds a
  domain that first appeared in a registrar account since the LAST snapshot AND isn't on the
  SNAP sheet (a fresh Porkbun buy, a caught drop), it's surfaced — it is NEVER auto-added to the
  sheet (the audit stays a reconciliation view). `lib/snap-alerts.ts` `computeNewUntracked`
  (diff nowOwned − prevOwned, minus on-sheet, minus hidden; skips accounts that weren't `ok`
  last build to avoid transient-error false positives; no alert on the first-ever build) +
  `alertNewUntracked` (bell via `notifications.ts` new `createNotification` + email via
  `email.ts` to every `reports.snap_names` user). `buildAndSaveSnapshot` (snap-inventory.ts)
  computes it against the prior snapshot, persists `new_untracked` on the row, then fires the
  alert after the write. Client (`snap-names-client.tsx`): a 🆕 banner above the audit lists the
  fresh names with "Review in audit →" (scrolls to `#snap-audit`) + "Dismiss" (localStorage
  `snapNewDismissed`). **One-time migration:** the `new_untracked jsonb` column
  (`scripts/snap_registrar_inventory.sql` — `add column if not exists`); the write degrades
  gracefully (strips the column + retries) until it's run.
- **Archive-with-a-reason.** The per-row Archive button is a reason picker using the SAME
  preset tags as the audit hide (`PRESET_TAGS` — Sold / Let expire / Personal / …) + a
  "New reason…" custom prompt. `snap-archive.ts` stores it in a new `tag` column
  (`setArchived(domain, archived, by, tag?)`; `listArchived` -> `{domain, tag}[]`); the
  client `archived` state is a `Map<domain, reason>`; archived rows show the reason chip +
  a restore. **One-time migration:** `scripts/snap_names_archive.sql` adds `tag`
  (`add column if not exists`); the write degrades gracefully until run.

# NameBright registrar adapter — inventory + NS/DNS writes (2026-07-11)

NameBright (TurnCommerce — the operator behind the ~1252 NameBake/GlamDomains/DropCatch
shells) is now a full registrar provider for SNAP Names, alongside Porkbun/Spaceship/
Dynadot/NameSilo/GoDaddy/Namecheap: it lists account domains (possession verification) and
executes nameserver + DNS-record changes.

- **Auth** (`lib/registrar/adapters.ts`): OAuth2 **client_credentials** → 30-min bearer.
  `namebrightToken(e)` POSTs `grant_type/client_id/client_secret` (form) to
  `https://api.namebright.com/auth/token`, caches the token until ~30s before expiry;
  `namebrightApi(method, path, e, body?)` adds the bearer over REST root
  `https://api.namebright.com/rest/`. **Env: `NAMEBRIGHT_CLIENT_ID`** (the FULL
  `Account:Application` value, e.g. `GoophBall:SnaggedAdmin`) **+ `NAMEBRIGHT_CLIENT_SECRET`**.
- **IP allowlist:** NameBright allowlists per API client and Vercel egress rotates, so calls
  **ALWAYS egress via the Fixie static IPs when `FIXIE_URL` is set** (same as Namecheap/
  NameSilo) — whitelist those IPs in NameBright. `NAMEBRIGHT_NO_PROXY=1` forces the direct
  path for an open client. Rate limit 30 req/30s (403 "IP not whitelisted" is the tell —
  it means the request egressed direct, i.e. FIXIE_URL missing or the IPs aren't whitelisted).
- **Inventory** (`lib/registrar/inventory.ts` `namebrightInventory`): `GET account/domains?
  page=&domainsPerPage=500`, paginated; parses domain/expiry/auto-renew via the reused
  case-insensitive `extractDynadotDomains` walk + a `bareDomainStrings` fallback (handles a
  wrapper object OR a bare string array — the exact list shape wasn't live-verifiable). Wired
  into `listAllInventory`.
- **Writes** (`adapters.ts`): `namebrightSetNs` = DELETE all nameservers then PUT each (no
  bulk-set endpoint); `namebrightSetDns` = POST `hostrecords/{type}` `{host,data,ttl,priority?}`
  (append). Added to `NS_EXECUTABLE` + `DNS_EXECUTABLE` + both dispatch switches.
- **Registry** (`registry.ts`): `namebright` ProviderId + `PROVIDERS` entry (hasKeys = both
  env vars) + `PROVIDER_DEFAULT_NS` (`dns1/dns2.name-services.com`) + `REGISTRAR_MATCH`
  (`namebright|turncommerce|dropcatch` → the provider) + `NSHOST_MATCH` (`name-services.com`).
  So a domain whose RDAP registrar resolves to "NameBright/DropCatch" routes NS/DNS writes to
  this adapter. **Live-verify on first ✓ Verify accounts** — the domain-list JSON shape + the
  host-record POST body are best-effort (couldn't probe: creds are Vercel-only + IP-walled).

# Marketplace per-domain Deal report — engagement, pitch-type, exercise pitches (2026-06-17)

The Reports → Marketplace → `[domain]` deal report (`dashboard/lib/marketplace-deals.ts`
`buildDealReport`, UI `app/reports/marketplace/[domain]/deal-client.tsx`, API
`app/api/admin/marketplace/deals/route.ts`) is reconstructed from the Gmail deal mailboxes
(`lib/gmail.ts`). Cached in Supabase `marketplace_deal_reports` for 6h (Regenerate forces a
rebuild). Enhancements this session:

- **Real back-and-forth vs form-and-gone.** Each thread now carries `repliedAfterUs` (a buyer
  message dated after our FIRST reply — a true two-way exchange, not just a submitted lead
  form). Report adds `inboundEngaged` = qualified inbound that replied after we did. UI: a
  **All / Responded-after-our-reply** toggle on the inbound table + a "Responded after we did"
  headline card. (`active` stays the recency-gated live-negotiation flag; engaged is all-time.)
- **Broker suppression.** `BROKER_DOMAINS = godaddy.com, afternic.com` fold into `isSystem` —
  GoDaddy/Afternic brokers (e.g. Jason Villalobos, afternicsales@godaddy.com) never count as a
  buyer counterparty. A real buyer they FORWARD still surfaces (form / forwarded headers); a
  broker-only thread is dropped.
- **Cold mass vs individual pitch — now HubSpot-authoritative (2026-06-17).** Pitch type is
  classified from the **HubSpot CRM email log** (`lib/hubspot.ts`, private-app token
  `HUBSPOT_TOKEN`; scopes `sales-email-read` + `automation.sequences.read` + `content`). The
  join key is the **RFC Message-ID**: HubSpot stores it as `hs_email_message_id`, which equals
  our `GmailMessage.mid` — so `classifyMessageIds(mids)` maps each of our sends to its logged
  engagement. An outbound send carrying an `hs_sequence_id` is a **sequence (mass)** send (its
  name resolved via `/automation/v4/sequences?userId=`, self-discovered from the token); a
  logged 1:1 is **individual**; `INCOMING_EMAIL` is inbound. The old Gmail `looksBulk()` header
  heuristic remains the **fallback** for sends not in the HubSpot log. `DealThread` carries
  `pitchKind` + `sequenceName` + per-thread `opens/clicks/replies`; report carries
  `pitchSource: "hubspot" | "heuristic"` (also the cache marker).
- **Three-bucket report (2026-06-17).** The drill-down is split into **1 · Inbound** (form /
  buyer-initiated, Gmail), **2 · Pitched 1:1** (individual outreach + naming-exercise sheet
  pitches), and **3 · Cold outreach (HubSpot sequences)**. Each bucket leads with its own metric
  cards and a responded/no-response toggle. Buckets 2 & 3 show HubSpot engagement (opens/clicks/
  replies). The cold bucket is the **FULL HubSpot sequence audience** (every recipient of a
  sequence naming the domain, not just threads in the deal mailboxes) via
  `recipientEngagementForDomain(domain)` (`hs_email_subject CONTAINS_TOKEN domain` + literal
  guard, aggregated per `hs_email_to_email` → sends/opens/clicks/replies + name + sequence);
  rows are enriched with the matching deal-mailbox thread's outcome/active when a cold send
  became a real exchange (`buildCold` in marketplace-deals.ts). `DealReport.cold: ColdOutreach`.
  Mass pitched-Gmail-threads are NOT shown in bucket 2 (they live in bucket 3) when HubSpot is
  on; without HubSpot, bucket 2 shows all pitched threads with a Mass/1:1 chip.
- **Unique-people metrics + chain drill-down (2026-06-17).** Every bucket's Opened / Clicked /
  Responded headline counts **unique individuals**, never a sum of reply emails (one recipient
  who generated a 100-email back-and-forth still counts as ONE responder). The "Responded" metric
  card is **clickable** → flips the bucket's toggle to the responded breakdown. Each cold roster
  row carries `chain` (the real conversation length — the matching deal-mailbox thread's message
  count, else the # of sequence steps the recipient replied to), shown as "💬 N in chain"; the
  pitched-1:1 rows show the chain as "· N msg". `ColdOutreach` adds a `responded` aggregate.
- **Pitch-scan sharpening (`lib/pitch-scan.ts`).** The weekly scan drops sent messages HubSpot
  logged as `INCOMING_EMAIL` (buyer replies mis-filed in Sent) and annotates confirmed cold
  sequence sends with their sequence name in the digest.
- **Naming-exercise pitches (Google Sheets).** `lib/marketplace-pitch-sheets.ts` reads the
  per-client pitch-exercise workbooks (where we pitch a client a curated domain shortlist) via
  the SAME service account (`marketplace-pipeline@snagged-pipeline...`, plain SA token — NO
  impersonation; delegation is NOT authorized for the Sheets scope, so the sheets must be
  link-shared or shared to the SA email). **Small explicit registry** `EXERCISES` (sheet id →
  client); **exact-domain** match across every tab (tolerant of header/headerless tabs + an
  SLD/TLD split tab). A hit = a pitch of that domain to that client → `DealReport.pitchExercises`,
  counted in bucket 2 (Pitched 1:1) + its own sub-table. Add an engagement = add one line to
  `EXERCISES`. `lib/sheets.ts` gained `getSheetMeta` (title + tab list).
- **Verbatim buyer pull-quotes (2026-06-18).** The per-thread recap LLM call
  (`lib/marketplace-deal-recaps.ts`) now ALSO returns a `quote` (the single most
  telling VERBATIM line from the OTHER party — interest / objection / price reaction /
  praise, names+emails+links stripped) + a `quoteKind`. `DealThread` carries
  `quote`/`quoteKind`; `buildHighlights` curates a de-duped, balanced top-8 into
  `DealReport.highlights: DealQuote[]` (each with an ANONYMIZED `attribution` —
  "A buyer who offered $25,000", "A fintech prospect we pitched" — never the lead's
  identity, so the client doc is safe). Surfaced as color-coded callouts: a "💬 In
  their own words" block in the admin report (`QuoteCard`, real name shown for
  curation) and in the client Doc (`quoteCallout` in `client-report-doc.ts`,
  anonymized attribution). REPORT_VERSION → 6.
- **Client Doc curated-search emphasis (2026-06-18).** The funded-startup naming-
  exercise entries in section 03 render as emphasized 11pt bullets (coral marker,
  semibold navy) instead of small chips — pitching to funded startups is a key
  differentiator.
- **Broker notes — off-platform activity (2026-06-18).** A free-text Notes box at
  the bottom of each domain's deal report (`📝 Notes` in `deal-client.tsx`) for
  activity that never lands in Gmail/HubSpot (offers over text/WhatsApp/phone,
  verbal context, next steps). Saved per-domain to `marketplace_deal_notes`
  (`lib/marketplace-notes.ts` `getNotes`/`saveNotes`; API
  `app/api/admin/marketplace/notes/route.ts`, GET+POST, gated `reports.marketplace`,
  records `updated_by`). Best-effort read (empty when the table/DB is absent); save
  surfaces a clear "run the migration / reload schema" error on 42P01/PGRST205.
  **One-time migration:** `scripts/marketplace_deal_notes.sql` on the **domain-owner-
  research** project (the admin `SUPABASE_URL` project, where `marketplace_deal_reports`
  lives) — then `NOTIFY pgrst, 'reload schema';` so PostgREST sees the new table.
- **LLM-drafted prose + notes DECOMPOSED across the report (2026-06-18).**
  `draftReportNarrative` (one Anthropic call, `DEAL_SUMMARY_MODEL`||`DEAL_RECAP_MODEL`||
  Haiku) returns `{summary, outlook, offers[]}` from the FULL report (inbound/
  qualified/engaged, active negs, proactive engagement, firm offers, verbatim
  highlights) AND the broker notes. The notes are **integrated, not dumped**: any
  concrete dollar offer in the notes → `offers[]` → merged into the **Offers received**
  table (sorted with the email/CRM offers; SOURCE = the channel e.g. "WhatsApp"); the
  rest of the notes' context → woven into the **summary** + **What's next**. The
  verbatim notes section now only renders as a **fallback when the LLM didn't run**
  (no API key) so context is never lost. `generateReportDoc` fills `execSummary`/
  `whatsNext`/`noteOffers` on `ReportInput`. Both prose blocks render as "Draft —
  review before sending". Facts-only prompt; **no client-facing internal jargon**
  ("off-platform"/"CRM"/"HubSpot"/"sequence" banned in output). Client Doc also drops
  the quote category labels (OBJECTION/ON PRICE) and renames §02 to "Proactive outreach".
- **Offers table = offers + stated budgets + note offers (2026-06-18).** `DealReport.offers`
  (built in `buildDealReport`, so the admin view AND the client Doc render an identical
  list) now includes every credible dollar figure a buyer put on the table: a named
  offer (`kind:"offer"`), a stated inquiry budget (`kind:"budget"`, e.g. Adam Shellard's
  $50k), AND offers the broker logged in the per-domain Notes (`extractNoteOffers` in
  `lib/marketplace-deal-recaps.ts` — one Haiku call over the notes text; `channel` set to
  WhatsApp/Phone/etc, shown as the SOURCE). `parseAmount` handles commas/K/M and band
  tops ("$5K to $25K"→25000); `OFFER_FLOOR` $1,000 drops parse noise ("5 figures"→5).
  Budget rows are labeled "stated budget". The Doc just renders `report.offers` (no
  separate merge); `draftReportNarrative` now only drafts summary/outlook (offers are
  upstream). REPORT_VERSION → 8.
- **Cache schema marker:** `readCache` ignores reports cached before the HubSpot wiring existed
  (`pitchSource === undefined`; prior marker was `inboundEngaged`) so old rows rebuild instead
  of serving the old Gmail-heuristic classification.

# SNAP top-level menu + SNAP Eval permission (2026-06-28)

The hub (`dashboard/app/page.tsx`) gained a **SNAP** card — a top-level workspace
peer to Research/Admin/Reports — holding two tiles: **SNAP Eval** (→
`/research/evaluate`, the research app's new should-we-buy-it acquisition/resale
scorecard, gated `research.evaluate`) and **SNAP Opportunities** (→
`/reports/opportunities`, the existing snap+auctions feed, gated
`reports.opportunities` via `canReports`). The Opportunities tile was **moved out of
the Reports hub card** into SNAP (its page still lives under `/reports/opportunities`
and stays in `REPORTS_TABS` for the in-Reports sub-nav).

- **Permissions** (`dashboard/lib/permissions.ts`): new module `research.evaluate`
  (stored flat `evaluate` via `storageKey`). CATALOG now has a **`SNAP` group** with
  `research.evaluate` (module) + `reports.opportunities` (regrouped from Reports — key
  unchanged, so no data migration). Grant `research.evaluate` per-user in the Users
  editor; admins auto-pass. The SNAP Eval tool itself lives in the
  **domain-owner-research** repo (see that repo's CLAUDE.md "SNAP Eval").
- **Deal-history reuse:** SNAP Eval reads `marketplace_deal_reports` directly from
  the shared main project (admin `SUPABASE_URL` == research `SUPABASE_URL`) for a
  domain's real offers — no new internal endpoint, cached read, fail-open.
- **Expiring .ai (2026-07-27):** new module `research.expiring` (stored flat `expiring`;
  MODULES + SNAP_TABS + CATALOG group SNAP) gates a SNAP report of good one-word `.ai`
  names entering the redemption window. Tool + engine live in the **domain-owner-research**
  repo (see that repo's CLAUDE.md "Expiring .ai"). Grant per-user; admins auto-pass. The
  admin ⌘K palette + SNAP hub sub-nav pick it up automatically from `SNAP_TABS`.

# Navigation registry — single source of truth for menus (2026-06-28)

All umbrella menus derive from ONE registry: **`dashboard/lib/navigation.ts`**
(`SECTIONS`). Adding a section or a tab is a one-line data change — never hand-edit
the hub, header, or layouts again.

- **`SECTIONS`** = the four top-level workspaces in order (Research · Admin · SNAP ·
  Reports), each `{ key, label, href, blurb, tabs }`. The `tabs` reference the tab
  arrays in `lib/permissions.ts` (`RESEARCH_TABS`, `ADMIN_TABS`, `SNAP_TABS`,
  `REPORTS_TABS`) — those stay in permissions.ts (so `canEnterAdmin/Reports` can use
  them without a cycle); navigation.ts builds the section structure + helpers on top.
- **Helpers:** `visibleSections(user)` (header + hub, in order), `sectionTabs(user,
  key)` (per-section gated tabs), `canTab` (routes a tab's perm to canAdmin/canReports/
  userCan by namespace), `canEnterSection`, and **`sectionForPath(pathname)`** — the
  longest-matching-tab-href resolver that lets a page live in one app but belong to
  another section (e.g. `/reports/opportunities` → SNAP, `/research/portfolio` →
  Reports).
- **Consumers (all derive, none hardcode):** `app/page.tsx` (hub cards =
  `visibleSections` × `sectionTabs`), `app/top-bar.tsx` (header = `visibleSections`,
  mobile menu = `sectionTabs(current)`), and **`app/section-chrome.tsx`** — the single
  shared chrome (`<TopBar current> + <Nav tabs>`) used by the admin + reports layouts,
  which resolves the current section from the URL via `sectionForPath`. This replaced
  the per-layout TopBar/Nav wiring and the old `reports-chrome.tsx` special case.
- A tab whose `href` starts with `/research` is the research app → rendered as a
  full-nav `<a>` (Nav/TopBar/hub all branch on this), so cross-app tabs just work.

**Runbook — add a top-level section:** add its tab array + any new permission keys to
`lib/permissions.ts` (MODULES/ACTIONS + CATALOG), then add one `NavSection` to
`SECTIONS`. Done — card, header item, mobile menu, sub-nav all appear.

**⌘K command palette (2026-07-22):** `app/command-palette.tsx` — a universal Cmd/Ctrl-K
quick-switch mounted in `TopBar` (so it works on every admin-app page: Admin/SNAP/Reports/
Deals/hub). Destinations are built from `visibleSections(user) × sectionTabs(user, key)` — so
it's permission-gated and auto-covers Admin's Users/Lessons/Sources/… (which the research
SPA's palette can't see, since those tabs live only in this app). Fuzzy-ranked (exact-prefix >
word-prefix > substring > subsequence); `/research/*` full-navs, same-app routes use the client
router. The research SPA has its own mirror palette (see that repo's CLAUDE.md "⌘K palette") +
a cross-app registry for Admin/Deals tabs. When it full-navs to `/research/*` it first sets a
one-shot `sessionStorage['cmdkFocus']` flag (same-origin) so the research SPA focuses its lookup
field on arrival — otherwise a ⌘K jump from the admin app landed on research with no cursor in
the search bar (the research SPA's boot handler consumes the flag; see that repo's CLAUDE.md).
**Runbook — add a tab:** add one row to that section's tab array in permissions.ts.
**Runbook — move a tool between sections:** move its row to the other section's tab
array (and update its CATALOG `group`). `sectionForPath` handles the URL→section
mapping automatically.

**⚠️ STANDING RULE — every new module/submodule must be uniformly navigable + ⌘K-enabled
from ANYWHERE (Rob, 2026-09-01).** A new tool/report/tab/standalone page isn't done until it's
reachable via ⌘K from BOTH apps. **Admin palette (`app/command-palette.tsx`)** derives from the nav
tab arrays (`visibleSections × sectionTabs`), so putting the page in a tab array here auto-covers it;
a STANDALONE/universal page (not a section tab) goes in that palette's **`extraDests()`** (e.g.
Feedback, and the research tools not in `RESEARCH_TABS` — TLD Count/Renewal/Net Worth). **Research
palette (`domain-owner-research public/app.js`)** DOM-scans its own nav-btns, but any cross-app or
hidden destination needs a row in **`CMDK_CROSS_APP`** (use `section:'always'` for a universal page) —
keep that list in sync with the admin nav tab arrays. Verify from every section, then it's shippable.
Same permission gating as the page. (2026-09-01 audit added Feedback + Ahrefs/My Tasks/Owner Review/
SNAP Opportunities/SNAP Names coverage across both palettes; admin `extraDests` added.)

**…AND must carry the STANDARD HEADER (Rob, 2026-09-01).** Same standing rule extends to chrome: every new
module/submodule/standalone page — on research OR admin — must show the same top-of-page header controls as
every other module: the **back / refresh / share** icons, the **💡 Feedback** link, the **🔔 notifications**
bell, and the **account avatar** (plus the top-level section switcher). In the admin app a page that renders
inside `SectionChrome`/`TopBar` gets these automatically; a STANDALONE page (its own `<TopBar>`, like
`/feedback`) must still get them — `NavControls` renders on section pages AND on `/feedback`, so extend that
allow-list when you add another standalone page. In the research SPA the same header (`.topbar` + the PWA
back/refresh/share + 💡 + bell + avatar) must be present. A module you can't ⌘K-to from everywhere, that
isn't on the menus, OR that's missing the standard header icons isn't finished.

**Corporate Portfolios → Reports (2026-06-28):** added the missing `research.portfolio`
module key (MODULES + CATALOG, group Reports) and put Corporate Portfolios
(`/research/portfolio`, a research-app page) in `REPORTS_TABS`. `canEnterReports` now
also admits a portfolio-only (or opportunities-only) user since those pages live under
the section but aren't `reports.*` keys. The research SPA mirrors this (see that repo).

**Ahrefs Report → Reports (2026-08-06):** added `research.ahrefs` (module, group Reports,
stored flat as `ahrefs`; MODULES + REPORTS_TABS + CATALOG) → a website deep-dive
(traffic/DR/keywords/backlinks/competitors) at `/research/ahrefs`, a research-app page. Tool +
Ahrefs API v3 client live in the **domain-owner-research** repo (see that repo's CLAUDE.md
"Ahrefs Report"). Grant per-user; admins auto-pass. Key `AHREF_API_KEY` is in the research Vercel
project (the report + the Sales-Hub prominence traffic/DR chip both read it there).

# Internal transaction-comps endpoint for SNAP Eval (2026-06-28)

`app/api/internal/sales-comps/route.ts` lets the research app's **SNAP Eval** pull
REAL comparable sale prices from the Snagged Domain Tracker's **"Master Txns List"**
tab (`SNAGGED_TRACKER_SHEET_ID`, range `'Master Txns List'!A1:Z20000`). Columns are
**auto-detected by content** (the domain column = most domain-shaped values; the
price column = most money-dense non-domain column, preferring a sale/price header),
so the tab's exact headers don't have to be hard-coded. Auth = shared secret
`x-internal-secret` == `RESEARCH_INTERNAL_SECRET` (same as the email-threads
endpoint; `middleware.ts` already excludes `api/internal`). `GET ?sld=&tld=&len=`
returns `{deals:[{domain,price,date,relation}]}` where `relation` is `same_sld`
(exact word, any TLD) / `same_tld` (same extension, similar length). Parsed deals
cached in-memory 5 min (a 25-name batch doesn't re-read the sheet 25×). Reuses the
existing Google SA (must be shared on the sheet — it already is, for the revenue
report). Research side: `domain-owner-research` `lib/evaluate/trackerComps.js`.

# Gmail per-user quota is SHARED across all apps — throttle hygiene (2026-08-09)

`lib/gmail.ts` reads the deal mailboxes via the `marketplace-pipeline` service account with
**domain-wide delegation** (impersonates a user per request). Key operational fact learned when
**Brian's Superhuman kept showing "Throttled: offline until Gmail responds"**: Gmail enforces a
**PER-USER daily data allocation that is SHARED by every app on that mailbox** (Superhuman + our
SA + HubSpot + anything else), and it is **not raisable**. If one heavy consumer burns Brian's
budget, Superhuman (and everything else) gets 429'd.
- **A domain-wide-delegated consumer (our SA, and an admin-installed Workspace-Marketplace app
  like HubSpot) does NOT appear in a user's Google "apps with access to Gmail" page** — only in
  the **Admin Console audit logs** (Reporting → Audit → Gmail, filter by user, group by app). That
  page showing "only Superhuman" does NOT mean Superhuman is the consumer.
- **Audit-log findings (Brian, 7-day export, 2026-08-09):**
  - **Gmail log events** (mailbox actions): **Superhuman's own OAuth client `649336022844-…` was
    the dominant actor — 10,472 events (65% of all; 88% of API events)**, almost all `Draft`
    (5,076) / `Archive` / `Move to Inbox`. That's Superhuman's per-keystroke draft **autosave**:
    ~50 real drafts/day inflated to ~725 `drafts.update` API calls/day (~14× per message). Confirmed
    via apptotal.io that the client ID is Superhuman.
  - **OAuth token log** (authorizations): **our SA (`104413441059090976334`) was the top authorizer
    — 373 grants/7d (~53/day)**, i.e. our crons minting a delegated token for brian@ ~53×/day (the
    hourly `deal-emails` re-pull was the bulk). Auth events carry no byte size, so this doesn't
    quantify our data volume, but it proved we were a frequent, reducible reader.
  - **HubSpot is CLEARED** — absent from both logs; it doesn't touch Brian's Gmail via API (sends
    via its own path, not the Gmail API).
- **Hardening (2026-08-09):** `gget()` backs off + retries on 429 / 5xx (honors `Retry-After`, exp
  backoff, 4 attempts). AND the `deal-emails` cron was trimmed from **hourly → every 4h**
  (`15 */4 * * *`) + **activity-gated**: ACTIVE deals (updated ≤ ACTIVE_DAYS=21) sync every run;
  IDLE deals rotate over the 6 daily runs (stable `bucketOf(id)` % 6) so each still refreshes
  ~1×/day. `?full=1` overrides (manual backfill). The manual "Pull emails" button + on-open ingest
  cover urgency. This removed ~80–90% of our authorizations on brian@ — the lever WE control, to
  isolate whether Superhuman's autosave alone still throttles him.
- **Thread re-download guard (2026-08-28).** Superhuman support confirmed the throttle mechanism is
  **byte-based**: a few GIANT negotiation threads re-downloaded hundreds of times (one 145 MB thread
  355×) blow the shared per-user Gmail DATA quota. Our `ingestDealEmails` (`lib/deals/emails.ts`) did a
  full-body `getThread` on every matched thread each run — so a deal linked to a giant thread had US
  re-downloading it too. Fix: before the heavy `getThread`, when we ALREADY have the thread stored, do a
  **cheap `getThreadMeta`** (new in `lib/gmail.ts`, `format=metadata&metadataHeaders=Message-ID` — headers
  + summed `sizeEstimate` only, ~KB even for a 145 MB thread) and **skip the re-download** if it's
  **oversized** (`sizeEstimate > DEAL_EMAIL_THREAD_MAX_BYTES`, default 10 MB) OR **unchanged** (newest
  Message-ID already stored). A brand-new thread is still ingested once. Skipped/failed threads
  **carry their existing rows forward** (`carryThread`) so `replaceDealEmails`' delete-and-replace doesn't
  drop them. Protects Brian's quota + our DB; env-tunable.
  - **Extended to the OTHER full-chain readers (2026-08-28).** The deal-emails cron was the recurring one,
    but two on-demand paths also re-download the SAME giant threads with a full-body `getThread`: the
    **marketplace per-domain deal-report builder** (`lib/marketplace-deals.ts`, on viewing/regenerating a
    domain report) and the **research chat email-attach endpoint** (`app/api/internal/email-threads`).
    Added a shared **`getThreadCapped(subject, threadId, maxBytes=GMAIL_THREAD_SIZE_CAP)`** in `lib/gmail.ts`
    (`GMAIL_THREAD_SIZE_CAP` = same `DEAL_EMAIL_THREAD_MAX_BYTES` 10 MB env): a cheap `getThreadMeta`
    pre-check → returns `[]` (skips the heavy download) when the thread is oversized, falling through to a
    normal fetch if the metadata check itself fails (degrades safely). marketplace-deals routes all 3
    `getThread` calls through it (an oversized chain is just omitted from that report — low-priority
    content, never worth throttling the mailbox). email-threads does an explicit meta pre-check and returns
    a clear **413 "Thread too large to attach (N MB / M messages)"** instead of a silent empty (it's a
    single deliberate attach, so the requester should know why). Pulling full chains is deliberately low
    priority — the guard never affects normal functionality (small/normal threads pull exactly as before).
    Per-MESSAGE readers (`leads.ts`, `domain-corpus/sources/gmail.ts`, `pitch-scan.ts` via `getMessage`)
    are NOT capped — they pull individual messages, not whole chains, so they're not the byte bomb.

# Internal Gmail endpoint for research chat (2026-06-20)

`app/api/internal/email-threads/route.ts` lets the **research app's** Domain Owner
chat ingest email threads (so the user stops copy-pasting). Reuses `lib/gmail.ts`
(`dealMailboxes` / `searchMessages` / `getMessage` / `getThread`), read-only, over
the deal mailboxes only (mailbox param constrained to `dealMailboxes()`). Auth =
shared secret header `x-internal-secret` == `RESEARCH_INTERNAL_SECRET` (NOT the
session — it's server-to-server). `GET ?q=<query>` → thread candidates; `GET
?action=thread&mailbox=&thread_id=` → full thread text. `middleware.ts` matcher
excludes `api/internal` (machine-to-machine, no cookie). **Env:** set
`RESEARCH_INTERNAL_SECRET` here AND in the research project (same value). Research
side: `domain-owner-research` `lib/email/threads.js` + `api/chat-email.js` (see that
repo's CLAUDE.md "Chat email ingestion").

# MUB — "Made-Up Brandable" naming profile (2026-06-22)

Saved ruleset for picking brandable, **coined** `.com`s with a strict two-way
sound↔spelling lock, positive/neutral connotation, and startup-name feel (gold
standard: **Ambrino**). **Full spec: `scripts/brandables/PROFILE.md`** — keep it in
sync with the code. Pipeline:
- `scripts/tighten_brandables.py` — applies the MUB gates + two scores
  (`wordlike_score` = sound/spelling clarity, the **Ambrino floor** is the gate;
  `brandable_score` = startup-name-ability, the sheet is **ranked** by it). Reads the
  candidate pool, writes `scripts/brandables/brandables_{full,top100}.csv`.
- `scripts/brandables/connotation.json` — committed DB connotation map (positive/
  neutral only; negative/somewhat-negative dropped).
- `scripts/make_brand_sheet.py` + `.github/workflows/brandable-sheet.yml` — publishes
  to a Google Sheet (SA Drive+Sheets creds live only in CI). `spreadsheet_id` input
  updates an existing sheet **in place** (clears/rewrites tabs, drops stale tabs);
  blank creates a new one in the SA-writable Shared Drive folder. Live sheet:
  `1do9T60t-deBGCZQq7bQoM9xgYFnpRn9sTtet7yKx3eo`.
- Gates (drop on any): banned letters `k x q y` + **bare** `c` (but `ch` is allowed —
  `c` only before `h`, archmont), soft-g, `ph/gh/ck/wh` digraphs, double letters,
  adjacent vowels EXCEPT clear hiatus `ia/io/eo/ua/uo` (lorian), intervocalic `s`/`l`,
  back-vowel(`o`/`u`)-before-a-**3+** -consonant pile-up (softened from 2+ so "mont"/
  "pront" pass), terminal `i` (`brandi`/Brandy); must be made-up + 2–3 syllables;
  clarity floor = lowest blessed example (`BLESSED`; archmont is currently lowest); negative/icky/suggestive sound excluded (root substrings, ≤1-edit to
  a negative word, sensitive-word rhyme like `habido`~libido). Re-run: `python3
  scripts/tighten_brandables.py` then dispatch the workflow with the `spreadsheet_id`.
- **Runtime gate `filters/mub.py`** (`is_mub`/`mub_mark`/`count_mub`/`mub_brandable`)
  flags MUB-grade coined `.com`s in SNAP + auction runs. Same definition as the sheet
  (verified every sheet name returns `is_mub=True`); **committed-data-driven** —
  `scripts/brandables/mub_ngrams.json` (word-like floor) + `scripts/brandables/words.txt`
  (english_words set for the made-up check). **NB: do NOT use wordfreq for made-up** — it
  rates junk fragments (amb/rino/ino) as words and falsely flags coined names
  (ambrino=amb+rino) as concats; that broke CI once. Wiring: the **morning auctions
  report** (`auctions/orchestrator.py`) posts a **standalone "✨ MUB picks"** message
  (its own post, ranked by `mub_brandable`, each tagged with its source — NOT mixed into
  the per-source watchlist sections); **SNAP good-deals** (`namepros_marketplace` +
  `reddit_domains`) mark MUB lines with ✨ + `· N ✨ MUB` in the headline. Tests:
  `tests/test_mub.py`.

## Auctions watchlist — closing-today urgency + no row truncation (2026-07-11)

The morning **Auctions watchlist** Slack post (`auctions/orchestrator.py` + `auctions/
slack.py`) got two changes for urgency + completeness:
- **⏰ Closing TODAY roundup pinned to the top** — a cross-source section listing EVERY
  name whose auction ends today (business-tz `America/New_York` calendar day, `_closes_today`),
  soonest-first, each row tagged with its source. Built in `_closing_today_section`.
- **No more "… and N more" truncation** — `format_section(top_n=None)` now renders ALL rows
  per source (a truncated watchlist hides names that close today). To stay under Slack's 40k
  `chat.postMessage` limit, a heavy day is split into multiple posts (`_chunk_lines`,
  `MAX_MESSAGE_CHARS=38000`) at row boundaries rather than dropping rows; dedupe rides the
  first chunk (identical re-run still skipped). `format_line` is the shared row renderer.
  The **MUB picks** post is unchanged (still a curated top-20). Tests:
  `tests/test_auctions_orchestrator.py` (+ slack).

# english_words.zipf — word-frequency backfill (2026-08-28)

`english_words` (NAMING project) had only `word/is_root/pos/definition` — no frequency — so a
dictionary walk couldn't order "most-common first". Added a **`zipf`** column (wordfreq's
`zipf_frequency`, 0.0=rare … ~7=commonest) so SNAP Research (research repo, being built) and any
future dictionary sweep can `order by zipf desc`.
- **Prereq SQL** (NAMING project, once): `scripts/english_words_zipf.sql` (`add column if not exists
  zipf real` + `idx_english_words_zipf` on `zipf desc nulls last`).
- **Backfill:** `scripts/backfill_english_zipf.py` (wordfreq + supabase `create_client` on
  `SUPABASE_NAMING_*`, both pipeline deps) → keyset-pages english_words, upserts `{word, zipf}` on the
  `word` PK (preserves other cols). Idempotent/resumable (only `zipf IS NULL` unless `--recompute`);
  dry-run default. Run via the **`backfill-english-zipf.yml`** Action (dispatch `commit=true`). ~98k
  root words (+ inflections), a few minutes.
- **Re-run** if the dictionary grows (new rows are `zipf` NULL → picked up next run).

## english_words — broader dictionary expansion (2026-08-29)

Rob asked to "load the next ~100k most popular words." **Investigated first: the premise didn't hold.**
`english_words` already has **237,964 words** (98k `is_root`), reaching **zipf 0** — we already hold
essentially the whole useful English dictionary. wordfreq's "next 100k by frequency" is ~95% junk for us
(proper nouns michael/obama/facebook, slang gonna/lol/dont, foreign words, surnames, abbreviations) —
loading it verbatim would pollute the corpus that feeds SNAP Research + Expiring .ai + the naming
exercise. The genuinely-missing *common* real words are only a few thousand (verified absent:
blog/podcast/emoji/selfie/awesome/powerful/different/available/useful/elegant…). Rob chose the **broader
real-dict** option.
- **What loads:** real English words from the **dwyl/english-words** 370k list (`words_alpha.txt`), 3–15
  letters, that carry SOME real usage (**wordfreq zipf > 0**) and weren't already present, minus a light
  inflection filter (drop plural/-ing/-ed forms whose base we already have). **= 23,389 words**, committed
  as **`scripts/new_english_words.csv`** (`word,zipf`) so the load is deterministic + reviewable (no
  CI network/wordfreq dep). Still includes some stopwords/proper nouns/obscure words — an accepted cost of
  the "broader" choice (they just become weak/non candidates downstream).
- **Load:** `scripts/load_english_words.py` (reads the CSV, upserts `{word, zipf, is_root:true}` — `is_root`
  true so SNAP Research + Expiring .ai actually curate them, both gate on it; pos/definition left NULL for
  the WordNet pos backfill to fill later). **INSERT … ON CONFLICT DO NOTHING** (`ignore_duplicates`) so it
  NEVER overwrites an existing curated row — only adds. Dry-run by default; `--commit` to write. Idempotent
  (re-runnable). Env `SUPABASE_NAMING_URL`+`SUPABASE_NAMING_SERVICE_KEY`.
- **Run it:** dispatch **`load-english-words.yml`** with `commit=true` (dry-run without). Then re-dispatch
  the pos backfill if you want the new rows POS-tagged (`enrich`/`backfill-structural`).
- **To expand again / regenerate the CSV:** it was computed in-session — pull all `english_words` (read via
  `scripts/db.py naming`), fetch dwyl `words_alpha.txt`, keep real words with zipf>0 not already present,
  apply the inflection filter. Widen by lowering the zipf>0 floor (the ~178k zipf-0 dwyl remainder is
  obscure/unrated — mostly not worth it).

# Working agreements

## ALWAYS deep-link SQL to run AND Actions to dispatch, on GitHub — and NAME THE EXACT PROJECT (Rob, 2026-08-28)

Whenever a change requires Rob (or an admin) to **run SQL / a migration** OR **dispatch a GitHub
Action**, always give the GitHub deep-link, not just a name/path. **For SQL, ALWAYS state the EXACT
Supabase project to run it in, BY ITS PROJECT-PICKER NAME** (the name in the Supabase project
dropdown), never a vague "main/research". The projects are: **`domain-owner-research`** (the
main/research project, marked PRODUCTION — holds ALL `domain_research_*` tables incl. `deals` /
`owner_review_cards` / `feature_requests`; it's `SUPABASE_URL` for BOTH apps), **`snagged-naming-universe`**
(naming), **`Master Domain Name List`** (master), **`snagged-zone-index`** (zone). (A `rob-personal`
project also shows in the picker — we NEVER use it.) It's easy to run in the wrong one (a 0022 migration
got run in snagged-naming-universe instead of domain-owner-research once — nothing populated). Name it
explicitly, e.g. "run on the **`domain-owner-research`** project (the PRODUCTION one holding the other
`domain_research_*` tables — NOT snagged-naming-universe)".
- **SQL file:** `https://github.com/snaggeddomains/snagged-admin/blob/main/<repo-relative-path>`
  (e.g. `.../blob/main/dashboard/scripts/snap_deals.sql`).
- **Action to dispatch:** `https://github.com/snaggeddomains/snagged-admin/actions/workflows/<file>.yml`
  (e.g. `.../actions/workflows/backfill-english-zipf.yml`) — links straight to the workflow's Run-workflow page.
- **Any other repo file/artifact** Rob needs to open/run/review on GitHub (a script, a config, a
  migration dir, a PR/commit): link it too — `.../blob/main/<path>`, `.../actions/workflows/<file>.yml`,
  `.../commit/<sha>`, etc. Default to handing a clickable GitHub URL, never just a bare path or name.
For the research repo swap the base to `https://github.com/snaggeddomains/domain-owner-research/…`.
Commit + push the file FIRST so the `main` link resolves. Applies to both repos.

## Data tables are SORTABLE by default — don't wait to be asked (2026-08-10)

Rob's standing instruction: **every data table we build has click-to-sort column headers by
default.** Don't ship a static table and wait for someone to request sorting. The house pattern
(see `app/reports/seo/seo-client.tsx` `COLS`/`sort`/`toggleSort`/`sortedTargets`, and the
expiring-.ai / deals-reporting tables): a `COLS` metadata array (`{key,label,num}`), a
`{col,dir}` sort state, clickable `<th>` headers (cursor pointer, active header coral + ▲/▼),
**numeric columns default to descending (high-first)** on first click / string columns ascending,
and **blanks always sort last**. Client-side sort over the loaded rows; the CSV export (when
present) respects the active sort. Applies to new tables in BOTH repos.

## Probes and one-shot scripts: run locally by default

When a task is a pure-compute probe or one-shot diagnostic that could be
done either by (a) pushing a GitHub Actions workflow + waiting for Rob to
dispatch and paste the log back, or (b) running directly in this sandbox
with `python3` / `requests` / etc. — **default to (b)**.

Only push an Actions workflow when the target genuinely requires a GH
runner:

- IP-allowlisted edges (Sedo's CDN returns `403 "Host not in allowlist"`
  to this sandbox; GH runners are on the allowlist)
- Cloudflare-protected endpoints that need scrape.do (Oxley, NameJet)
- Headless-browser scrapes that need Playwright + Chromium (Dropcatch renders
  dropcatch.com/auctions via Playwright — not scrape.do)
- Workflows that need GitHub Secrets we don't have locally
- Anything that should run on a recurring cron

For everything else — Sheets reads, Spaceship/Atom/Namecheap APIs,
Supabase queries, Drive ops, pipeline CLI commands — execute it here and
report the result. No round-trip, no dispatch link, no copy/paste.

## Google Docs / Sheets: build them DIRECTLY via the service account (default, 2026-08-08)

Rob's standing instruction: **any time he asks for a Google Doc or Google Sheet, build it
DIRECTLY through the `marketplace-pipeline` service account + Drive/Docs/Sheets REST APIs.
Never Zapier, never a per-session consent prompt.** (Slides/presentations are out of scope —
ignore.) The sandbox already has `GOOGLE_SA_KEY` (raw SA JSON), and the Docs/Drive/Sheets
APIs are enabled on the GCP project — no setup needed to run it here.

- **Reusable CLI: `scripts/gdrive.mjs`** (dependency-free, Node built-ins only). Mints an
  RS256 JWT from `GOOGLE_SA_KEY` → access token → Drive/Docs/Sheets REST. Subcommands:
  - `node scripts/gdrive.mjs doc "<title>" [--text-file f.md | --text "…"]` (or pipe text on STDIN)
  - `node scripts/gdrive.mjs sheet "<title>" [--tsv f.tsv | --json rows.json]` (or pipe TSV on STDIN — one row/line, tab-separated)
  - `node scripts/gdrive.mjs share <fileId> <email> [--role writer|reader|commenter]`
  - Flags: `--drive <id>` (default the shared drive below), `--share <email>` (default
    `rob@snagged.com`), `--no-share`. Prints the file URL.
- **⚠️ HARD CONSTRAINT — must create in a Shared Drive.** The SA has NO personal Drive
  (`storageQuota.limit = 0`), so a `files.create` in "My Drive" fails. Everything is created
  inside the **"Snagged Pipeline" Shared Drive** (`0ACKJ-QAwIhwLUk9PVA`) via
  `parents:[driveId]` + `supportsAllDrives=true`, then shared to rob@ (writer,
  `sendNotificationEmail=false`).
- **Delete gotcha:** the SA is a writer/content-manager, NOT an organizer, so a permanent
  `files.delete` in the shared drive **404s**. To remove a file, **trash it** instead:
  `PATCH /drive/v3/files/{id}?supportsAllDrives=true {trashed:true}` (returns 200).
- **App integration (if we ever want it in-product):** Admin already has
  `dashboard/lib/google-auth.ts` `googleAccessToken(scope)` (the same JWT mint) — a
  `createDoc/createSheet` helper would be ~30 lines and reuse it. Research has no Google
  creds; give it Docs/Sheets by either adding `GOOGLE_SA_KEY` to its Vercel env, or (better,
  matches the email-threads/sales-comps/valuate pattern) an admin internal endpoint gated by
  `x-internal-secret == RESEARCH_INTERNAL_SECRET` that research calls. Not built yet — the
  CLI above covers ad-hoc "build me a doc/sheet" asks today.

# Reports → Site Analytics: multi-platform Ads (X + Reddit) (2026-07-22)

The Ads tranche is now **platform-delineated** — a platform switcher (X · Reddit · Meta·soon
· Google·soon) at the top of the Ads view. Shared shape in `dashboard/lib/ads-types.ts`
(`AdReport`/`AdTotals`/`AdCampaign`/`AdDaily`/`AdRoi` + `AdPlatform`), so every source renders
in one `AdsView`. The analytics route (`app/api/admin/analytics/route.ts`) `ads` tranche reads
`&platform=` (default `x`), returns a `platforms[]` (id/label/live) for the switcher, and routes
to `xAdsReport` or `redditAdsReport`. Per-ad effectiveness / lift / lead tie-back stay **X-only**
for now (Reddit gets the base spend/campaign/ROI view).
- **Reddit client** `dashboard/lib/redditads.ts` — OAuth2 (refresh-token → bearer), base
  `https://ads-api.reddit.com/api/v3`, `POST /ad_accounts/{id}/reports`. Returns the shared
  `AdReport`; ROI pairs Reddit spend with Reddit-attributed core-GA leads. **⚠️ best-effort, NOT
  live-verified** (needs a Reddit **BUSINESS** account + approved dev app first). Report parser is
  defensive (spend micros-or-plain, tolerant field names). **Env (dormant until set):**
  `REDDIT_ADS_CLIENT_ID` / `REDDIT_ADS_CLIENT_SECRET` / `REDDIT_ADS_REFRESH_TOKEN` /
  `REDDIT_ADS_ACCOUNT_ID`. Until configured the Reddit tab shows a "not connected" note; X unaffected.
- **Adding Meta/Google later:** add a `lib/<platform>ads.ts` returning `AdReport`, a `platforms[]`
  entry + a route branch, and flip its switcher button selectable. No UI changes otherwise.

# Reports → Site Analytics: X Ads tranche (2026-06-08)

The **Ads** tab in Reports → Site Analytics (`dashboard/app/reports/analytics-client.tsx`
→ `AdsView`) is an X (Twitter) ad-spend + ROI tranche. X is Snagged's #1 self-reported
lead source (~41%), so the headline is **cost-per-X-lead = X spend ÷ X-attributed leads**.

- **`dashboard/lib/xads.ts`** — hand-rolled **OAuth 1.0a** signer (HMAC-SHA1 via Node
  `crypto`, no dependency — same dependency-free spirit as `lib/google-auth.ts`) + the
  `xAdsReport(from, to)` builder. Returns `totals` (spend/impressions/clicks/engagements
  + CPC/CPM/CTR), `byCampaign[]`, a daily `trend[]`, and `roi` (X-attributed leads,
  total leads, cost-per-lead). **Spend = `billed_charge_local_micro` / 1e6** (USD).
  ROI leads come from `analyticsReport("core")` `selfReportedSource` where the label is
  `X / Twitter` (tolerates `Twitter`/`X` free-text variants); null when GA isn't configured.
- **Live API constraints** (confirmed by probe 2026-06-08, app 33036944, Standard access):
  base `https://ads-api.x.com/12`; **DAY granularity is capped at a 7-day (+1h) window per
  call** and **≤20 entity_ids per call**, and day boundaries must be **midnight in the
  account's tz (America/New_York)**, not UTC — so `xAdsReport` chunks the date range into
  ≤7-day sub-windows × ≤20-id campaign groups and fetches them in parallel. Stats come back
  as **per-day arrays** under `data[].id_data[].metrics`, or `null` when an entity had no
  activity in the window.
- **Env (Vercel + web session):** `X_ADS_CONSUMER_KEY` / `X_ADS_CONSUMER_SECRET` (app
  key/secret) · `X_ADS_ACCESS_TOKEN` / `X_ADS_ACCESS_TOKEN_SECRET` (account token) ·
  `X_ADS_ACCOUNT_ID` (e.g. `18ce55lp5d7`). Account currency USD.
- **Wiring:** `ads` tranche in `app/api/admin/analytics/route.ts` (gated by the existing
  `reports.analytics` — **no new permission**); `x_ads` tool in `lib/chat-analytics.ts` so
  Chat Analytics can answer "what's our cost per lead on X this month?".
- **Local cache (speed / 429 / timeout fix):** X spend per campaign per day is append-only
  history, so it's snapshotted to Supabase (`x_ads_daily`, admin project — SUPABASE_URL/
  SERVICE_ROLE_KEY, same project as the import log) by a cron and read back from the table
  instead of re-fetching live every page view. `lib/xads-store.ts` (read/upsert) ·
  `lib/xads.ts` `getDailyRows` (cache-first, **live API fallback when empty** — degrades
  gracefully before backfill) · `syncXAdsDaily(days)` · cron `/api/cron/x-ads-sync`
  (CRON_SECRET-gated, runs inline — no GH workflow needed; `?days=N` to backfill, default
  trailing 14). **One-time setup:** run `scripts/x_ads_cache.sql` in the admin project, then
  backfill once: `curl -H "Authorization: Bearer $CRON_SECRET" ".../api/cron/x-ads-sync?days=1200"`.
  Scheduled 3×/day in `vercel.json`. GA stays live (single fast query: ROI leads + the lift
  channel series). The lift view is also **lazy-loaded** as a separate `part=lift` request so
  its trailing-90-day compute never blocks (or times out) the main spend view.
- **Per-ad + per-campaign effectiveness (2026-06-08):** a lazy `part=effectiveness` request
  (`xAdsEffectiveness`) → engagement efficiency (CTR/CPC/CPE/eng-rate), **runtime** (days
  active) and **week-over-week CTR trend + Δ CTR degradation** (last vs first active week),
  per campaign and per ad. UI = the "Effectiveness" section in `AdsView` with a Per-campaign/
  Per-ad toggle + sparkline. Per-ad data is its own cache: **`x_ads_ad_daily`** (one row per
  (date, promoted-tweet); campaign + tweet-text labels denormalized in; SQL
  `scripts/x_ads_ads_cache.sql`), synced by the SAME cron alongside `x_ads_daily`
  (`syncXAdsAdsDaily`; cron `?level=campaign|ad|both`, default both). The sync resolves
  campaign→line_item→promoted_tweet and pulls `entity=PROMOTED_TWEET` stats (same DST-safe,
  fault-tolerant chunking). **Conversion** efficiency (cost-per-lead per ad) is still
  account-level via the lift model — it can't be split per-ad until the **X conversion pixel**
  fires (the `WEB_CONVERSION` metrics come back null today; getting the pixel/CAPI working
  server-side unlocks true per-ad cost-per-conversion).
- **Next (Rob's direction):** stand up the X **Conversion API (CAPI)** server-side on the
  contact-form handler (keyed by `twclid` / hashed email) → unblocks per-ad conversions.
  Google Ads to be added as a second spend source once live — the tranche/`AdsView` are
  provider-agnostic enough to grow.

# Domain data model — canonical (do not let this drift)

Two domain corpora live in **separate Supabase projects**. Keep the boundary clean:

**`name_universe`** — project `snagged-naming-universe` (env `SUPABASE_NAMING_URL` /
`SUPABASE_NAMING_SERVICE_KEY`). Home for **everything automated**: all SNAP/pipeline
sources + marketplace feeds (afternic, atom, sedo, namecheap_bin, oxley, efty, the
owned sheets — snagged_snap_sheet, rob_purchases_sheet, snagged_marketplace_sheet,
berserk_snap_sheet — and BrandBucket going forward). One row per `domain` with a
`sources[]` array and `source_tier` (1 = owned/controlled, 2 = broad market).
Written **only** by this pipeline (`universe/supabase_writer.py` →
`upsert_universe_rows` RPC).
- **TLD is stored BARE** (`com`, never `.com`). `merged_to_universe_row()` strips the
  dot; existing rows were backfilled 2026-06. Never write a leading dot.
- **Structural enrichment** (`zipf_score`, `num_words`, `num_syllables`,
  `is_dictionary_word`) is computed at ingest via `wordfreq`
  (`filters/universe.classify_dict_word`). `num_words`/`is_dictionary_word` are NULL
  for non-dictionary SLDs.
- **LLM enrichment** (`category` text — one of a **controlled ~31-label list**
  (`CATEGORIES` in `tools/enrich.py`; unknown → `General & Other`); `connotation`
  text — 5-point: `positive`/`somewhat positive`/`neutral`/`somewhat negative`/
  `negative`; `emotions[]`, `keywords[]`, `industries[]` arrays) is a separate paid
  pass run by `pipeline enrich --target universe|master`
  (tool: `tools/enrich.py`; workflow: `.github/workflows/enrich-domains.yml`).
  Dry-run by default; `--commit` to write. Selection is
  `category IS NULL AND enriched_at IS NULL`, so legacy-enriched rows are never
  re-charged and attempted rows are stamped `enriched_at` (resumable, failure-safe;
  `--retry-failed` revisits empties). Before paying it copies any already-enriched
  row from the OTHER corpus on a domain match (free; becomes one-project SQL once
  Master is consolidated in). Output casing matches the search filters: emotions
  Title-cased, keywords/industries lowercase. Default model
  `claude-haiku-4-5-20251001` (override via `--model` / `ENRICHMENT_MODEL`).
  Scope flags narrow the slice (`--tld com --single-word --dict-word
  --quality-min/--quality-max --len-max --no-numbers`) and `--order` prioritizes
  (universe defaults to `quality_score` desc). Starting strategy: one-word
  dictionary `.com` first (`enrich --target universe --tld com --single-word
  --dict-word`).
  `pipeline enrich-batch submit|collect|status` runs the same enrichment via the
  Anthropic Message Batches API (50% cheaper, async ≤24h; state in
  `state/enrichment/batches.jsonl`; tool `tools/enrich_batch.py`, workflow
  `.github/workflows/enrich-batch.yml`) — for the `quality_score`-banded bulk
  rollout. `submit` is dry-run unless `--commit`; `collect` upserts ended batches.
  **One-time setup SQL** (run in each project):
  ```sql
  -- name_universe (naming project)
  alter table name_universe add column if not exists connotation text;
  alter table name_universe add column if not exists enriched_at timestamptz;
  alter table name_universe add column if not exists enrichment_model text;
  create index if not exists idx_universe_enrich_queue on name_universe
    (num_words, is_dictionary_word, tld, quality_score desc nulls last)
    where category is null and enriched_at is null;
  -- Master Domain List (masterlist project)
  alter table "Master Domain List" add column if not exists industries text[];
  alter table "Master Domain List" add column if not exists connotation text;
  alter table "Master Domain List" add column if not exists enriched_at timestamptz;
  alter table "Master Domain List" add column if not exists enrichment_model text;
  create index if not exists idx_master_industries_gin
    on "Master Domain List" using gin (industries);
  create index if not exists idx_master_needs_enrich on "Master Domain List" (domain)
    where category is null and enriched_at is null;
  ```

**Master Domain List** — project `Master Domain Name List` (env
`MASTERLIST_SUPABASE_URL` / `MASTERLIST_SUPABASE_SECRET_KEY`). **Manual / curated
owner attributions only**: hand-uploaded CSV/portfolio imports + real-owner rows +
the broader `snagged` set. One row per `domain` with a single `source` text +
`owner`. NOT written by this pipeline.
- `is_single_word` / `dictionary_word` are TEXT `'Y'`/`'N'`; `emotions`/`keywords`
  are `text[]` (migrated 2026-06 to match Universe; Master emotions stored
  Capitalized — the search title-cases the emotion filter).
- **2026-06 cleanup:** removed ~3.75M marketplace placeholder dupes (sources
  sedo/afternic/atom where `owner` was null or a marketplace name
  Atom/Sedo/Afternic/Namecheap/BrandBucket). Real-owner rows kept. Backup in
  `master_domain_list_backup` (+ Pro PITR). ≈ 435K rows post-cleanup.

**Boundary rule:** automated/SNAP + marketplace feeds → `name_universe`;
manual/curated owner attributions → Master. BrandBucket is a marketplace feed → it
belongs in `name_universe` (don't enrich it in Master).

**Part-of-speech on Master (2026-08-05).** Master carries the LLM-enrich fields already
(category/connotation/emotions/keywords/industries — all filterable in Domain Name Search); the one
gap was `part_of_speech` (Master had no such column, so a Master-only dictionary name couldn't be
POS-filtered — the research search skipped Master when POS was active). Added a WordNet backfill:
`backfill_structural.py` `_run_master_pos` (+ `_master_sld` to derive the SLD by stripping the TLD)
computes `pos_for_sld(sld, 1)` for SINGLE-WORD Master rows (`is_single_word='Y'`), writing `[]` for
function/non-dictionary words so they're not re-scanned. Wired through `cli.py` (`--pos` flag — the CLI
builds its own argv, so it's added in BOTH the tool and cli.py) and the **backfill-quality-master.yml**
workflow (new `pos` boolean input → `--pos`). Run: `pipeline backfill-structural --target master --pos
--commit` (dry-run without `--commit`). **One-time SQL (masterlist project) FIRST:**
`alter table "Master Domain List" add column if not exists part_of_speech text[];`
`create index if not exists idx_master_pos_gin on "Master Domain List" using gin (part_of_speech);`
Research-side search wiring (buildMaster POS filter + resilience) is in the domain-owner-research repo.

**Search (research app):** Domain Name Search (`api/dbsearch.js`) queries both
(`db=both|universe|master`); Domain DB Screen (`api/dbscreen.js`) is the
single-domain lookup. Universe filters use `num_words`/`is_dictionary_word`; Master
uses `is_single_word`/`dictionary_word`. TLD filters require a single-dot domain
(exclude multi-label hosts like `ab.co.com`).

# Admin Imports tool — app.snagged.com/admin/imports

Manual CSV/paste importer into either corpus. Code: `dashboard/app/admin/imports/*`
(client), `dashboard/app/api/admin/imports/route.ts` (actions), `dashboard/lib/imports.ts`
(DB). **Lives in the snagged-admin Vercel project**, so that project needs its OWN
env vars (separate from research): `SUPABASE_NAMING_*` (universe), `MASTERLIST_SUPABASE_*`
(master), and `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` (the MAIN research DB — it
backs user auth AND the import-history log; **not** the naming universe).

**Flow (2026-06-03 — simplified for non-admins):** a visual "How to use" explainer
sits at the top; the page now uses the standard content width (`--maxw`), not a 940
column. Default flow → drop CSV / paste → source name (typeahead) → optional
auto-backfill + auto-enrich → Start. Then per-import "Past Imports" cards show the
funnel: **Inserted · Net-new · Quality q≥1 · Enriched X/Y** with a green ✓ / yellow ⏳ /
red ✗ (stalled >24h) dot. Re-enrich button re-dispatches; trash deletes the log row only.
**Re-enrich also RETRIES FAILED rows** (2026-06-09): the pipeline stamps `enriched_at` on
every attempted row (so it's never re-charged), but an attempt that returns NO category
leaves `category IS NULL, enriched_at IS NOT NULL` — which the resumable selection
(`category IS NULL AND enriched_at IS NULL`) then skips forever (an import freezes at e.g.
580/582). So Re-enrich now passes `retryFailed` → the route calls `clearFailedEnrichStamps`
(`lib/imports.ts`) to null those stamps (scoped to source + net-new) BEFORE dispatching, so
they re-qualify. (Auto-enrich on import does NOT retry-failed — only the manual button.)
The import-log `import_ts` is now always stamped (the client passes it to the `log` action;
the route falls back to `now()`) — it was NULL before, so net-new scoping leaned on `created_at`.

- **Corpus is AUTO-ROUTED by source (2026-07-09).** There's no manual corpus toggle;
  the target is DERIVED from the source name — a recognized universe/marketplace feed
  (in `sourcesUniverse` = `sources.yaml` registry + `UNIVERSE_EXTRA_SOURCES` incl.
  brandbucket + universe-logged names) → `target=universe`; anything else → `master`.
  A "→ Writes to the Name Universe / Master Domain List" indicator shows under the
  source field so it's unmistakable. This fixed the class of bug where brandbucket got
  imported into Master (owner became a mis-parsed date). Owner-required + the "Owner for
  all" field only apply when it resolves to Master. The server always supported
  `target=universe`; only the client hard-pinned master before.
  - `admin.imports.replace` — without it the **Mode toggle is hidden** (always Merge) and
    the explainer drops the Merge/Replace step. The API 403s the `finalize-replace` action.
- **Owner is REQUIRED on Master** (`domain` required · `owner` required · `price` optional;
  template header `domain,owner,price`). The import **blocks** if any row lacks an owner;
  **Preview** surfaces a "Missing owner (required)" warn-stat + a log line. (Universe stores
  no owner, so it's not enforced there.)
- **Auto-enrich now defaults ON** (auto-backfill already did).

- **Upsert** is chunked client-side (universe 400/req, master 1000) and **halves on a
  statement timeout** (`57014`) server-side, so big files (145K+) land. Universe goes
  through the `upsert_universe_rows` merge RPC; master is a plain upsert (+`owner`,
  Master-only). Preview streams **domain strings** in 3,000-batches (`preview-existing`),
  and `countExisting` sub-chunks the `IN(...)` at 200 (URL-length cap).
- **Source typeahead** is target-aware: Universe = `sources.yaml` registry ids +
  `UNIVERSE_EXTRA_SOURCES` (brandbucket — a manual feed not in the registry) + names
  from the import log; Master = `distinct_master_sources()` RPC + log names.
- **Post-import backfill** = `backfill-universe-structural.yml` (universe; all 6
  structural fields) / `backfill-quality-master.yml` (master; quality_score only,
  `commit=true`).
- **Enrich = NET-NEW ONLY ∧ quality_score ≥ 1 ∧ un-enriched.** Never re-enrich names
  that already existed (a Merge just appends the source to their `sources[]`). Net-new
  via `--new-since <import_ts>`: universe `first_seen` (a DATE), master `created_at` —
  **floored to the date** (import rows are created just before the log entry, so an
  exact-timestamp `>=` would miss them). `--source` scopes to the import's source.
- **`pipeline enrich-batch auto --min-batch-saving 5`** is the chained enrich: counts
  eligible, estimates the 50%-off batch saving from `RATES`, and runs **realtime
  immediately** unless the saving clears $5 → then submits the async batch (collected by
  the 4h cron). Fail-safe: if the eligible count times out it returns -1 → submit async.
  `--source` / `--new-since` were added to `enrich` + `enrich-batch` + the `pipeline` CLI
  subparsers (cli.py builds its own argv — wire new flags in BOTH the tool and cli.py).

**Required one-time SQL:**
```sql
-- naming project (snagged-naming-universe) — CRITICAL: source-scoped count/enrich/status
-- seq-scan + time out (57014) without this.
create index concurrently if not exists idx_universe_sources_gin
  on name_universe using gin (sources);
-- masterlist project — powers the Master source typeahead
create or replace function distinct_master_sources()
returns table(source text) language sql stable as $$
  select distinct source from "Master Domain List"
  where source is not null and source <> '' order by source $$;
-- main research project — import-history log (migrations 0004 + 0005)
create table if not exists domain_research_imports ( ... );   -- 0004
alter table domain_research_imports add column if not exists import_ts timestamptz;  -- 0005
```
Validated 2026-06-02: Reflex (1,960→1,959 net-new→616 q≥1→616 enriched via batch),
brandbucket (145,722→5 net-new→0 q≥1→skipped), Narendra Ghimire (1,496→20→13→13 enriched
realtime). All three paths (batch / skip / realtime) confirmed.

# Permissions — granular per-tab admin (lib/permissions.ts)

Two-tier model (module + action) in `dashboard/lib/permissions.ts`, stored in the
`permissions` JSONB on `domain_research_users`. **Every Admin tab is its own
user-settable permission** (`ADMIN_TABS` is the single source of truth for the
sub-nav + each tab's gate): `admin.sources` · `admin.config` · `admin.schedule` ·
`admin.users.manage` (Users) · `admin.imports` (+ `admin.imports.replace`) ·
`admin.lessons.approve` (Lessons). The `admin` umbrella key (and the `is_admin`
flag) grants ALL tabs.
- `canAdmin(user, key)` = `is_admin || perms.admin || perms[key]`; `canEnterAdmin(user)`
  = umbrella or any one tab. The admin layout admits on `canEnterAdmin` and passes only
  the allowed tabs to `<Nav>`; the TopBar mirrors this on mobile; **each page also
  re-checks its own tab perm** (server-side). `/admin` (Sources) redirects to the
  user's first allowed tab if they lack `admin.sources`.
- `is_admin` is the **owner-only** break-glass superuser (auto-passes everything) —
  reserve it for the owner; grant everyone else granular tabs. Research-side perms are
  flat keys (`domain_owner`, …) via `storageKey`; the research SPA's Admin link checks
  `is_admin || permissions.admin`.
- **FORWARD RULE: every new module/tool gets its own granular, user-settable permission
  in MODULES/ACTIONS + CATALOG (+ ADMIN_TABS if it's an admin tab).** Never gate a new
  surface on `is_admin` or the coarse `admin` umbrella alone.

# Read-only DB lookups (claude_ro)

For troubleshooting / confirming functionality, a least-privilege Postgres role
`claude_ro` (SELECT-only + `BYPASSRLS`, so it still reads after RLS is on) exists
in all three projects. Query via `python3 scripts/db.py <research|naming|master>
"<sql>"`. The role can read everything but **cannot write** (no
INSERT/UPDATE/DELETE/DDL grants). Recreate/rotate: `alter role claude_ro with
login bypassrls password '…';` then `grant usage on schema public … ; grant
select on all tables in schema public …`.

**Primary transport — REST over HTTPS/443 (this is the web path; nothing else
works on the web).** Claude Code on the web egresses through an HTTP proxy that
allows **ports 80/443 only** — raw Postgres (5432/6543) never connects there, on
*any* network policy including "Full" (the dropdown gates HTTP *domains*, not TCP
ports), so the direct-pooler approach is a dead end for web sessions. Instead,
lookups go through a token-gated PostgREST RPC `claude_ro_query(q, token)`
(SECURITY DEFINER, owned by `claude_ro` → read-only by construction; the shared
token stops the *public* anon key reading through it; the query is wrapped as a
subquery so writes can't even parse). Setup SQL per project:
`scripts/claude_ro_rest.sql`. `db.py` uses REST whenever a project's three vars
are set in the Claude Code **web environment config** (NOT Vercel):
`{RESEARCH,NAMING,MASTERLIST}_SUPABASE_REST_URL` (https://&lt;ref&gt;.supabase.co),
`…_SUPABASE_ANON_KEY` (public anon key — gateway only), `…_SUPABASE_RO_TOKEN`
(the shared token from the SQL). Rotate the token:
`update public._claude_ro_auth set token = '…';`. **All three verified working
2026-06-02.** (Why a token-RPC and not a `role: claude_ro` JWT: these projects
use the **new asymmetric** Supabase JWT keys — no legacy HMAC secret to self-sign
with.)

**Fallback — direct Postgres (pooler) on 5432, local terminal only.** For a
local shell that *does* have raw 5432 egress, `db.py` falls back to
`RESEARCH_PG_RO_URL` / `NAMING_PG_RO_URL` / `MASTERLIST_PG_RO_URL` (shared
**Session pooler**) when the REST vars aren't set. These were **removed from the
web env config** (they never worked there — 5432 is unreachable) and remain only
as a documented local-terminal option.

# Security: enable RLS on Master + naming (no policies)

Supabase flagged the **Master** project (and naming is the same shape) for
`rls_disabled_in_public`. Our apps use the **service_role** key (bypasses RLS),
so enabling RLS with **no policies** closes anon/public access without breaking
anything (matches the main research project). Run per project:
`do $$ declare r record; begin for r in select tablename from pg_tables where
schemaname='public' loop execute format('alter table public.%I enable row level
security;', r.tablename); end loop; end $$;`

**Done:** Master + naming, and the **`snagged-zone-index`** project (the zone DB
behind Nameserver Search; reads via `ZONE_SUPABASE_SERVICE_KEY`) — RLS enabled with
no policies **2026-06-23**, clearing the `rls_disabled_in_public` advisor on each.

# Session handoff — 2026-06-02 (imports + notifications + permissions)

Shipped to `main` (both repos) this session:
- **Admin Imports tool** — full build (see section above): preview, owner column,
  net-new+quality auto-enrich (realtime <$5 / batch ≥$5), per-import funnel cards
  with green/yellow/red status + "view qualifying domains" drill-down, Re-enrich.
  Master is the default target.
- **Permissions** — new `admin.imports` (module) gates the import tool; new
  `admin.lessons.approve` (action) gates lesson curation. Both in
  `dashboard/lib/permissions.ts` CATALOG; research enforces `admin.lessons.approve`
  in `api/lessons.js` (was strict is_admin).
- **Notifications** — research `api/lessons.js` notifies curators (bell + email)
  when a lesson is submitted (`notifyAdminsOfLesson`, kind 'lesson'). The admin
  **top bar** now has the bell + profile avatar (`app/notifications-bell.tsx`,
  `app/top-bar.tsx`, `lib/notifications.ts`, `api/notifications/route.ts`) reading
  the shared `domain_research_notifications` table.

OPEN / next session:
1. **Run the GIN index** `idx_universe_sources_gin` on the naming project (CRITICAL
   for source-scoped enrich/count/status; without it they time out 57014).
2. **Run RLS-enable** on Master + naming (security alert above).
3. **Run migrations** 0004 + 0005 on the main research project (import-history log
   + `import_ts`).
4. **Verify read-only DB** once `*_PG_RO_URL` env vars are set: `python3
   scripts/db.py naming "select 1"`, then the brandbucket net-new split
   (`total` vs `first_seen>=current_date` vs `+ quality_score>=1`) to confirm the 0.
