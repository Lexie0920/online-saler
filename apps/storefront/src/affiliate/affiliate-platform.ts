export const COLLECTION_MIN_ITEMS = 5;
export const COLLECTION_MAX_ITEMS = 30;
export const AFFILIATE_LEVELS = ["LEVEL_1", "LEVEL_2", "LEVEL_3"] as const;
export const STATUS_PACK_ITEM_COUNTS = [4, 6, 8] as const;

export type AffiliateTracking = {
  source?: string | null;
  placement?: string | null;
  campaign?: string | null;
};

export function slugifyAffiliateValue(value: string, fallback = "affiliate"): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  return normalized || fallback;
}

export function normalizeTrackingValue(value?: string | null): string | null {
  const normalized = value?.trim().replace(/[^a-zA-Z0-9_.:-]/g, "").slice(0, 80);
  return normalized || null;
}

export function normalizeTrackingSource(value?: string | null): string | null {
  return normalizeTrackingValue(value)?.toLowerCase() ?? null;
}

export function buildAffiliatePath(
  path: string,
  affiliateCode: string,
  tracking: AffiliateTracking = {},
): string {
  const url = new URL(path, "https://direct-loop.invalid");
  url.searchParams.set("ref", affiliateCode);
  url.searchParams.set("source", normalizeTrackingSource(tracking.source) ?? "direct");
  url.searchParams.set("placement", normalizeTrackingValue(tracking.placement) ?? "share");
  url.searchParams.set("campaign", normalizeTrackingValue(tracking.campaign) ?? "organic");
  return `${url.pathname}?${url.searchParams.toString()}`;
}

export function collectionPublicationIssue(itemCount: number): string | null {
  if (itemCount < COLLECTION_MIN_ITEMS) {
    return `Add at least ${COLLECTION_MIN_ITEMS} products before publishing.`;
  }
  if (itemCount > COLLECTION_MAX_ITEMS) {
    return `A collection can contain at most ${COLLECTION_MAX_ITEMS} products.`;
  }
  return null;
}

export function statusPackPageCount(itemCount: number): number {
  if (!STATUS_PACK_ITEM_COUNTS.includes(itemCount as (typeof STATUS_PACK_ITEM_COUNTS)[number])) {
    throw new Error("Status packs support exactly 4, 6, or 8 products.");
  }
  return itemCount;
}

export function affiliateConversionRate(orders: number, clicks: number): number {
  if (clicks <= 0 || orders <= 0) return 0;
  return Math.round((orders / clicks) * 10_000) / 100;
}

/**
 * Orders, sales and commission on the promoter dashboard all come from the same
 * commission rows, so commission / sales reads as the real rate (25%). Sales used
 * to add up every attributed order, including unpaid, cancelled and expired ones
 * that never earn commission, which made the rate look like ~17%. Rejected
 * commissions earn nothing and count in none of the three.
 */
export function affiliateEarningTotals(
  commissions: Array<{ status: string; orderSubtotalKsh: number; commissionAmountKsh: number }>,
): { orders: number; sales: number; commission: number } {
  const earning = commissions.filter((row) => row.status !== "REJECTED");
  return {
    orders: earning.length,
    sales: earning.reduce((total, row) => total + row.orderSubtotalKsh, 0),
    commission: earning.reduce((total, row) => total + row.commissionAmountKsh, 0),
  };
}

/**
 * Orders attributed to a promoter: all of them, how many are paid, how many are not (yet).
 * "Paid" is the back office's definition (paid, being fulfilled or completed), so the
 * promoter and the staff read the same numbers. Unpaid, cancelled and expired orders
 * earn nothing but still count in the total.
 */
export function affiliateOrderCounts(total: number, paid: number): { total: number; paid: number; unpaid: number } {
  const safeTotal = Math.max(0, total);
  const safePaid = Math.min(Math.max(0, paid), safeTotal);
  return { total: safeTotal, paid: safePaid, unpaid: safeTotal - safePaid };
}

export function affiliateLevelLabel(level: string): string {
  const match = /^LEVEL_([123])$/.exec(level);
  return match ? `Level ${match[1]}` : "Level 1";
}

export type AffiliateDailyPoint = {
  /** A Nairobi calendar date, e.g. 2026-10-12. */
  date: string;
  /** Orders that earn commission (not rejected) credited on that day. */
  orders: number;
  /** Commission earned on that day. */
  commission: number;
};

const NAIROBI_OFFSET_MS = 3 * 60 * 60 * 1000;

function nairobiDay(date: Date): string {
  return new Date(date.getTime() + NAIROBI_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * One point per Nairobi day for the last `days` days (oldest first, today last),
 * so the charts on the Results and Earnings pages have no gaps. Uses the same
 * rows as the totals (rejected commission earns nothing and is left out).
 */
export function affiliateDailySeries(
  commissions: Array<{ status: string; commissionAmountKsh: number; createdAt: Date }>,
  days: number,
  now: Date = new Date(),
): AffiliateDailyPoint[] {
  const points = new Map<string, AffiliateDailyPoint>();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = nairobiDay(new Date(now.getTime() - offset * 24 * 60 * 60 * 1000));
    points.set(date, { date, orders: 0, commission: 0 });
  }
  for (const row of commissions) {
    if (row.status === "REJECTED") continue;
    const point = points.get(nairobiDay(row.createdAt));
    if (!point) continue;
    point.orders += 1;
    point.commission += row.commissionAmountKsh;
  }
  return [...points.values()];
}
