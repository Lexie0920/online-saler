export const RESERVATION_MINUTES = 5;
/**
 * Pieces one M-Pesa phone may have locked for payment at once, across all of
 * its open checkouts. Matches the bag size (owner, 2026-10-05; was 5). A new
 * checkout first releases that phone's earlier unpaid attempts, so only
 * payments that may still complete count against it.
 */
export const MAX_ACTIVE_RESERVATIONS_PER_PHONE = 50;
/** Door-to-door delivery within Nairobi, one flat fee (owner, 2026-09-26). Pickup is free. */
export const KIKUYU_DELIVERY_FEE_KSH = 200;
export const AFFILIATE_ATTRIBUTION_DAYS = 7;
/**
 * Commission can be confirmed once the 3-day return window has closed (owner,
 * 2026-10-14; was 24 hours). Matches RETURN_REQUEST_WINDOW_HOURS, so a
 * commission is never confirmed while its garment could still come back.
 */
export const COMMISSION_CONFIRMATION_HOURS = 72;
/** Customers may bring an item back to a store within 3 days for any reason (owner, 2026-09-26). */
export const RETURN_REQUEST_WINDOW_HOURS = 72;
export const SIGNIFICANT_MEASUREMENT_ERROR_CM = 3;

export function createReservationExpiry(now = new Date()): Date {
  return new Date(now.getTime() + RESERVATION_MINUTES * 60 * 1000);
}

export function isReservationExpired(expiresAt: Date, now = new Date()): boolean {
  return expiresAt.getTime() <= now.getTime();
}

export function getDeliveryFeeKsh(method: "PICKUP" | "KIKUYU_LOCAL_DELIVERY"): number {
  return method === "PICKUP" ? 0 : KIKUYU_DELIVERY_FEE_KSH;
}

export function createAttributionExpiry(clickedAt = new Date()): Date {
  return new Date(clickedAt.getTime() + AFFILIATE_ATTRIBUTION_DAYS * 24 * 60 * 60 * 1000);
}

export function createCommissionEligibleAt(deliveredAt: Date): Date {
  return new Date(deliveredAt.getTime() + COMMISSION_CONFIRMATION_HOURS * 60 * 60 * 1000);
}

export * from "./transaction-domain";
export * from "./deposit-plan";
export * from "./commission-rate";
export * from "./size-chart";
export * from "./product-measurement-requirements";
export * from "./measurement-board-geometry";
export * from "./product-detail-measurement-templates";

export * from "./delivery-address";
export * from "./delivery-economics";
export * from "./customer-code";
export * from "./notification-topics";
export * from "./notification-templates";
export * from "./customer-service";
