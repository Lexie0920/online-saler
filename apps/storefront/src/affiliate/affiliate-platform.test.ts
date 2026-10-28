import assert from "node:assert/strict";
import test from "node:test";
import {
  AFFILIATE_LEVELS,
  affiliateBadges,
  affiliateConversionRate,
  affiliateCountedDaily,
  affiliateCountedTotal,
  affiliateCountedWeekly,
  affiliateFirstCommissionDay,
  badgeMarkIndex,
  AFFILIATE_BADGES,
  affiliateDailySeries,
  affiliateNextGoal,
  affiliateOrderState,
  affiliateOrderStateCounts,
  filterAffiliateOrders,
  affiliateWeeklyCumulative,
  maskPhone,
  topRows,
  affiliateWeekComparison,
  nextPayoutDate,
  affiliateEarningTotals,
  affiliateLevelLabel,
  affiliateOrderCounts,
  buildAffiliatePath,
  buildShareLink,
  clicksByChannel,
  collectionPublicationIssue,
  normalizeTrackingSource,
  normalizeTrackingValue,
  slugifyAffiliateValue,
  statusPackPageCount,
} from "./affiliate-platform";

test("flow 1: every new profile starts from the only active V1 level", () => {
  assert.equal(AFFILIATE_LEVELS[0], "LEVEL_1");
  assert.equal(affiliateLevelLabel("LEVEL_1"), "Level 1");
  assert.equal(affiliateLevelLabel("UNKNOWN"), "Level 1");
});

test("flow 2: public profile and Collection slugs are URL safe", () => {
  assert.equal(slugifyAffiliateValue(" Njeri's Kikuyu Edit "), "njeri-s-kikuyu-edit");
});

test("flow 3: default Affiliate links contain all four tracking dimensions", () => {
  assert.equal(buildAffiliatePath("/p/DL-1", "AFF-1"), "/p/DL-1?ref=AFF-1&source=direct&placement=share&campaign=organic");
});

test("flow 4: campaign links normalize source, placement, and campaign", () => {
  const path = buildAffiliatePath("/c/weekend", "AFF-2", { source: "WhatsApp Status", placement: "status pack", campaign: "August!" });
  assert.equal(path, "/c/weekend?ref=AFF-2&source=whatsappstatus&placement=statuspack&campaign=August");
});

test("flow 5: a Collection with fewer than five products stays draft", () => {
  assert.match(collectionPublicationIssue(4) ?? "", /at least 5/);
});

test("flow 6: a Collection with five products can publish", () => {
  assert.equal(collectionPublicationIssue(5), null);
});

test("flow 7: a Collection with thirty products can publish", () => {
  assert.equal(collectionPublicationIssue(30), null);
});

test("flow 8: a Collection cannot exceed thirty products", () => {
  assert.match(collectionPublicationIssue(31) ?? "", /at most 30/);
});

test("flow 9: Status Packs support exactly 4, 6, and 8 vertical pages", () => {
  assert.deepEqual([4, 6, 8].map(statusPackPageCount), [4, 6, 8]);
  assert.throws(() => statusPackPageCount(5), /exactly 4, 6, or 8/);
});

test("flow 10: analytics conversion is stable and safe with no clicks", () => {
  assert.equal(affiliateConversionRate(2, 50), 4);
  assert.equal(affiliateConversionRate(2, 0), 0);
  assert.equal(normalizeTrackingSource(" TikTok Ads! "), "tiktokads");
  assert.equal(normalizeTrackingValue("link in bio"), "linkinbio");
});

test("dashboard sales count only orders that earned commission, so the rate reads 25%", () => {
  const totals = affiliateEarningTotals([
    { status: "PENDING", orderSubtotalKsh: 1000, commissionAmountKsh: 250 },
    { status: "CONFIRMED", orderSubtotalKsh: 2000, commissionAmountKsh: 500 },
    { status: "PAID", orderSubtotalKsh: 400, commissionAmountKsh: 100 },
    { status: "REJECTED", orderSubtotalKsh: 5000, commissionAmountKsh: 1250 },
  ]);
  assert.deepEqual(totals, { orders: 3, sales: 3400, commission: 850 });
  assert.equal(totals.commission / totals.sales, 0.25);
});

test("affiliate order counts: unpaid is total minus paid and never negative", () => {
  assert.deepEqual(affiliateOrderCounts(10, 4), { total: 10, paid: 4, unpaid: 6 });
  assert.deepEqual(affiliateOrderCounts(0, 0), { total: 0, paid: 0, unpaid: 0 });
  assert.deepEqual(affiliateOrderCounts(3, 5), { total: 3, paid: 3, unpaid: 0 });
  assert.deepEqual(affiliateOrderCounts(-2, -1), { total: 0, paid: 0, unpaid: 0 });
});

test("flow 9: the daily series has one point per Nairobi day, no gaps, and skips rejected commission", () => {
  const now = new Date("2026-10-27T10:00:00Z");
  const series = affiliateDailySeries([
    { status: "PENDING", commissionAmountKsh: 200, createdAt: new Date("2026-10-27T08:00:00Z") },
    { status: "PAID", commissionAmountKsh: 300, createdAt: new Date("2026-10-27T09:00:00Z") },
    { status: "REJECTED", commissionAmountKsh: 999, createdAt: new Date("2026-10-27T09:30:00Z") },
    // 22:30 UTC on the 25th is already the 26th in Nairobi (UTC+3).
    { status: "CONFIRMED", commissionAmountKsh: 100, createdAt: new Date("2026-10-25T22:30:00Z") },
    // Older than the window.
    { status: "PAID", commissionAmountKsh: 500, createdAt: new Date("2026-10-01T09:00:00Z") },
  ], 7, now);
  assert.equal(series.length, 7);
  assert.equal(series[0].date, "2026-10-21");
  assert.equal(series[6].date, "2026-10-27");
  assert.deepEqual(series[6], { date: "2026-10-27", orders: 2, commission: 500, sales: 0 });
  assert.deepEqual(series[5], { date: "2026-10-26", orders: 1, commission: 100, sales: 0 });
  assert.equal(series.reduce((total, point) => total + point.orders, 0), 3);
});

test("flow 10: the next payout is the next Monday in Nairobi", () => {
  assert.equal(nextPayoutDate(new Date("2026-10-27T10:00:00Z")), "2026-11-02"); // Tuesday
  assert.equal(nextPayoutDate(new Date("2026-10-26T10:00:00Z")), "2026-11-02"); // Monday: next week's
  assert.equal(nextPayoutDate(new Date("2026-11-01T10:00:00Z")), "2026-11-02"); // Sunday
  assert.equal(nextPayoutDate(new Date("2026-10-25T22:00:00Z")), "2026-11-02"); // Monday 01:00 in Nairobi
});

test("flow 11: week comparison and the next small goal", () => {
  const daily = Array.from({ length: 14 }, (_, index) => ({ date: `d${index}`, orders: index < 7 ? 1 : 2, commission: 0, sales: 0 }));
  assert.deepEqual(affiliateWeekComparison(daily), { thisWeek: 14, lastWeek: 7 });
  assert.deepEqual(affiliateNextGoal({ collections: 0, largestCollectionItems: 0, ordersTotal: 0, thisWeek: 0, lastWeek: 0 }), { kind: "createCollection" });
  assert.deepEqual(affiliateNextGoal({ collections: 1, largestCollectionItems: 2, ordersTotal: 0, thisWeek: 0, lastWeek: 0 }), { kind: "addProducts", count: 3 });
  assert.deepEqual(affiliateNextGoal({ collections: 1, largestCollectionItems: 6, ordersTotal: 0, thisWeek: 0, lastWeek: 0 }), { kind: "firstOrder" });
  assert.deepEqual(affiliateNextGoal({ collections: 1, largestCollectionItems: 6, ordersTotal: 5, thisWeek: 3, lastWeek: 4 }), { kind: "beatLastWeek", target: 5 });
});

test("flow 12: a share link carries the channel the promoter picked", () => {
  assert.equal(buildShareLink("/c/summer-edit", "AFF-1", "STATUS"), "/c/summer-edit?ref=AFF-1&source=whatsapp-status&placement=status-pack&campaign=organic");
  assert.equal(buildShareLink("/c/summer-edit", "AFF-1", "WHATSAPP"), "/c/summer-edit?ref=AFF-1&source=whatsapp&placement=direct-message&campaign=organic");
});

test("flow 13: clicks are grouped by everyday channel name, unknown sources become Other", () => {
  assert.deepEqual(clicksByChannel([
    { source: "whatsapp", count: 5 },
    { source: "whatsapp-status", count: 9 },
    { source: "direct", count: 2 },
    { source: null, count: 1 },
  ]), [
    { label: "WhatsApp Status", count: 9 },
    { label: "WhatsApp chats", count: 5 },
    { label: "Other", count: 3 },
  ]);
});

test("flow 14: all-time earnings go up week by week and skip rejected commission", () => {
  const now = new Date("2026-10-27T10:00:00Z"); // Tuesday; the week starts Monday 2026-10-26
  const points = affiliateWeeklyCumulative([
    { status: "PAID", commissionAmountKsh: 200, createdAt: new Date("2026-10-07T09:00:00Z") }, // week of 10-05
    { status: "REJECTED", commissionAmountKsh: 999, createdAt: new Date("2026-10-08T09:00:00Z") },
    { status: "PENDING", commissionAmountKsh: 300, createdAt: new Date("2026-10-26T09:00:00Z") },
  ], 52, now);
  assert.deepEqual(points.map((point) => point.date), ["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]);
  assert.deepEqual(points.map((point) => point.total), [200, 200, 200, 500]);
  assert.deepEqual(affiliateWeeklyCumulative([], 52, now), []);
});

test("flow 15: phone is masked, order states are plain, top rows are the biggest", () => {
  assert.equal(maskPhone("0712345123"), "07•• ••• 123");
  assert.equal(maskPhone("+254712345123"), "07•• ••• 123");
  assert.equal(maskPhone("12"), null);
  assert.equal(maskPhone(null), null);
  assert.deepEqual(affiliateOrderState("PENDING", "PAID"), { state: "waiting" });
  assert.deepEqual(affiliateOrderState("CONFIRMED", "COMPLETED"), { state: "ready" });
  assert.deepEqual(affiliateOrderState("PAID", "COMPLETED"), { state: "paid" });
  assert.deepEqual(affiliateOrderState("REJECTED", "REFUNDED"), { state: "notCounted", reason: "returned" });
  assert.deepEqual(affiliateOrderState("REJECTED", "CANCELLED"), { state: "notCounted", reason: "cancelled" });
  assert.deepEqual(topRows([{ count: 1 }, { count: 9 }, { count: 4 }, { count: 7 }], 3), [{ count: 9 }, { count: 7 }, { count: 4 }]);
});

test("flow 15b: the Earnings order tabs count paid orders by stage and leave cancelled or returned ones out", () => {
  const rows = [{ status: "PENDING" }, { status: "PENDING" }, { status: "CONFIRMED" }, { status: "PAID" }, { status: "PAID" }, { status: "PAID" }, { status: "REJECTED" }];
  assert.deepEqual(affiliateOrderStateCounts(rows), { all: 6, waiting: 2, ready: 1, paid: 3 });
  assert.deepEqual(affiliateOrderStateCounts([]), { all: 0, waiting: 0, ready: 0, paid: 0 });
  const orders = [{ state: "waiting" as const }, { state: "ready" as const }, { state: "paid" as const }, { state: "notCounted" as const }];
  assert.equal(filterAffiliateOrders(orders, "all").length, 3);
  assert.deepEqual(filterAffiliateOrders(orders, "ready"), [{ state: "ready" }]);
  assert.equal(filterAffiliateOrders(orders, "paid").length, 1);
});

const badgeNow = new Date("2026-10-27T10:00:00Z"); // Tuesday
const badgeRows = [
  { status: "PAID", commissionAmountKsh: 600, createdAt: new Date("2026-09-01T09:00:00Z"), confirmedAt: new Date("2026-09-05T09:00:00Z") },
  { status: "CONFIRMED", commissionAmountKsh: 400, createdAt: new Date("2026-10-20T09:00:00Z"), confirmedAt: new Date("2026-10-23T09:00:00Z") },
  { status: "PENDING", commissionAmountKsh: 900, createdAt: new Date("2026-10-26T09:00:00Z") },
  { status: "REJECTED", commissionAmountKsh: 700, createdAt: new Date("2026-10-10T09:00:00Z"), confirmedAt: null },
];

test("flow 16: badges count only ready or paid commission, on the day it was confirmed", () => {
  assert.equal(affiliateCountedTotal(badgeRows), 1000);
  const daily = affiliateCountedDaily(badgeRows, 7, badgeNow);
  assert.equal(daily.length, 7);
  assert.equal(daily[0].date, "2026-10-21");
  // 600 was counted before the window, so the line starts there and only goes up.
  assert.deepEqual(daily.map((point) => point.total), [600, 600, 1000, 1000, 1000, 1000, 1000]);
  assert.deepEqual(daily.map((point) => point.added), [0, 0, 400, 0, 0, 0, 0]);
  const weekly = affiliateCountedWeekly(badgeRows, 52, badgeNow);
  assert.equal(weekly[weekly.length - 1].total, 1000);
  assert.equal(weekly[weekly.length - 1].added, 0);
  assert.equal(weekly.find((point) => point.date === "2026-10-19")?.added, 400);
  assert.deepEqual(affiliateCountedWeekly([], 52, badgeNow), []);
});

test("flow 17: the next badge shows how far away it is, unlocked ones stay unlocked", () => {
  const { badges, unlocked } = affiliateBadges(5390, true);
  assert.equal(unlocked, 4);
  assert.deepEqual(badges.map((badge) => badge.state), ["unlocked", "unlocked", "unlocked", "unlocked", "next", "locked", "locked"]);
  const next = badges.find((badge) => badge.state === "next")!;
  assert.equal(next.id, "mkali");
  assert.equal(next.remainingKsh, 4610);
  assert.equal(Math.round(next.progress * 100), 54);
  // Nothing yet: the first badge is next and needs a first commission.
  assert.equal(affiliateBadges(0, false).badges[0].state, "next");
  // A waiting commission is enough for Chipukizi, but not for the money badges.
  const waiting = affiliateBadges(0, true).badges;
  assert.equal(waiting[0].state, "unlocked");
  assert.equal(waiting[1].state, "next");
  assert.equal(AFFILIATE_BADGES.length, 7);
});

test("flow 18: badges sit on the point where they were reached", () => {
  const series = [
    { date: "d1", added: 0, total: 0 },
    { date: "d2", added: 600, total: 600 },
    { date: "d3", added: 500, total: 1100 },
    { date: "d4", added: 0, total: 1100 },
  ];
  const find = (id: string) => AFFILIATE_BADGES.find((badge) => badge.id === id)!;
  assert.equal(badgeMarkIndex(series, find("fiti"), "d2"), 1);
  assert.equal(badgeMarkIndex(series, find("poa"), "d2"), 2);
  assert.equal(badgeMarkIndex(series, find("moto"), "d2"), -1);
  assert.equal(badgeMarkIndex(series, find("chipukizi"), "d2"), 1);
  // Reached before this chart starts: no mark on it.
  assert.equal(badgeMarkIndex(series, find("chipukizi"), "d0"), -1);
  assert.equal(badgeMarkIndex(series, find("chipukizi"), "d0", { clampToStart: true }), 0);
  const later = [{ date: "d5", added: 0, total: 1100 }, { date: "d6", added: 0, total: 1100 }];
  assert.equal(badgeMarkIndex(later, find("poa"), "d1"), -1);
  assert.equal(affiliateFirstCommissionDay([{ status: "REJECTED", createdAt: new Date("2026-10-01T09:00:00Z") }, { status: "PENDING", createdAt: new Date("2026-10-05T09:00:00Z") }]), "2026-10-05");
  assert.equal(affiliateFirstCommissionDay([]), null);
});
