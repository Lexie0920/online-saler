import {
  FulfillmentHolderType,
  FulfillmentItemStatus,
  FulfillmentMethod,
  FulfillmentNodeType,
  FulfillmentStatus,
  OrderStatus
} from "@online-saler/database";

export type FulfillmentTransitionInput = {
  from: FulfillmentStatus;
  to: FulfillmentStatus;
  fulfillmentMethod?: FulfillmentMethod | null;
  hasDeliveryRider?: boolean;
  /**
   * Where this package is handed to the customer. A store node needs the two
   * transit steps; the warehouse hands over on the spot.
   */
  nodeType?: FulfillmentNodeType | null;
  /**
   * Whether the customer has read out their code for this handover. No code, no
   * completion: this is checked here as well as in the service, so a new caller
   * cannot complete an order by skipping the verification helper.
   */
  customerCodeVerified?: boolean;
  /**
   * 无码补登: a super admin records that the parcel already reached the
   * customer without the code being read out. It is a separate, named flag so
   * no ordinary caller can stumble into it, and it only opens the statuses in
   * CODELESS_COMPLETION_STATUSES. The service checks the role before setting it.
   */
  codelessBySuperAdmin?: boolean;
};

/**
 * Where a super admin may record a code-less handover from. Everything from a
 * sealed parcel onwards: staff sometimes hand a packed parcel over at the
 * warehouse, or a store gives it out before scanning it in. A failed delivery
 * on its way back is not here — it has to come back to the shelf first.
 */
export const CODELESS_COMPLETION_STATUSES: readonly FulfillmentStatus[] = [
  FulfillmentStatus.PACKED,
  FulfillmentStatus.IN_TRANSIT_TO_NODE,
  FulfillmentStatus.ARRIVED_AT_NODE,
  FulfillmentStatus.READY_FOR_PICKUP,
  FulfillmentStatus.READY_FOR_DISPATCH,
  FulfillmentStatus.OUT_FOR_DELIVERY
];

/** Why the code was not used. OTHER needs the note to say what happened. */
export const CODELESS_COMPLETION_REASONS = {
  OFFLINE_HANDOVER_NO_CODE: "已线下交付，顾客无码",
  PICKED_UP_CODE_LOST: "顾客已取货，码丢失",
  OTHER: "其他"
} as const;

export type CodelessCompletionReason = keyof typeof CODELESS_COMPLETION_REASONS;

/** The note has to be a sentence, not "ok". */
export const CODELESS_COMPLETION_NOTE_MIN_LENGTH = 10;

/** The event both the timeline and the business report look for. */
export const CODELESS_COMPLETION_ACTION = "CODELESS_COMPLETION";

/** A reassignment has to say why, so the timeline can answer "who moved this and why". */
export const REASSIGN_REASON_MIN_LENGTH = 2;

export function canCompleteWithoutCode(status: FulfillmentStatus | null | undefined): boolean {
  return Boolean(status) && CODELESS_COMPLETION_STATUSES.includes(status!);
}

/**
 * Every tab of the order centre, in the order the screen shows them. The
 * console keeps its own copy (order-center-routes.ts) and a test holds the two
 * together, so a status the API can report is never left without a tab.
 */
export const ORDER_CENTER_TABS = [
  "all",
  "pending-payment",
  "waiting-pick",
  "picking",
  "ready-to-pack",
  "packed",
  "in-transit-to-node",
  "at-node",
  "ready-for-pickup",
  "ready-for-dispatch",
  "out-for-delivery",
  "delivery-failed",
  "returning-to-node",
  "exception",
  "completed",
  "after-sale",
  "cancelled"
] as const;

export type OrderCenterTab = (typeof ORDER_CENTER_TABS)[number];

export type BarcodeCheckInput = {
  orderItemId: string;
  expectedBarcode: string | null;
  scannedBarcode: string;
  productName: string;
  locationCode: string | null;
};

export type BarcodeCheckResult =
  | { ok: true; normalizedBarcode: string }
  | {
      ok: false;
      normalizedBarcode: string;
      expectedBarcode: string | null;
      actualBarcode: string;
      productName: string;
      locationCode: string | null;
    };

/** A store node has to receive the package before it can hand it over. */
export function requiresNodeTransit(nodeType?: FulfillmentNodeType | null): boolean {
  return nodeType === FulfillmentNodeType.STORE;
}

/** The handover state a packed order moves into once it is at its node. */
export function handoverStatusFor(fulfillmentMethod?: FulfillmentMethod | null): FulfillmentStatus {
  return fulfillmentMethod === FulfillmentMethod.PICKUP
    ? FulfillmentStatus.READY_FOR_PICKUP
    : FulfillmentStatus.READY_FOR_DISPATCH;
}

export function canTransitionFulfillment(input: FulfillmentTransitionInput): boolean {
  const { from, to, fulfillmentMethod, hasDeliveryRider, nodeType } = input;
  if (from === to || from === FulfillmentStatus.COMPLETED) return false;
  if (to === FulfillmentStatus.EXCEPTION) return from !== FulfillmentStatus.EXCEPTION;

  if (from === FulfillmentStatus.PAID && to === FulfillmentStatus.PICKING) return true;
  if (from === FulfillmentStatus.PICKING && to === FulfillmentStatus.READY_TO_PACK) return true;
  if (from === FulfillmentStatus.READY_TO_PACK && to === FulfillmentStatus.PACKED) return true;
  if (from === FulfillmentStatus.PACKED && to === FulfillmentStatus.IN_TRANSIT_TO_NODE) {
    return requiresNodeTransit(nodeType);
  }
  if (from === FulfillmentStatus.IN_TRANSIT_TO_NODE && to === FulfillmentStatus.ARRIVED_AT_NODE) {
    return requiresNodeTransit(nodeType);
  }
  if (from === FulfillmentStatus.PACKED && to === FulfillmentStatus.READY_FOR_PICKUP) {
    return fulfillmentMethod === FulfillmentMethod.PICKUP && !requiresNodeTransit(nodeType);
  }
  if (from === FulfillmentStatus.PACKED && to === FulfillmentStatus.READY_FOR_DISPATCH) {
    return fulfillmentMethod === FulfillmentMethod.KIKUYU_LOCAL_DELIVERY && !requiresNodeTransit(nodeType);
  }
  if (from === FulfillmentStatus.ARRIVED_AT_NODE && to === FulfillmentStatus.READY_FOR_PICKUP) {
    return fulfillmentMethod === FulfillmentMethod.PICKUP;
  }
  if (from === FulfillmentStatus.ARRIVED_AT_NODE && to === FulfillmentStatus.READY_FOR_DISPATCH) {
    return fulfillmentMethod === FulfillmentMethod.KIKUYU_LOCAL_DELIVERY;
  }
  if (from === FulfillmentStatus.READY_FOR_DISPATCH && to === FulfillmentStatus.OUT_FOR_DELIVERY) {
    return fulfillmentMethod === FulfillmentMethod.KIKUYU_LOCAL_DELIVERY && Boolean(hasDeliveryRider);
  }
  // A rider who cannot hand the package over comes back with it. The order is
  // never cancelled here: the customer has already paid, so the package returns
  // to the node and waits for another attempt.
  if (from === FulfillmentStatus.OUT_FOR_DELIVERY && to === FulfillmentStatus.DELIVERY_FAILED) {
    return fulfillmentMethod === FulfillmentMethod.KIKUYU_LOCAL_DELIVERY;
  }
  if (from === FulfillmentStatus.DELIVERY_FAILED && to === FulfillmentStatus.RETURNING_TO_NODE) {
    return fulfillmentMethod === FulfillmentMethod.KIKUYU_LOCAL_DELIVERY;
  }
  if (from === FulfillmentStatus.RETURNING_TO_NODE && to === FulfillmentStatus.ARRIVED_AT_NODE) {
    return fulfillmentMethod === FulfillmentMethod.KIKUYU_LOCAL_DELIVERY;
  }

  // The super-admin back door (无码补登), kept apart from the coded completions
  // below and limited to sealed parcels that are not on their way back.
  if (to === FulfillmentStatus.COMPLETED && input.codelessBySuperAdmin) {
    return canCompleteWithoutCode(from);
  }

  // The two completions, and the one rule they share.
  if (from === FulfillmentStatus.READY_FOR_PICKUP && to === FulfillmentStatus.COMPLETED) {
    return fulfillmentMethod === FulfillmentMethod.PICKUP && Boolean(input.customerCodeVerified);
  }
  if (from === FulfillmentStatus.OUT_FOR_DELIVERY && to === FulfillmentStatus.COMPLETED) {
    return fulfillmentMethod === FulfillmentMethod.KIKUYU_LOCAL_DELIVERY && Boolean(input.customerCodeVerified);
  }

  return false;
}

/**
 * Handing a package to the customer always needs the customer's own code. Both
 * completions go through it, which is what makes "the rider knows them" or "they
 * said so on WhatsApp" not a way to close an order.
 */
export function requiresCustomerCode(to: FulfillmentStatus): boolean {
  return to === FulfillmentStatus.COMPLETED;
}

export function orderCenterTab(input: {
  orderStatus: OrderStatus;
  fulfillmentStatus?: FulfillmentStatus | null;
  hasOpenAfterSale?: boolean;
}): OrderCenterTab {
  if (input.hasOpenAfterSale || input.orderStatus === OrderStatus.REFUNDED) return "after-sale";
  // A lapsed deposit is a dead order like a cancelled one: the garment is back
  // on sale. The refund it still owes is followed up on 定金单, not here.
  if (
    input.orderStatus === OrderStatus.CANCELLED
    || input.orderStatus === OrderStatus.EXPIRED
    || input.orderStatus === OrderStatus.DEPOSIT_EXPIRED
  ) return "cancelled";
  if (input.orderStatus === OrderStatus.COMPLETED || input.fulfillmentStatus === FulfillmentStatus.COMPLETED) return "completed";
  // An exception used to fall into "all" and no tab at all, so the tab counts
  // never added up to 全部 and the order could only be found by scrolling.
  if (input.fulfillmentStatus === FulfillmentStatus.EXCEPTION) return "exception";

  const fulfillmentTabs: Partial<Record<FulfillmentStatus, OrderCenterTab>> = {
    [FulfillmentStatus.PAID]: "waiting-pick",
    [FulfillmentStatus.PICKING]: "picking",
    [FulfillmentStatus.READY_TO_PACK]: "ready-to-pack",
    [FulfillmentStatus.PACKED]: "packed",
    [FulfillmentStatus.IN_TRANSIT_TO_NODE]: "in-transit-to-node",
    [FulfillmentStatus.ARRIVED_AT_NODE]: "at-node",
    [FulfillmentStatus.READY_FOR_PICKUP]: "ready-for-pickup",
    [FulfillmentStatus.READY_FOR_DISPATCH]: "ready-for-dispatch",
    [FulfillmentStatus.OUT_FOR_DELIVERY]: "out-for-delivery",
    [FulfillmentStatus.DELIVERY_FAILED]: "delivery-failed",
    [FulfillmentStatus.RETURNING_TO_NODE]: "returning-to-node",
    [FulfillmentStatus.COMPLETED]: "completed"
  };
  if (input.fulfillmentStatus && fulfillmentTabs[input.fulfillmentStatus]) {
    return fulfillmentTabs[input.fulfillmentStatus]!;
  }
  if (input.orderStatus === OrderStatus.PAID || input.orderStatus === OrderStatus.FULFILLING) return "waiting-pick";
  return "pending-payment";
}

export function normalizeScannedBarcode(value: string): string {
  return value.trim().replace(/\s+/g, "").toUpperCase();
}

export function barcodeMatchesOrder(expectedBarcodes: readonly string[], scannedBarcode: string): boolean {
  const scanned = normalizeScannedBarcode(scannedBarcode);
  return expectedBarcodes.some((barcode) => normalizeScannedBarcode(barcode) === scanned);
}

export function verifyFulfillmentItemBarcode(input: BarcodeCheckInput): BarcodeCheckResult {
  const normalizedBarcode = normalizeScannedBarcode(input.scannedBarcode);
  const expected = input.expectedBarcode ? normalizeScannedBarcode(input.expectedBarcode) : null;
  if (expected && expected === normalizedBarcode) return { ok: true, normalizedBarcode };
  return {
    ok: false,
    normalizedBarcode,
    expectedBarcode: input.expectedBarcode,
    actualBarcode: input.scannedBarcode,
    productName: input.productName,
    locationCode: input.locationCode
  };
}

export type WarehouseTaskOwnership =
  | { allowed: true }
  | { allowed: false; reason: "UNASSIGNED" | "OTHER_EMPLOYEE" };

/**
 * May this person work this parcel?
 *
 * Picking and packing answer it differently on purpose. A picker takes a task
 * by scanning the garment in their hand — the work itself is the claim, and an
 * unclaimed order is fair game. Packing is handed out: a trolley of loose
 * garments is the last point where what goes into a bag can still be traced to
 * a person, so an unassigned parcel belongs to nobody rather than to whoever
 * reaches it first.
 *
 * `supervisor` is whoever holds the matching assign permission. They can always
 * act, or a floor where nothing has been handed out yet could not start.
 */
export function canWorkWarehouseTask(input: {
  assignedEmployeeId: string | null;
  actorEmployeeId: string | null;
  supervisor: boolean;
  /** Picking lets anyone take an unclaimed task; packing does not. */
  unassignedIsOpen: boolean;
}): WarehouseTaskOwnership {
  if (input.supervisor) return { allowed: true };
  if (!input.assignedEmployeeId) {
    return input.unassignedIsOpen ? { allowed: true } : { allowed: false, reason: "UNASSIGNED" };
  }
  // A missing actor can never match an assignment; treat it as someone else's
  // rather than letting a null slip past an equality check.
  if (!input.actorEmployeeId || input.assignedEmployeeId !== input.actorEmployeeId) {
    return { allowed: false, reason: "OTHER_EMPLOYEE" };
  }
  return { allowed: true };
}

export function allFulfillmentItemsVerified(items: ReadonlyArray<{ status: FulfillmentItemStatus }>): boolean {
  return items.length > 0 && items.every((item) => item.status === FulfillmentItemStatus.VERIFIED);
}

/**
 * EXCEPTION used to be a dead end: an order that hit it could only be
 * cancelled. A resolved exception returns to the step it was on, so a package
 * that was mis-routed or briefly lost can rejoin the normal flow.
 */
export function canResolveFulfillmentException(input: {
  status: FulfillmentStatus;
  exceptionFromStatus?: FulfillmentStatus | null;
}): boolean {
  if (input.status !== FulfillmentStatus.EXCEPTION) return false;
  const back = input.exceptionFromStatus;
  return Boolean(back) && back !== FulfillmentStatus.EXCEPTION && back !== FulfillmentStatus.COMPLETED;
}

/**
 * Exceptions that mean the garment will never reach this customer. These are
 * the ones that lead to a write-off and a refund rather than a retry.
 */
export const UNRECOVERABLE_EXCEPTION_REASONS = [
  "ITEM_NOT_FOUND",
  "ITEM_DAMAGED",
  "ITEM_SOLD_OFFLINE"
] as const;

/**
 * Who is holding the package at a given status. Storing the answer on the
 * fulfillment row means "where is this order and who is responsible for it" is
 * one read, not a replay of the event log, and it is the same answer on every
 * screen that asks.
 */
export function holderForStatus(input: {
  status: FulfillmentStatus;
  fulfillmentNodeId?: string | null;
  nodeName?: string | null;
  deliveryRiderId?: string | null;
  riderName?: string | null;
}): { currentHolderType: FulfillmentHolderType; currentHolderId: string | null; currentHolderLabel: string | null } {
  switch (input.status) {
    case FulfillmentStatus.PAID:
    case FulfillmentStatus.PICKING:
    case FulfillmentStatus.READY_TO_PACK:
    case FulfillmentStatus.PACKED:
      return { currentHolderType: FulfillmentHolderType.WAREHOUSE, currentHolderId: null, currentHolderLabel: "Central warehouse" };

    // Between the warehouse door and the store counter nobody on the system is
    // holding it. Saying so is more useful than pretending the node already has it.
    case FulfillmentStatus.IN_TRANSIT_TO_NODE:
    case FulfillmentStatus.RETURNING_TO_NODE:
      return {
        currentHolderType: FulfillmentHolderType.IN_TRANSIT,
        currentHolderId: input.fulfillmentNodeId ?? null,
        currentHolderLabel: input.nodeName ? `In transit to ${input.nodeName}` : "In transit"
      };

    case FulfillmentStatus.ARRIVED_AT_NODE:
    case FulfillmentStatus.READY_FOR_PICKUP:
    case FulfillmentStatus.READY_FOR_DISPATCH:
      return {
        currentHolderType: FulfillmentHolderType.NODE,
        currentHolderId: input.fulfillmentNodeId ?? null,
        currentHolderLabel: input.nodeName ?? "Fulfillment node"
      };

    // A failed delivery is still in the rider's hands until they hand it back.
    case FulfillmentStatus.OUT_FOR_DELIVERY:
    case FulfillmentStatus.DELIVERY_FAILED:
      return {
        currentHolderType: FulfillmentHolderType.RIDER,
        currentHolderId: input.deliveryRiderId ?? null,
        currentHolderLabel: input.riderName ?? "Delivery rider"
      };

    case FulfillmentStatus.COMPLETED:
      return { currentHolderType: FulfillmentHolderType.CUSTOMER, currentHolderId: null, currentHolderLabel: "Customer" };

    // An exception does not move the package, so the holder stays whoever the
    // caller already recorded; this is the safe fallback for a brand-new row.
    case FulfillmentStatus.EXCEPTION:
    default:
      return { currentHolderType: FulfillmentHolderType.WAREHOUSE, currentHolderId: null, currentHolderLabel: null };
  }
}

/** Statuses where a delivery order is somewhere between the node and the customer. */
export const RIDER_HELD_STATUSES = [
  FulfillmentStatus.OUT_FOR_DELIVERY,
  FulfillmentStatus.DELIVERY_FAILED
] as const;

/** Human-facing package label carried on the box between warehouse and node. */
export function buildPackageCode(orderNumber: string, nodeCode: string): string {
  const order = orderNumber.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(-8);
  const node = nodeCode.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 6);
  return `PKG-${node}-${order}`;
}
