// The subreddit universe for the domain-opportunity sweep (spec §5.3). Domain-native
// communities PLUS adjacent founder/marketing/startup subs where buy-side signals
// often surface first. Override via env CORPUS_REDDIT_SUBS (comma-separated).

const DEFAULT_SUBS = [
  "Domains", "domainnames", "Entrepreneur", "startups", "smallbusiness", "SaaS",
  "indiehackers", "SEO", "webdev", "marketing", "agency", "ecommerce", "shopify",
  "sideproject", "cofounder", "web_design", "startups_promotion", "branding",
  "juststart", "freelance", "content_marketing", "PPC", "Business_Ideas",
  "EntrepreneurRideAlong", "nocode",
];

export function subreddits(): string[] {
  const env = (process.env.REDDIT_SWEEP_SUBS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return env.length ? env : DEFAULT_SUBS;
}
