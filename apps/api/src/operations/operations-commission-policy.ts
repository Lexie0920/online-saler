import { COMMISSION_CONFIRMATION_HOURS, createCommissionEligibleAt } from "@online-saler/business-rules";

type CommissionEligibilityInput = {
  holdReason: string | null;
  rateBps: number;
  orderSubtotalKsh: number;
  commissionAmountKsh: number;
  order: {
    status: string;
    totalKsh: number;
    payments: Array<{ status: string; amountKsh: number }>;
    fulfillment: { status: string; completedAt: Date | null } | null;
    customerServiceCases: Array<{
      status: string;
      issueType: string;
      requiresReturn: boolean;
      requiresRefund: boolean;
      affectsAffiliateCommission: boolean;
    }>;
    afterSaleReturns: Array<{ status: string }>;
  };
};

export function commissionEligibility(commission: CommissionEligibilityInput, now = new Date()): {
  eligibleAt: Date | null;
  blockingReason: string | null;
} {
  const completedAt = commission.order.fulfillment?.completedAt;
  const eligibleAt = completedAt && Number.isFinite(completedAt.getTime())
    ? createCommissionEligibleAt(completedAt) : null;
  if (commission.holdReason) return { eligibleAt, blockingReason: `Commission is on hold: ${commission.holdReason}.` };
  if (commission.order.status !== "COMPLETED" || commission.order.fulfillment?.status !== "COMPLETED" || !eligibleAt) {
    return { eligibleAt, blockingReason: "Delivery or pickup must be completed before commission confirmation." };
  }
  const successfulPayments = commission.order.payments.filter((payment) => payment.status === "SUCCESS");
  if (!successfulPayments.length || successfulPayments.reduce((sum, payment) => sum + payment.amountKsh, 0) < commission.order.totalKsh) {
    return { eligibleAt, blockingReason: "The original order requires verified successful payment covering its total." };
  }
  if (now.getTime() < eligibleAt.getTime()) {
    return { eligibleAt, blockingReason: `Commission becomes eligible ${COMMISSION_CONFIRMATION_HOURS} hours (3 days, the return window) after handover (${eligibleAt.toISOString()}).` };
  }
  if (commission.order.customerServiceCases.some((serviceCase) =>
    serviceCase.requiresReturn || serviceCase.requiresRefund || serviceCase.affectsAffiliateCommission ||
    (serviceCase.issueType === "AFTER_SALE" && ["OPEN", "IN_PROGRESS"].includes(serviceCase.status))
  ) || commission.order.afterSaleReturns.some((item) => ["REQUESTED", "APPROVED", "RECEIVED"].includes(item.status))) {
    return { eligibleAt, blockingReason: "Resolve the order's return, refund or commission-related after-sales case first." };
  }
  if (!Number.isSafeInteger(commission.rateBps) || commission.rateBps < 0 || commission.rateBps > 5000 ||
    !Number.isSafeInteger(commission.orderSubtotalKsh) || commission.orderSubtotalKsh < 0 ||
    !Number.isSafeInteger(commission.commissionAmountKsh) || commission.commissionAmountKsh < 0 ||
    commission.commissionAmountKsh > Math.round(commission.orderSubtotalKsh * commission.rateBps / 10000)) {
    return { eligibleAt, blockingReason: "Commission amount or rate needs finance review." };
  }
  return { eligibleAt, blockingReason: null };
}
