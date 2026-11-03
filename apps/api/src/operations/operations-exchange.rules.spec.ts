import assert from "node:assert/strict";
import test from "node:test";
import { assertCandidateAvailable, assertCanExchange, assertCanExchangeDelivered, assertCommissionRecalculable, assertDifferentPeople, commissionForSubtotal, exchangePricing, exchangeReason, returnToExchangeDiscount, type DeliveredExchangeState, type ExchangeOrderState } from "./operations-exchange.rules";

const OK: ExchangeOrderState = { orderStatus: "PAID", fulfillmentStatus: "PAID", fulfillmentItemStatus: "PENDING", inventoryStatus: "PAID", hasReturn: false };
const CANDIDATE = { status: "PUBLISHED", priceKsh: 400, inventoryStatus: "AVAILABLE", alreadyOnOrder: false, sameAsCurrent: false };

test("a paid order waiting to be picked can be exchanged, with or without a picking task yet", () => {
  assertCanExchange(OK);
  assertCanExchange({ ...OK, fulfillmentStatus: null, fulfillmentItemStatus: null });
});

test("anything past that point is refused with a reason", () => {
  assert.throws(() => assertCanExchange({ ...OK, orderStatus: "DEPOSIT_PAID" }), /fully paid/);
  assert.throws(() => assertCanExchange({ ...OK, orderStatus: "COMPLETED" }), /fully paid/);
  assert.throws(() => assertCanExchange({ ...OK, fulfillmentStatus: "PICKING" }), /Picking has already started/);
  assert.throws(() => assertCanExchange({ ...OK, fulfillmentItemStatus: "VERIFIED" }), /already been scanned/);
  assert.throws(() => assertCanExchange({ ...OK, inventoryStatus: "PICKED" }), /PICKED/);
  assert.throws(() => assertCanExchange({ ...OK, inventoryStatus: null }), /missing from stock/);
  assert.throws(() => assertCanExchange({ ...OK, hasReturn: true }), /already has a return/);
});

test("a cheaper item is refused and tells staff to use a return and refund", () => {
  assert.throws(() => exchangePricing(400, 300, {}), /return and refund/);
});

test("the same price needs no payment, and a stray amount or code is refused", () => {
  assert.deepEqual(exchangePricing(400, 400, {}), { topUpKsh: 0, mpesaCode: null, discountKsh: 0, linePriceKsh: 400 });
  assert.throws(() => exchangePricing(400, 400, { mpesaCode: "QGH7XY1234" }), /needs no payment/);
  assert.throws(() => exchangePricing(400, 400, { amountKsh: 0 }), /needs no payment/);
});

test("a dearer item needs the whole difference, the M-Pesa code, and a matching amount", () => {
  assert.deepEqual(exchangePricing(400, 520, { amountKsh: 120, mpesaCode: " qgh7xy1234 " }), { topUpKsh: 120, mpesaCode: "QGH7XY1234", discountKsh: 0, linePriceKsh: 520 });
  assert.throws(() => exchangePricing(400, 520, {}), /pays KSh 120/);
  assert.throws(() => exchangePricing(400, 520, { amountKsh: 120, mpesaCode: "short" }), /10 letters and digits/);
  assert.throws(() => exchangePricing(400, 520, { amountKsh: 100, mpesaCode: "QGH7XY1234" }), /does not match/);
  assert.throws(() => exchangePricing(400, 520, { mpesaCode: "QGH7XY1234" }), /does not match/);
});

test("a top-up recalculates an unpaid commission and is blocked by a paid one", () => {
  assert.equal(assertCommissionRecalculable(null), false);
  assert.equal(assertCommissionRecalculable({ status: "REJECTED", payoutId: null }), false);
  assert.equal(assertCommissionRecalculable({ status: "PENDING", payoutId: null }), true);
  assert.equal(assertCommissionRecalculable({ status: "CONFIRMED", payoutId: null }), true);
  assert.throws(() => assertCommissionRecalculable({ status: "PAID", payoutId: "p1" }), /already been paid out/);
  assert.throws(() => assertCommissionRecalculable({ status: "CONFIRMED", payoutId: "p1" }), /already been paid out/);
  assert.equal(commissionForSubtotal(520, 1000), 52);
  assert.equal(commissionForSubtotal(525, 1000), 53);
});

test("the new item must be for sale, priced, and not already on the order", () => {
  assertCandidateAvailable(CANDIDATE);
  assert.throws(() => assertCandidateAvailable({ ...CANDIDATE, sameAsCurrent: true }), /already on the order/);
  assert.throws(() => assertCandidateAvailable({ ...CANDIDATE, alreadyOnOrder: true }), /already on this order/);
  assert.throws(() => assertCandidateAvailable({ ...CANDIDATE, inventoryStatus: "RESERVED" }), /not for sale/);
  assert.throws(() => assertCandidateAvailable({ ...CANDIDATE, status: "REVIEW_PENDING" }), /not for sale/);
  assert.throws(() => assertCandidateAvailable({ ...CANDIDATE, priceKsh: null }), /no price/);
});

test("a reason is required and bounded", () => {
  assert.equal(exchangeReason("  wrong size "), "wrong size");
  assert.throws(() => exchangeReason(""), /why/);
  assert.throws(() => exchangeReason("ab"), /why/);
  assert.throws(() => exchangeReason("x".repeat(501)), /500/);
});

const NOW = new Date("2026-11-03T12:00:00Z");
const DELIVERED: DeliveredExchangeState = { orderStatus: "COMPLETED", completedAt: new Date("2026-11-01T12:00:00Z"), now: NOW, inventoryStatus: "DELIVERED", hasReturn: false, hasOpenExchange: false };

test("a delivered order can be exchanged within 3 days of completion, and not after", () => {
  assertCanExchangeDelivered(DELIVERED);
  assertCanExchangeDelivered({ ...DELIVERED, completedAt: new Date("2026-10-31T12:00:00Z") });
  assert.throws(() => assertCanExchangeDelivered({ ...DELIVERED, completedAt: new Date("2026-10-31T11:59:00Z") }), /within 3 days/);
  assert.throws(() => assertCanExchangeDelivered({ ...DELIVERED, completedAt: null }), /within 3 days/);
  assert.throws(() => assertCanExchangeDelivered({ ...DELIVERED, orderStatus: "PAID" }), /delivered or collected/);
  assert.throws(() => assertCanExchangeDelivered({ ...DELIVERED, hasReturn: true }), /already has a return/);
  assert.throws(() => assertCanExchangeDelivered({ ...DELIVERED, hasOpenExchange: true }), /in progress/);
  assert.throws(() => assertCanExchangeDelivered({ ...DELIVERED, inventoryStatus: "AVAILABLE" }), /not with the customer/);
});

test("return to exchange takes KSh 80 off, needs a reason, and only once per order", () => {
  assert.deepEqual(returnToExchangeDiscount({ returnToExchange: false, alreadyUsedOnOrder: true }), { discountKsh: 0, discountReason: null });
  assert.deepEqual(returnToExchangeDiscount({ returnToExchange: true, discountReason: " wanted to return ", alreadyUsedOnOrder: false }), { discountKsh: 80, discountReason: "wanted to return" });
  assert.throws(() => returnToExchangeDiscount({ returnToExchange: true, discountReason: "", alreadyUsedOnOrder: false }), /Say why/);
  assert.throws(() => returnToExchangeDiscount({ returnToExchange: true, discountReason: "wanted to return", alreadyUsedOnOrder: true }), /already been used/);
});

test("the discount comes off the difference: small differences are free, big ones pay the rest", () => {
  assert.deepEqual(exchangePricing(400, 460, {}, 80), { topUpKsh: 0, mpesaCode: null, discountKsh: 60, linePriceKsh: 400 });
  assert.deepEqual(exchangePricing(400, 400, {}, 80), { topUpKsh: 0, mpesaCode: null, discountKsh: 0, linePriceKsh: 400 });
  assert.deepEqual(exchangePricing(400, 580, { amountKsh: 100, mpesaCode: "QGH7XY1234" }, 80), { topUpKsh: 100, mpesaCode: "QGH7XY1234", discountKsh: 80, linePriceKsh: 500 });
  assert.throws(() => exchangePricing(400, 580, { amountKsh: 180, mpesaCode: "QGH7XY1234" }, 80), /pays KSh 100/);
  assert.throws(() => exchangePricing(400, 460, { mpesaCode: "QGH7XY1234" }, 80), /covers the whole difference/);
  assert.throws(() => exchangePricing(400, 300, {}, 80), /return and refund/);
});

test("the person who received the old item cannot approve the exchange", () => {
  assertDifferentPeople(null, "b");
  assertDifferentPeople("a", "b");
  assert.throws(() => assertDifferentPeople("a", "a"), /cannot also approve/);
});
