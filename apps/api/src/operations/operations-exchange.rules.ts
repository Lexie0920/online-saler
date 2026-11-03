/**
 * Rules for swapping a garment on an order for another (owner request, 2026-11-03).
 *
 * Pure functions, so the rules can be read and tested without a database. This
 * covers a paid order that has not been delivered, swapped for a garment of the
 * same price or a dearer one (the customer pays the difference). Delivered orders
 * and the "return to exchange" discount are in operations-exchange-delivered.service.ts.
 */
import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { EXCHANGE_REQUEST_WINDOW_HOURS, EXCHANGE_RETURN_DISCOUNT_KSH } from "@online-saler/business-rules";

export const EXCHANGE_REASON_MIN = 3;
export const EXCHANGE_REASON_MAX = 500;

export function exchangeReason(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < EXCHANGE_REASON_MIN) throw new BadRequestException("Say why the item is being exchanged.");
  if (text.length > EXCHANGE_REASON_MAX) throw new BadRequestException(`The reason must be ${EXCHANGE_REASON_MAX} characters or fewer.`);
  return text;
}

export type ExchangeOrderState = {
  orderStatus: string;
  /** Null when no picking task exists yet. */
  fulfillmentStatus: string | null;
  /** Who holds the parcel; null when there is no picking task. */
  holderType: string | null;
  inventoryStatus: string | null;
  hasReturn: boolean;
};

/** Stages where the parcel is still in the warehouse, so the garment can be swapped. */
const WAREHOUSE_STAGES = ["PAID", "PICKING", "READY_TO_PACK", "PACKED", "READY_FOR_PICKUP", "READY_FOR_DISPATCH"];
/** From these stages the picked-and-checked parcel has to go back to picking. */
const REWIND_STAGES = ["READY_TO_PACK", "PACKED", "READY_FOR_PICKUP", "READY_FOR_DISPATCH"];

/** Picking for this order was already finished, so swapping one garment re-opens picking. */
export function exchangeReopensPicking(fulfillmentStatus: string | null): boolean {
  return fulfillmentStatus !== null && REWIND_STAGES.includes(fulfillmentStatus);
}

/** The old garment was taken off its shelf for picking or packing, so it needs a shelf to go back to. */
export function oldItemLeftShelf(inventoryStatus: string | null): boolean {
  return inventoryStatus === "PICKED" || inventoryStatus === "PACKED";
}

/**
 * Whether the garment on this order line can still be swapped, and if not, why not.
 * Any order that is paid in full and not yet delivered qualifies while the parcel is
 * still in the warehouse, whatever stage picking and packing have reached.
 */
export function assertCanExchange(state: ExchangeOrderState): void {
  if (state.orderStatus !== "PAID" && state.orderStatus !== "FULFILLING") {
    throw new ConflictException("Only a fully paid order that has not been delivered can have an item exchanged here. For a delivered order use the delivered-order exchange.");
  }
  if (state.hasReturn) throw new ConflictException("This item already has a return. Finish or close it before exchanging.");
  if (state.fulfillmentStatus !== null && (!WAREHOUSE_STAGES.includes(state.fulfillmentStatus) || state.holderType !== "WAREHOUSE")) {
    throw new ConflictException("The parcel has already left the warehouse (in transit, at a store or out for delivery). Bring it back to the warehouse first, then exchange.");
  }
  if (state.inventoryStatus !== "PAID" && state.inventoryStatus !== "PICKED" && state.inventoryStatus !== "PACKED") {
    throw new ConflictException(`The item on this order is ${state.inventoryStatus ?? "missing from stock"}, not held for this order, so it cannot be swapped.`);
  }
}

export type TopUpInput = { amountKsh?: unknown; mpesaCode?: unknown };

/** An M-Pesa transaction code: ten upper-case letters and digits. */
export function normalizeTopUpCode(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim().toUpperCase() : "";
  return text.length > 0 ? text : null;
}

/**
 * What the customer pays for this swap. A cheaper garment is refused (use a return
 * and refund). The same price needs no payment. A dearer garment needs the whole
 * difference, and staff must type the M-Pesa code of the payment that covers it
 * and the amount, which has to match exactly so a typo cannot be recorded as paid.
 */
export function exchangePricing(oldPriceKsh: number, newPriceKsh: number, topUp: TopUpInput, discountKsh = 0): { topUpKsh: number; mpesaCode: string | null; discountKsh: number; linePriceKsh: number } {
  const code = normalizeTopUpCode(topUp.mpesaCode);
  if (newPriceKsh < oldPriceKsh) {
    throw new BadRequestException("Choose an item priced the same or higher. A cheaper item cannot be swapped in; use a return and refund instead.");
  }
  const difference = newPriceKsh - oldPriceKsh;
  if (difference === 0) {
    if (code || (topUp.amountKsh !== undefined && topUp.amountKsh !== null && topUp.amountKsh !== "")) {
      throw new BadRequestException("This swap needs no payment. Leave the top-up amount and M-Pesa code empty.");
    }
    return { topUpKsh: 0, mpesaCode: null, discountKsh: 0, linePriceKsh: oldPriceKsh };
  }
  const applied = Math.min(Math.max(discountKsh, 0), difference);
  const payable = difference - applied;
  if (payable === 0) {
    if (code || (topUp.amountKsh !== undefined && topUp.amountKsh !== null && topUp.amountKsh !== "")) {
      throw new BadRequestException(`The KSh ${applied} discount covers the whole difference, so nothing is paid. Leave the top-up amount and M-Pesa code empty.`);
    }
    return { topUpKsh: 0, mpesaCode: null, discountKsh: applied, linePriceKsh: oldPriceKsh };
  }
  if (!code) throw new BadRequestException(`The customer pays KSh ${payable}${applied ? ` (KSh ${difference} less the KSh ${applied} discount)` : ""}. Collect it by M-Pesa, then enter the transaction code and the amount.`);
  if (!/^[A-Z0-9]{10}$/.test(code)) throw new BadRequestException("The M-Pesa code must be 10 letters and digits, for example QGH7XY1234.");
  if (Number(topUp.amountKsh) !== payable) throw new BadRequestException(`The customer pays KSh ${payable}. The top-up amount entered does not match.`);
  return { topUpKsh: payable, mpesaCode: code, discountKsh: applied, linePriceKsh: oldPriceKsh + payable };
}

/**
 * A top-up raises the order total, so a commission that has not been paid out is
 * recalculated on what the customer actually paid. One already paid (or in a
 * payout batch) cannot be changed silently and blocks the top-up.
 */
export function assertCommissionRecalculable(commission: { status: string; payoutId: string | null } | null): boolean {
  if (!commission || commission.status === "REJECTED") return false;
  if (commission.status === "PAID" || commission.payoutId) {
    throw new ConflictException("The commission on this order has already been paid out, so a top-up cannot be added. Ask finance.");
  }
  return true;
}

/** Same rounding as the commission created when an order is paid. */
export function commissionForSubtotal(subtotalKsh: number, rateBps: number): number {
  return Math.round((subtotalKsh * rateBps) / 10000);
}

export type ExchangeCandidate = {
  status: string;
  priceKsh: number | null;
  inventoryStatus: string | null;
  alreadyOnOrder: boolean;
  sameAsCurrent: boolean;
};

/** Whether the garment the customer wants can be sold right now. */
export function assertCandidateAvailable(candidate: ExchangeCandidate): void {
  if (candidate.sameAsCurrent) throw new BadRequestException("That is the item already on the order.");
  if (candidate.alreadyOnOrder) throw new BadRequestException("That item is already on this order.");
  if (candidate.status !== "PUBLISHED" || candidate.inventoryStatus !== "AVAILABLE") {
    throw new ConflictException("That item is not for sale right now.");
  }
  if (!candidate.priceKsh || candidate.priceKsh <= 0) throw new ConflictException("That item has no price.");
}

export type DeliveredExchangeState = {
  orderStatus: string;
  /** When the order was completed (delivered or collected). */
  completedAt: Date | null;
  now: Date;
  inventoryStatus: string | null;
  hasReturn: boolean;
  hasOpenExchange: boolean;
};

/** A completed order, within 3 days of completion, with the garment still out with the customer. */
export function assertCanExchangeDelivered(state: DeliveredExchangeState): void {
  if (state.orderStatus !== "COMPLETED") throw new ConflictException("Only a delivered or collected order can be exchanged this way.");
  const completedAt = state.completedAt;
  if (!completedAt || state.now.getTime() < completedAt.getTime() || state.now.getTime() - completedAt.getTime() > EXCHANGE_REQUEST_WINDOW_HOURS * 60 * 60 * 1000) {
    throw new BadRequestException("Exchanges on a delivered order must be requested within 3 days after delivery or pickup.");
  }
  if (state.hasReturn) throw new ConflictException("This item already has a return. Finish or close it before exchanging.");
  if (state.hasOpenExchange) throw new ConflictException("This item already has an exchange in progress.");
  if (state.inventoryStatus !== "DELIVERED") throw new ConflictException(`The item on this order is ${state.inventoryStatus ?? "missing from stock"}, not with the customer, so it cannot be exchanged this way.`);
}

/**
 * "Return to exchange": the customer meant to return the garment and staff offer an
 * exchange instead. It takes KSh 80 off the price difference, needs a reason, and
 * can be used once per order.
 */
export function returnToExchangeDiscount(input: { returnToExchange: boolean; discountReason?: unknown; alreadyUsedOnOrder: boolean }): { discountKsh: number; discountReason: string | null } {
  if (!input.returnToExchange) return { discountKsh: 0, discountReason: null };
  const reason = typeof input.discountReason === "string" ? input.discountReason.trim() : "";
  if (reason.length < EXCHANGE_REASON_MIN) throw new BadRequestException("Say why this is a return to exchange.");
  if (reason.length > EXCHANGE_REASON_MAX) throw new BadRequestException(`The reason must be ${EXCHANGE_REASON_MAX} characters or fewer.`);
  if (input.alreadyUsedOnOrder) throw new ConflictException("The return-to-exchange discount has already been used on this order.");
  return { discountKsh: EXCHANGE_RETURN_DISCOUNT_KSH, discountReason: reason };
}

/** The person who photographs the old garment cannot be the one who approves it. */
export function assertDifferentPeople(receiverAdminUserId: string | null, reviewerAdminUserId: string): void {
  if (receiverAdminUserId && receiverAdminUserId === reviewerAdminUserId) {
    throw new ForbiddenException("The person who received the item cannot also approve the exchange.");
  }
}

export type ExchangeBlockState = { orderItemId: string; kind: string; status: string };

const OPEN_EXCHANGE_STATUSES = ["AWAITING_RETURN", "PENDING_REVIEW", "REJECTED"];

/**
 * An order that is mid-exchange, or was converted from a return to an exchange,
 * cannot also be returned or refunded: that would pay out twice for one case.
 * Pass the order item for a return of one garment, or nothing for a whole-order refund.
 */
export function assertNoExchangeBlocksReturn(exchanges: ExchangeBlockState[], orderItemId?: string): void {
  if (exchanges.some((row) => OPEN_EXCHANGE_STATUSES.includes(row.status) && (!orderItemId || row.orderItemId === orderItemId))) {
    throw new ConflictException("An exchange is still open on this order. Finish or cancel the exchange before returning or refunding.");
  }
  if (exchanges.some((row) => row.kind === "RETURN_TO_EXCHANGE" && row.status !== "CANCELLED")) {
    throw new ConflictException("This order was changed from a return to an exchange, so it cannot also be returned or refunded.");
  }
}
