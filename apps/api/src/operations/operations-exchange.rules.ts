/**
 * Rules for swapping a garment on an order for another (owner request, 2026-11-03).
 *
 * Pure functions, so the rules can be read and tested without a database. Step 1
 * covers the simplest swap: a paid order that has not started picking, a garment
 * of the same price. Dearer garments (the customer tops up), orders already
 * delivered and the "return to exchange" discount come in later steps and are
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

/** Step 1: the new garment must cost exactly what the old one did. */
export function assertSamePrice(oldPriceKsh: number, newPriceKsh: number): void {
  if (newPriceKsh < oldPriceKsh) {
    throw new BadRequestException("Choose an item priced the same or higher. A cheaper item cannot be swapped in; use a return and refund instead.");
  }
  if (newPriceKsh > oldPriceKsh) {
    throw new BadRequestException(`That item costs KSh ${newPriceKsh - oldPriceKsh} more. Exchanges with a top-up are not available yet; choose an item at the same price.`);
  }
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
