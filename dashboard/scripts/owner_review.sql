-- Owner Review queue — human-in-the-loop confirmation of the "owner we bought from"
-- for each closed Master Txn where our email search surfaced a candidate. Reviewers
-- (Rob / Brian / Sam) confirm → the owner is upserted into deal_owners + linked to the
-- matching deal. New Master Txn rows create a new pending card (Increment 2 cron).
-- Run once on the MAIN project. RLS enabled (service key bypasses).
create table if not exists owner_review_cards (
  id                   uuid primary key default gen_random_uuid(),
  domain               text not null,
  txn_date             text,
  txn_price            text,
  candidate_name       text,
  candidate_first_name text,
  candidate_email      text,
  candidate_phone      text,
  channel              text,            -- Escrow.com / GoDaddy / Direct / Afternic / DropCatch auction / registration / inbound sale …
  buyer_context        text,           -- who we SOLD to (context; never the owner)
  confidence           text,           -- high | medium | low | none | broker
  evidence             text,           -- short human-readable note / thread evidence
  notes                text,           -- reviewer's free-text note
  status               text not null default 'pending',  -- pending | confirmed | rejected | skipped | dismissed
  assigned_to          text,           -- reviewer email (per-card assignment)
  reviewed_by          text,
  reviewed_at          timestamptz,
  deal_owner_id        uuid references deal_owners(id) on delete set null,
  source               text not null default 'txn',      -- txn | manual
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
-- Explicit last name (first name is candidate_first_name). candidate_name stays as the
-- computed "First Last" display/owner name. Added after the initial ship — safe to re-run.
alter table owner_review_cards add column if not exists candidate_last_name text;
-- Stamp set when a card has been RE-MINED with the whole-thread miner, so the background re-mine
-- drain processes each wrong card exactly once (and terminates). Added after ship — safe to re-run.
alter table owner_review_cards add column if not exists remined_at timestamptz;
create unique index if not exists idx_owner_review_domain on owner_review_cards (lower(domain));
create index if not exists idx_owner_review_queue on owner_review_cards (status, assigned_to);
alter table owner_review_cards enable row level security;

-- Seed: the 15 calibrated cards (thread-read, direction-aware). Idempotent — a domain
-- already present is left untouched, so re-running is safe.
insert into owner_review_cards
  (domain, txn_date, txn_price, candidate_name, candidate_first_name, candidate_email, candidate_phone, channel, buyer_context, confidence, evidence, assigned_to)
values
  ('sagapanama.com','9/1/2026','$1,770','Michel Lecumberry','Michel','michel.lecumberry@gmail.com','','Escrow.com','','high','Seller transacted via Escrow; direct email on file.','rob@snagged.com'),
  ('agentnative.com','8/28/2026','$28,000','','','','','Spaceship aftermarket','','broker','Bought via Spaceship aftermarket; owner not named.','rob@snagged.com'),
  ('tryscope.com','8/28/2026','$2,898','','','','','Inbound sale (no acquisition thread)','Anand Pajaniradjane <anand@tryscope.app>','none','Only the BUYER is in email (Anand bought FROM us); no seller/acquisition thread.','rob@snagged.com'),
  ('lfg.ai','8/27/2026','$50,000','Rick Latona','Rick','rick@giantpanda.com','','Direct','','high','Rick Latona (domain investor) — direct seller.','rob@snagged.com'),
  ('harbor.ai','8/26/2026','$80,000','Marc Hadfield','Marc','marc@vital.ai','','Escrow.com','Ghalib Suleiman <ghalib@polytomic.com> (inquired)','high','Seller Marc Hadfield (Vital.ai) via Escrow; a separate buyer also inquired.','rob@snagged.com'),
  ('netz.com','8/25/2026','$52,200','','','','','Escrow.com','Uzi Dan Pagirsky <uzi@acentecom.com> (BUYER)','none','Uzi is the BUYER, not the seller; the seller is escrow-hidden.','sam@snagged.com'),
  ('booko.com','8/24/2026','$35,000','','','','','GoDaddy','Arjun Saluja <arjun@bookoapp.com>','broker','Via GoDaddy broker (owner not named; "done several deals w/ this owner").','rob@snagged.com'),
  ('abortion.org','8/24/2026','$76,100','','','','','DropCatch auction','Daniel Nall / ineedana.com <eng@ateam.tech>','none','Caught at a DropCatch drop auction — no prior owner.','rob@snagged.com'),
  ('dale.org','8/20/2026','$45,000','','','domainnetcontact@gmail.com','','Escrow.com','','medium','Seller emailed from a generic handle via Escrow; no first name in-thread.','rob@snagged.com'),
  ('ghost.ai','8/20/2026','$700,000','','','','','Escrow.com','Zain Javaid <zain@tryghost.ai>','broker','Via Escrow (owner hidden); sold to Zain @tryghost.ai.','brian@snagged.com'),
  ('levi.ne','8/18/2026','$463.49','','','','','101domain (registration)','Daniel Levine <daniel.mark.levine@gmail.com>','none','Registered via 101domain — not bought from an owner.','sam@snagged.com'),
  ('cicerp.com','8/18/2026','$9,800','','','','','Direct transfer (seller anonymous)','Logan / Dylan Bohlender <cicesp.com>','low','Seller updated NS + auth code but never emailed directly.','brian@snagged.com'),
  ('quorum.news','8/17/2026','$4,920','','','','','GoDaddy / Afternic listing','vmansur@quorum.us (client/buyer)','broker','Bought off a GoDaddy/Afternic listing; no direct seller in email.','rob@snagged.com'),
  ('industrial.capital','8/11/2026','$20,000','Tim Symington','Tim','timsymington@gmail.com','','Escrow.com','Blake Masters <blake@industrialcapital.co>','low','Escrow deal; possible seller Tim Symington — verify. Buyer = Blake Masters.','brian@snagged.com'),
  ('atob.io','8/10/2026','$12,888','','','','','Afternic','Gireesh Bandlamudi <gireesh@atob.com>','broker','Bought off Afternic (NS afternic→cloudflare); sold to atob.com.','rob@snagged.com')
on conflict (lower(domain)) do nothing;

-- Correct the named-seller rows to clean First + Last (idempotent; only touches still-pending
-- cards so a confirmed/edited card is never clobbered). Fixes rows seeded before the last-name
-- split — e.g. harbor.ai was "Marc (Vital.ai)" → "Marc Hadfield".
update owner_review_cards set candidate_name='Marc Hadfield',    candidate_first_name='Marc',   candidate_last_name='Hadfield',   evidence='Seller Marc Hadfield (Vital.ai) via Escrow; a separate buyer also inquired.' where lower(domain)='harbor.ai' and status <> 'confirmed';
update owner_review_cards set candidate_name='Michel Lecumberry', candidate_first_name='Michel', candidate_last_name='Lecumberry' where lower(domain)='sagapanama.com' and status <> 'confirmed';
update owner_review_cards set candidate_name='Rick Latona',       candidate_first_name='Rick',   candidate_last_name='Latona'     where lower(domain)='lfg.ai' and status <> 'confirmed';
update owner_review_cards set candidate_name='Tim Symington',     candidate_first_name='Tim',    candidate_last_name='Symington'  where lower(domain)='industrial.capital' and status <> 'confirmed';
