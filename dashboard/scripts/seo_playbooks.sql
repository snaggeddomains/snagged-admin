-- SEO action drill-downs — the full build kit (slug, title, H1, copy, FAQ, schema,
-- internal linking) for each seeded action, shown when you expand the action row.
-- Run AFTER scripts/seo.sql, on the MAIN project. Idempotent (UPDATE by title).
alter table seo_actions add column if not exists playbook text;

-- ── /domain-broker (verbatim from the Commercial SEO Page Build Kit) ──────────────
update seo_actions set playbook = $md$
## Webflow page settings
- **Template:** Standard Page
- **Slug:** `domain-broker` → www.snagged.com/domain-broker
- **Access:** Public · **Sitemap indexing:** On
- **Title tag (53 chars):** Domain Broker — Buy or Sell Premium Domains | Snagged
- **Meta description:** Work with a founder-led domain broker to buy or sell a premium domain. Aligned fees, fast outreach, and real negotiation on your behalf.
- **Canonical:** https://www.snagged.com/domain-broker
- **OG title/description:** same as SEO · **OG image:** branded 1200×630
- **Primary keyword:** domain broker · **Secondary:** domain brokers, best domain broker, domain name broker, premium domain broker, domain acquisition, buy a domain, sell a domain

## Page copy
**H1:** Domain Broker Services That Get the Deal Done

**Intro:** Whether you're trying to acquire the exact name you want or sell a domain you own, a good domain broker is the difference between a deal that closes and months of silence. Snagged is a founder-led brokerage that negotiates domain deals on your behalf — quietly, quickly, and with our incentives lined up with yours.

**H2 — What a domain broker does:** A domain broker represents you in a domain transaction. On the buy side, we find out who really owns the name you want (even when it's behind privacy), open the conversation, and negotiate the price down. On the sell side, we find the buyers who'd pay the most for your name and run the outreach and negotiation for you. Either way, you stay anonymous, you don't tip your hand on budget, and you get someone who does this every day pushing for the best possible number.

**H2 — Buying a domain (acquisition):** Most premium names aren't officially for sale — and the ones that are listed are almost never priced at what they'll actually sell for. Our domain acquisition process is part detective work, part negotiation: we identify the owner, gauge how flexible they are, and float offers to bring the price down. Sometimes we get owners down 50%+; sometimes they barely move. And if the name you want is out of budget today, we'll help you find a strong starter name you can upgrade from later, instead of pushing you to overspend.

**H2 — Selling a domain:** If you own a great domain, the highest bidder usually isn't the person who happens to email you — it's a company that doesn't know it wants your name yet. We identify the businesses that would benefit most from owning it, reach out on your behalf, and negotiate from a position of strength. You set the floor; we go find the ceiling.

**H2 — Why work with Snagged:**
- We're operators, not just brokers. Snagged is run by startup founders (Rob co-founded Ro, the telehealth company). We've been on the other side of these decisions.
- Our fee is aligned with your outcome. We typically work off a share of the savings we negotiate, so we only win when you win. At earlier stages we'll flex the structure so it's fair for where you are.
- We move fast. Founders tell us we reply faster than any broker they've contacted.
- Straight talk. If we don't think a deal is worth it, we'll tell you.
- Trusted by funded startups. We do a lot of work with YC and venture-backed companies.

**H2 — How it works:**
1. Tell us the domain — the name you want to buy or the one you want to sell.
2. We do the homework — identify the owner (or the buyers), assess flexibility, set a strategy.
3. We negotiate — float offers and work the price, keeping you anonymous.
4. You approve the deal — nothing happens without your sign-off; we handle transfer and escrow.

**H2 — Our fees:** No confusing retainers. For most acquisitions we work off a percentage of the cost savings we negotiate, so we're motivated to get you the lowest price — and we'll calibrate the structure to your stage. You'll always know the arrangement in writing before we start.

**CTA block (top + bottom):** Ready to buy or sell a domain? Tell us the name and we'll tell you how we'd approach it — no obligation. Buttons: **[Book assessment]** (buy) / **[Book evaluation]** (sell) → Contact form. Or call 855-SNAGGED.

## FAQ (on-page + powers the schema)
- **What does a domain broker do?** A domain broker represents you in buying or selling a domain — finding the counterparty, negotiating the price, and keeping you anonymous.
- **How much does a domain broker cost?** Fees vary. Snagged typically works off a share of the savings we negotiate, so our incentives are aligned with getting you the best price; we put the arrangement in writing up front.
- **Can a domain broker get a name that isn't for sale?** Often, yes. Many owners will sell at the right price even without a public listing.
- **How long does a domain acquisition take?** It depends on the owner's responsiveness, but many deals wrap in roughly 2–4 weeks.
- **Do I stay anonymous?** Yes. Owners and buyers negotiate with the broker, not with you.

## Internal links to add
- Link to `/marketplace` as "browse our domains for sale"
- Link to `/snagged-reviews` as "Snagged reviews" (trust)
- Link to `/guides` as "domain guides"
- Add `/domain-broker` to the main nav + footer

## Schema markup (paste into Webflow's JSON-LD field; else wrap in a <script> in <head>)
```json
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Service",
      "@id": "https://www.snagged.com/domain-broker#service",
      "name": "Domain Broker Services",
      "serviceType": "Domain brokerage, acquisition and sales",
      "url": "https://www.snagged.com/domain-broker",
      "areaServed": "Worldwide",
      "description": "Founder-led domain broker services for acquiring and selling premium domains, with aligned fees and full-service negotiation.",
      "provider": { "@type": "Organization", "name": "Snagged", "url": "https://www.snagged.com", "telephone": "+1-855-762-4433", "email": "sales@snagged.com" }
    },
    {
      "@type": "FAQPage",
      "mainEntity": [
        {"@type":"Question","name":"What does a domain broker do?","acceptedAnswer":{"@type":"Answer","text":"A domain broker represents you in buying or selling a domain, finding the counterparty, negotiating the price, and keeping you anonymous."}},
        {"@type":"Question","name":"How much does a domain broker cost?","acceptedAnswer":{"@type":"Answer","text":"Fees vary. Snagged typically works off a share of the savings we negotiate, so our incentives are aligned with getting you the best price; we put the arrangement in writing up front."}},
        {"@type":"Question","name":"Can a domain broker get a name that isnt for sale?","acceptedAnswer":{"@type":"Answer","text":"Often, yes. Many owners will sell at the right price even without a public listing."}},
        {"@type":"Question","name":"How long does a domain acquisition take?","acceptedAnswer":{"@type":"Answer","text":"It depends on the owners responsiveness, but many deals wrap in roughly 2 to 4 weeks."}},
        {"@type":"Question","name":"Do I stay anonymous?","acceptedAnswer":{"@type":"Answer","text":"Yes. Owners and buyers negotiate with the broker, not with you."}}
      ]
    }
  ]
}
```
$md$ where title = 'Build /domain-broker page';

-- ── /sell-your-domain ────────────────────────────────────────────────────────────
update seo_actions set playbook = $md$
## Webflow page settings
- **Slug:** `sell-your-domain` → www.snagged.com/sell-your-domain
- **Title tag:** Sell a Domain — Reach the Buyers Who Pay Most | Snagged
- **Meta description:** Sell your domain for what it's really worth. We find the companies that would benefit most from owning it and negotiate the sale on your behalf.
- **Primary keyword:** sell a domain · **Secondary:** sell my domain, sell a domain name, how to sell a domain, domain broker

## Page copy
**H1:** Sell Your Domain to the Buyer Who Values It Most

**Intro:** The person who happens to email you about your domain is rarely the one who'll pay the most for it. We find the companies that would benefit most from owning your name, reach out on your behalf, and negotiate from strength. You set the floor; we go find the ceiling.

**H2 — How selling a domain with a broker works:** We research who's actively building in your name's space, identify decision-makers, and open a discreet conversation that frames your domain as the obvious upgrade. Because buyers negotiate with us, not you, you never look eager and you never reveal your floor.

**H2 — Why the right buyer beats the first buyer:** A funded startup rebranding onto your exact-match .com will pay a multiple of what a flipper offers. Our whole model is finding that buyer — matching your name to the businesses whose growth it unlocks.

**H2 — What your domain is worth:** Not sure of the number? Start with a free appraisal, then we'll pressure-test it against real comparable sales before we take it to market. (Link to /domain-appraisal.)

**H2 — Why work with Snagged:** Founder-led, incentives aligned with your outcome, fast, and trusted by YC / venture-backed companies. We only win when you win.

**H2 — How it works:** 1) Tell us the domain. 2) We set a floor and a target list of likely buyers. 3) We run outreach + negotiation, keeping you anonymous. 4) You approve; we handle escrow + transfer.

**CTA:** Own a great domain? **[Book an evaluation]** → contact form, or call 855-SNAGGED.

## FAQ
- **How do I sell my domain?** List the floor you'd accept; we identify the highest-value buyers, negotiate, and close via escrow.
- **What's my domain worth?** Get a free appraisal, then we validate it against comparable sales.
- **How long does it take to sell a domain?** Varies by demand; a well-matched buyer often closes in weeks, not months.
- **Do I stay anonymous?** Yes — buyers deal with the broker, not you.

## Internal links
- `/domain-appraisal` as "free domain appraisal" · `/marketplace` as "domains for sale" · `/snagged-reviews` as trust · link "domain broker" → `/domain-broker`.

## Schema
Reuse the Service + FAQPage JSON-LD from the /domain-broker kit; change `name` to "Sell Your Domain", the `url`/`@id` to this page, and swap in this page's FAQ questions.
$md$ where title = 'Build /sell-your-domain page';

-- ── /buy-a-domain (acquisition) ──────────────────────────────────────────────────
update seo_actions set playbook = $md$
## Webflow page settings
- **Slug:** `buy-a-domain` → www.snagged.com/buy-a-domain
- **Title tag:** Domain Acquisition — Buy the Name You Actually Want | Snagged
- **Meta description:** Want a domain that isn't for sale? Our domain acquisition service finds the owner, opens the conversation, and negotiates the price down — anonymously.
- **Primary keyword:** domain acquisition · **Secondary:** buy a domain, buy a domain name, how to buy a domain that's taken, domain broker

## Page copy
**H1:** Domain Acquisition — Get the Name That Isn't for Sale

**Intro:** Most premium names aren't listed, and the ones that are almost never priced at what they'll actually sell for. We find out who really owns the name you want (even behind privacy), open the conversation, and negotiate the price down — while you stay anonymous.

**H2 — How domain acquisition works:** Part detective work, part negotiation. We identify the owner, gauge flexibility, and float offers strategically. Sometimes we get owners down 50%+; sometimes they barely move — either way you learn the real number without tipping your hand.

**H2 — If your dream name is out of budget:** We'll help you find a strong starter name you can upgrade from later instead of overpaying today. (Link to /marketplace and /domain-appraisal.)

**H2 — Why a broker gets a better price:** Owners hold firm against an eager end-buyer and soften with a professional who negotiates these every day and keeps you anonymous.

**H2 — Why work with Snagged:** Founder-led, fee aligned to the savings we negotiate (we're motivated to get you the lowest price), fast, trusted by funded startups.

**H2 — How it works:** 1) Tell us the name. 2) We identify the owner + set strategy. 3) We negotiate anonymously. 4) You approve; we handle escrow + transfer.

**CTA:** Know the name you want? **[Book an assessment]** → contact form, or call 855-SNAGGED.

## FAQ
- **Can I buy a domain that's already taken?** Often yes — many owners sell at the right price even without a listing.
- **How much does domain acquisition cost?** Our fee is typically a share of the savings we negotiate, agreed in writing up front.
- **How long does it take?** Many acquisitions wrap in ~2–4 weeks depending on the owner.
- **Do I stay anonymous?** Yes.

## Internal links
- `/domain-broker` as "domain broker" · `/domain-appraisal` as "what a domain is worth" · `/marketplace` as "starter names".

## Schema
Reuse the Service + FAQPage JSON-LD from the /domain-broker kit; set `name` to "Domain Acquisition", update url/@id + FAQ.
$md$ where title = 'Build /buy-a-domain (acquisition) page';

-- ── /domain-appraisal (free tool landing) ────────────────────────────────────────
update seo_actions set playbook = $md$
## Why this one can BEAT MediaOptions
They rank for "domain value" (2.7K vol) with a text blog post. We have an actual appraisal **tool** — a free-tool landing page out-ranks a text page, attracts links, and generates leads. This is our best offensive play.

## Webflow page settings
- **Slug:** `domain-appraisal` → www.snagged.com/domain-appraisal
- **Title tag:** Free Domain Appraisal — What Is Your Domain Worth? | Snagged
- **Meta description:** Get a free, instant domain appraisal. See what your domain name is worth based on real comparable sales — then talk to a broker about selling it.
- **Primary keyword:** domain appraisal · **Secondary:** domain value, what is my domain worth, domain name value, domain appraisal tool

## Page structure
**H1:** What Is Your Domain Worth? Free Domain Appraisal
- **Above the fold:** the appraisal tool itself (domain input → instant estimate). The tool must be crawlable/indexable — server-render the intro copy, don't hide it behind JS.
- **H2 — How our domain appraisal works:** We blend real comparable sales, keyword demand, extension, length, and brandability into a defensible range — not a black-box guess.
- **H2 — Appraisal vs. what it'll actually sell for:** An appraisal is a starting point; the sale price is set by the right buyer. If you want to sell, we'll validate the number and take it to market. (Link to /sell-your-domain.)
- **H2 — FAQ + CTA:** "Want the real number? Book a broker evaluation." → contact form.

## FAQ
- **How is a domain appraised?** By comparing it to real sales of similar names plus demand, length, extension, and brandability.
- **Is the appraisal free?** Yes — enter a domain for an instant estimate.
- **What's my domain actually worth?** The appraisal gives a defensible range; the sale price depends on the buyer, which is where a broker adds value.

## Internal links
- `/sell-your-domain` as "sell your domain" · `/domain-broker` as "domain broker" · relevant `/guides`.

## Schema
Add **WebApplication** (the appraisal tool) + **FAQPage** JSON-LD. WebApplication: name "Domain Appraisal Tool", applicationCategory "BusinessApplication", offers price 0.
$md$ where title = 'Ship /domain-appraisal free-tool landing page';

-- ── Internal linking → USE the Crosslinking tool (don't do it by hand) ────────────
update seo_actions set playbook = $md$
## Use the built-in Crosslinking engine — don't do this manually
We already have this: **Reports → Content → Crosslinking tab** finds the highest-relevance internal-link opportunities across the blog AND inserts them into the Webflow post body (staged or live) in one click. Don't hand-edit posts.

**Steps:**
1. Go to **Reports → Content** and switch to the **Crosslinking** tab.
2. Click **Analyze** (heavy, runs a few minutes) to (re)build the ranked opportunities.
3. Once the money pages exist, look for rows whose **target** is `/domain-broker`, `/sell-your-domain`, `/buy-a-domain`, or `/domain-appraisal` — especially FROM the high-authority posts (nissan, geocities, gmail, casper).
4. **Insert** (staged draft, safe) or **＋ Live** per row; or bulk-select and Insert. The engine wraps a body-prose anchor (never a heading) or adds a sentence, and repoints weak existing links.
5. 👍/👎 to train it. Done rows disappear.

**Guidance:** favor exact-match anchors — "domain broker", "sell your domain", "domain acquisition", "domain appraisal" — pointing at the matching money page. This is the fastest lever on the board (no new authority needed), but it only surfaces links once the target pages are published, so build those first.

→ Open it: `/reports/content` (Crosslinking tab).
$md$ where title = 'Internal-link money pages from top 5 blog posts';

-- ── /brokered-domains case-study hub ─────────────────────────────────────────────
update seo_actions set playbook = $md$
## Steal MediaOptions' best playbook — we're already set up to win it
They turn every closed deal into a page (/brokered-domains/ok-com/, /url-com/, …) optimized for "<name>.com" that internally links "domain broker". We already write great deal narratives — just re-point them commercially instead of pure storytelling.

## Structure
- **Hub:** `/brokered-domains` — a grid of closed-deal case studies + an H1 "Domains We've Brokered" and intro that uses "domain broker" naturally, linking `/domain-broker`.
- **Per deal:** `/brokered-domains/<name>-com` — Title "How We Brokered <Name>.com | Snagged", H1 "<Name>.com — Brokered by Snagged". Cover: the challenge, that we found the owner behind privacy, the negotiation, the outcome. Each page **internally links `/domain-broker`** with a "domain broker" anchor and `/domain-appraisal`.
- Target keyword per page = the exact **`<name>.com`** (people search the name; we intercept with proof we can get it).

## Reuse what we have
- Repurpose existing deal narratives (the Marketplace deal reports) into case-study copy — commercial angle, not storytelling.
- Add each case study to the sitemap; feature 3–4 on `/domain-broker` as proof.

## Schema
Per case study: **Article** JSON-LD (+ optional Review/AggregateRating on the hub from /snagged-reviews).
$md$ where title = 'Build /brokered-domains case-study hub';
