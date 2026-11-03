/**
 * Rules for swapping a garment on an order for another (owner request, 2026-11-03).
 *
 * Pure functions, so the rules can be read and tested without a database. This
 * covers a paid order that has not started picking, swapped for a garment of the
 * same price or a dearer one (the customer pays the difference). Orders already
 * delivered and the "return to exchange" discount come in a later step and are
 * refused here with a message that says so.
 */
import { BadRequestException, ConflictException } from "@nestjs/common";

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
  /** Null when the order line has no picking task line. */
  fulfillmentItemStatus: string | null;
  inventoryStatus: string | null;
  hasReturn: boolean;
};

/** Whether the garment on this order line can still be swapped, and if not, why not. */
export function assertCanExchange(state: ExchangeOrderState): void {
  if (state.orderStatus !== "PAID") {
    throw new ConflictException("Only a fully paid order that has not started fulfilment can have an item exchanged. Orders already delivered are not supported yet.");
  }
  if (state.hasReturn) throw new ConflictException("This item already has a return. Finish or close it before exchanging.");
  if (state.fulfillmentStatus !== null && state.fulfillmentStatus !== "PAID") {
    throw new ConflictException("Picking has already started on this order. Ask the warehouse to put the item back on its shelf first.");
  }
  if (state.fulfillmentItemStatus === "VERIFIED") throw new ConflictException("This item has already been scanned during picking.");
  if (state.inventoryStatus !== "PAID") {
    throw new ConflictException(`The item on this order is ${state.inventoryStatus ?? "missing from stock"}, not waiting to be picked, so it cannot be swapped.`);
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
export function exchangePricing(oldPriceKsh: number, newPriceKsh: number, topUp: TopUpInput): { topUpKsh: number; mpesaCode: string | null } {
  const code = normalizeTopUpCode(topUp.mpesaCode);
  if (newPriceKsh < oldPriceKsh) {
    throw new BadRequestException("Choose an item priced the same or higher. A cheaper item cannot be swapped in; use a return and refund instead.");
  }
  const difference = newPriceKsh - oldPriceKsh;
  if (difference === 0) {
    if (code || (topUp.amountKsh !== undefined && topUp.amountKsh !== null && topUp.amountKsh !== "")) {
      throw new BadRequestException("This swap needs no payment. Leave the top-up amount and M-Pesa code empty.");
    }
    return { topUpKsh: 0, mpesaCode: null };
  }
  if (!code) throw new BadRequestException(`That item costs KSh ${difference} more. Collect KSh ${difference} by M-Pesa from the customer, then enter the transaction code and the amount.`);
  if (!/^[A-Z0-9]{10}$/.test(code)) throw new BadRequestException("The M-Pesa code must be 10 letters and digits, for example QGH7XY1234.");
  if (Number(topUp.amountKsh) !== difference) throw new BadRequestException(`The difference is KSh ${difference}. The top-up amount entered does not match.`);
  return { topUpKsh: difference, mpesaCode: code };
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
