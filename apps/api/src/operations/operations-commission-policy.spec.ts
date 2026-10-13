import assert from "node:assert/strict";
import test from "node:test";
import { resolveDefaultCommissionRate } from "@online-saler/business-rules";
import { commissionEligibility } from "./operations-commission-policy";

const deliveredAt = new Date("2026-09-01T10:00:00Z");
const eligibleAt = new Date("2026-09-04T10:00:00Z");
function input() {
  return {
    holdReason: null as string | null,
    rateBps: 1000,
    orderSubtotalKsh: 1000,
    commissionAmountKsh: 100,
    order: {
      status: "COMPLETED",
      totalKsh: 1000,
      payments: [{ status: "SUCCESS", amountKsh: 1000 }],
      fulfillment: { status: "COMPLETED", completedAt: deliveredAt } as { status: string; completedAt: Date | null } | null,
      customerServiceCases: [] as Array<{ status: string; issueType: string; requiresReturn: boolean; requiresRefund: boolean; affectsAffiliateCommission: boolean }>,
      afterSaleReturns: [] as Array<{ status: string }>
    }
  };
}

test("handover is required and the 72-hour boundary is exact for both pickup and delivery", () => {
  assert.match(commissionEligibility(input(), new Date(eligibleAt.getTime() - 1)).blockingReason!, /72 hours/);
  // 2026-10-14: a commission handed over 25 hours ago is no longer confirmable (was 24h).
  assert.match(commissionEligibility(input(), new Date(deliveredAt.getTime() + 25 * 60 * 60 * 1000)).blockingReason!, /72 hours/);
  assert.deepEqual(commissionEligibility(input(), eligibleAt), { eligibleAt, blockingReason: null });
  const missing = input();
  missing.order.fulfillment = null;
  assert.match(commissionEligibility(missing, eligibleAt).blockingReason!, /completed/);
  const uncompleted = input();
  uncompleted.order.status = "FULFILLING";
  assert.match(commissionEligibility(uncompleted, eligibleAt).blockingReason!, /completed/);
  const invalidDate = input();
  invalidDate.order.fulfillment!.completedAt = new Date("invalid");
  assert.match(commissionEligibility(invalidDate, eligibleAt).blockingReason!, /completed/);
});

test("cancelled, refunded and held commissions cannot become payable", () => {
  for (const status of ["CANCELLED", "REFUNDED", "PAID"]) {
    const value = input();
    value.order.status = status;
    assert.ok(commissionEligibility(value, eligibleAt).blockingReason);
  }
  const held = input();
  held.holdReason = "FINANCE_REVIEW";
  assert.match(commissionEligibility(held, eligibleAt).blockingReason!, /FINANCE_REVIEW/);
});

test("completed order status cannot substitute for actual full successful payment", () => {
  for (const payments of [[], [{ status: "PENDING", amountKsh: 1000 }], [{ status: "SUCCESS", amountKsh: 999 }]]) {
    const value = input();
    value.order.payments = payments;
    assert.match(commissionEligibility(value, eligibleAt).blockingReason!, /successful payment/);
  }
});

test("open after-sales and unresolved return/refund flags block even if a case was closed", () => {
  for (const status of ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]) {
    for (const flag of ["requiresReturn", "requiresRefund", "affectsAffiliateCommission"] as const) {
      const value = input();
      value.order.customerServiceCases.push({ status, issueType: "AFTER_SALE", requiresReturn: false, requiresRefund: false, affectsAffiliateCommission: false, [flag]: true });
      assert.match(commissionEligibility(value, eligibleAt).blockingReason!, /after-sales/);
    }
  }
  const value = input();
  value.order.customerServiceCases.push({ status: "OPEN", issueType: "AFTER_SALE", requiresReturn: false, requiresRefund: false, affectsAffiliateCommission: false });
  assert.ok(commissionEligibility(value, eligibleAt).blockingReason);
  value.order.customerServiceCases[0]!.status = "RESOLVED";
  assert.equal(commissionEligibility(value, eligibleAt).blockingReason, null);
});

test("active item returns block; rejected and reconciled partial returns allow the remaining commission", () => {
  for (const status of ["REQUESTED", "APPROVED", "RECEIVED"]) {
    const value = input();
    value.order.afterSaleReturns.push({ status });
    assert.ok(commissionEligibility(value, eligibleAt).blockingReason);
  }
  for (const status of ["REJECTED", "REFUND_RECORDED"]) {
    const value = input();
    value.commissionAmountKsh = 50;
    value.order.afterSaleReturns.push({ status });
    assert.equal(commissionEligibility(value, eligibleAt).blockingReason, null);
  }
});

test("invalid commission values require review without changing historic amounts", () => {
  for (const amount of [-1, 100.5, 101]) {
    const value = input();
    value.commissionAmountKsh = amount;
    assert.match(commissionEligibility(value, eligibleAt).blockingReason!, /finance review/);
    assert.equal(value.commissionAmountKsh, amount);
  }
});

test("Operations and checkout parse defaults identically and use the 25% fallback", () => {
  assert.deepEqual(resolveDefaultCommissionRate(undefined), { valueBps: 2500, source: "FALLBACK" });
  assert.deepEqual(resolveDefaultCommissionRate("invalid"), { valueBps: 2500, source: "FALLBACK" });
  assert.deepEqual(resolveDefaultCommissionRate("3000"), { valueBps: 3000, source: "SYSTEM_SETTING" });
  assert.deepEqual(resolveDefaultCommissionRate(0), { valueBps: 0, source: "SYSTEM_SETTING" });
  assert.deepEqual(resolveDefaultCommissionRate(6000), { valueBps: 5000, source: "SYSTEM_SETTING" });
});
