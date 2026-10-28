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
  /** Sales (order subtotals) on that day. */
  sales: number;
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
  commissions: Array<{ status: string; commissionAmountKsh: number; orderSubtotalKsh?: number; createdAt: Date }>,
  days: number,
  now: Date = new Date(),
): AffiliateDailyPoint[] {
  const points = new Map<string, AffiliateDailyPoint>();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = nairobiDay(new Date(now.getTime() - offset * 24 * 60 * 60 * 1000));
    points.set(date, { date, orders: 0, commission: 0, sales: 0 });
  }
  for (const row of commissions) {
    if (row.status === "REJECTED") continue;
    const point = points.get(nairobiDay(row.createdAt));
    if (!point) continue;
    point.orders += 1;
    point.commission += row.commissionAmountKsh;
    point.sales += row.orderSubtotalKsh ?? 0;
  }
  return [...points.values()];
}

/** The next Monday after `now`, as a Nairobi calendar date. Weekly M-Pesa payouts go out on Mondays. */
export function nextPayoutDate(now: Date = new Date()): string {
  const nairobi = new Date(now.getTime() + NAIROBI_OFFSET_MS);
  const weekday = nairobi.getUTCDay(); // 0 = Sunday ... 1 = Monday
  const daysAhead = ((8 - weekday) % 7) || 7;
  return new Date(nairobi.getTime() + daysAhead * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Orders in the last 7 days against the 7 days before, from the daily series (oldest first). */
export function affiliateWeekComparison(daily: AffiliateDailyPoint[]): { thisWeek: number; lastWeek: number } {
  const sum = (points: AffiliateDailyPoint[]) => points.reduce((total, point) => total + point.orders, 0);
  return { thisWeek: sum(daily.slice(-7)), lastWeek: sum(daily.slice(-14, -7)) };
}

export type AffiliateNextGoal =
  | { kind: "createCollection" }
  | { kind: "addProducts"; count: number }
  | { kind: "firstOrder" }
  | { kind: "beatLastWeek"; target: number };

/** One small next step for the Home page, from the simplest missing thing to the next order target. */
export function affiliateNextGoal(input: {
  collections: number;
  largestCollectionItems: number;
  ordersTotal: number;
  thisWeek: number;
  lastWeek: number;
  minCollectionItems?: number;
}): AffiliateNextGoal {
  const min = input.minCollectionItems ?? 5;
  if (input.collections === 0) return { kind: "createCollection" };
  if (input.largestCollectionItems < min && input.ordersTotal === 0) {
    return { kind: "addProducts", count: min - input.largestCollectionItems };
  }
  if (input.ordersTotal === 0) return { kind: "firstOrder" };
  return { kind: "beatLastWeek", target: Math.max(input.thisWeek, input.lastWeek) + 1 };
}

export const SHARE_CHANNELS = ["WHATSAPP", "TIKTOK", "INSTAGRAM", "FACEBOOK", "OTHER"] as const;
/** Channels a link can be tagged with: the ones in the Share dialog, plus WhatsApp Status (videos and Status packs). */
const TAGGED_CHANNELS = [...SHARE_CHANNELS, "STATUS"] as const;
export type ShareChannel = (typeof SHARE_CHANNELS)[number];

export type TaggedChannel = (typeof TAGGED_CHANNELS)[number];

const SHARE_CHANNEL_TRACKING: Record<TaggedChannel, { source: string; placement: string }> = {
  WHATSAPP: { source: "whatsapp", placement: "direct-message" },
  STATUS: { source: "whatsapp-status", placement: "status-pack" },
  TIKTOK: { source: "tiktok", placement: "link-in-bio" },
  INSTAGRAM: { source: "instagram", placement: "post" },
  FACEBOOK: { source: "facebook", placement: "post" },
  OTHER: { source: "other", placement: "share" },
};

/** A share link for a page, tagged with the channel the promoter picked. No setup step is needed first. */
export function buildShareLink(path: string, affiliateCode: string, channel: TaggedChannel): string {
  return buildAffiliatePath(path, affiliateCode, { ...SHARE_CHANNEL_TRACKING[channel], campaign: "organic" });
}

/** Everyday name for a click `source`, for the "where clicks came from" list. */
export function shareSourceLabel(source: string | null | undefined): string {
  const names: Record<TaggedChannel, string> = {
    WHATSAPP: "WhatsApp chats", STATUS: "WhatsApp Status", TIKTOK: "TikTok", INSTAGRAM: "Instagram", FACEBOOK: "Facebook", OTHER: "Other",
  };
  const known = (Object.entries(SHARE_CHANNEL_TRACKING) as Array<[TaggedChannel, { source: string }]>)
    .find(([, tracking]) => tracking.source === (source ?? "").toLowerCase());
  return known ? names[known[0]] : "Other";
}

/** Group click counts by everyday channel name, biggest first. Unknown sources are summed as "Other". */
export function clicksByChannel(rows: Array<{ source: string | null; count: number }>): Array<{ label: string; count: number }> {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const label = shareSourceLabel(row.source);
    totals.set(label, (totals.get(label) ?? 0) + row.count);
  }
  return [...totals.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
}


/** Monday of the Nairobi week that contains `date`, as YYYY-MM-DD. */
function nairobiWeekStart(date: Date): string {
  const nairobi = new Date(date.getTime() + NAIROBI_OFFSET_MS);
  const back = (nairobi.getUTCDay() + 6) % 7; // days since Monday
  return new Date(nairobi.getTime() - back * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * Commission earned so far, week by week, for the "All time" chart. Only goes up
 * (rejected commission earns nothing). Oldest week first, up to `weeks` weeks ending this week.
 */
export function affiliateWeeklyCumulative(
  commissions: Array<{ status: string; commissionAmountKsh: number; createdAt: Date }>,
  weeks = 52,
  now: Date = new Date(),
): Array<{ date: string; total: number }> {
  const earning = commissions.filter((row) => row.status !== "REJECTED");
  if (!earning.length) return [];
  const byWeek = new Map<string, number>();
  for (const row of earning) {
    const week = nairobiWeekStart(row.createdAt);
    byWeek.set(week, (byWeek.get(week) ?? 0) + row.commissionAmountKsh);
  }
  const thisWeek = nairobiWeekStart(now);
  const first = [...byWeek.keys()].sort()[0];
  const out: Array<{ date: string; total: number }> = [];
  let total = 0;
  for (let cursor = new Date(`${first}T00:00:00Z`); cursor.toISOString().slice(0, 10) <= thisWeek; cursor = new Date(cursor.getTime() + 7 * 24 * 60 * 60 * 1000)) {
    const date = cursor.toISOString().slice(0, 10);
    total += byWeek.get(date) ?? 0;
    out.push({ date, total });
  }
  return out.slice(-weeks);
}

export type AffiliateCountedPoint = { date: string; added: number; total: number };

type CountedRow = { status: string; commissionAmountKsh: number; createdAt: Date; confirmedAt?: Date | null; eligibleAt?: Date | null };

/** Commission that counts for badges: ready to be paid or already paid. The day it counts is the day it was confirmed. */
function countedRows(commissions: CountedRow[]) {
  return commissions
    .filter((row) => row.status === "CONFIRMED" || row.status === "PAID")
    .map((row) => ({ at: row.confirmedAt ?? row.eligibleAt ?? row.createdAt, amount: row.commissionAmountKsh }));
}

/** Total commission that counts for badges. */
export function affiliateCountedTotal(commissions: CountedRow[]): number {
  return countedRows(commissions).reduce((total, row) => total + row.amount, 0);
}

/** Counted commission added each Nairobi day for the last `days` days, with the running total (money before the first day included). */
export function affiliateCountedDaily(commissions: CountedRow[], days: number, now: Date = new Date()): AffiliateCountedPoint[] {
  const rows = countedRows(commissions);
  const dates: string[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) dates.push(nairobiDay(new Date(now.getTime() - offset * 24 * 60 * 60 * 1000)));
  const added = new Map<string, number>(dates.map((date) => [date, 0]));
  let total = 0;
  for (const row of rows) {
    const day = nairobiDay(row.at);
    if (day < dates[0]) total += row.amount;
    else if (added.has(day)) added.set(day, (added.get(day) ?? 0) + row.amount);
  }
  return dates.map((date) => {
    const amount = added.get(date) ?? 0;
    total += amount;
    return { date, added: amount, total };
  });
}

/** The same, one point per Nairobi week (Monday start), from the first counted week up to this week. */
export function affiliateCountedWeekly(commissions: CountedRow[], weeks = 52, now: Date = new Date()): AffiliateCountedPoint[] {
  const rows = countedRows(commissions);
  if (!rows.length) return [];
  const byWeek = new Map<string, number>();
  for (const row of rows) {
    const week = nairobiWeekStart(row.at);
    byWeek.set(week, (byWeek.get(week) ?? 0) + row.amount);
  }
  const thisWeek = nairobiWeekStart(now);
  const first = [...byWeek.keys()].sort()[0];
  const out: AffiliateCountedPoint[] = [];
  let total = 0;
  for (let cursor = new Date(`${first}T00:00:00Z`); cursor.toISOString().slice(0, 10) <= thisWeek; cursor = new Date(cursor.getTime() + 7 * 24 * 60 * 60 * 1000)) {
    const date = cursor.toISOString().slice(0, 10);
    const added = byWeek.get(date) ?? 0;
    total += added;
    out.push({ date, added, total });
  }
  return out.slice(-weeks);
}

/** The Nairobi day of the first commission that is not rejected, waiting ones included. Null when there is none. */
export function affiliateFirstCommissionDay(commissions: Array<{ status: string; createdAt: Date }>): string | null {
  const days = commissions.filter((row) => row.status !== "REJECTED").map((row) => nairobiDay(row.createdAt)).sort();
  return days[0] ?? null;
}

export type AffiliateBadgeId = "chipukizi" | "fiti" | "poa" | "moto" | "mkali" | "boss" | "legend";

/** Badges in order. Chipukizi comes with the first commission (waiting ones count); the rest come with counted commission. */
export const AFFILIATE_BADGES: ReadonlyArray<{ id: AffiliateBadgeId; name: string; thresholdKsh: number }> = [
  { id: "chipukizi", name: "Chipukizi", thresholdKsh: 0 },
  { id: "fiti", name: "Fiti", thresholdKsh: 500 },
  { id: "poa", name: "Poa", thresholdKsh: 1000 },
  { id: "moto", name: "Moto", thresholdKsh: 5000 },
  { id: "mkali", name: "Mkali", thresholdKsh: 10000 },
  { id: "boss", name: "Boss", thresholdKsh: 20000 },
  { id: "legend", name: "Legend", thresholdKsh: 50000 },
];

export type AffiliateBadgeState = {
  id: AffiliateBadgeId;
  name: string;
  thresholdKsh: number;
  state: "unlocked" | "next" | "locked";
  /** 0 to 1, only for the next badge. */
  progress: number;
  /** KSh still needed, only for the next badge. */
  remainingKsh: number;
};

/** Which badges are unlocked, which one is next and how close it is. Unlocked badges are never taken back. */
export function affiliateBadges(countedKsh: number, hasFirstCommission: boolean): { badges: AffiliateBadgeState[]; unlocked: number } {
  let nextFound = false;
  const badges = AFFILIATE_BADGES.map((badge): AffiliateBadgeState => {
    const unlocked = badge.id === "chipukizi" ? hasFirstCommission || countedKsh > 0 : countedKsh >= badge.thresholdKsh;
    const base = { id: badge.id, name: badge.name, thresholdKsh: badge.thresholdKsh };
    if (unlocked) { return { ...base, state: "unlocked", progress: 1, remainingKsh: 0 }; }
    if (!nextFound) {
      nextFound = true;
      // Progress is counted from zero, so the bar matches "KSh x of y".
      const progress = badge.thresholdKsh > 0 ? Math.min(1, countedKsh / badge.thresholdKsh) : 0;
      return { ...base, state: "next", progress, remainingKsh: Math.max(0, badge.thresholdKsh - countedKsh) };
    }
    return { ...base, state: "locked", progress: 0, remainingKsh: 0 };
  });
  return { badges, unlocked: badges.filter((badge) => badge.state === "unlocked").length };
}

/**
 * Index in a counted series where a badge was reached: the first point whose total passes the threshold.
 * Chipukizi sits on the point that holds the first commission. -1 when it was reached before the series starts,
 * unless `clampToStart` is set (the all-time view, which starts at the first counted week).
 */
export function badgeMarkIndex(
  series: AffiliateCountedPoint[],
  badge: { id: string; thresholdKsh: number },
  firstCommissionDay: string | null,
  options: { clampToStart?: boolean } = {},
): number {
  if (!series.length) return -1;
  if (badge.id === "chipukizi") {
    if (!firstCommissionDay) return -1;
    let found = -1;
    series.forEach((point, index) => { if (point.date <= firstCommissionDay) found = index; });
    return found === -1 && options.clampToStart ? 0 : found;
  }
  // A badge reached before the first point of the series has no mark on this chart.
  if (series[0].total - series[0].added >= badge.thresholdKsh) return -1;
  return series.findIndex((point) => point.total >= badge.thresholdKsh);
}

/** A phone number with the middle hidden, e.g. 0712345123 becomes 07•• ••• 123. */
export function maskPhone(phone: string | null | undefined): string | null {
  let digits = (phone ?? "").replace(/\D/g, "");
  if (digits.startsWith("254") && digits.length === 12) digits = `0${digits.slice(3)}`;
  if (digits.length < 7) return null;
  return `${digits.slice(0, 2)}•• ••• ${digits.slice(-3)}`;
}

export type AffiliateOrderState = "waiting" | "ready" | "paid" | "notCounted";

/** What is happening to one commission, in the four everyday states the promoter sees. */
export function affiliateOrderState(commissionStatus: string, orderStatus: string): { state: AffiliateOrderState; reason?: "returned" | "cancelled" | "other" } {
  if (commissionStatus === "PAID") return { state: "paid" };
  if (commissionStatus === "CONFIRMED") return { state: "ready" };
  if (commissionStatus === "REJECTED") {
    if (orderStatus === "REFUNDED") return { state: "notCounted", reason: "returned" };
    if (orderStatus === "CANCELLED" || orderStatus === "EXPIRED") return { state: "notCounted", reason: "cancelled" };
    return { state: "notCounted", reason: "other" };
  }
  return { state: "waiting" };
}

export type AffiliateOrderFilter = "all" | "waiting" | "ready" | "paid";
export const AFFILIATE_ORDERS_PAGE_SIZE = 20;

/** The orders in one tab of the Earnings list. "all" is every order that counts. */
export function filterAffiliateOrders<T extends { state: AffiliateOrderState }>(orders: T[], filter: AffiliateOrderFilter): T[] {
  return filter === "all" ? orders.filter((order) => order.state !== "notCounted") : orders.filter((order) => order.state === filter);
}

/** How many paid orders sit in each stage. Rejected commissions (cancelled or returned orders) are left out. */
export function affiliateOrderStateCounts(commissions: Array<{ status: string }>): Record<AffiliateOrderFilter, number> {
  const counts = { all: 0, waiting: 0, ready: 0, paid: 0 };
  for (const row of commissions) {
    if (row.status === "PAID") counts.paid += 1;
    else if (row.status === "CONFIRMED") counts.ready += 1;
    else if (row.status === "REJECTED") continue;
    else counts.waiting += 1;
    counts.all += 1;
  }
  return counts;
}

/** The biggest few rows by count, for the "top 3" lists. */
export function topRows<T extends { count: number }>(rows: T[], limit = 3): T[] {
  return [...rows].sort((a, b) => b.count - a.count).slice(0, limit);
}
