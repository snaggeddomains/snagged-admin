// Platform-agnostic ad-report shape, shared by every ad-spend source (X, Reddit, and
// future Meta/Google) so the Site Analytics "Ads" tranche renders any platform with one
// view. X (lib/xads.ts) and Reddit (lib/redditads.ts) both return this shape.

export type AdTotals = {
  spend: number;
  impressions: number;
  clicks: number;
  engagements: number;
  cpc: number; // spend / clicks
  cpm: number; // spend / impressions * 1000
  ctr: number; // clicks / impressions
};

export type AdCampaign = {
  id: string;
  name: string;
  status: string;
  spend: number;
  impressions: number;
  clicks: number;
  engagements: number;
  cpc: number;
};

export type AdDaily = { date: string; spend: number; impressions: number; clicks: number };

// ROI = platform spend vs the platform-attributed leads the core funnel reports (the
// "How did you hear about us → <platform>" self-report). null when GA isn't configured.
export type AdRoi = {
  leads: number | null;
  totalLeads: number | null;
  costPerLead: number | null;
  gaConfigured: boolean;
};

export type AdReport = {
  totals: AdTotals;
  byCampaign: AdCampaign[];
  trend: AdDaily[];
  roi: AdRoi;
  campaignCount: number;
};

// The ad platforms the Ads tranche can show. `configured` is filled per-deployment.
export type AdPlatformId = "x" | "reddit" | "meta" | "google";
export type AdPlatform = { id: AdPlatformId; label: string; live: boolean };
