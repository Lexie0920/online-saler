import assert from "node:assert/strict";
import test from "node:test";
import { assertCandidateAvailable, assertCanExchange, assertSamePrice, exchangeReason, type ExchangeOrderState } from "./operations-exchange.rules";

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

test("step 1 only allows the same price: cheaper and dearer both say what to do instead", () => {
  assertSamePrice(400, 400);
  assert.throws(() => assertSamePrice(400, 300), /return and refund/);
  assert.throws(() => assertSamePrice(400, 520), /KSh 120 more/);
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
