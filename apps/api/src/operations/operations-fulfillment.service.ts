import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import {
  ActorType,
  SourceApp,
  CustomerCodePurpose,
  CustomerServiceCaseStatus,
  CustomerServiceIssueType,
  DeliveryCompletionMethod,
  DeliveryFailureReason,
  DeliveryRiderType,
  EmployeeStatus,
  FulfillmentExceptionReason,
  FulfillmentItemStatus,
  FulfillmentMethod,
  FulfillmentNodeStatus,
  FulfillmentNodeType,
  FulfillmentStatus,
  InventoryItemStatus,
  NotificationAudience,
  OrderStatus,
  PackagingMethod,
  PaymentStatus,
  PickupVerificationMethod,
  Prisma,
  RefundKind,
  closeUnpaidOrder,
  enqueueNotification,
  lockReservationOrder,
  lockOrderReservationInventory,
  orderRefundPosition,
  prisma,
  reverseCommissionForClosedOrder,
  writeOffPaidOrder,
  type InventoryOutcome
} from "@online-saler/database";
import {
  CUSTOMER_CODE_MAX_ATTEMPTS,
  SUPPORT_PHONE_LABEL,
  customerCodeFailureMessage,
  generateCustomerCode,
  hashCustomerCode,
  normalizeCustomerCode,
  isValidActualDeliveryCost,
  notificationBody,
  notificationDedupeKey,
  verifyCustomerCode,
  type NotificationTopicName
} from "@online-saler/business-rules";
import { ProductImageStorageService } from "../product/product-image-storage.service";
import { OperationsAccessService } from "./operations-access.service";
import {
  CODELESS_COMPLETION_ACTION,
  CODELESS_COMPLETION_NOTE_MIN_LENGTH,
  CODELESS_COMPLETION_REASONS,
  REASSIGN_REASON_MIN_LENGTH,
  buildPackageCode,
  canCompleteWithoutCode,
  canResolveFulfillmentException,
  type CodelessCompletionReason,
  canTransitionFulfillment,
  canWorkWarehouseTask,
  holderForStatus,
  orderCenterTab,
  requiresNodeTransit,
  type OrderCenterTab,
  verifyFulfillmentItemBarcode
} from "./operations-fulfillment-state";
import { refreshWarehouseLocationStatuses } from "./warehouse-capacity";
import { assertOrderInScope, scopedNodeId, storeScopeFor } from "./store-scope";
import { requireRiderFee, riderFeeNote } from "./rider-fee";
import { listPage, listPageRequest, listPageWindow } from "./list-page";

const ORDER_INCLUDE = {
  customer: true,
  affiliate: true,
  fulfillmentNode: true,
  refunds: { orderBy: { recordedAt: "desc" } },
  items: {
    include: { snapshot: true },
    orderBy: { createdAt: "asc" }
  },
  payments: {
    orderBy: { requestedAt: "desc" },
    take: 1
  },
  fulfillment: {
    include: {
      fulfillmentNode: true,
      sentToNodeBy: true,
      arrivedAtNodeBy: true,
      deliveryCostBy: true,
      assignedPicker: true,
      assignedPacker: true,
      packingStartedBy: true,
      packedBy: true,
      dispatchedBy: true,
      pickupConfirmedBy: true,
      afterSaleOwner: true,
      deliveryRider: { include: { employee: true } },
      items: { include: { verifiedBy: true }, orderBy: { createdAt: "asc" } },
      deliveryAssignments: {
        include: { deliveryRider: { include: { employee: true } }, assignedByAdminUser: true },
        orderBy: { createdAt: "desc" }
      },
      events: {
        include: {
          actorEmployee: true,
          actorAdminUser: true,
          relatedEmployee: true,
          deliveryRider: true,
          orderItem: { include: { snapshot: true } }
        },
        orderBy: { createdAt: "asc" }
      }
    }
  },
  customerServiceCases: {
    include: { assignedEmployee: true, createdByAdminUser: true, afterSaleReturn: { select: { id: true } } },
    orderBy: { updatedAt: "desc" }
  }
} as const;

type OrderDetail = Prisma.OrderGetPayload<{ include: typeof ORDER_INCLUDE }>;

export type OrderCenterScope = "workbench" | "all" | "after-sales" | "exceptions" | "node";

/**
 * The parcels a store desk works: on the way to it, at it, or out with one of
 * its riders. The `node` scope lists only these.
 *
 * It exists because the store screens used to ask for `scope=all` and sort out
 * the statuses themselves. `all` is every order that ever named the store —
 * including every abandoned pickup checkout, because a pickup order carries its
 * store from the moment it is created, paid or not — and the list stops at 150,
 * newest first. A delivery order is created days before it is routed and sent,
 * so on a store with enough newer pickup checkouts the parcel actually on its
 * way was the one that fell off the end, and the store could not sign for it.
 */
export const NODE_DESK_STATUSES: FulfillmentStatus[] = [
  FulfillmentStatus.IN_TRANSIT_TO_NODE,
  FulfillmentStatus.ARRIVED_AT_NODE,
  FulfillmentStatus.READY_FOR_PICKUP,
  FulfillmentStatus.READY_FOR_DISPATCH,
  FulfillmentStatus.OUT_FOR_DELIVERY,
  FulfillmentStatus.DELIVERY_FAILED,
  FulfillmentStatus.RETURNING_TO_NODE
];

export type OrderCenterListInput = {
  adminUserId?: string;
  scope?: OrderCenterScope;
  tab?: OrderCenterTab;
  dateFrom?: string;
  dateTo?: string;
  orderNumber?: string;
  customerName?: string;
  customerPhone?: string;
  productName?: string;
  barcode?: string;
  fulfillmentMethod?: FulfillmentMethod;
  paymentStatus?: PaymentStatus;
  orderStatus?: OrderStatus;
  pickerEmployeeId?: string;
  packerEmployeeId?: string;
  rider?: string;
  affiliate?: string;
  /** Narrows the list to one store's packages, for the node workbench. */
  nodeId?: string;
  packageCode?: string;
  /**
   * One or more fulfillment statuses, comma separated: the steps of 每日打单配送
   * (PAID, PICKING, READY_TO_PACK, PACKED, IN_TRANSIT_TO_NODE).
   */
  fulfillmentStatus?: string;
  /** Asking for a page turns the list into `{ items, total, page, pageSize, pageCount }`. */
  page?: string | number;
  pageSize?: string | number;
};

/** The photos the enlarged view pages through: the order's own photo first, no repeats. */
export function orderItemImageUrls(snapshotUrl: string | null | undefined, productUrls: string[]): string[] {
  return [...new Set([snapshotUrl, ...productUrls].filter((url): url is string => Boolean(url)))];
}

/** The comma-separated fulfillment statuses a screen asked for, unknown ones dropped. */
export function fulfillmentStatusFilter(value?: string): FulfillmentStatus[] {
  if (!value?.trim()) return [];
  const known = new Set<string>(Object.values(FulfillmentStatus));
  return [...new Set(value.split(",").map((part) => part.trim()).filter((part) => known.has(part)))] as FulfillmentStatus[];
}

export type AdminInput = { adminUserId?: string; note?: string };
export type EmployeeInput = AdminInput & { employeeId?: string };
/** Moving work that is already under way to somebody else. The reason is required. */
export type ReassignInput = EmployeeInput & { reason?: string };
export type BatchReassignInput = ReassignInput & { orderIds?: unknown };
/** 无码补登: a super admin closes an order whose code was never read out. */
export type CodelessCompletionInput = AdminInput & { reasonCode?: string };
/** How many orders one batch reassignment may touch. A page holds 30. */
export const BATCH_REASSIGN_LIMIT = 100;
export type ScanInput = AdminInput & { barcode?: string };
export type PackingInput = EmployeeInput & { packagingMethod?: PackagingMethod; packageCount?: number };
export type PickupInput = AdminInput & { verificationMethod?: PickupVerificationMethod; verificationValue?: string };
export type RiderInput = AdminInput & {
  riderType?: DeliveryRiderType;
  employeeId?: string;
  name?: string;
  phone?: string;
  company?: string;
  vehicle?: string;
  estimatedDeliveryAt?: string;
  /** This order's rider pay: 50 or 100 (KSh). Required; see rider-fee.ts. */
  riderFeeKsh?: unknown;
};
export type ExceptionInput = AdminInput & { reason?: FulfillmentExceptionReason };
/** Hands a package at a node to one of that node's riders, in one step. */
export type DispatchToRiderInput = AdminInput & { deliveryRiderId?: string; estimatedDeliveryAt?: string; riderFeeKsh?: unknown };
/**
 * Confirming a hand-off to a rider registered earlier. The fee chosen then
 * stands; sending one here replaces it.
 */
export type DispatchInput = AdminInput & { riderFeeKsh?: unknown };
/** Everything a rider submits to close or fail a delivery. */
export type DeliveryCodeInput = AdminInput & { code?: string };
export type DropOffInput = DeliveryCodeInput & {
  photoBase64?: string;
  photoContentType?: string;
  dropOffNote?: string;
};
export type DeliveryFailureInput = AdminInput & { reason?: DeliveryFailureReason };
/**
 * Exactly the fields a rider is allowed to be shown. Declaring it structurally
 * rather than as a Prisma payload means a rider-facing query can select these
 * columns and nothing else, and adding a money column to Order later cannot
 * silently widen what the rider portal returns.
 */
export type RiderVisibleOrder = {
  id: string;
  orderNumber: string;
  deliveryAddress: string | null;
  deliveryNote: string | null;
  customer: { displayName: string | null; phone: string | null };
  items: ReadonlyArray<{ snapshot: { title: string; sizeLabel: string | null } | null }>;
  fulfillment: {
    packageCode: string | null;
    status: FulfillmentStatus;
    outForDeliveryAt: Date | null;
    completedAt: Date | null;
    deliveryAttemptCount: number;
    customerCodeFailedAttempts: number;
    customerCodeLockedAt: Date | null;
    deliveryFailureReason: DeliveryFailureReason | null;
    fulfillmentNode: { name: string } | null;
    /** The rider's own pay for this delivery; the only money they are shown. */
    riderFeeKsh: number | null;
  } | null;
};

/** A rider acting on their own delivery, resolved from their login. */
export type RiderActor = { id: string; name: string; employeeId: string | null };
export type NodeInput = AdminInput & { nodeId?: string };
export type LabelPrintedInput = AdminInput & { packageCode?: string };

/**
 * Sent back when a parcel is sent to its store before its label was printed.
 * The console matches on the code to show its own wording; the message is for
 * everyone else.
 */
export const PACKAGE_LABEL_NOT_PRINTED = "PACKAGE_LABEL_NOT_PRINTED";
export type DeliveryCostInput = AdminInput & { actualDeliveryCostKsh?: number };
export type WriteOffInput = AdminInput & { inventoryOutcome?: InventoryOutcome };
export type RefundInput = AdminInput & {
  amountKsh?: number;
  externalReference?: string;
  evidenceNote?: string;
  refundedAt?: string;
  reason?: string;
};
export type AfterSaleInput = AdminInput & {
  employeeId?: string;
  caseId?: string;
  status?: CustomerServiceCaseStatus;
  afterSaleReason?: string;
  customerRequest?: string;
  requiresReturn?: boolean;
  requiresRefund?: boolean;
  affectsAffiliateCommission?: boolean;
};

type EventInput = {
  idempotencyKey?: string;
  fulfillmentId: string;
  orderId: string;
  actorAdminUserId?: string | null;
  actorEmployeeId?: string | null;
  relatedEmployeeId?: string | null;
  deliveryRiderId?: string | null;
  orderItemId?: string | null;
  action: string;
  oldStatus: FulfillmentStatus | null;
  newStatus: FulfillmentStatus;
  note?: string | null;
  expectedBarcode?: string | null;
  scannedBarcode?: string | null;
  exceptionReason?: FulfillmentExceptionReason | null;
};

@Injectable()
export class OperationsFulfillmentService {
  constructor(
    private readonly access: OperationsAccessService,
    private readonly photos: ProductImageStorageService
  ) {}

  async summary(input: OrderCenterListInput) {
    const session = await this.access.requirePermission(input.adminUserId, "orders.view");
    const nodeId = scopedNodeId(await storeScopeFor(session), input.nodeId);
    await this.ensurePaidFulfillments();
    const orders = await prisma.order.findMany({
      where: this.orderWhere({ ...input, nodeId, scope: "all", tab: "all" }),
      select: {
        status: true,
        fulfillment: { select: { status: true } },
        customerServiceCases: { select: { issueType: true, status: true } }
      }
    });
    const counts: Record<OrderCenterTab, number> = {
      all: orders.length,
      "pending-payment": 0,
      "waiting-pick": 0,
      "in-transit-to-node": 0,
      "at-node": 0,
      picking: 0,
      "ready-to-pack": 0,
      packed: 0,
      "ready-for-pickup": 0,
      "ready-for-dispatch": 0,
      "out-for-delivery": 0,
      "delivery-failed": 0,
      "returning-to-node": 0,
      exception: 0,
      completed: 0,
      "after-sale": 0,
      cancelled: 0
    };
    for (const order of orders) {
      const tab = orderCenterTab({
        orderStatus: order.status,
        fulfillmentStatus: order.fulfillment?.status,
        hasOpenAfterSale: order.customerServiceCases.some(
          (item) => item.issueType === CustomerServiceIssueType.AFTER_SALE && item.status !== CustomerServiceCaseStatus.CLOSED
        )
      });
      if (tab !== "all") counts[tab] += 1;
    }
    return counts;
  }

  async listOrders(input: OrderCenterListInput) {
    const session = await this.access.requirePermission(input.adminUserId, "orders.view");
    // A store account is narrowed to its own store here, on the server, so a
    // screen that forgets to pass nodeId still cannot list another store.
    const nodeId = scopedNodeId(await storeScopeFor(session), input.nodeId);
    await this.ensurePaidFulfillments();
    const where = this.orderWhere({ ...input, nodeId });
    const paging = listPageRequest(input.page, input.pageSize);
    if (!paging) {
      // The store console, picking and pack-station screens read one unpaged
      // list, capped as before; only the order centre and 每日打单配送 page.
      const orders = await prisma.order.findMany({ where, include: ORDER_INCLUDE, orderBy: { createdAt: "desc" }, take: 150 });
      return this.attachInventory(orders);
    }
    const total = await prisma.order.count({ where });
    const window = listPageWindow(paging, total);
    const orders = total
      ? await prisma.order.findMany({
          where,
          include: ORDER_INCLUDE,
          // id breaks ties so two orders placed in the same millisecond never
          // swap between pages.
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip: window.skip,
          take: window.take
        })
      : [];
    return listPage(await this.attachInventory(orders), total, paging);
  }

  /**
   * How many orders sit at each fulfillment status, for the step badges on
   * 每日打单配送. The list there is paged, so the badges cannot be counted from
   * the rows on screen any more.
   */
  async fulfillmentStatusCounts(input: OrderCenterListInput) {
    const session = await this.access.requirePermission(input.adminUserId, "orders.view");
    const nodeId = scopedNodeId(await storeScopeFor(session), input.nodeId);
    await this.ensurePaidFulfillments();
    const rows = await prisma.order.findMany({
      where: this.orderWhere({ ...input, nodeId, tab: "all", fulfillmentStatus: undefined }),
      select: { fulfillment: { select: { status: true } } }
    });
    const counts = Object.fromEntries(Object.values(FulfillmentStatus).map((status) => [status, 0])) as Record<FulfillmentStatus, number>;
    for (const row of rows) if (row.fulfillment) counts[row.fulfillment.status] += 1;
    return counts;
  }

  async orderDetail(orderId: string, adminUserId?: string) {
    const session = await this.access.requirePermission(adminUserId, "orders.view");
    await this.ensurePaidFulfillments(orderId);
    const order = await this.requireOrder(orderId);
    assertOrderInScope(await storeScopeFor(session), order);
    return (await this.attachInventory([order]))[0];
  }

  /**
   * Refuses any action on an order that belongs to a different store than the
   * signed-in account. The controller calls it before every order action, so a
   * store account cannot receive, hand over or cancel another store's parcel by
   * sending its id: the list hiding it is not the only line of defence.
   */
  async assertOrderInStoreScope(orderId: string, adminUserId?: string) {
    const scope = await storeScopeFor(await this.access.session(adminUserId));
    if (!scope) return;
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { fulfillmentNodeId: true, fulfillment: { select: { fulfillmentNodeId: true } } }
    });
    if (!order) throw new NotFoundException("Order was not found.");
    assertOrderInScope(scope, order);
  }

  async employees(adminUserId?: string) {
    await this.access.requirePermission(adminUserId, "orders.view");
    return prisma.employee.findMany({
      where: { status: EmployeeStatus.ACTIVE },
      select: { id: true, employeeCode: true, name: true, phone: true },
      orderBy: [{ name: "asc" }, { employeeCode: "asc" }]
    });
  }

  async assignPicker(orderId: string, input: EmployeeInput) {
    const actor = await this.adminForPermission(input.adminUserId, "orders.assign-picker");
    const employee = await this.requireEmployee(input.employeeId);
    const order = await this.requireOrderWithTask(orderId);
    const fulfillment = order.fulfillment!;
    if (fulfillment.status !== FulfillmentStatus.PAID && fulfillment.status !== FulfillmentStatus.PICKING) {
      throw new BadRequestException("Picker can only be assigned before picking is complete.");
    }
    if (fulfillment.assignedPickerEmployeeId === employee.id) return this.orderDetail(orderId, input.adminUserId);
    // Taking a task off somebody who has started it is a reassignment, and a
    // reassignment says why (改派拣货员, reassign-picker).
    if (fulfillment.status === FulfillmentStatus.PICKING && fulfillment.assignedPickerEmployeeId) {
      throw new BadRequestException("Picking has already started. Use reassign-picker and give a reason.");
    }
    await prisma.$transaction(async (tx) => {
      await tx.orderFulfillment.update({ where: { id: fulfillment.id }, data: { assignedPickerEmployeeId: employee.id } });
      await this.createEvent(tx, {
        idempotencyKey: `assign-picker:${fulfillment.id}:${employee.id}:${fulfillment.assignedPickerEmployeeId ?? "unassigned"}`,
        fulfillmentId: fulfillment.id,
        orderId,
        ...actor,
        relatedEmployeeId: employee.id,
        action: "ASSIGN_PICKER",
        oldStatus: fulfillment.status,
        newStatus: fulfillment.status,
        note: input.note
      });
    });
    return this.orderDetail(orderId, input.adminUserId);
  }

  /**
   * 改派拣货员: hands a picking task that is already under way to somebody else.
   *
   * A task belongs to whoever claimed it, and the scan refuses everyone else —
   * which is right until that person leaves with sixteen orders in their name.
   * Only a supervisor (orders.assign-picker) can move it, a reason is required,
   * and the garments already scanned stay scanned: the scan proved the right
   * garment was in the trolley, and that does not stop being true because a
   * different person finishes the order. The new picker scans the rest.
   */
  async reassignPicker(orderId: string, input: ReassignInput) {
    const actor = await this.adminForPermission(input.adminUserId, "orders.assign-picker");
    await this.reassignWorker(orderId, input, actor, "picker");
    return this.orderDetail(orderId, input.adminUserId);
  }

  /**
   * 改派打包员: the same for a parcel whose packer was named, or who already
   * pressed 开始打包. Packing has no per-item progress to keep; the start time
   * stays, and the new packer is recorded as the one packing it so 完成打包
   * works for them without a supervisor.
   */
  async reassignPacker(orderId: string, input: ReassignInput) {
    const actor = await this.adminForPermission(input.adminUserId, "orders.assign-packer");
    await this.reassignWorker(orderId, input, actor, "packer");
    return this.orderDetail(orderId, input.adminUserId);
  }

  /**
   * 批量改派: moves every selected order to one person in one go. Orders still
   * being picked go to them as picker, orders waiting to be packed as packer.
   * One order failing does not stop the rest, and each failure is named.
   */
  async reassignBatch(input: BatchReassignInput) {
    await this.adminForPermission(input.adminUserId, "orders.assign-picker");
    const orderIds = Array.isArray(input.orderIds)
      ? [...new Set(input.orderIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()))]
      : [];
    if (!orderIds.length) throw new BadRequestException("Choose at least one order to reassign.");
    if (orderIds.length > BATCH_REASSIGN_LIMIT) throw new BadRequestException(`Reassign at most ${BATCH_REASSIGN_LIMIT} orders at a time.`);
    // Checked once up front so a missing reason or person fails the whole
    // request instead of failing every order with the same message.
    requireReassignReason(input.reason);
    await this.requireEmployee(input.employeeId);

    const results: Array<{ orderId: string; orderNumber: string | null; ok: boolean; role?: "picker" | "packer"; error?: string }> = [];
    for (const orderId of orderIds) {
      let orderNumber: string | null = null;
      try {
        await this.assertOrderInStoreScope(orderId, input.adminUserId);
        const order = await this.requireOrderWithTask(orderId);
        orderNumber = order.orderNumber;
        const status = order.fulfillment!.status;
        const role = status === FulfillmentStatus.READY_TO_PACK ? "packer" : "picker";
        const actor = await this.adminForPermission(input.adminUserId, role === "packer" ? "orders.assign-packer" : "orders.assign-picker");
        await this.reassignWorker(orderId, input, actor, role, order);
        results.push({ orderId, orderNumber, ok: true, role });
      } catch (caught) {
        results.push({ orderId, orderNumber, ok: false, error: errorMessage(caught) });
      }
    }
    const succeeded = results.filter((row) => row.ok).length;
    return { total: results.length, succeeded, failed: results.length - succeeded, results };
  }

  private async reassignWorker(
    orderId: string,
    input: ReassignInput,
    actor: Pick<EventInput, "actorAdminUserId" | "actorEmployeeId">,
    role: "picker" | "packer",
    loaded?: OrderDetail
  ) {
    const reason = requireReassignReason(input.reason);
    const employee = await this.requireEmployee(input.employeeId);
    const order = loaded ?? await this.requireOrderWithTask(orderId);
    const fulfillment = order.fulfillment!;
    const picker = role === "picker";
    const allowed: FulfillmentStatus[] = picker
      ? [FulfillmentStatus.PAID, FulfillmentStatus.PICKING]
      : [FulfillmentStatus.READY_TO_PACK];
    if (!allowed.includes(fulfillment.status)) {
      throw new BadRequestException(picker
        ? `Only an order waiting to be picked or being picked can change picker; this one is ${fulfillment.status}.`
        : `Only a parcel waiting to be packed can change packer; this one is ${fulfillment.status}.`);
    }
    const previousId = picker ? fulfillment.assignedPickerEmployeeId : fulfillment.assignedPackerEmployeeId;
    const previousName = (picker ? fulfillment.assignedPicker?.name : fulfillment.assignedPacker?.name) ?? null;
    // Already theirs: nothing to move and nothing to write.
    if (previousId === employee.id && (picker || !fulfillment.packingStartedAt || fulfillment.packingStartedByEmployeeId === employee.id)) return;
    const verified = fulfillment.items.filter((item) => item.status === FulfillmentItemStatus.VERIFIED).length;

    await prisma.$transaction(async (tx) => {
      await lockReservationOrder(tx, orderId);
      const current = await tx.orderFulfillment.findUnique({ where: { id: fulfillment.id } });
      if (!current) throw new NotFoundException("Fulfillment was not found.");
      const currentId = picker ? current.assignedPickerEmployeeId : current.assignedPackerEmployeeId;
      if (current.status !== fulfillment.status || currentId !== previousId) {
        throw new ConflictException("This order changed while you were reassigning it. Refresh and try again.");
      }
      const data: Prisma.OrderFulfillmentUncheckedUpdateInput = picker
        ? { assignedPickerEmployeeId: employee.id }
        : {
            assignedPackerEmployeeId: employee.id,
            // The start time stays; the person packing it is now the new packer.
            ...(current.packingStartedAt ? { packingStartedByEmployeeId: employee.id } : {})
          };
      await tx.orderFulfillment.update({ where: { id: fulfillment.id }, data });
      const progress = picker ? `已核对 ${verified}/${fulfillment.items.length} 件，保留不重扫` : current.packingStartedAt ? "已开始打包，开始时间保留" : "尚未开始打包";
      await this.createEvent(tx, {
        // No idempotency key: moving A → B → A → B is four facts, not one.
        fulfillmentId: fulfillment.id,
        orderId,
        ...actor,
        relatedEmployeeId: employee.id,
        action: picker ? "REASSIGN_PICKER" : "REASSIGN_PACKER",
        oldStatus: current.status,
        newStatus: current.status,
        note: `${previousName ?? "未分配"} → ${employee.name} · 原因：${reason} · ${progress}`
      });
      await tx.auditLog.create({
        data: {
          actorType: ActorType.EMPLOYEE,
          actorId: actor.actorEmployeeId ?? null,
          actorAdminUserId: actor.actorAdminUserId ?? null,
          sourceApp: SourceApp.OPERATIONS,
          module: "ORDERS",
          entityType: "OrderFulfillment",
          entityId: fulfillment.id,
          action: picker ? "REASSIGN_PICKER" : "REASSIGN_PACKER",
          beforeJson: { orderId, employeeId: previousId, employeeName: previousName, status: current.status, verifiedItems: verified },
          afterJson: { orderId, employeeId: employee.id, employeeName: employee.name, status: current.status, verifiedItems: verified },
          reason
        }
      });
    });
  }

  /**
   * 无码补登: a super admin records that a parcel already reached its customer
   * although nobody read out the pickup or delivery code — staff handed it over
   * in person, or the customer took it and lost the code.
   *
   * It is the only way to complete without a code, and it is narrow on purpose:
   * the SUPER_ADMIN role itself (not a permission that could be granted to a
   * store), a reason, a written note, and a parcel that is sealed and paid for.
   * It then goes through the same completion as a coded handover — stock marked
   * delivered, completedAt set, the customer told — so commission is confirmed
   * as usual. The customer-code timestamp stays empty, which is what tells this
   * completion apart from a coded one everywhere it is looked up.
   */
  async completeWithoutCode(orderId: string, input: CodelessCompletionInput) {
    const actor = await this.superAdminActor(input.adminUserId);
    const reasonCode = input.reasonCode?.trim() as CodelessCompletionReason | undefined;
    if (!reasonCode || !Object.prototype.hasOwnProperty.call(CODELESS_COMPLETION_REASONS, reasonCode)) {
      throw new BadRequestException("Choose why the order is completed without the customer's code.");
    }
    const note = input.note?.trim() ?? "";
    if (note.length < CODELESS_COMPLETION_NOTE_MIN_LENGTH) {
      throw new BadRequestException(`Write what happened (at least ${CODELESS_COMPLETION_NOTE_MIN_LENGTH} characters) before completing without a code.`);
    }
    const order = await this.requireOrderWithTask(orderId);
    const fulfillment = order.fulfillment!;
    if (fulfillment.status === FulfillmentStatus.COMPLETED) return this.orderDetail(orderId, input.adminUserId);
    if (!canCompleteWithoutCode(fulfillment.status)) {
      throw new BadRequestException(`An order at ${fulfillment.status} cannot be completed without a code. It has to be packed first, and a failed delivery has to come back to its node.`);
    }
    const reasonLabel = CODELESS_COMPLETION_REASONS[reasonCode];
    const pickup = order.fulfillmentMethod === FulfillmentMethod.PICKUP;
    await this.completeOrder(order, actor, CODELESS_COMPLETION_ACTION, `无码补登 · ${reasonLabel} · ${note}`, pickup
      ? { pickupConfirmedByEmployeeId: actor.actorEmployeeId, pickupNote: `无码补登：${note}` }
      : { deliveryCompletionMethod: DeliveryCompletionMethod.HANDED_TO_CUSTOMER },
    {
      customerCodeVerified: false,
      codeless: { reasonCode, reasonLabel, note, fromStatus: fulfillment.status }
    });
    return this.orderDetail(orderId, input.adminUserId);
  }

  /** The SUPER_ADMIN role, checked by its code rather than by any permission. */
  private async superAdminActor(adminUserId: string | undefined) {
    const session = await this.access.session(adminUserId);
    if (!session.adminUser || !isSuperAdminSession(session)) {
      throw new ForbiddenException("Only a super admin can complete an order without the customer's code.");
    }
    return {
      actorAdminUserId: session.adminUser.id,
      actorEmployeeId: session.adminUser.linkedEmployee?.id ?? null
    };
  }

  async claimPicking(orderId: string, input: AdminInput) {
    const actor = await this.employeeForPermission(input.adminUserId, "orders.pick");
    const order = await this.requireOrderWithTask(orderId);
    const fulfillment = order.fulfillment!;
    if (fulfillment.status === FulfillmentStatus.PICKING && fulfillment.assignedPickerEmployeeId === actor.actorEmployeeId) {
      return this.orderDetail(orderId, input.adminUserId);
    }
    if (fulfillment.assignedPickerEmployeeId && fulfillment.assignedPickerEmployeeId !== actor.actorEmployeeId) {
      throw new ForbiddenException("This picking task is assigned to another employee.");
    }
    this.assertTransition(order, FulfillmentStatus.PICKING);
    await prisma.$transaction(async (tx) => {
      await tx.order.updateMany({ where: { id: orderId, status: OrderStatus.PAID }, data: { status: OrderStatus.FULFILLING } });
      await tx.orderFulfillment.update({
        where: { id: fulfillment.id },
        data: { status: FulfillmentStatus.PICKING, assignedPickerEmployeeId: actor.actorEmployeeId }
      });
      await this.createEvent(tx, {
        idempotencyKey: `transition:${fulfillment.id}:${FulfillmentStatus.PICKING}`,
        fulfillmentId: fulfillment.id,
        orderId,
        ...actor,
        relatedEmployeeId: actor.actorEmployeeId,
        action: fulfillment.assignedPickerEmployeeId ? "START_PICKING" : "CLAIM_PICKING_TASK",
        oldStatus: fulfillment.status,
        newStatus: FulfillmentStatus.PICKING,
        note: input.note
      });
    });
    return this.orderDetail(orderId, input.adminUserId);
  }

  async scanItem(orderId: string, orderItemId: string, input: ScanInput) {
    const actor = await this.employeeForPermission(input.adminUserId, "orders.pick");
    let order = await this.requireOrderWithTask(orderId);
    let fulfillment = order.fulfillment!;
    if (fulfillment.assignedPickerEmployeeId && fulfillment.assignedPickerEmployeeId !== actor.actorEmployeeId) {
      throw new ForbiddenException("This picking task is assigned to another employee.");
    }
    // The scan is the claim. A picker who has the garment in their hand has
    // already started the task; a separate "claim" press before the first scan
    // only exists in the software, and a shared claim-everything button is how
    // one person ends up owning nineteen orders they are not picking.
    if (fulfillment.status === FulfillmentStatus.PAID && !fulfillment.assignedPickerEmployeeId) {
      await this.claimPicking(orderId, { adminUserId: input.adminUserId });
      order = await this.requireOrderWithTask(orderId);
      fulfillment = order.fulfillment!;
    }
    if (fulfillment.status !== FulfillmentStatus.PICKING) throw new BadRequestException("Only an active picking task accepts barcode scans.");
    const fulfillmentItem = fulfillment.items.find((item) => item.orderItemId === orderItemId);
    const orderItem = order.items.find((item) => item.id === orderItemId);
    if (!fulfillmentItem || !orderItem) throw new NotFoundException("Order item was not found in this picking task.");
    const inventoryItem = await prisma.inventoryItem.findUnique({
      where: { productId: orderItem.productId },
      include: { location: true }
    });
    const expectedBarcode = fulfillmentItem.expectedBarcode || orderItem.snapshot?.barcode || inventoryItem?.barcode || null;
    const check = verifyFulfillmentItemBarcode({
      orderItemId,
      expectedBarcode,
      scannedBarcode: input.barcode ?? "",
      productName: orderItem.snapshot?.title ?? "Unnamed product",
      locationCode: inventoryItem?.location?.locationCode ?? null
    });
    if (!check.ok) {
      await prisma.$transaction((tx) => this.createEvent(tx, {
        fulfillmentId: fulfillment.id,
        orderId,
        ...actor,
        orderItemId,
        action: "BARCODE_REJECTED",
        oldStatus: fulfillment.status,
        newStatus: fulfillment.status,
        note: input.note,
        expectedBarcode: check.expectedBarcode,
        scannedBarcode: check.actualBarcode,
        exceptionReason: FulfillmentExceptionReason.BARCODE_MISMATCH
      }));
      throw new BadRequestException({
        message: "Barcode does not match the selected order item.",
        expectedBarcode: check.expectedBarcode,
        actualBarcode: check.actualBarcode,
        productName: check.productName,
        locationCode: check.locationCode
      });
    }
    if (fulfillmentItem.status === FulfillmentItemStatus.VERIFIED) return this.orderDetail(orderId, input.adminUserId);

    await prisma.$transaction(async (tx) => {
      await lockReservationOrder(tx, orderId);
      const current = await tx.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });
      if (!current) throw new NotFoundException("Order was not found.");
      if ((current.status !== OrderStatus.PAID && current.status !== OrderStatus.FULFILLING) || current.fulfillment?.status !== FulfillmentStatus.PICKING) {
        throw new ConflictException("Picking task changed. Refresh before scanning another item.");
      }
      if (current.fulfillment.assignedPickerEmployeeId && current.fulfillment.assignedPickerEmployeeId !== actor.actorEmployeeId) {
        throw new ForbiddenException("This picking task is assigned to another employee.");
      }
      const currentItem = current.fulfillment.items.find((item) => item.orderItemId === orderItemId);
      if (!currentItem) throw new NotFoundException("Order item was not found in this picking task.");
      if (currentItem.status === FulfillmentItemStatus.VERIFIED) return;
      await tx.fulfillmentItem.update({
        where: { orderItemId },
        data: {
          status: FulfillmentItemStatus.VERIFIED,
          scannedBarcode: check.normalizedBarcode,
          verifiedByEmployeeId: actor.actorEmployeeId,
          verifiedAt: new Date()
        }
      });
      await this.createEvent(tx, {
        idempotencyKey: `scan:${fulfillment.id}:${orderItemId}`,
        fulfillmentId: fulfillment.id,
        orderId,
        ...actor,
        relatedEmployeeId: actor.actorEmployeeId,
        orderItemId,
        action: "ITEM_BARCODE_VERIFIED",
        oldStatus: fulfillment.status,
        newStatus: fulfillment.status,
        note: input.note,
        expectedBarcode,
        scannedBarcode: check.normalizedBarcode
      });
      const remaining = await tx.fulfillmentItem.count({
        where: { fulfillmentId: fulfillment.id, status: FulfillmentItemStatus.PENDING }
      });
      if (remaining === 0) {
        await this.assertOwnedInventory(tx, orderId, current.items.length, InventoryItemStatus.PAID);
        const pickedInventory = await tx.inventoryItem.findMany({
          where: { productId: { in: order.items.map((item) => item.productId) } },
          select: { locationId: true }
        });
        await tx.orderFulfillment.update({
          where: { id: fulfillment.id },
          data: {
            status: FulfillmentStatus.READY_TO_PACK,
            pickedAt: new Date(),
            // The picker holds the trolley, so the parcel is theirs until somebody
            // says otherwise. Packing is assigned work — but leaving it assigned to
            // nobody would stop a one-person warehouse dead: they would pick a
            // trolley and then be told to ask a supervisor who is them. A
            // supervisor can still hand it to someone else before packing starts.
            assignedPackerEmployeeId: fulfillment.assignedPackerEmployeeId ?? actor.actorEmployeeId
          }
        });
        const changed = await tx.inventoryItem.updateMany({
          where: { productId: { in: current.items.map((item) => item.productId) }, status: InventoryItemStatus.PAID },
          data: { status: InventoryItemStatus.PICKED }
        });
        if (changed.count !== current.items.length) throw new ConflictException("Inventory changed before picking completed.");
        await refreshWarehouseLocationStatuses(
          tx,
          pickedInventory.map((item) => item.locationId ?? "")
        );
        await this.createEvent(tx, {
          idempotencyKey: `transition:${fulfillment.id}:${FulfillmentStatus.READY_TO_PACK}`,
          fulfillmentId: fulfillment.id,
          orderId,
          ...actor,
          relatedEmployeeId: actor.actorEmployeeId,
          action: "COMPLETE_PICKING",
          oldStatus: FulfillmentStatus.PICKING,
          newStatus: FulfillmentStatus.READY_TO_PACK,
          note: "All order item barcodes were verified."
        });
      }
    });
    return this.orderDetail(orderId, input.adminUserId);
  }

  /**
   * Hands a finished trolley to a named packer. Only a supervisor can do this,
   * and until they do the parcel belongs to nobody: packing is the last point
   * where what went into a bag can still be traced to a person, so it is not
   * left to whoever reaches it first.
   */
  async assignPacker(orderId: string, input: EmployeeInput) {
    const actor = await this.adminForPermission(input.adminUserId, "orders.assign-packer");
    const employee = await this.requireEmployee(input.employeeId);
    const order = await this.requireOrderWithTask(orderId);
    const fulfillment = order.fulfillment!;
    if (fulfillment.status !== FulfillmentStatus.READY_TO_PACK) {
      throw new BadRequestException("A packer can only be assigned to a trolley that is ready to pack.");
    }
    if (fulfillment.assignedPackerEmployeeId === employee.id) return this.orderDetail(orderId, input.adminUserId);
    if (fulfillment.packingStartedAt && fulfillment.packingStartedByEmployeeId !== employee.id) {
      throw new ConflictException("Packing has already started on this parcel. Resolve it as an exception instead of reassigning it.");
    }
    await prisma.$transaction(async (tx) => {
      await tx.orderFulfillment.update({ where: { id: fulfillment.id }, data: { assignedPackerEmployeeId: employee.id } });
      await this.createEvent(tx, {
        idempotencyKey: `assign-packer:${fulfillment.id}:${employee.id}:${fulfillment.assignedPackerEmployeeId ?? "unassigned"}`,
        fulfillmentId: fulfillment.id,
        orderId,
        ...actor,
        relatedEmployeeId: employee.id,
        action: "ASSIGN_PACKER",
        oldStatus: fulfillment.status,
        newStatus: fulfillment.status,
        note: input.note
      });
    });
    return this.orderDetail(orderId, input.adminUserId);
  }

  /**
   * A packer may only touch the parcel a supervisor gave them. Anyone holding
   * the assign permission is that supervisor and may pack directly — otherwise
   * a warehouse with nobody assigned yet could not pack at all.
   */
  private async assertPackerOwnsParcel(
    adminUserId: string | undefined,
    fulfillment: { assignedPackerEmployeeId: string | null },
    actorEmployeeId: string | null
  ) {
    const ownership = canWorkWarehouseTask({
      assignedEmployeeId: fulfillment.assignedPackerEmployeeId,
      actorEmployeeId,
      supervisor: await this.access.hasPermission(adminUserId, "orders.assign-packer"),
      unassignedIsOpen: false
    });
    if (ownership.allowed) return;
    throw new ForbiddenException(ownership.reason === "UNASSIGNED"
      ? "This parcel has not been assigned to anyone yet. Ask a supervisor to assign it to you."
      : "This parcel is assigned to another packer.");
  }

  async startPacking(orderId: string, input: EmployeeInput) {
    const actor = await this.employeeForPermission(input.adminUserId, "orders.pack");
    const packerId = input.employeeId?.trim() || actor.actorEmployeeId!;
    if (packerId !== actor.actorEmployeeId) await this.access.requirePermission(input.adminUserId, "orders.assign-packer");
    await this.requireEmployee(packerId);
    const order = await this.requireOrderWithTask(orderId);
    const fulfillment = order.fulfillment!;
    // Status first, ownership second. A parcel that is not ready to pack is not
    // ready for anyone, and answering "it is not assigned to you" to someone
    // whose real problem is an unfinished pick sends them to find a supervisor
    // who can do nothing for them.
    if (fulfillment.status !== FulfillmentStatus.READY_TO_PACK) throw new BadRequestException("Packing can start only after every item is verified.");
    await this.assertPackerOwnsParcel(input.adminUserId, fulfillment, actor.actorEmployeeId);
    if (fulfillment.packingStartedAt && fulfillment.packingStartedByEmployeeId === packerId) {
      return this.orderDetail(orderId, input.adminUserId);
    }
    await prisma.$transaction(async (tx) => {
      await tx.orderFulfillment.update({
        where: { id: fulfillment.id },
        data: {
          packingStartedAt: new Date(),
          packingStartedByEmployeeId: packerId,
          // A supervisor packing an unassigned parcel assigns it to whoever is
          // actually doing it, so the parcel is never worked by a ghost.
          ...(fulfillment.assignedPackerEmployeeId ? {} : { assignedPackerEmployeeId: packerId })
        }
      });
      await this.createEvent(tx, {
        idempotencyKey: `start-packing:${fulfillment.id}:${packerId}:${fulfillment.packingStartedByEmployeeId ?? "unassigned"}`,
        fulfillmentId: fulfillment.id,
        orderId,
        ...actor,
        relatedEmployeeId: packerId,
        action: "START_PACKING",
        oldStatus: fulfillment.status,
        newStatus: fulfillment.status,
        note: input.note
      });
    });
    return this.orderDetail(orderId, input.adminUserId);
  }

  async completePacking(orderId: string, input: PackingInput) {
    const actor = await this.employeeForPermission(input.adminUserId, "orders.pack");
    const order = await this.requireOrderWithTask(orderId);
    const fulfillment = order.fulfillment!;
    if (fulfillment.status === FulfillmentStatus.PACKED) return this.orderDetail(orderId, input.adminUserId);
    if (!fulfillment.packingStartedAt) throw new BadRequestException("Start packing before completing it.");
    await this.assertPackerOwnsParcel(input.adminUserId, fulfillment, actor.actorEmployeeId);
    this.assertTransition(order, FulfillmentStatus.PACKED);
    const packerId = input.employeeId?.trim() || fulfillment.packingStartedByEmployeeId || actor.actorEmployeeId!;
    if (packerId !== actor.actorEmployeeId) await this.access.requirePermission(input.adminUserId, "orders.assign-picker");
    await this.requireEmployee(packerId);
    const packagingMethod = input.packagingMethod && Object.values(PackagingMethod).includes(input.packagingMethod)
      ? input.packagingMethod
      : null;
    const packageCount = Number(input.packageCount);
    if (!packagingMethod) throw new BadRequestException("Packaging method must be Bag, Box, or Other.");
    if (!Number.isInteger(packageCount) || packageCount < 1) throw new BadRequestException("Package count must be at least one.");
    await prisma.$transaction(async (tx) => {
      await lockReservationOrder(tx, orderId);
      const current = await tx.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });
      if (!current) throw new NotFoundException("Order was not found.");
      if ((current.status !== OrderStatus.PAID && current.status !== OrderStatus.FULFILLING) ||
        current.fulfillment?.status !== FulfillmentStatus.READY_TO_PACK ||
        current.fulfillment.updatedAt.getTime() !== fulfillment.updatedAt.getTime()) {
        throw new ConflictException("Order or packing task changed. Refresh before completing packing.");
      }
      await this.assertOwnedInventory(tx, orderId, current.items.length, InventoryItemStatus.PICKED);
      // The package code is minted here, not when the parcel is sent, because
      // the label goes on the parcel and the parcel is sealed now. Minting it at
      // dispatch meant a packer had to press 发往门店 before the sticker existed
      // — recording that a parcel had left in order to be allowed to label it.
      //
      // It needs the destination, which is in the code. A delivery order that has
      // not been routed yet has none, so it keeps getting its code at dispatch
      // and the screens say to route it first. A placeholder would be worse than
      // nothing: `send-to-node` keeps an existing code, so a wrong one would
      // survive onto the shelf the store scans.
      const node = current.fulfillmentNode;
      const packageCode = current.fulfillment.packageCode
        || (node && requiresNodeTransit(node.type) ? buildPackageCode(current.orderNumber, node.code) : null);
      await tx.orderFulfillment.update({
        where: { id: fulfillment.id },
        data: {
          status: FulfillmentStatus.PACKED,
          packedByEmployeeId: packerId,
          packedAt: new Date(),
          packagingMethod,
          packageCount,
          packingStatus: packagingMethod,
          packingNote: input.note?.trim() || null,
          ...(packageCode ? { packageCode } : {}),
          // The sticker names a node, so from here on the record has to name the
          // same one. Re-routing writes both fields together; this is the other
          // way the two could drift apart.
          ...(node ? { fulfillmentNodeId: node.id } : {})
        }
      });
      const changed = await tx.inventoryItem.updateMany({
        where: { productId: { in: current.items.map((item) => item.productId) }, status: InventoryItemStatus.PICKED },
        data: { status: InventoryItemStatus.PACKED }
      });
      if (changed.count !== current.items.length) throw new ConflictException("Inventory changed before packing completed.");
      await this.createEvent(tx, {
        idempotencyKey: `transition:${fulfillment.id}:${FulfillmentStatus.PACKED}`,
        fulfillmentId: fulfillment.id,
        orderId,
        ...actor,
        relatedEmployeeId: packerId,
        action: "COMPLETE_PACKING",
        oldStatus: fulfillment.status,
        newStatus: FulfillmentStatus.PACKED,
        note: input.note
      });
    });
    return this.orderDetail(orderId, input.adminUserId);
  }

  async readyForPickup(orderId: string, input: AdminInput) {
    // The warehouse shelves its own pickups (orders.pack); a store shelves the
    // parcels it signed for. Store staff hold orders.complete, not orders.pack,
    // and were refused the step that comes before the one they are allowed —
    // handing the parcel over against the customer's pickup code.
    const actor = await this.employeeForAnyPermission(input.adminUserId, ["orders.pack", "orders.complete"]);
    return this.moveToHandoff(orderId, input, actor, FulfillmentStatus.READY_FOR_PICKUP, "READY_FOR_PICKUP", {
      readyForPickupAt: new Date()
    });
  }

  async readyForDispatch(orderId: string, input: AdminInput) {
    const actor = await this.adminForPermission(input.adminUserId, "orders.assign-rider");
    return this.moveToHandoff(orderId, input, actor, FulfillmentStatus.READY_FOR_DISPATCH, "READY_FOR_DISPATCH", {
      readyForDispatchAt: new Date()
    });
  }

  async assignRider(orderId: string, input: RiderInput) {
    const actor = await this.adminForPermission(input.adminUserId, "orders.assign-rider");
    const order = await this.requireOrderWithTask(orderId);
    const fulfillment = order.fulfillment!;
    if (order.fulfillmentMethod !== FulfillmentMethod.KIKUYU_LOCAL_DELIVERY) {
      throw new BadRequestException("Pickup orders cannot be assigned to a delivery rider.");
    }
    if (fulfillment.status !== FulfillmentStatus.READY_FOR_DISPATCH) {
      throw new BadRequestException("The order must be ready for dispatch before rider assignment.");
    }
    // Every assignment chooses the pay again, a re-assignment included: the
    // fee belongs to the rider who is given the parcel, not to the order.
    const riderFeeKsh = requireRiderFee(input.riderFeeKsh);
    const riderType = input.riderType && Object.values(DeliveryRiderType).includes(input.riderType) ? input.riderType : null;
    if (!riderType) throw new BadRequestException("Rider type is required.");
    const rider = riderType === DeliveryRiderType.INTERNAL
      ? await this.internalRider(input.employeeId)
      : await this.externalRider(input);
    const estimatedDeliveryAt = input.estimatedDeliveryAt ? new Date(input.estimatedDeliveryAt) : null;
    if (estimatedDeliveryAt && Number.isNaN(estimatedDeliveryAt.getTime())) throw new BadRequestException("Estimated delivery time is invalid.");
    const latest = fulfillment.deliveryAssignments[0];
    if (
      fulfillment.deliveryRiderId === rider.id
      && fulfillment.riderFeeKsh === riderFeeKsh
      && latest?.estimatedDeliveryAt?.getTime() === estimatedDeliveryAt?.getTime()
      && (latest?.note ?? "") === (input.note?.trim() ?? "")
    ) return this.orderDetail(orderId, input.adminUserId);

    await prisma.$transaction(async (tx) => {
      await tx.deliveryAssignment.create({
        data: {
          fulfillmentId: fulfillment.id,
          orderId,
          deliveryRiderId: rider.id,
          assignedByAdminUserId: actor.actorAdminUserId,
          estimatedDeliveryAt,
          note: input.note?.trim() || null
        }
      });
      await tx.orderFulfillment.update({
        where: { id: fulfillment.id },
        data: {
          deliveryRiderId: rider.id,
          deliveryRiderName: rider.name,
          deliveryRiderPhone: rider.phone,
          riderFeeKsh,
          riderFeeSetByEmployeeId: actor.actorEmployeeId
        }
      });
      await this.createEvent(tx, {
        idempotencyKey: `assign-rider:${fulfillment.id}:${latest?.id ?? "initial"}:${rider.id}:${riderFeeKsh}:${estimatedDeliveryAt?.toISOString() ?? "unscheduled"}:${input.note?.trim() ?? ""}`,
        fulfillmentId: fulfillment.id,
        orderId,
        ...actor,
        relatedEmployeeId: rider.employeeId,
        deliveryRiderId: rider.id,
        action: "ASSIGN_DELIVERY_RIDER",
        oldStatus: fulfillment.status,
        newStatus: fulfillment.status,
        note: [riderFeeNote(riderFeeKsh), input.note?.trim()].filter(Boolean).join(" · ")
      });
    });
    return this.orderDetail(orderId, input.adminUserId);
  }

  /**
   * The older two-step route, kept for the external-rider flow: a rider is
   * registered with `assignRider`, then the handover is confirmed here. It goes
   * through the same step as one-tap dispatch, so it mints and texts a delivery
   * code too rather than leaving an uncompletable order behind.
   */
  async dispatch(orderId: string, input: DispatchInput) {
    const actor = await this.employeeForPermission(input.adminUserId, "orders.dispatch");
    const order = await this.requireOrderWithTask(orderId);
    const fulfillment = order.fulfillment!;
    if (fulfillment.status === FulfillmentStatus.OUT_FOR_DELIVERY) return this.orderDetail(orderId, input.adminUserId);
    this.assertTransition(order, FulfillmentStatus.OUT_FOR_DELIVERY);
    const rider = fulfillment.deliveryRider;
    if (!rider) throw new BadRequestException("Assign a rider before confirming the handover.");
    // The fee chosen when the rider was assigned stands. A rider assigned before
    // fees existed has none, and the parcel does not leave until one is chosen.
    const sentFee = input.riderFeeKsh !== undefined && input.riderFeeKsh !== null && input.riderFeeKsh !== "";
    const riderFee = sentFee
      ? { ksh: requireRiderFee(input.riderFeeKsh), setByEmployeeId: actor.actorEmployeeId }
      : { ksh: requireRiderFee(fulfillment.riderFeeKsh), setByEmployeeId: fulfillment.riderFeeSetByEmployeeId ?? null };
    const latest = fulfillment.deliveryAssignments[0];
    await this.handToRider(order, rider, actor, input.note, latest?.estimatedDeliveryAt ?? null, riderFee);
    return this.orderDetail(orderId, input.adminUserId);
  }

  /**
   * Customer pickup. The customer reads out the pickup code they were texted;
   * the order number and phone number are no longer proof on their own, because
   * both are printed on the package sitting on the counter.
   */
  async confirmPickup(orderId: string, input: PickupInput) {
    const actor = await this.employeeForPermission(input.adminUserId, "orders.complete");
    const order = await this.requireOrderWithTask(orderId);
    const fulfillment = order.fulfillment!;
    if (fulfillment.status === FulfillmentStatus.COMPLETED) return this.orderDetail(orderId, input.adminUserId);
    if (order.fulfillmentMethod !== FulfillmentMethod.PICKUP) throw new BadRequestException("Delivery orders cannot be completed as pickup.");

    await this.consumePickupCode(order, input.verificationValue, { actorAdminUserId: actor.actorAdminUserId });
    await this.completeOrder(order, actor, "CONFIRM_CUSTOMER_PICKUP", input.note, {
      pickupConfirmedByEmployeeId: actor.actorEmployeeId,
      pickupVerificationMethod: PickupVerificationMethod.PICKUP_CODE,
      // The code itself is not kept; only the fact that it matched.
      pickupVerificationValue: "VERIFIED",
      pickupNote: input.note?.trim() || null,
      customerCodeVerifiedAt: new Date()
    }, { customerCodeVerified: true });
    return this.orderDetail(orderId, input.adminUserId);
  }

  /**
   * Completing a delivery from an operations screen rather than the rider's
   * phone. It still needs the customer's code: a store or an admin recognising
   * the buyer is not a substitute for the customer reading out four digits.
   */
  async completeDelivery(orderId: string, input: DeliveryCodeInput) {
    const actor = await this.employeeForPermission(input.adminUserId, "orders.complete");
    const order = await this.requireOrderWithTask(orderId);
    if (order.fulfillment?.status === FulfillmentStatus.COMPLETED) return this.orderDetail(orderId, input.adminUserId);
    if (order.fulfillmentMethod !== FulfillmentMethod.KIKUYU_LOCAL_DELIVERY) {
      throw new BadRequestException("Pickup orders cannot be completed as delivery.");
    }
    await this.consumeDeliveryCode(order, input.code, { actorAdminUserId: actor.actorAdminUserId });
    await this.completeOrder(order, actor, "CONFIRM_DELIVERY", input.note, {
      deliveryCompletionMethod: DeliveryCompletionMethod.HANDED_TO_CUSTOMER,
      customerCodeVerifiedAt: new Date()
    }, { customerCodeVerified: true });
    return this.orderDetail(orderId, input.adminUserId);
  }

  /**
   * The store hands a package to one of its own riders. Everything the flow
   * needs happens in one transaction -- rider assigned, code minted, status
   * moved, SMS queued, event written -- so a crash halfway cannot leave a
   * package out for delivery with no code the customer could ever read out.
   */
  async dispatchToRider(orderId: string, input: DispatchToRiderInput) {
    const actor = await this.employeeForPermission(input.adminUserId, "orders.dispatch");
    const order = await this.requireOrderWithTask(orderId);
    const fulfillment = order.fulfillment!;
    if (order.fulfillmentMethod !== FulfillmentMethod.KIKUYU_LOCAL_DELIVERY) {
      throw new BadRequestException("Pickup orders are not dispatched to a rider.");
    }
    // A second tap on Dispatch must not mint a second code or send a second SMS.
    if (fulfillment.status === FulfillmentStatus.OUT_FOR_DELIVERY) return this.orderDetail(orderId, input.adminUserId);
    if (fulfillment.status !== FulfillmentStatus.ARRIVED_AT_NODE && fulfillment.status !== FulfillmentStatus.READY_FOR_DISPATCH) {
      throw new BadRequestException("The package has to be received at its node before it goes out for delivery.");
    }
    await this.employeeBelongsToNode(actor.actorEmployeeId, fulfillment.fulfillmentNodeId);

    const rider = await this.requireNodeRider(input.deliveryRiderId, fulfillment.fulfillmentNodeId);
    const riderFeeKsh = requireRiderFee(input.riderFeeKsh);
    const estimatedDeliveryAt = input.estimatedDeliveryAt ? validDate(input.estimatedDeliveryAt, "Estimated delivery time") : null;
    await this.handToRider(order, rider, actor, input.note, estimatedDeliveryAt, { ksh: riderFeeKsh, setByEmployeeId: actor.actorEmployeeId });
    return this.orderDetail(orderId, input.adminUserId);
  }

  /**
   * Hands a package to a rider: assign, mint the code, move the status, text the
   * customer, write the event -- all or nothing.
   *
   * Both dispatch routes come through here. That matters: an order that reached
   * OUT_FOR_DELIVERY without a code could never be completed, because completion
   * needs one, so a second route that skipped this step would strand a paid order
   * with nobody able to close it.
   */
  private async handToRider(
    order: OrderDetail,
    rider: { id: string; name: string; phone: string | null; employeeId: string | null },
    actor: Pick<EventInput, "actorAdminUserId" | "actorEmployeeId">,
    note: string | undefined,
    estimatedDeliveryAt: Date | null,
    riderFee: { ksh: number; setByEmployeeId: string | null }
  ) {
    const fulfillment = order.fulfillment!;
    const attempt = fulfillment.deliveryAttemptCount + 1;
    const code = generateCustomerCode();

    await prisma.$transaction(async (tx) => {
      // Re-read under the row lock: two store screens dispatching at once must
      // not both get past the status check above.
      await lockReservationOrder(tx, order.id);
      const current = await tx.orderFulfillment.findUnique({ where: { id: fulfillment.id } });
      if (!current) throw new NotFoundException("Fulfillment was not found.");
      if (current.status === FulfillmentStatus.OUT_FOR_DELIVERY) return;
      if (current.status !== FulfillmentStatus.ARRIVED_AT_NODE && current.status !== FulfillmentStatus.READY_FOR_DISPATCH) {
        throw new ConflictException("This package moved before dispatch. Refresh and scan it again.");
      }

      if (current.status === FulfillmentStatus.ARRIVED_AT_NODE) {
        await tx.orderFulfillment.update({
          where: { id: fulfillment.id },
          data: { status: FulfillmentStatus.READY_FOR_DISPATCH, readyForDispatchAt: current.readyForDispatchAt ?? new Date() }
        });
        await this.createEvent(tx, {
          idempotencyKey: `transition:${fulfillment.id}:${FulfillmentStatus.READY_FOR_DISPATCH}:${attempt}`,
          fulfillmentId: fulfillment.id,
          orderId: order.id,
          ...actor,
          action: "READY_FOR_DISPATCH",
          oldStatus: current.status,
          newStatus: FulfillmentStatus.READY_FOR_DISPATCH
        });
      }

      await tx.deliveryAssignment.create({
        data: {
          fulfillmentId: fulfillment.id,
          orderId: order.id,
          deliveryRiderId: rider.id,
          assignedByAdminUserId: actor.actorAdminUserId ?? null,
          estimatedDeliveryAt,
          note: note?.trim() || null
        }
      });
      await tx.orderFulfillment.update({
        where: { id: fulfillment.id },
        data: {
          status: FulfillmentStatus.OUT_FOR_DELIVERY,
          deliveryRiderId: rider.id,
          deliveryRiderName: rider.name,
          deliveryRiderPhone: rider.phone,
          riderFeeKsh: riderFee.ksh,
          riderFeeSetByEmployeeId: riderFee.setByEmployeeId,
          dispatchedByEmployeeId: actor.actorEmployeeId,
          dispatchedAt: new Date(),
          outForDeliveryAt: new Date(),
          deliveryAttemptCount: attempt,
          // A new attempt gets a new code and a clean attempt budget; the old
          // code dies the moment this hash is overwritten.
          deliveryCodeHash: hashCustomerCode(code),
          deliveryCode: code,
          deliveryCodeIssuedAt: new Date(),
          deliveryCodeSentCount: { increment: 1 },
          customerCodeVerifiedAt: null,
          customerCodeFailedAttempts: 0,
          customerCodeLockedAt: null,
          deliveryFailureReason: null,
          deliveryFailureNote: null,
          deliveryFailedAt: null,
          returningToNodeAt: null,
          ...this.holderData({
            status: FulfillmentStatus.OUT_FOR_DELIVERY,
            deliveryRiderId: rider.id,
            riderName: rider.name
          })
        }
      });
      await this.createEvent(tx, {
        idempotencyKey: `dispatch-rider:${fulfillment.id}:${attempt}`,
        fulfillmentId: fulfillment.id,
        orderId: order.id,
        ...actor,
        relatedEmployeeId: rider.employeeId,
        deliveryRiderId: rider.id,
        action: "DISPATCH_TO_RIDER",
        oldStatus: FulfillmentStatus.READY_FOR_DISPATCH,
        newStatus: FulfillmentStatus.OUT_FOR_DELIVERY,
        note: `Handed to ${rider.name} · ${riderFeeNote(riderFee.ksh)}; delivery code sent to the customer (attempt ${attempt}).`
      });
      await this.queueCustomerNotification(tx, order.id, "CUSTOMER_DELIVERY_CODE", {
        riderName: rider.name,
        deliveryCode: code,
        dedupeSuffix: `attempt-${attempt}`
      });
    });
  }

  /**
   * Sends the customer a code again when the first SMS never arrived.
   *
   * It is a new code, not the old one, because the old one is only stored as a
   * hash and nobody -- not this API, not customer service -- can read it back.
   * That is the point: a resend cannot leak the code to whoever asked for it.
   */
  async resendDeliveryCode(orderId: string, input: AdminInput) {
    const actor = await this.employeeForAnyPermission(input.adminUserId, ["orders.resend-code", "orders.dispatch", "orders.after-sale"]);
    const order = await this.requireOrderWithTask(orderId);
    const fulfillment = order.fulfillment!;
    if (fulfillment.status !== FulfillmentStatus.OUT_FOR_DELIVERY) {
      throw new BadRequestException("A delivery code can only be resent while the order is out for delivery.");
    }
    const code = generateCustomerCode();
    const sendCount = fulfillment.deliveryCodeSentCount + 1;
    await prisma.$transaction(async (tx) => {
      await tx.orderFulfillment.update({
        where: { id: fulfillment.id },
        data: {
          deliveryCodeHash: hashCustomerCode(code),
          deliveryCode: code,
          deliveryCodeIssuedAt: new Date(),
          deliveryCodeSentCount: sendCount,
          // Resending is also how a locked-out order is rescued.
          customerCodeFailedAttempts: 0,
          customerCodeLockedAt: null
        }
      });
      await this.createEvent(tx, {
        idempotencyKey: `resend-code:${fulfillment.id}:${sendCount}`,
        fulfillmentId: fulfillment.id,
        orderId: order.id,
        ...actor,
        deliveryRiderId: fulfillment.deliveryRiderId,
        action: "RESEND_DELIVERY_CODE",
        oldStatus: fulfillment.status,
        newStatus: fulfillment.status,
        note: input.note?.trim() || "A new delivery code replaced the previous one and was sent to the customer."
      });
      await this.queueCustomerNotification(tx, order.id, "CUSTOMER_DELIVERY_CODE", {
        riderName: fulfillment.deliveryRiderName,
        deliveryCode: code,
        dedupeSuffix: `send-${sendCount}`
      });
    });
    return this.orderDetail(orderId, input.adminUserId);
  }

  /**
   * Authorized drop-off: the customer is not there but agreed to the package
   * being left with security, at reception or at the door. It needs both a photo
   * of where it was left and the customer's code, because the code read out over
   * the phone is what makes it the customer's decision rather than the rider's.
   */
  async completeAuthorizedDropOff(orderId: string, input: DropOffInput, rider: RiderActor) {
    const order = await this.requireOrderWithTask(orderId);
    const fulfillment = order.fulfillment!;
    if (order.fulfillmentMethod !== FulfillmentMethod.KIKUYU_LOCAL_DELIVERY) {
      throw new BadRequestException("Only delivery orders can be dropped off.");
    }
    if (fulfillment.deliveryRiderId !== rider.id) throw new ForbiddenException("This delivery is assigned to another rider.");
    if (fulfillment.status === FulfillmentStatus.COMPLETED) return this.riderDeliveryView(order);

    // The photo is stored first: a valid code with no proof of where the package
    // was left is exactly the gap this rule exists to close.
    const photoObject = await this.storeDropOffPhoto(order.id, fulfillment.id, input);
    await this.consumeDeliveryCode(order, input.code, { deliveryRiderId: rider.id });

    const actor = { actorAdminUserId: null, actorEmployeeId: rider.employeeId };
    await this.completeOrder(order, actor, "AUTHORIZED_DROP_OFF", input.dropOffNote || input.note, {
      deliveryCompletionMethod: DeliveryCompletionMethod.AUTHORIZED_DROP_OFF,
      dropOffPhotoObject: photoObject,
      dropOffNote: input.dropOffNote?.trim() || null,
      customerCodeVerifiedAt: new Date()
    }, { customerCodeVerified: true });
    return this.riderDeliveryView(await this.requireOrderWithTask(orderId));
  }

  /** A rider hands the package to the customer and closes the order. */
  async completeRiderDelivery(orderId: string, input: DeliveryCodeInput, rider: RiderActor) {
    const order = await this.requireOrderWithTask(orderId);
    const fulfillment = order.fulfillment!;
    if (order.fulfillmentMethod !== FulfillmentMethod.KIKUYU_LOCAL_DELIVERY) {
      throw new BadRequestException("Only delivery orders are completed by a rider.");
    }
    if (fulfillment.deliveryRiderId !== rider.id) throw new ForbiddenException("This delivery is assigned to another rider.");
    if (fulfillment.status === FulfillmentStatus.COMPLETED) return this.riderDeliveryView(order);

    await this.consumeDeliveryCode(order, input.code, { deliveryRiderId: rider.id });
    await this.completeOrder(order, { actorAdminUserId: null, actorEmployeeId: rider.employeeId }, "CONFIRM_DELIVERY", input.note, {
      deliveryCompletionMethod: DeliveryCompletionMethod.HANDED_TO_CUSTOMER,
      customerCodeVerifiedAt: new Date()
    }, { customerCodeVerified: true });
    return this.riderDeliveryView(await this.requireOrderWithTask(orderId));
  }

  /**
   * The rider could not hand the package over. The order is never cancelled:
   * the customer has paid, so the package comes back and waits for another try.
   */
  async markDeliveryFailed(orderId: string, input: DeliveryFailureInput, rider?: RiderActor) {
    const actor = rider
      ? { actorAdminUserId: null, actorEmployeeId: rider.employeeId }
      : await this.employeeForAnyPermission(input.adminUserId, ["orders.dispatch", "orders.complete"]);
    const order = await this.requireOrderWithTask(orderId);
    const fulfillment = order.fulfillment!;
    if (rider && fulfillment.deliveryRiderId !== rider.id) throw new ForbiddenException("This delivery is assigned to another rider.");
    if (fulfillment.status === FulfillmentStatus.DELIVERY_FAILED) return this.orderDetail(orderId, input.adminUserId);
    this.assertTransition(order, FulfillmentStatus.DELIVERY_FAILED);
    const reason = input.reason && Object.values(DeliveryFailureReason).includes(input.reason)
      ? input.reason
      : DeliveryFailureReason.OTHER;

    await prisma.$transaction(async (tx) => {
      await tx.orderFulfillment.update({
        where: { id: fulfillment.id },
        data: {
          status: FulfillmentStatus.DELIVERY_FAILED,
          deliveryFailureReason: reason,
          deliveryFailureNote: input.note?.trim() || null,
          deliveryFailedAt: new Date(),
          // The code dies with the attempt. A retry gets a fresh one.
          deliveryCodeHash: null,
          deliveryCode: null,
          customerCodeFailedAttempts: 0,
          customerCodeLockedAt: null,
          ...this.holderData({
            status: FulfillmentStatus.DELIVERY_FAILED,
            deliveryRiderId: fulfillment.deliveryRiderId,
            riderName: fulfillment.deliveryRiderName
          })
        }
      });
      await this.createEvent(tx, {
        idempotencyKey: `delivery-failed:${fulfillment.id}:${fulfillment.deliveryAttemptCount}`,
        fulfillmentId: fulfillment.id,
        orderId: order.id,
        ...actor,
        deliveryRiderId: fulfillment.deliveryRiderId,
        action: "DELIVERY_FAILED",
        oldStatus: fulfillment.status,
        newStatus: FulfillmentStatus.DELIVERY_FAILED,
        note: `${reason}${input.note?.trim() ? `: ${input.note.trim()}` : ""}`
      });
      await this.queueCustomerNotification(tx, order.id, "CUSTOMER_DELIVERY_FAILED", {
        reason: failureReasonLabel(reason),
        dedupeSuffix: `attempt-${fulfillment.deliveryAttemptCount}`
      });
      await this.queueAdminAlert(tx, order, "ADMIN_FULFILLMENT_EXCEPTION", `delivery failed - ${reason}`);
    });
    return this.orderDetail(orderId, input.adminUserId);
  }

  /** The rider sets off back to the store with the package still in hand. */
  async startReturnToNode(orderId: string, input: AdminInput, rider?: RiderActor) {
    const actor = rider
      ? { actorAdminUserId: null, actorEmployeeId: rider.employeeId }
      : await this.employeeForAnyPermission(input.adminUserId, ["orders.dispatch", "orders.node-receive"]);
    const order = await this.requireOrderWithTask(orderId);
    const fulfillment = order.fulfillment!;
    if (rider && fulfillment.deliveryRiderId !== rider.id) throw new ForbiddenException("This delivery is assigned to another rider.");
    if (fulfillment.status === FulfillmentStatus.RETURNING_TO_NODE) return this.orderDetail(orderId, input.adminUserId);
    this.assertTransition(order, FulfillmentStatus.RETURNING_TO_NODE);
    await this.moveWithEvent(order, FulfillmentStatus.RETURNING_TO_NODE, actor, "RETURN_TO_NODE_STARTED", input.note, {
      returningToNodeAt: new Date()
    });
    return this.orderDetail(orderId, input.adminUserId);
  }

  /** The store has the package back on the shelf and can dispatch it again. */
  async confirmReturnAtNode(orderId: string, input: AdminInput) {
    const actor = await this.employeeForPermission(input.adminUserId, "orders.node-receive");
    const order = await this.requireOrderWithTask(orderId);
    const fulfillment = order.fulfillment!;
    if (fulfillment.status === FulfillmentStatus.ARRIVED_AT_NODE) return this.orderDetail(orderId, input.adminUserId);
    await this.employeeBelongsToNode(actor.actorEmployeeId, fulfillment.fulfillmentNodeId);
    this.assertTransition(order, FulfillmentStatus.ARRIVED_AT_NODE);
    await this.moveWithEvent(order, FulfillmentStatus.ARRIVED_AT_NODE, actor, "RETURN_RECEIVED_AT_NODE", input.note, {
      arrivedAtNodeByEmployeeId: actor.actorEmployeeId,
      arrivedAtNodeAt: new Date(),
      // The package is the store's problem again, not the rider's.
      deliveryRiderId: null,
      deliveryRiderName: null,
      deliveryRiderPhone: null,
      // A failed attempt earns nothing, and the next hand-off chooses again.
      riderFeeKsh: null,
      riderFeeSetByEmployeeId: null
    });
    return this.orderDetail(orderId, input.adminUserId);
  }

  async markException(orderId: string, input: ExceptionInput) {
    const actor = await this.employeeForAnyPermission(input.adminUserId, ["orders.pick", "orders.pack", "orders.dispatch"]);
    const order = await this.requireOrderWithTask(orderId);
    const fulfillment = order.fulfillment!;
    const reason = input.reason && Object.values(FulfillmentExceptionReason).includes(input.reason)
      ? input.reason
      : FulfillmentExceptionReason.OTHER;
    if (fulfillment.status === FulfillmentStatus.EXCEPTION && fulfillment.exceptionReason === reason && fulfillment.exceptionNote === input.note?.trim()) {
      return this.orderDetail(orderId, input.adminUserId);
    }
    if (!canTransitionFulfillment({ from: fulfillment.status, to: FulfillmentStatus.EXCEPTION })) {
      throw new BadRequestException("A completed order cannot be moved to fulfillment exception.");
    }
    await prisma.$transaction(async (tx) => {
      await tx.orderFulfillment.update({
        where: { id: fulfillment.id },
        data: {
          status: FulfillmentStatus.EXCEPTION,
          exceptionReason: reason,
          exceptionNote: input.note?.trim() || null,
          // Keep the step the order was on so a resolved exception can rejoin it.
          exceptionFromStatus: fulfillment.status === FulfillmentStatus.EXCEPTION
            ? fulfillment.exceptionFromStatus
            : fulfillment.status,
          exceptionResolvedAt: null
        }
      });
      await this.queueAdminAlert(tx, order, "ADMIN_FULFILLMENT_EXCEPTION", `${reason}${input.note?.trim() ? `: ${input.note.trim()}` : ""}`);
      await this.createEvent(tx, {
        idempotencyKey: `exception:${fulfillment.id}:${fulfillment.status}:${reason}:${input.note?.trim() ?? ""}`,
        fulfillmentId: fulfillment.id,
        orderId,
        ...actor,
        action: "SUBMIT_EXCEPTION_FACT",
        oldStatus: fulfillment.status,
        newStatus: FulfillmentStatus.EXCEPTION,
        note: input.note,
        exceptionReason: reason
      });
    });
    return this.orderDetail(orderId, input.adminUserId);
  }

  /**
   * Cancels an order that was never paid. The garment goes straight back on
   * sale: leaving the inventory row reserved, as this used to, took the item
   * out of circulation permanently because the expiry sweep skips an order that
   * is no longer waiting for payment.
   */
  async cancel(orderId: string, input: AdminInput) {
    const actor = await this.adminForPermission(input.adminUserId, "orders.cancel");
    await prisma.$transaction(async (tx) => {
      await lockReservationOrder(tx, orderId);
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: { fulfillment: true, payments: { where: { status: PaymentStatus.SUCCESS }, select: { id: true } } }
      });
      if (!order) throw new NotFoundException("Order was not found.");
      if (order.status === OrderStatus.CANCELLED) return;
      if (order.status === OrderStatus.COMPLETED || order.status === OrderStatus.REFUNDED || order.fulfillment?.status === FulfillmentStatus.COMPLETED) {
        throw new BadRequestException("Completed or refunded orders cannot be cancelled here.");
      }
      if (order.payments.length) {
        throw new BadRequestException("This order has been paid. Use write-off so the stock outcome and the refund are recorded.");
      }
      const reason = input.note?.trim() || "Order cancelled in the order centre.";
      const result = await closeUnpaidOrder(tx, orderId, actor.actorEmployeeId ?? null, reason);
      if (!result.changed) throw new ConflictException("Order state changed before cancellation. Refresh and try again.");
      if (order.fulfillment) {
        await tx.orderFulfillment.update({
          where: { id: order.fulfillment.id },
          data: {
            status: FulfillmentStatus.EXCEPTION,
            exceptionReason: FulfillmentExceptionReason.CUSTOMER_CANCELLED,
            exceptionNote: input.note?.trim() || null,
            exceptionFromStatus: order.fulfillment.status === FulfillmentStatus.EXCEPTION
              ? order.fulfillment.exceptionFromStatus
              : order.fulfillment.status
          }
        });
        await this.createEvent(tx, {
          idempotencyKey: `cancel:${order.fulfillment.id}`,
          fulfillmentId: order.fulfillment.id,
          orderId,
          ...actor,
          action: "CANCEL_ORDER",
          oldStatus: order.fulfillment.status,
          newStatus: FulfillmentStatus.EXCEPTION,
          note: input.note,
          exceptionReason: FulfillmentExceptionReason.CUSTOMER_CANCELLED
        });
      }
    });
    return this.orderDetail(orderId, input.adminUserId);
  }

  async assignAfterSale(orderId: string, input: AfterSaleInput) {
    const actor = await this.adminForPermission(input.adminUserId, "orders.after-sale");
    const employee = await this.requireEmployee(input.employeeId);
    const status = input.status && Object.values(CustomerServiceCaseStatus).includes(input.status) ? input.status : undefined;
    await prisma.$transaction(async (tx) => {
      // Share the order lock with case mutations, returns and commission transitions.
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
      const order = await tx.order.findUnique({ where: { id: orderId }, include: { fulfillment: true } });
      if (!order) throw new NotFoundException("Order was not found.");
      const fulfillment = order.fulfillment;
      if (!fulfillment) throw new BadRequestException("After-sale ownership requires an order fulfillment record.");
      const existingCase = input.caseId ? await tx.customerServiceCase.findFirst({
        where: { id: input.caseId, orderId, issueType: CustomerServiceIssueType.AFTER_SALE },
        include: { afterSaleReturn: { select: { id: true } } }
      }) : null;
      if (input.caseId && !existingCase) throw new NotFoundException("After-sale case was not found for this order.");
      if (existingCase?.afterSaleReturn && [input.status, input.requiresReturn, input.requiresRefund, input.affectsAffiliateCommission].some((value) => value !== undefined)) {
        throw new BadRequestException("Use the return workflow to change this managed after-sale case status or return/refund flags.");
      }
      if (fulfillment.afterSaleOwnerEmployeeId === employee.id && !input.caseId) return;
      await tx.orderFulfillment.update({ where: { id: fulfillment.id }, data: { afterSaleOwnerEmployeeId: employee.id } });
      const updatedCase = existingCase ? await tx.customerServiceCase.update({
        where: { id: existingCase.id },
        data: {
          assignedEmployeeId: employee.id,
          ...(status ? { status } : {}),
          ...(input.afterSaleReason !== undefined ? { afterSaleReason: input.afterSaleReason.trim() || null } : {}),
          ...(input.customerRequest !== undefined ? { customerRequest: input.customerRequest.trim() || null } : {}),
          ...(input.requiresReturn !== undefined ? { requiresReturn: input.requiresReturn } : {}),
          ...(input.requiresRefund !== undefined ? { requiresRefund: input.requiresRefund } : {}),
          ...(input.affectsAffiliateCommission !== undefined ? { affectsAffiliateCommission: input.affectsAffiliateCommission } : {}),
          ...(status ? { resolvedAt: status === CustomerServiceCaseStatus.RESOLVED || status === CustomerServiceCaseStatus.CLOSED ? new Date() : null } : {})
        }
      }) : null;
      const action = input.caseId ? "UPDATE_AFTER_SALE_CASE" : "ASSIGN_AFTER_SALE_OWNER";
      await this.createEvent(tx, {
        idempotencyKey: `after-sale:${fulfillment.id}:${input.caseId ?? "order"}:${employee.id}:${status ?? "unchanged"}:${input.requiresReturn ?? "unchanged"}:${input.requiresRefund ?? "unchanged"}:${input.affectsAffiliateCommission ?? "unchanged"}:${input.afterSaleReason?.trim() ?? ""}:${input.customerRequest?.trim() ?? ""}`,
        fulfillmentId: fulfillment.id,
        orderId,
        ...actor,
        relatedEmployeeId: employee.id,
        action,
        oldStatus: fulfillment.status,
        newStatus: fulfillment.status,
        note: input.note
      });
      // Keep each actual case change even when its fulfillment timeline key was seen before.
      await tx.auditLog.create({ data: {
        actorType: ActorType.EMPLOYEE, actorId: actor.actorEmployeeId,
        actorAdminUserId: actor.actorAdminUserId, sourceApp: SourceApp.OPERATIONS,
        module: "customer-service", entityType: input.caseId ? "CustomerServiceCase" : "OrderFulfillment",
        entityId: input.caseId ?? fulfillment.id, action,
        beforeJson: JSON.parse(JSON.stringify({ orderId, ownerEmployeeId: fulfillment.afterSaleOwnerEmployeeId, serviceCase: existingCase })),
        afterJson: JSON.parse(JSON.stringify({ orderId, ownerEmployeeId: employee.id, serviceCase: updatedCase })),
        reason: input.note?.trim() || input.afterSaleReason?.trim() || "After-sale ownership or case updated."
      } });
    });
    return this.orderDetail(orderId, input.adminUserId);
  }

  /** Nodes a package can be routed to. */
  async nodes(adminUserId?: string) {
    const session = await this.access.requirePermission(adminUserId, "nodes.view");
    // A store account is offered its own store and nothing else.
    const scope = await storeScopeFor(session);
    return prisma.fulfillmentNode.findMany({
      where: { status: FulfillmentNodeStatus.ACTIVE, ...(scope ? { id: scope.id } : {}) },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }]
    });
  }

  /**
   * Routes an order to the node that will hand it to the customer. Pickup
   * orders arrive with the node the customer chose; delivery orders are routed
   * here, before the package leaves the warehouse.
   */
  async assignNode(orderId: string, input: NodeInput) {
    const actor = await this.adminForPermission(input.adminUserId, "orders.assign-node");
    const nodeId = input.nodeId?.trim();
    if (!nodeId) throw new BadRequestException("Choose a fulfillment node.");
    const node = await prisma.fulfillmentNode.findUnique({ where: { id: nodeId } });
    if (!node || node.status !== FulfillmentNodeStatus.ACTIVE) throw new BadRequestException("That fulfillment node is not active.");

    await prisma.$transaction(async (tx) => {
      await lockReservationOrder(tx, orderId);
      const order = await tx.order.findUnique({ where: { id: orderId }, include: { fulfillment: true } });
      if (!order) throw new NotFoundException("Order was not found.");
      if (!order.fulfillment) throw new BadRequestException("This order does not have a fulfillment task yet.");
      const settled: FulfillmentStatus[] = [
        FulfillmentStatus.IN_TRANSIT_TO_NODE,
        FulfillmentStatus.ARRIVED_AT_NODE,
        FulfillmentStatus.READY_FOR_PICKUP,
        FulfillmentStatus.READY_FOR_DISPATCH,
        FulfillmentStatus.OUT_FOR_DELIVERY,
        FulfillmentStatus.COMPLETED
      ];
      if (settled.includes(order.fulfillment.status)) {
        throw new BadRequestException("The package has already left the warehouse. Raise an exception instead of re-routing it.");
      }
      if (order.fulfillmentMethod === FulfillmentMethod.PICKUP && !node.supportsPickup) {
        throw new BadRequestException("That node does not accept customer pickup.");
      }
      if (order.fulfillmentMethod === FulfillmentMethod.KIKUYU_LOCAL_DELIVERY && !node.supportsDelivery) {
        throw new BadRequestException("That node does not dispatch deliveries.");
      }
      // A package code needs two facts: the parcel is sealed, and it knows where
      // it is going. Packing supplies the first, routing the second, and either
      // can come last — an order packed before it was routed, which is every
      // order from before nodes existed, would otherwise stay unlabelled until
      // it was recorded as sent.
      // Re-routing renames the parcel. A package code carries its node — the
      // sticker on the box says PKG-THOGOT- — so keeping the old one after a
      // move sends the warehouse sorter to the wrong pile and tells the
      // receiving store the box is not theirs. The code is rebuilt whenever the
      // node it names is no longer the node it goes to.
      const routed = order.fulfillment.fulfillmentNodeId === node.id;
      const keepExisting = order.fulfillment.packageCode && routed;
      const packageCode = keepExisting
        ? order.fulfillment.packageCode
        : (order.fulfillment.packageCode || order.fulfillment.status === FulfillmentStatus.PACKED)
            && requiresNodeTransit(node.type)
          ? buildPackageCode(order.orderNumber, node.code)
          : order.fulfillment.packageCode;
      await tx.order.update({ where: { id: orderId }, data: { fulfillmentNodeId: node.id } });
      // A printed sticker names the old code. Once the code changes that
      // sticker is wrong, so the parcel counts as unlabelled again and has to
      // be printed before it may leave.
      const relabelled = (packageCode ?? null) !== (order.fulfillment.packageCode ?? null);
      await tx.orderFulfillment.update({
        where: { id: order.fulfillment.id },
        data: {
          fulfillmentNodeId: node.id,
          ...(packageCode ? { packageCode } : {}),
          ...(relabelled ? { packageLabelPrintedAt: null, packageLabelPrintedByEmployeeId: null } : {})
        }
      });
      await this.createEvent(tx, {
        fulfillmentId: order.fulfillment.id,
        orderId,
        ...actor,
        action: "ASSIGN_FULFILLMENT_NODE",
        oldStatus: order.fulfillment.status,
        newStatus: order.fulfillment.status,
        note: `${node.name}${input.note?.trim() ? ` - ${input.note.trim()}` : ""}`
      });
    });
    return this.orderDetail(orderId, input.adminUserId);
  }

  /**
   * Hands a packed order to the transfer run that takes it to its store node.
   * The package code is what the store scans in on arrival, so warehouse and
   * store are looking at the same label instead of arguing about a parcel.
   */
  async sendToNode(orderId: string, input: AdminInput) {
    const actor = await this.employeeForPermission(input.adminUserId, "orders.assign-node");
    const order = await this.requireOrderWithTask(orderId);
    const fulfillment = order.fulfillment!;
    if (fulfillment.status === FulfillmentStatus.IN_TRANSIT_TO_NODE) return this.orderDetail(orderId, input.adminUserId);
    const node = order.fulfillmentNode;
    if (!node) throw new BadRequestException("Route this order to a node before sending its package.");
    if (!requiresNodeTransit(node.type)) {
      throw new BadRequestException("Orders handed over at the warehouse do not need a transfer.");
    }
    this.assertTransition(order, FulfillmentStatus.IN_TRANSIT_TO_NODE);
    // The store scans the sticker to receive the parcel. A box that leaves
    // without one arrives as a parcel nobody can check in.
    if (!fulfillment.packageLabelPrintedAt) throw labelNotPrinted();
    const packageCode = fulfillment.packageCode || buildPackageCode(order.orderNumber, node.code);
    const now = new Date();

    await prisma.$transaction(async (tx) => {
      await lockReservationOrder(tx, orderId);
      const current = await tx.orderFulfillment.findUnique({ where: { id: fulfillment.id } });
      if (!current || current.status !== FulfillmentStatus.PACKED) {
        throw new ConflictException("Fulfillment state changed. Refresh before sending the package.");
      }
      // Re-checked under the lock: a re-route in between clears the flag.
      if (!current.packageLabelPrintedAt) throw labelNotPrinted();
      await tx.orderFulfillment.update({
        where: { id: fulfillment.id },
        data: {
          status: FulfillmentStatus.IN_TRANSIT_TO_NODE,
          packageCode,
          // The store's board and scanner read the node off this record. The
          // check above used the order's node, so the record is made to name the
          // same one: a parcel sent to Kinoo is on Kinoo's en-route list even if
          // its task was created before the node was copied onto it.
          fulfillmentNodeId: node.id,
          sentToNodeByEmployeeId: actor.actorEmployeeId,
          sentToNodeAt: now
        }
      });
      await this.createEvent(tx, {
        idempotencyKey: `transition:${fulfillment.id}:${FulfillmentStatus.IN_TRANSIT_TO_NODE}`,
        fulfillmentId: fulfillment.id,
        orderId,
        ...actor,
        relatedEmployeeId: actor.actorEmployeeId,
        action: "SEND_PACKAGE_TO_NODE",
        oldStatus: fulfillment.status,
        newStatus: FulfillmentStatus.IN_TRANSIT_TO_NODE,
        note: `${packageCode}${input.note?.trim() ? ` - ${input.note.trim()}` : ""}`
      });
      await this.queueNodeNotification(tx, order, "NODE_PACKAGE_IN_TRANSIT");
    });
    return this.orderDetail(orderId, input.adminUserId);
  }

  /**
   * Records that this parcel's routing label (the sticker with the QR code) was
   * just sent to the printer. The console calls it after the print helper says
   * the sheet went out; a reprint moves the time forward.
   *
   * The code on the sticker is checked against the current one, so a label
   * rendered before a re-route cannot vouch for the parcel after it.
   */
  async markPackageLabelPrinted(orderId: string, input: LabelPrintedInput) {
    const actor = await this.adminForPermission(input.adminUserId, "orders.pack");
    const order = await this.requireOrderWithTask(orderId);
    const fulfillment = order.fulfillment!;
    if (!fulfillment.packageCode) {
      throw new BadRequestException("This parcel has no package code yet, so it has no label to print.");
    }
    const printed = input.packageCode?.trim().toUpperCase();
    if (printed && printed !== fulfillment.packageCode.toUpperCase()) {
      throw new ConflictException(`The printed label says ${printed}, but this parcel is now ${fulfillment.packageCode}. Print the label again.`);
    }
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await lockReservationOrder(tx, orderId);
      const current = await tx.orderFulfillment.findUnique({ where: { id: fulfillment.id } });
      if (!current || current.packageCode !== fulfillment.packageCode) {
        throw new ConflictException("The package code changed. Print the label again.");
      }
      await tx.orderFulfillment.update({
        where: { id: fulfillment.id },
        data: { packageLabelPrintedAt: now, packageLabelPrintedByEmployeeId: actor.actorEmployeeId }
      });
      await this.createEvent(tx, {
        fulfillmentId: fulfillment.id,
        orderId,
        ...actor,
        action: "PRINT_PACKAGE_LABEL",
        oldStatus: current.status,
        newStatus: current.status,
        note: fulfillment.packageCode
      });
    });
    return { orderId, packageCode: fulfillment.packageCode, packageLabelPrintedAt: now.toISOString() };
  }

  /**
   * The store confirms the package physically arrived. Without this record
   * there is no way to settle "the warehouse says it shipped, the store says it
   * never came".
   */
  async receiveAtNode(orderId: string, input: AdminInput & { packageCode?: string }) {
    const actor = await this.employeeForPermission(input.adminUserId, "orders.node-receive");
    const order = await this.requireOrderWithTask(orderId);
    const fulfillment = order.fulfillment!;
    if (fulfillment.status === FulfillmentStatus.ARRIVED_AT_NODE) return this.orderDetail(orderId, input.adminUserId);
    this.assertTransition(order, FulfillmentStatus.ARRIVED_AT_NODE);
    const scanned = input.packageCode?.trim().toUpperCase();
    if (scanned && fulfillment.packageCode && scanned !== fulfillment.packageCode.toUpperCase()) {
      throw new BadRequestException(`This package belongs to ${fulfillment.packageCode}. Check the label before receiving it.`);
    }
    await this.employeeBelongsToNode(actor.actorEmployeeId, fulfillment.fulfillmentNodeId);

    await prisma.$transaction(async (tx) => {
      await lockReservationOrder(tx, orderId);
      const current = await tx.orderFulfillment.findUnique({ where: { id: fulfillment.id } });
      if (!current || current.status !== FulfillmentStatus.IN_TRANSIT_TO_NODE) {
        throw new ConflictException("Fulfillment state changed. Refresh before receiving the package.");
      }
      await tx.orderFulfillment.update({
        where: { id: fulfillment.id },
        data: {
          status: FulfillmentStatus.ARRIVED_AT_NODE,
          arrivedAtNodeByEmployeeId: actor.actorEmployeeId,
          arrivedAtNodeAt: new Date(),
          nodeReceiptNote: input.note?.trim() || null
        }
      });
      await this.createEvent(tx, {
        idempotencyKey: `transition:${fulfillment.id}:${FulfillmentStatus.ARRIVED_AT_NODE}`,
        fulfillmentId: fulfillment.id,
        orderId,
        ...actor,
        relatedEmployeeId: actor.actorEmployeeId,
        action: "RECEIVE_PACKAGE_AT_NODE",
        oldStatus: fulfillment.status,
        newStatus: FulfillmentStatus.ARRIVED_AT_NODE,
        note: input.note
      });
    });
    return this.orderDetail(orderId, input.adminUserId);
  }

  /** Records the fare the node actually paid Bolt, against the KSh 50 the customer paid. */
  async recordDeliveryCost(orderId: string, input: DeliveryCostInput) {
    const actor = await this.employeeForPermission(input.adminUserId, "orders.delivery-cost");
    const order = await this.requireOrderWithTask(orderId);
    const fulfillment = order.fulfillment!;
    if (order.fulfillmentMethod !== FulfillmentMethod.KIKUYU_LOCAL_DELIVERY) {
      throw new BadRequestException("Only delivery orders have a Bolt fare.");
    }
    const amount = Number(input.actualDeliveryCostKsh);
    if (!isValidActualDeliveryCost(amount)) {
      throw new BadRequestException("Enter the actual fare as a whole KSh amount.");
    }
    const dispatched: FulfillmentStatus[] = [
      FulfillmentStatus.OUT_FOR_DELIVERY,
      FulfillmentStatus.COMPLETED,
      FulfillmentStatus.EXCEPTION
    ];
    if (!dispatched.includes(fulfillment.status)) {
      throw new BadRequestException("Record the fare once the parcel has been handed to the rider.");
    }
    await this.employeeBelongsToNode(actor.actorEmployeeId, fulfillment.fulfillmentNodeId);
    await prisma.$transaction(async (tx) => {
      const before = await tx.orderFulfillment.findUnique({ where: { id: fulfillment.id } });
      if (!before) throw new NotFoundException("Fulfillment task was not found.");
      await tx.orderFulfillment.update({
        where: { id: fulfillment.id },
        data: {
          actualDeliveryCostKsh: amount,
          deliveryCostNote: input.note?.trim() || null,
          deliveryCostByEmployeeId: actor.actorEmployeeId,
          deliveryCostRecordedAt: new Date()
        }
      });
      await tx.auditLog.create({
        data: {
          actorType: ActorType.EMPLOYEE,
          actorId: actor.actorEmployeeId,
          actorAdminUserId: actor.actorAdminUserId,
          sourceApp: SourceApp.OPERATIONS,
          module: "ORDERS",
          entityType: "OrderFulfillment",
          entityId: fulfillment.id,
          action: "RECORD_DELIVERY_COST",
          beforeJson: { actualDeliveryCostKsh: before.actualDeliveryCostKsh },
          afterJson: { actualDeliveryCostKsh: amount, customerDeliveryFeeKsh: order.deliveryFeeKsh },
          reason: input.note?.trim() || "Bolt fare recorded after dispatch."
        }
      });
    });
    return this.orderDetail(orderId, input.adminUserId);
  }

  /**
   * Returns an order from EXCEPTION to the step it was on. Without this an
   * exception is a dead end and the only way out is cancelling the order.
   */
  async resolveException(orderId: string, input: AdminInput) {
    const actor = await this.employeeForAnyPermission(input.adminUserId, ["orders.pick", "orders.pack", "orders.dispatch", "orders.node-receive"]);
    const order = await this.requireOrderWithTask(orderId);
    const fulfillment = order.fulfillment!;
    if (fulfillment.status !== FulfillmentStatus.EXCEPTION) return this.orderDetail(orderId, input.adminUserId);
    if (!canResolveFulfillmentException(fulfillment)) {
      throw new BadRequestException("This exception has no recorded step to return to. Write the order off instead.");
    }
    if (order.status === OrderStatus.CANCELLED || order.status === OrderStatus.REFUNDED) {
      throw new BadRequestException("A cancelled or refunded order cannot re-enter fulfillment.");
    }
    const note = input.note?.trim();
    if (!note) throw new BadRequestException("Say what was resolved before returning the order to fulfillment.");
    const back = fulfillment.exceptionFromStatus!;

    await prisma.$transaction(async (tx) => {
      await lockReservationOrder(tx, orderId);
      const current = await tx.orderFulfillment.findUnique({ where: { id: fulfillment.id } });
      if (!current || current.status !== FulfillmentStatus.EXCEPTION) {
        throw new ConflictException("Fulfillment state changed. Refresh before resolving the exception.");
      }
      await tx.orderFulfillment.update({
        where: { id: fulfillment.id },
        data: {
          status: back,
          exceptionReason: null,
          exceptionNote: null,
          exceptionFromStatus: null,
          exceptionResolvedAt: new Date()
        }
      });
      await this.createEvent(tx, {
        fulfillmentId: fulfillment.id,
        orderId,
        ...actor,
        action: "RESOLVE_EXCEPTION",
        oldStatus: FulfillmentStatus.EXCEPTION,
        newStatus: back,
        note
      });
    });
    return this.orderDetail(orderId, input.adminUserId);
  }

  /**
   * Writes off a paid order that can never be fulfilled - the garment was lost,
   * damaged, or already sold in a store. The stock outcome is explicit, the
   * commission is reversed, and the order is left owing a refund that finance
   * records separately once M-Pesa has actually sent the money back.
   */
  async writeOff(orderId: string, input: WriteOffInput) {
    const actor = await this.adminForPermission(input.adminUserId, "orders.write-off");
    const outcome: InventoryOutcome = input.inventoryOutcome === "RESTOCK" ? "RESTOCK" : "LOST";
    const note = input.note?.trim();
    if (!note) throw new BadRequestException("A write-off needs a reason on the record.");

    await prisma.$transaction(async (tx) => {
      await lockReservationOrder(tx, orderId);
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: { fulfillment: true, payments: { where: { status: PaymentStatus.SUCCESS }, select: { id: true } } }
      });
      if (!order) throw new NotFoundException("Order was not found.");
      if (!order.payments.length) throw new BadRequestException("This order was never paid. Cancel it instead of writing it off.");
      if (order.status === OrderStatus.COMPLETED) throw new BadRequestException("A completed order goes through after-sales, not write-off.");
      if (order.status === OrderStatus.CANCELLED || order.status === OrderStatus.REFUNDED) return;

      const before = order.fulfillment?.status ?? null;
      const result = await writeOffPaidOrder(tx, orderId, outcome, actor.actorEmployeeId ?? null, `Order write-off: ${note}`);
      if (!result.changed) throw new ConflictException("Order state changed before write-off. Refresh and try again.");

      if (order.fulfillment) {
        await tx.orderFulfillment.update({
          where: { id: order.fulfillment.id },
          data: {
            status: FulfillmentStatus.EXCEPTION,
            exceptionReason: order.fulfillment.exceptionReason ?? FulfillmentExceptionReason.ITEM_NOT_FOUND,
            exceptionNote: note,
            exceptionFromStatus: null
          }
        });
        await this.createEvent(tx, {
          idempotencyKey: `write-off:${order.fulfillment.id}`,
          fulfillmentId: order.fulfillment.id,
          orderId,
          ...actor,
          action: "WRITE_OFF_ORDER",
          oldStatus: before,
          newStatus: FulfillmentStatus.EXCEPTION,
          note: `${outcome === "RESTOCK" ? "Item returned to stock" : "Item written off as lost"} - ${note}`
        });
      }
      await tx.auditLog.create({
        data: {
          actorType: ActorType.EMPLOYEE,
          actorId: actor.actorEmployeeId,
          actorAdminUserId: actor.actorAdminUserId,
          sourceApp: SourceApp.OPERATIONS,
          module: "ORDERS",
          entityType: "Order",
          entityId: orderId,
          action: "WRITE_OFF_ORDER",
          beforeJson: { orderStatus: order.status, fulfillmentStatus: before },
          afterJson: {
            orderStatus: OrderStatus.CANCELLED,
            inventoryOutcome: outcome,
            restockedItems: result.restockedItems,
            lostItems: result.lostItems
          },
          reason: note
        }
      });
    });
    return this.orderDetail(orderId, input.adminUserId);
  }

  /**
   * Records a refund that has already been executed in M-Pesa. Like the
   * after-sales path, this books money that moved outside the system; it never
   * moves money itself.
   */
  async recordRefund(orderId: string, input: RefundInput) {
    const actor = await this.adminForPermission(input.adminUserId, "orders.refund");
    const amount = Number(input.amountKsh);
    const externalReference = input.externalReference?.trim();
    const evidenceNote = input.evidenceNote?.trim() || input.note?.trim();
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new BadRequestException("Refund amount must be a positive whole KSh amount.");
    if (!externalReference) throw new BadRequestException("Enter the M-Pesa reversal or payout reference.");
    if (!evidenceNote) throw new BadRequestException("Describe the evidence for this refund.");
    const refundedAt = input.refundedAt ? validDate(input.refundedAt, "Refund date") : new Date();

    await prisma.$transaction(async (tx) => {
      await lockReservationOrder(tx, orderId);
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: { payments: true, refunds: true }
      });
      if (!order) throw new NotFoundException("Order was not found.");
      const position = orderRefundPosition(order);
      if (!position.paidKsh) throw new BadRequestException("This order has no successful payment to refund.");
      if (amount > position.outstandingKsh) {
        throw new BadRequestException(`Recorded refunds would exceed the KSh ${position.paidKsh} actually paid.`);
      }
      await tx.refundRecord.create({
        data: {
          orderId,
          kind: RefundKind.UNFULFILLABLE_ORDER,
          reason: input.reason?.trim() || null,
          amountKsh: amount,
          externalReference,
          evidenceNote,
          refundedAt,
          recordedByAdminUserId: actor.actorAdminUserId!
        }
      });
      const refundedKsh = position.refundedKsh + amount;
      if (refundedKsh >= position.paidKsh) {
        await tx.order.update({ where: { id: orderId }, data: { status: OrderStatus.REFUNDED } });
        await reverseCommissionForClosedOrder(tx, orderId, "ORDER_REFUNDED");
      }
      await tx.auditLog.create({
        data: {
          actorType: ActorType.EMPLOYEE,
          actorId: actor.actorEmployeeId,
          actorAdminUserId: actor.actorAdminUserId,
          sourceApp: SourceApp.OPERATIONS,
          module: "ORDERS",
          entityType: "Order",
          entityId: orderId,
          action: "RECORD_ORDER_REFUND",
          beforeJson: { refundedKsh: position.refundedKsh, paidKsh: position.paidKsh },
          afterJson: { refundedKsh, paidKsh: position.paidKsh, externalReference },
          reason: evidenceNote
        }
      });
      await this.queueCustomerNotification(tx, orderId, "CUSTOMER_REFUND_RECORDED", { amountKsh: amount });
    });
    return this.orderDetail(orderId, input.adminUserId);
  }

  /** Store staff may only receive packages addressed to their own node. */
  private async employeeBelongsToNode(employeeId: string | null | undefined, nodeId: string | null) {
    if (!employeeId || !nodeId) return;
    const employee = await prisma.employee.findUnique({ where: { id: employeeId }, select: { homeNodeId: true } });
    // Warehouse and head-office staff have no home node and can act anywhere.
    if (!employee?.homeNodeId || employee.homeNodeId === nodeId) return;
    throw new ForbiddenException("This package is addressed to a different node.");
  }

  /**
   * Queues a message for the shopper. It is written inside the same
   * transaction as the state change that earned it, so a provider outage can
   * never roll back a fulfillment transition and a retried transition can never
   * send the message twice.
   */
  private async queueCustomerNotification(
    tx: Prisma.TransactionClient,
    orderId: string,
    topic: NotificationTopicName,
    extra: {
      amountKsh?: number | null;
      riderName?: string | null;
      /** Plaintext only ever passes through here into the SMS body. */
      deliveryCode?: string | null;
      reason?: string | null;
      /**
       * A re-dispatch has to text a second, different code, so the dedupe key
       * needs the attempt number. Without it the outbox would treat the new code
       * as a duplicate of the old one and silently drop it.
       */
      dedupeSuffix?: string | null;
    } = {}
  ) {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { customer: true, fulfillmentNode: true, items: { select: { id: true } } }
    });
    if (!order) return;
    await enqueueNotification(tx, {
      topic,
      audience: NotificationAudience.CUSTOMER,
      dedupeKey: notificationDedupeKey(topic, extra.dedupeSuffix ? `${orderId}:${extra.dedupeSuffix}` : orderId),
      recipientPhone: order.whatsappPhone || order.customer.phone,
      recipientLabel: order.customer.displayName ?? null,
      orderId,
      fulfillmentNodeId: order.fulfillmentNodeId,
      body: notificationBody(topic, {
        orderNumber: order.orderNumber,
        customerName: order.customer.displayName,
        nodeName: order.fulfillmentNode?.name ?? null,
        itemCount: order.items.length,
        amountKsh: extra.amountKsh ?? null,
        riderName: extra.riderName ?? null,
        deliveryCode: extra.deliveryCode ?? null,
        reason: extra.reason ?? null,
        pickupCode: order.pickupCode,
        supportPhone: SUPPORT_PHONE_LABEL
      })
    });
  }

  /** Tells the store a package is coming or is waiting for a rider. */
  private async queueNodeNotification(
    tx: Prisma.TransactionClient,
    order: OrderDetail,
    topic: NotificationTopicName
  ) {
    const node = order.fulfillmentNode;
    if (!node?.phone) return;
    await enqueueNotification(tx, {
      topic,
      audience: NotificationAudience.NODE,
      dedupeKey: notificationDedupeKey(topic, order.id),
      recipientPhone: node.phone,
      recipientLabel: node.name,
      orderId: order.id,
      fulfillmentNodeId: node.id,
      body: notificationBody(topic, {
        orderNumber: order.orderNumber,
        nodeName: node.name,
        itemCount: order.items.length
      })
    });
  }

  /**
   * Alerts whoever is on duty. The numbers come from ADMIN_ALERT_PHONES so the
   * on-call list can change without a deploy; with none set the alert is simply
   * not queued and the exception still shows in the order centre.
   */
  private async queueAdminAlert(
    tx: Prisma.TransactionClient,
    order: { id: string; orderNumber: string },
    topic: NotificationTopicName,
    reason: string
  ) {
    const phones = (process.env.ADMIN_ALERT_PHONES ?? "").split(",").map((value) => value.trim()).filter(Boolean);
    for (const phone of phones) {
      await enqueueNotification(tx, {
        topic,
        audience: NotificationAudience.ADMIN,
        dedupeKey: notificationDedupeKey(topic, `${order.id}:${phone}:${reason}`),
        recipientPhone: phone,
        orderId: order.id,
        body: notificationBody(topic, { orderNumber: order.orderNumber, reason })
      });
    }
  }

  private async moveToHandoff(
    orderId: string,
    input: AdminInput,
    actor: Pick<EventInput, "actorAdminUserId" | "actorEmployeeId">,
    status: FulfillmentStatus,
    action: string,
    data: Prisma.OrderFulfillmentUpdateInput
  ) {
    const order = await this.requireOrderWithTask(orderId);
    const fulfillment = order.fulfillment!;
    if (fulfillment.status === status) return this.orderDetail(orderId, input.adminUserId);
    this.assertTransition(order, status);
    await prisma.$transaction(async (tx) => {
      await tx.orderFulfillment.update({ where: { id: fulfillment.id }, data: { ...data, status } });
      await this.createEvent(tx, {
        idempotencyKey: `transition:${fulfillment.id}:${status}`,
        fulfillmentId: fulfillment.id,
        orderId,
        ...actor,
        action,
        oldStatus: fulfillment.status,
        newStatus: status,
        note: input.note
      });
      if (status === FulfillmentStatus.READY_FOR_PICKUP) {
        await this.queueCustomerNotification(tx, orderId, "CUSTOMER_ORDER_READY_FOR_PICKUP");
      }
      if (status === FulfillmentStatus.READY_FOR_DISPATCH) {
        await this.queueNodeNotification(tx, order, "NODE_PACKAGE_AWAITING_DISPATCH");
      }
    });
    return this.orderDetail(orderId, input.adminUserId);
  }

  private async completeOrder(
    order: OrderDetail,
    actor: Pick<EventInput, "actorAdminUserId" | "actorEmployeeId">,
    action: string,
    note: string | undefined,
    fulfillmentData: Prisma.OrderFulfillmentUncheckedUpdateInput,
    options: {
      customerCodeVerified: boolean;
      /** 无码补登 only. Set by completeWithoutCode after the role check. */
      codeless?: { reasonCode: string; reasonLabel: string; note: string; fromStatus: FulfillmentStatus };
    }
  ) {
    await prisma.$transaction(async (tx) => {
      await lockReservationOrder(tx, order.id);
      const current = await tx.order.findUnique({ where: { id: order.id }, include: ORDER_INCLUDE });
      if (!current) throw new NotFoundException("Order was not found.");
      // A delayed completion retry must not touch a refunded/relisted garment or reset the return window.
      if (current.status === OrderStatus.COMPLETED || current.status === OrderStatus.REFUNDED) return;
      if (current.status !== OrderStatus.PAID && current.status !== OrderStatus.FULFILLING) throw new ConflictException("Order state changed before handover. Refresh before continuing.");
      if (options.codeless && current.fulfillment?.status !== options.codeless.fromStatus) {
        throw new ConflictException("This order moved while you were completing it. Refresh and check it again.");
      }
      this.assertTransition(current, FulfillmentStatus.COMPLETED, {
        customerCodeVerified: options.customerCodeVerified,
        codelessBySuperAdmin: Boolean(options.codeless)
      });
      const fulfillment = current.fulfillment!;
      const successfulPayments = await tx.payment.findMany({ where: { orderId: current.id, status: PaymentStatus.SUCCESS }, select: { amountKsh: true } });
      if (successfulPayments.reduce((sum, payment) => sum + payment.amountKsh, 0) < current.totalKsh) throw new BadRequestException("Verified successful payment must cover the order before handover.");
      await this.assertOwnedInventory(tx, current.id, current.items.length, InventoryItemStatus.PACKED);
      const changed = await tx.inventoryItem.updateMany({
        where: { productId: { in: current.items.map((item) => item.productId) }, status: InventoryItemStatus.PACKED },
        data: { status: InventoryItemStatus.DELIVERED }
      });
      if (changed.count !== current.items.length) throw new ConflictException("Inventory changed before handover. Refresh and check the actual parcel.");
      await tx.order.update({ where: { id: current.id }, data: { status: OrderStatus.COMPLETED } });
      await tx.orderFulfillment.update({
        where: { id: fulfillment.id },
        data: {
          ...fulfillmentData,
          status: FulfillmentStatus.COMPLETED,
          completedAt: new Date(),
          // The readable copy exists only so the customer can read it out during
          // the handover. Once the handover happened it is spent, so it stops
          // being readable — on their order page and everywhere else.
          deliveryCode: null,
          ...this.holderData({ status: FulfillmentStatus.COMPLETED })
        }
      });
      await this.createEvent(tx, {
        idempotencyKey: `transition:${fulfillment.id}:${FulfillmentStatus.COMPLETED}`,
        fulfillmentId: fulfillment.id,
        orderId: current.id,
        ...actor,
        action,
        oldStatus: fulfillment.status,
        newStatus: FulfillmentStatus.COMPLETED,
        note
      });
      if (options.codeless) {
        await tx.auditLog.create({
          data: {
            actorType: ActorType.EMPLOYEE,
            actorId: actor.actorEmployeeId ?? null,
            actorAdminUserId: actor.actorAdminUserId ?? null,
            sourceApp: SourceApp.OPERATIONS,
            module: "ORDERS",
            entityType: "Order",
            entityId: current.id,
            action: CODELESS_COMPLETION_ACTION,
            beforeJson: { orderStatus: current.status, fulfillmentStatus: fulfillment.status },
            afterJson: {
              orderStatus: OrderStatus.COMPLETED,
              fulfillmentStatus: FulfillmentStatus.COMPLETED,
              reasonCode: options.codeless.reasonCode,
              customerCodeVerified: false
            },
            reason: `${options.codeless.reasonLabel} · ${options.codeless.note}`
          }
        });
      }
      await this.queueCustomerNotification(tx, current.id, "CUSTOMER_ORDER_COMPLETED");
    });
  }

  private async assertOwnedInventory(tx: Prisma.TransactionClient, orderId: string, itemCount: number, expected: InventoryItemStatus) {
    const inventory = await lockOrderReservationInventory(tx, orderId);
    if (!itemCount || inventory.length !== itemCount || inventory.some((item) => !item.owned || item.status !== expected)) {
      throw new ConflictException("Inventory is no longer owned by this order in the expected fulfillment state.");
    }
    const otherPaidOrder = await tx.orderItem.findFirst({ where: {
      productId: { in: inventory.map((item) => item.productId) }, orderId: { not: orderId },
      order: { status: { in: [OrderStatus.PAID, OrderStatus.FULFILLING] } }
    }, select: { id: true } });
    if (otherPaidOrder) throw new ConflictException("A different paid order claims this inventory. Review ownership before continuing.");
  }

  private orderWhere(input: OrderCenterListInput): Prisma.OrderWhereInput {
    const and: Prisma.OrderWhereInput[] = [];
    if (input.scope === "after-sales") and.push(afterSaleWhere());
    if (input.scope === "exceptions") and.push({ fulfillment: { is: { status: FulfillmentStatus.EXCEPTION } } });
    if (input.scope === "node") and.push({ fulfillment: { is: { status: { in: NODE_DESK_STATUSES } } } });
    if (input.tab && input.tab !== "all") and.push(tabWhere(input.tab));
    const fulfillmentStatuses = fulfillmentStatusFilter(input.fulfillmentStatus);
    if (fulfillmentStatuses.length) and.push({ fulfillment: { is: { status: { in: fulfillmentStatuses } } } });

    const createdAt: Prisma.DateTimeFilter = {};
    if (input.dateFrom) createdAt.gte = validDate(input.dateFrom, "Start date");
    if (input.dateTo) createdAt.lt = exclusiveDateEnd(input.dateTo);
    if (createdAt.gte || createdAt.lt) and.push({ createdAt });
    if (input.orderNumber?.trim()) and.push({ orderNumber: { contains: input.orderNumber.trim(), mode: "insensitive" } });
    if (input.customerName?.trim()) and.push({ customer: { displayName: { contains: input.customerName.trim(), mode: "insensitive" } } });
    if (input.customerPhone?.trim()) and.push({ payments: { some: { phone: { contains: input.customerPhone.trim(), mode: "insensitive" } } } });
    if (input.productName?.trim()) and.push({ items: { some: { snapshot: { is: { title: { contains: input.productName.trim(), mode: "insensitive" } } } } } });
    if (input.barcode?.trim()) and.push({ items: { some: { snapshot: { is: { barcode: { contains: input.barcode.trim(), mode: "insensitive" } } } } } });
    if (input.fulfillmentMethod && Object.values(FulfillmentMethod).includes(input.fulfillmentMethod)) and.push({ fulfillmentMethod: input.fulfillmentMethod });
    if (input.paymentStatus && Object.values(PaymentStatus).includes(input.paymentStatus)) and.push({ payments: { some: { status: input.paymentStatus } } });
    if (input.orderStatus && Object.values(OrderStatus).includes(input.orderStatus)) and.push({ status: input.orderStatus });
    if (input.nodeId?.trim()) and.push(nodeWhere(input.nodeId.trim()));
    if (input.packageCode?.trim()) and.push({ fulfillment: { is: { packageCode: { contains: input.packageCode.trim(), mode: "insensitive" } } } });
    if (input.pickerEmployeeId?.trim()) and.push({ fulfillment: { is: { assignedPickerEmployeeId: input.pickerEmployeeId.trim() } } });
    if (input.packerEmployeeId?.trim()) and.push({ fulfillment: { is: { packedByEmployeeId: input.packerEmployeeId.trim() } } });
    if (input.rider?.trim()) {
      const value = input.rider.trim();
      and.push({ fulfillment: { is: { deliveryRider: { is: {
        OR: [
          { name: { contains: value, mode: "insensitive" } },
          { phone: { contains: value, mode: "insensitive" } },
          { company: { contains: value, mode: "insensitive" } },
          { employee: { name: { contains: value, mode: "insensitive" } } }
        ]
      } } } } });
    }
    if (input.affiliate?.trim()) {
      const value = input.affiliate.trim();
      and.push({ OR: [
        { affiliateSource: { contains: value, mode: "insensitive" } },
        { affiliateCampaign: { contains: value, mode: "insensitive" } },
        { affiliate: { affiliateCode: { contains: value, mode: "insensitive" } } },
        { affiliate: { displayName: { contains: value, mode: "insensitive" } } }
      ] });
    }
    return and.length ? { AND: and } : {};
  }

  private async requireOrder(orderId: string): Promise<OrderDetail> {
    const order = await prisma.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });
    if (!order) throw new NotFoundException("Order was not found.");
    return order;
  }

  private async requireOrderWithTask(orderId: string) {
    await this.ensurePaidFulfillments(orderId);
    const order = await this.requireOrder(orderId);
    if (!order.fulfillment) throw new BadRequestException("This order does not have a picking task.");
    return order;
  }

  private assertTransition(order: OrderDetail, to: FulfillmentStatus, extra: { customerCodeVerified?: boolean; codelessBySuperAdmin?: boolean } = {}) {
    const fulfillment = order.fulfillment;
    if (!fulfillment || !canTransitionFulfillment({
      from: fulfillment.status,
      to,
      fulfillmentMethod: order.fulfillmentMethod,
      hasDeliveryRider: Boolean(fulfillment.deliveryRiderId),
      nodeType: nodeTypeFor(order),
      customerCodeVerified: extra.customerCodeVerified,
      codelessBySuperAdmin: extra.codelessBySuperAdmin
    })) {
      // Completion without a verified code is the one failure worth naming, so
      // the rider's screen says what to do instead of "cannot move".
      if (to === FulfillmentStatus.COMPLETED && !extra.customerCodeVerified && !extra.codelessBySuperAdmin && fulfillment) {
        throw new BadRequestException("This order cannot be completed without the customer's code.");
      }
      throw new BadRequestException(`Fulfillment cannot move from ${fulfillment?.status ?? "NONE"} to ${to}.`);
    }
  }

  /**
   * Records the holder alongside a status change. Kept next to the transition so
   * a new step cannot forget it and leave "who has the package" stale.
   */
  private holderData(input: {
    status: FulfillmentStatus;
    fulfillmentNodeId?: string | null;
    nodeName?: string | null;
    deliveryRiderId?: string | null;
    riderName?: string | null;
  }): Prisma.OrderFulfillmentUncheckedUpdateInput {
    return holderForStatus(input);
  }

  private async ensurePaidFulfillments(orderId?: string) {
    const orders = await prisma.order.findMany({
      where: { ...(orderId ? { id: orderId } : {}), status: OrderStatus.PAID },
      include: { items: { include: { snapshot: true } }, fulfillment: { include: { items: true } } },
      take: orderId ? 1 : 100
    });
    for (const order of orders) {
      await prisma.$transaction(async (tx) => {
        // The picking task inherits the order's node. A customer who chose where
        // to collect, or a delivery routed at checkout, already answered "which
        // store", and the store end reads that answer off the fulfillment record
        // — its board, its scanner and its ownership check all key on this
        // column. Leaving it for re-routing to fill meant a parcel nobody
        // re-routed was one no store could receive.
        const fulfillment = await tx.orderFulfillment.upsert({
          where: { orderId: order.id },
          update: order.fulfillmentNodeId && !order.fulfillment?.fulfillmentNodeId
            ? { fulfillmentNodeId: order.fulfillmentNodeId }
            : {},
          create: { orderId: order.id, status: FulfillmentStatus.PAID, fulfillmentNodeId: order.fulfillmentNodeId }
        });
        await tx.fulfillmentItem.createMany({
          data: order.items.map((item) => ({
            fulfillmentId: fulfillment.id,
            orderItemId: item.id,
            expectedBarcode: item.snapshot?.barcode?.trim() || null
          })),
          skipDuplicates: true
        });
        await this.createEvent(tx, {
          idempotencyKey: `pick-task:${order.id}`,
          fulfillmentId: fulfillment.id,
          orderId: order.id,
          action: "PAYMENT_CONFIRMED_PICK_TASK_CREATED",
          oldStatus: null,
          newStatus: FulfillmentStatus.PAID,
          note: "Payment confirmed; one order-level picking task was created."
        });
      });
    }
  }

  private async attachInventory(orders: OrderDetail[]) {
    const productIds = [...new Set(orders.flatMap((order) => order.items.map((item) => item.productId)))];
    const inventory = productIds.length ? await prisma.inventoryItem.findMany({
      where: { productId: { in: productIds } },
      include: {
        location: true,
        product: {
          select: {
            images: {
              orderBy: { sortOrder: "asc" },
              // Enough for the enlarged view to page through a garment's photos.
              take: 8,
              select: { id: true, publicUrl: true }
            }
          }
        }
      }
    }) : [];
    const byProduct = new Map(inventory.map((item) => [item.productId, item]));
    return orders.map((order) => ({
      ...order,
      // Neither code ever leaves the API.
      //
      // The pickup code is the customer's proof at the counter; the delivery code
      // is theirs at the door. A store screen that displayed either would let
      // staff complete an order the customer never turned up for -- which is the
      // whole thing the codes exist to prevent. The delivery code's hash goes too:
      // four digits is 10,000 guesses, so a hash in a JSON response is a code.
      //
      // `deliveryCode` is the readable copy the customer's own order page shows
      // while SMS is not live. It is the code itself, so it is redacted here
      // first and hardest.
      pickupCode: undefined,
      fulfillment: order.fulfillment
        ? { ...order.fulfillment, deliveryCode: undefined, deliveryCodeHash: undefined, pickupVerificationValue: undefined }
        : order.fulfillment,
      // The customer's name, phone and address go through whole. Staff pack,
      // route and ring these parcels, and a masked number cannot be dialled;
      // the owner removed the masking on 2026-09-24. Who may open an order is
      // still decided by the orders.view permission its callers check, not by
      // hiding digits.
      centerTab: orderCenterTab({
        orderStatus: order.status,
        fulfillmentStatus: order.fulfillment?.status,
        hasOpenAfterSale: order.customerServiceCases.some(
          (item) => item.issueType === CustomerServiceIssueType.AFTER_SALE && item.status !== CustomerServiceCaseStatus.CLOSED
        )
      }),
      items: order.items.map((item) => {
        const inventoryItem = byProduct.get(item.productId);
        const currentImage = inventoryItem?.product.images[0];
        return {
          ...item,
          displayImageUrl: item.snapshot?.imageUrl || currentImage?.publicUrl || (currentImage ? `/products/${item.productId}/images/${currentImage.id}/content` : null),
          // Every photo of the garment, for the enlarged view; the one shown on
          // the card comes first.
          imageUrls: orderItemImageUrls(
            item.snapshot?.imageUrl,
            (inventoryItem?.product.images ?? []).map((image) => image.publicUrl || `/products/${item.productId}/images/${image.id}/content`)
          ),
          inventoryItem: inventoryItem ? {
            id: inventoryItem.id,
            barcode: inventoryItem.barcode,
            status: inventoryItem.status,
            location: inventoryItem.location
          } : null
        };
      })
    }));
  }

  private async requireEmployee(employeeId?: string) {
    const id = employeeId?.trim();
    if (!id) throw new BadRequestException("Employee is required.");
    const employee = await prisma.employee.findFirst({ where: { id, status: EmployeeStatus.ACTIVE } });
    if (!employee) throw new BadRequestException("Employee is missing or inactive.");
    return employee;
  }

  private async adminForPermission(adminUserId: string | undefined, permission: string) {
    const session = await this.access.requirePermission(adminUserId, permission);
    return {
      actorAdminUserId: session.adminUser!.id,
      actorEmployeeId: session.adminUser!.linkedEmployee?.id ?? null
    };
  }

  private async employeeForPermission(adminUserId: string | undefined, permission: string) {
    const actor = await this.adminForPermission(adminUserId, permission);
    if (!actor.actorEmployeeId) throw new ForbiddenException("This action requires an active employee linked to the admin account.");
    return actor;
  }

  private async employeeForAnyPermission(adminUserId: string | undefined, permissions: string[]) {
    const session = await this.access.session(adminUserId);
    if (!session.adminUser || !permissions.some((permission) => session.permissions.includes(permission))) {
      throw new ForbiddenException("This admin account does not have permission for this operation.");
    }
    const actorEmployeeId = session.adminUser.linkedEmployee?.id;
    if (!actorEmployeeId) throw new ForbiddenException("This action requires an active employee linked to the admin account.");
    return { actorAdminUserId: session.adminUser.id, actorEmployeeId };
  }

  private async internalRider(employeeId?: string) {
    const employee = await this.requireEmployee(employeeId);
    return prisma.deliveryRider.upsert({
      where: { employeeId: employee.id },
      update: { name: employee.name, phone: employee.phone, type: DeliveryRiderType.INTERNAL },
      create: { type: DeliveryRiderType.INTERNAL, employeeId: employee.id, name: employee.name, phone: employee.phone }
    });
  }

  private async externalRider(input: RiderInput) {
    const name = input.name?.trim();
    const phone = input.phone?.trim();
    if (!name || !phone) throw new BadRequestException("External rider name and phone are required.");
    const existing = await prisma.deliveryRider.findFirst({
      where: {
        type: DeliveryRiderType.EXTERNAL,
        name,
        phone,
        company: input.company?.trim() || null,
        vehicle: input.vehicle?.trim() || null
      },
      orderBy: { createdAt: "desc" }
    });
    if (existing) return existing;
    return prisma.deliveryRider.create({
      data: {
        type: DeliveryRiderType.EXTERNAL,
        name,
        phone,
        company: input.company?.trim() || null,
        vehicle: input.vehicle?.trim() || null
      }
    });
  }

  /**
   * The single gate every delivery completion passes through.
   *
   * It re-reads the row inside a transaction and updates the attempt counter in
   * the same statement it checks, so two riders submitting codes at the same
   * moment cannot both be told they were first, and a wrong code always costs an
   * attempt even if the request is retried. Nothing about the stored code is
   * returned: the caller learns only "yes" or a message telling it what to do.
   */
  private async consumeDeliveryCode(
    order: OrderDetail,
    submitted: string | null | undefined,
    actor: { deliveryRiderId?: string | null; actorAdminUserId?: string | null }
  ) {
    const fulfillment = order.fulfillment!;
    if (fulfillment.status !== FulfillmentStatus.OUT_FOR_DELIVERY) {
      throw new BadRequestException("This order is not out for delivery.");
    }
    await this.consumeCustomerCode(order, CustomerCodePurpose.DELIVERY, submitted, actor);
  }

  /** The same gate for a customer collecting from a store counter. */
  private async consumePickupCode(
    order: OrderDetail,
    submitted: string | null | undefined,
    actor: { actorAdminUserId?: string | null }
  ) {
    const fulfillment = order.fulfillment!;
    if (fulfillment.status !== FulfillmentStatus.READY_FOR_PICKUP) {
      throw new BadRequestException("This order is not ready for pickup.");
    }
    await this.consumeCustomerCode(order, CustomerCodePurpose.PICKUP, submitted, actor);
  }

  private async consumeCustomerCode(
    order: OrderDetail,
    purpose: CustomerCodePurpose,
    submitted: string | null | undefined,
    actor: { deliveryRiderId?: string | null; actorAdminUserId?: string | null }
  ) {
    const fulfillmentId = order.fulfillment!.id;
    const failure = await prisma.$transaction(async (tx) => {
      const current = await tx.orderFulfillment.findUnique({ where: { id: fulfillmentId } });
      if (!current) throw new NotFoundException("Fulfillment was not found.");

      // Both codes are readable on the customer's own order page, and both are
      // verified against a hash rather than against that readable copy — so a
      // wrong column, a stale copy or a tampered row still cannot pass a code
      // the customer was never given.
      const codeHash = purpose === CustomerCodePurpose.PICKUP
        ? (order.pickupCode ? hashCustomerCode(normalizeCustomerCode(order.pickupCode)) : null)
        : current.deliveryCodeHash;

      const result = verifyCustomerCode(
        {
          codeHash,
          failedAttempts: current.customerCodeFailedAttempts,
          lockedAt: current.customerCodeLockedAt,
          // A pickup code is reusable until the order completes, which the
          // status check already covers; a delivery code is strictly one-time.
          verifiedAt: purpose === CustomerCodePurpose.DELIVERY ? current.customerCodeVerifiedAt : null
        },
        submitted
      );

      // A malformed entry is a typo, not a guess, so it does not burn an attempt.
      if (result.outcome === "MALFORMED") return result;

      const attemptNumber = current.customerCodeFailedAttempts + 1;
      if (result.outcome === "WRONG_CODE") {
        await tx.orderFulfillment.update({
          where: { id: fulfillmentId },
          data: {
            customerCodeFailedAttempts: { increment: 1 },
            ...(result.nowLocked ? { customerCodeLockedAt: new Date() } : {})
          }
        });
      }

      await tx.customerCodeAttempt.create({
        data: {
          fulfillmentId,
          orderId: order.id,
          purpose,
          succeeded: result.outcome === "VERIFIED",
          attemptNumber,
          lockedOut: result.outcome === "LOCKED" || (result.outcome === "WRONG_CODE" && result.nowLocked),
          deliveryRiderId: actor.deliveryRiderId ?? null,
          actorAdminUserId: actor.actorAdminUserId ?? null,
          note: result.outcome === "VERIFIED" ? null : result.outcome
        }
      });

      if (result.outcome === "VERIFIED") {
        await this.createEvent(tx, {
          fulfillmentId,
          orderId: order.id,
          actorAdminUserId: actor.actorAdminUserId ?? null,
          deliveryRiderId: actor.deliveryRiderId ?? null,
          action: purpose === CustomerCodePurpose.PICKUP ? "PICKUP_CODE_VERIFIED" : "DELIVERY_CODE_VERIFIED",
          oldStatus: current.status,
          newStatus: current.status,
          note: "The customer's code was verified."
        });
        return null;
      }

      await this.createEvent(tx, {
        fulfillmentId,
        orderId: order.id,
        actorAdminUserId: actor.actorAdminUserId ?? null,
        deliveryRiderId: actor.deliveryRiderId ?? null,
        action: "CUSTOMER_CODE_REJECTED",
        oldStatus: current.status,
        newStatus: current.status,
        note: `Code attempt ${attemptNumber} rejected: ${result.outcome}.`
      });
      return result;
    });

    if (failure) throw new BadRequestException(customerCodeFailureMessage(failure));
  }

  /**
   * Stores the drop-off photo before the code is checked, so proof of where the
   * package was left always exists for a completed drop-off. The object name
   * binds the picture to the order and the moment it was taken.
   */
  private async storeDropOffPhoto(orderId: string, fulfillmentId: string, input: DropOffInput): Promise<string> {
    const contentType = input.photoContentType?.trim() || "image/jpeg";
    const base64 = (input.photoBase64 ?? "").replace(/^data:[^;]+;base64,/, "").trim();
    if (!base64) throw new BadRequestException("A photo of where the package was left is required for an authorized drop-off.");
    let body: Buffer;
    try {
      body = Buffer.from(base64, "base64");
    } catch {
      throw new BadRequestException("The drop-off photo could not be read. Take it again.");
    }
    if (!body.length) throw new BadRequestException("The drop-off photo is empty. Take it again.");
    const objectName = `staging/deliveries/${orderId}/${fulfillmentId}-${Date.now()}.${contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg"}`;
    await this.photos.upload(objectName, contentType, body);
    return objectName;
  }

  /** A store may only dispatch to a rider who rides for that store and is active. */
  private async requireNodeRider(deliveryRiderId: string | undefined, nodeId: string | null) {
    const id = deliveryRiderId?.trim();
    if (!id) throw new BadRequestException("Choose a rider.");
    const rider = await prisma.deliveryRider.findUnique({ where: { id } });
    if (!rider) throw new NotFoundException("Rider was not found.");
    if (!rider.active) throw new BadRequestException(`${rider.name} is not an active rider.`);
    if (nodeId && rider.fulfillmentNodeId && rider.fulfillmentNodeId !== nodeId) {
      throw new ForbiddenException(`${rider.name} rides for a different node.`);
    }
    return rider;
  }

  /** One status move, its timestamps, its holder and its event, in one place. */
  private async moveWithEvent(
    order: OrderDetail,
    to: FulfillmentStatus,
    actor: Pick<EventInput, "actorAdminUserId" | "actorEmployeeId">,
    action: string,
    note: string | undefined,
    data: Prisma.OrderFulfillmentUncheckedUpdateInput
  ) {
    const fulfillment = order.fulfillment!;
    await prisma.$transaction(async (tx) => {
      const current = await tx.orderFulfillment.findUnique({ where: { id: fulfillment.id } });
      if (!current) throw new NotFoundException("Fulfillment was not found.");
      if (current.status === to) return;
      if (current.status !== fulfillment.status) {
        throw new ConflictException("This package moved while you were working on it. Refresh and try again.");
      }
      await tx.orderFulfillment.update({
        where: { id: fulfillment.id },
        data: {
          ...data,
          status: to,
          ...this.holderData({
            status: to,
            fulfillmentNodeId: current.fulfillmentNodeId,
            nodeName: order.fulfillment?.fulfillmentNode?.name ?? null,
            deliveryRiderId: data.deliveryRiderId === null ? null : current.deliveryRiderId,
            riderName: data.deliveryRiderName === null ? null : current.deliveryRiderName
          })
        }
      });
      await this.createEvent(tx, {
        idempotencyKey: `transition:${fulfillment.id}:${to}:${current.deliveryAttemptCount}`,
        fulfillmentId: fulfillment.id,
        orderId: order.id,
        ...actor,
        deliveryRiderId: current.deliveryRiderId,
        action,
        oldStatus: current.status,
        newStatus: to,
        note
      });
    });
  }

  /**
   * What a rider is allowed to see about a delivery: enough to find the customer
   * and nothing about money. No commission, no product cost, no order total, and
   * no delivery code -- there is no code to show, only a hash.
   */
  riderDeliveryView(order: RiderVisibleOrder) {
    const fulfillment = order.fulfillment!;
    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      packageCode: fulfillment.packageCode,
      status: fulfillment.status,
      itemCount: order.items.length,
      items: order.items.map((item) => ({
        title: item.snapshot?.title ?? "Item",
        sizeLabel: item.snapshot?.sizeLabel ?? null
      })),
      customerName: order.customer.displayName,
      customerPhone: order.customer.phone,
      deliveryAddress: order.deliveryAddress,
      deliveryNote: order.deliveryNote,
      nodeName: fulfillment.fulfillmentNode?.name ?? null,
      dispatchedAt: fulfillment.outForDeliveryAt,
      deliveryAttemptCount: fulfillment.deliveryAttemptCount,
      codeAttemptsRemaining: Math.max(0, CUSTOMER_CODE_MAX_ATTEMPTS - fulfillment.customerCodeFailedAttempts),
      codeLocked: Boolean(fulfillment.customerCodeLockedAt),
      failureReason: fulfillment.deliveryFailureReason,
      completedAt: fulfillment.completedAt,
      riderFeeKsh: fulfillment.riderFeeKsh ?? null
    };
  }

  private async createEvent(tx: Prisma.TransactionClient, input: EventInput) {
    const data: Prisma.FulfillmentEventUncheckedCreateInput = {
      idempotencyKey: input.idempotencyKey ?? null,
      fulfillmentId: input.fulfillmentId,
      orderId: input.orderId,
      actorAdminUserId: input.actorAdminUserId ?? null,
      actorEmployeeId: input.actorEmployeeId ?? null,
      relatedEmployeeId: input.relatedEmployeeId ?? null,
      deliveryRiderId: input.deliveryRiderId ?? null,
      orderItemId: input.orderItemId ?? null,
      action: input.action,
      oldStatus: input.oldStatus,
      newStatus: input.newStatus,
      note: input.note?.trim() || null,
      expectedBarcode: input.expectedBarcode?.trim() || null,
      scannedBarcode: input.scannedBarcode?.trim() || null,
      exceptionReason: input.exceptionReason ?? null
    };
    if (!input.idempotencyKey) return tx.fulfillmentEvent.create({ data });
    return tx.fulfillmentEvent.upsert({
      where: { idempotencyKey: input.idempotencyKey },
      update: {},
      create: data
    });
  }
}

/** The role whose holders may complete an order without the customer's code. */
export const SUPER_ADMIN_ROLE_CODE = "SUPER_ADMIN";

export function isSuperAdminSession(session: { roles: ReadonlyArray<{ code: string }> }): boolean {
  return session.roles.some((role) => role.code === SUPER_ADMIN_ROLE_CODE);
}

function requireReassignReason(value: string | undefined): string {
  const reason = value?.trim() ?? "";
  if (reason.length < REASSIGN_REASON_MIN_LENGTH) throw new BadRequestException("Say why the work is being moved to someone else.");
  return reason;
}

function errorMessage(caught: unknown): string {
  if (caught instanceof BadRequestException || caught instanceof ForbiddenException || caught instanceof ConflictException || caught instanceof NotFoundException) {
    const response = caught.getResponse();
    if (typeof response === "object" && response && "message" in response) {
      const message = (response as { message: unknown }).message;
      return Array.isArray(message) ? message.join("; ") : String(message);
    }
  }
  return caught instanceof Error ? caught.message : "Unknown error";
}

function labelNotPrinted() {
  return new BadRequestException({
    message: "Print the package label before sending the parcel to the store.",
    code: PACKAGE_LABEL_NOT_PRINTED
  });
}

/**
 * The rows behind one status tab. It has to agree with `orderCenterTab`, which
 * counts them: an order counted under 已取消 must not also be listed under 异常,
 * or the numbers on the tabs stop adding up to 全部. So each tab leaves out the
 * orders a higher-priority tab has already claimed, in the order
 * `orderCenterTab` checks them: after-sale, cancelled, completed, exception.
 */
export function tabWhere(tab: OrderCenterTab): Prisma.OrderWhereInput {
  const afterSale = afterSaleWhere();
  const cancelled: Prisma.OrderWhereInput = { status: { in: CANCELLED_TAB_STATUSES } };
  const completed: Prisma.OrderWhereInput = { OR: [{ status: OrderStatus.COMPLETED }, { fulfillment: { is: { status: FulfillmentStatus.COMPLETED } } }] };
  const exception: Prisma.OrderWhereInput = { fulfillment: { is: { status: FulfillmentStatus.EXCEPTION } } };

  if (tab === "after-sale") return afterSale;
  if (tab === "cancelled") return { AND: [cancelled, { NOT: afterSale }] };
  if (tab === "completed") return { AND: [completed, { NOT: afterSale }, { NOT: cancelled }] };
  if (tab === "exception") return { AND: [exception, { NOT: afterSale }, { NOT: cancelled }, { NOT: completed }] };

  const open: Prisma.OrderWhereInput[] = [afterSale, cancelled, completed, exception].map((where) => ({ NOT: where }));
  const noTask: Prisma.OrderWhereInput = { fulfillment: { is: null } };
  const paid: Prisma.OrderWhereInput = { status: { in: [OrderStatus.PAID, OrderStatus.FULFILLING] } };
  if (tab === "pending-payment") return { AND: [...open, noTask, { NOT: paid }] };
  if (tab === "waiting-pick") {
    return { AND: [...open, { OR: [{ fulfillment: { is: { status: FulfillmentStatus.PAID } } }, { AND: [noTask, paid] }] }] };
  }
  const status = TAB_FULFILLMENT_STATUS[tab];
  if (status) return { AND: [...open, { fulfillment: { is: { status } } }] };
  return {};
}

/** Order statuses that land on 已取消. Must match `orderCenterTab`. */
const CANCELLED_TAB_STATUSES: OrderStatus[] = [OrderStatus.CANCELLED, OrderStatus.EXPIRED, OrderStatus.DEPOSIT_EXPIRED];

const TAB_FULFILLMENT_STATUS: Partial<Record<OrderCenterTab, FulfillmentStatus>> = {
  picking: FulfillmentStatus.PICKING,
  "ready-to-pack": FulfillmentStatus.READY_TO_PACK,
  packed: FulfillmentStatus.PACKED,
  "in-transit-to-node": FulfillmentStatus.IN_TRANSIT_TO_NODE,
  "at-node": FulfillmentStatus.ARRIVED_AT_NODE,
  "ready-for-pickup": FulfillmentStatus.READY_FOR_PICKUP,
  "ready-for-dispatch": FulfillmentStatus.READY_FOR_DISPATCH,
  "out-for-delivery": FulfillmentStatus.OUT_FOR_DELIVERY,
  "delivery-failed": FulfillmentStatus.DELIVERY_FAILED,
  "returning-to-node": FulfillmentStatus.RETURNING_TO_NODE
};

/**
 * Orders going to one node. The fulfillment record is what the store end
 * trusts; an order whose task has no node yet falls back to the node on the
 * order itself, so a parcel routed to a store is never on nobody's list.
 */
export function nodeWhere(nodeId: string): Prisma.OrderWhereInput {
  return { OR: [
    { fulfillment: { is: { fulfillmentNodeId: nodeId } } },
    { fulfillmentNodeId: nodeId, fulfillment: { is: { fulfillmentNodeId: null } } },
    { fulfillmentNodeId: nodeId, fulfillment: { is: null } }
  ] };
}

function afterSaleWhere(): Prisma.OrderWhereInput {
  return {
    OR: [
      { status: OrderStatus.REFUNDED },
      { customerServiceCases: { some: { issueType: CustomerServiceIssueType.AFTER_SALE, status: { not: CustomerServiceCaseStatus.CLOSED } } } }
    ]
  };
}

/** Plain words for the customer, not the enum label. */
function failureReasonLabel(reason: DeliveryFailureReason): string {
  const labels: Record<DeliveryFailureReason, string> = {
    [DeliveryFailureReason.NO_ANSWER]: "nobody answered",
    [DeliveryFailureReason.PHONE_UNREACHABLE]: "your phone was unreachable",
    [DeliveryFailureReason.WRONG_ADDRESS]: "we could not find the address",
    [DeliveryFailureReason.CUSTOMER_REQUESTED_LATER]: "you asked us to come later",
    [DeliveryFailureReason.CUSTOMER_REFUSED]: "the delivery was refused",
    [DeliveryFailureReason.OTHER]: "we could not complete the handover"
  };
  return labels[reason];
}

function validDate(value: string, label: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new BadRequestException(`${label} is invalid.`);
  return date;
}

function exclusiveDateEnd(value: string): Date {
  const date = validDate(value, "End date");
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

function nodeTypeFor(order: {
  fulfillmentNode?: { type: FulfillmentNodeType } | null;
  fulfillment?: { fulfillmentNode?: { type: FulfillmentNodeType } | null } | null;
}): FulfillmentNodeType | null {
  return order.fulfillment?.fulfillmentNode?.type ?? order.fulfillmentNode?.type ?? null;
}
