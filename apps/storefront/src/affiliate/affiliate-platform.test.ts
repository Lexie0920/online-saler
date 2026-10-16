import assert from "node:assert/strict";
import test from "node:test";
import {
  AFFILIATE_LEVELS,
  affiliateConversionRate,
  affiliateEarningTotals,
  affiliateLevelLabel,
  buildAffiliatePath,
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
