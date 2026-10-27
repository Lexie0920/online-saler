import assert from "node:assert/strict";
import test from "node:test";
import {
  AFFILIATE_LEVELS,
  affiliateConversionRate,
  affiliateDailySeries,
  affiliateNextGoal,
  affiliateOrderState,
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
