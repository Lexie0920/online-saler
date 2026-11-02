import { createHash, randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, ForbiddenException, Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { ActorType, AfterSaleReturnReason, AfterSaleReturnStatus, CommissionAdjustmentKind, CommissionStatus, CustomerServiceCaseStatus, CustomerServiceCaseType, CustomerServiceIssueType, FulfillmentNodeStatus, InventoryItemStatus, InventoryMovementType, OrderStatus, PaymentStatus, Prisma, ProductStatus, RefundRequestStatus, SourceApp, WarehouseLocationStatus, prisma } from "@online-saler/database";
import { OperationsAccessService } from "./operations-access.service";
import { assertRefundAmount, assertReturnPhotoCount, assertReturnWindow, commissionShares, requiredText, RETURN_PHOTO_MAX, RETURN_REASONS, returnPhotoContentType } from "./operations-after-sales.rules";
import { ProductImageStorageService } from "../product/product-image-storage.service";
import { approvedRequestFor, raiseReturnRefundRequest, refundNeedsApprovedRequest } from "./operations-return-refund-request";
import { refreshWarehouseLocationStatuses, WAREHOUSE_OCCUPYING_STATUSES } from "./warehouse-capacity";
import { scopedNodeId, storeScopeFor } from "./store-scope";

export type AfterSalesInput = {
  idempotencyKey?: string; note?: string; orderItemId?: string; reason?: string; measurementDifferenceCm?: number;
  approved?: boolean; receivedBarcode?: string; restockable?: boolean; amountKsh?: number; externalReference?: string;
  evidenceNote?: string; refundedAt?: string; locationCode?: string;
  /** The store the customer is told to bring the item back to. */
  returnNodeId?: string;
};
type Action = "REQUEST" | "DECISION" | "RECEIVE" | "REFUND" | "RESTOCK";
/** Photo metadata only: the storage path never leaves the server. */
const PHOTO_SELECT = { id: true, contentType: true, sizeBytes: true, uploadedByAdminUserId: true, createdAt: true } as const;
const RETURN_INCLUDE = { orderItem: { include: { snapshot: true } }, photos: { select: PHOTO_SELECT, orderBy: { createdAt: "asc" as const } }, refundRequests: { select: { id: true, status: true, amountKsh: true, reviewNote: true, reviewedAt: true }, orderBy: { requestedAt: "asc" as const } }, refunds: { orderBy: { recordedAt: "asc" as const } }, commissionAdjustment: true, events: { orderBy: { createdAt: "asc" as const } } } as const;
const ORDER_INCLUDE = { items: { include: { snapshot: true } }, payments: true, fulfillment: true, commission: { include: { adjustments: true } }, afterSaleReturns: { include: RETURN_INCLUDE } } as const;
type Order = Prisma.OrderGetPayload<{ include: typeof ORDER_INCLUDE }>;
type Return = Order["afterSaleReturns"][number];

@Injectable()
export class OperationsAfterSalesService {
  constructor(private readonly access: OperationsAccessService, private readonly storage?: ProductImageStorageService) {}

  async list(orderId: string, adminUserId: string) {
    await this.access.requirePermission(adminUserId, "orders.view");
    if (!await prisma.order.findUnique({ where: { id: orderId }, select: { id: true } })) throw new NotFoundException("Order was not found.");
    return { returns: await prisma.afterSaleReturn.findMany({ where: { orderId }, include: RETURN_INCLUDE, orderBy: { requestedAt: "asc" } }) };
  }

  /**
   * What a store should expect back over its counter.
   *
   * Only approved returns appear: a return the customer has merely asked for is
   * not yet something the store should accept, and one already received is not
   * something it is still waiting for.
   */
  async returnsToReceive(nodeId: string, adminUserId: string) {
    const session = await this.access.requirePermission(adminUserId, "orders.view");
    // A store account sees the returns coming to its own store only.
    nodeId = scopedNodeId(await storeScopeFor(session), nodeId) ?? nodeId;
    return {
      returns: await prisma.afterSaleReturn.findMany({
        where: { returnNodeId: nodeId, status: AfterSaleReturnStatus.APPROVED },
        include: {
          orderItem: { include: { snapshot: { select: { title: true, barcode: true, imageUrl: true } } } },
          order: { select: { id: true, orderNumber: true, customer: { select: { displayName: true, phone: true } } } },
          returnNode: { select: { id: true, code: true, name: true } }
        },
        orderBy: { decidedAt: "asc" }
      })
    };
  }

  async execute(orderId: string, returnId: string | undefined, action: Action, input: AfterSalesInput, adminUserId: string) {
    const session = await this.access.requirePermission(adminUserId, "orders.after-sale");
    if (action === "DECISION" || action === "REFUND") await this.access.requirePermission(adminUserId, "action.customer-service.approve");
    const employeeId = session.adminUser?.linkedEmployeeId ?? null;
    const key = requiredText(input.idempotencyKey, "Idempotency key", 120);
    const note = requiredText(input.note, "Action note");
    const hash = createHash("sha256").update(JSON.stringify(canonical({ action, returnId: returnId ?? null, input }))).digest("hex");
    try {
      return await prisma.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`);
        const order = await tx.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });
        if (!order) throw new NotFoundException("Order was not found.");
        const existing = await tx.afterSaleEvent.findUnique({ where: { orderId_idempotencyKey: { orderId, idempotencyKey: key } } });
        if (existing) {
          if (existing.requestHash !== hash || existing.actorAdminUserId !== adminUserId) throw new ConflictException("Idempotency key was already used for a different request or actor.");
          return { returns: order.afterSaleReturns };
        }
        const now = new Date();
        let record = returnId ? order.afterSaleReturns.find((row) => row.id === returnId) : undefined;
        if (action !== "REQUEST" && !record) throw new NotFoundException("Return was not found for this order.");
        const before = record ? auditReturn(record) : {};
        if (action === "REQUEST") {
          record = await this.request(tx, order, input, adminUserId, note, now);
        } else if (action === "DECISION") {
          if (record!.status !== AfterSaleReturnStatus.REQUESTED || typeof input.approved !== "boolean") throw new BadRequestException("Only a requested return can receive an explicit approval/rejection.");
          await tx.afterSaleReturn.update({ where: { id: record!.id }, data: { status: input.approved ? AfterSaleReturnStatus.APPROVED : AfterSaleReturnStatus.REJECTED, decidedAt: now, decidedByAdminUserId: adminUserId, decisionNote: note } });
          if (!input.approved) await this.closeCase(tx, record!.serviceCaseId, now);
        } else if (action === "RECEIVE") {
          if (record!.status !== AfterSaleReturnStatus.APPROVED || typeof input.restockable !== "boolean") throw new BadRequestException("Only an approved return can be received with an explicit inspection result.");
          assertReturnPhotoCount(await tx.afterSaleReturnPhoto.count({ where: { afterSaleReturnId: record!.id } }));
          const barcode = requiredText(input.receivedBarcode, "Received barcode", 160);
          const inventory = await tx.inventoryItem.findUnique({ where: { productId: record!.orderItem.productId } });
          if (input.restockable && (!inventory || barcode !== inventory.barcode || barcode !== record!.orderItem.snapshot?.barcode)) throw new BadRequestException("A mismatched returned barcode cannot be restocked. Record it as not restockable for review.");
          await tx.afterSaleReturn.update({ where: { id: record!.id }, data: { status: AfterSaleReturnStatus.RECEIVED, receivedAt: now, receivedByAdminUserId: adminUserId, receivedBarcode: barcode, restockable: input.restockable, inspectionNote: note, inventoryUpdatedAt: inventory?.updatedAt ?? null } });
          await raiseReturnRefundRequest(tx, {
            orderId: order.id,
            paidKsh: order.payments.filter((payment) => payment.status === PaymentStatus.SUCCESS).reduce((sum, payment) => sum + payment.amountKsh, 0),
            serviceCaseId: record!.serviceCaseId,
            afterSaleReturnId: record!.id,
            amountKsh: record!.orderItem.lineTotalKsh,
            reason: `Returned item accepted at the counter: ${note}`,
            requestedByAdminUserId: adminUserId,
            actorEmployeeId: employeeId
          });
        } else if (action === "REFUND") {
          await this.refund(tx, order, record!, input, adminUserId, now);
        } else if (action === "RESTOCK") {
          await this.restock(tx, order, record!, input, adminUserId, employeeId, note, now);
        }
        const after = await tx.afterSaleReturn.findUniqueOrThrow({ where: { id: record!.id }, include: RETURN_INCLUDE });
        await tx.afterSaleEvent.create({ data: { orderId, afterSaleReturnId: record!.id, action, actorAdminUserId: adminUserId, sourceApp: SourceApp.OPERATIONS, reason: note, beforeJson: before, afterJson: auditReturn(after), idempotencyKey: key, requestHash: hash } });
        await tx.auditLog.create({ data: { actorType: ActorType.EMPLOYEE, actorId: employeeId, actorAdminUserId: adminUserId, sourceApp: SourceApp.OPERATIONS, module: "after-sales", entityType: "AfterSaleReturn", entityId: record!.id, action, beforeJson: before, afterJson: auditReturn(after), reason: note } });
        return { returns: await tx.afterSaleReturn.findMany({ where: { orderId }, include: RETURN_INCLUDE, orderBy: { requestedAt: "asc" } }) };
      }, { timeout: 15000 });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new ConflictException("This item request or external refund reference has already been recorded.");
      throw error;
    }
  }

  /**
   * Stores one photo of the returned item. Photos are added while the return is
   * approved and waiting at the counter; accepting the item then requires at
   * least one of them. Nothing here changes the return's status.
   */
  async uploadPhoto(orderId: string, returnId: string, adminUserId: string, contentTypeHeader: string | undefined, body: Buffer) {
    const session = await this.access.requirePermission(adminUserId, "orders.after-sale");
    const contentType = returnPhotoContentType(contentTypeHeader, body.length);
    if (!this.storage) throw new InternalServerErrorException("Photo storage is not available.");
    const record = await prisma.afterSaleReturn.findFirst({ where: { id: returnId, orderId }, select: { id: true, status: true } });
    if (!record) throw new NotFoundException("Return was not found for this order.");
    if (record.status !== AfterSaleReturnStatus.APPROVED) throw new BadRequestException("Photos can only be added while the return is approved and waiting to be accepted.");
    if (await prisma.afterSaleReturnPhoto.count({ where: { afterSaleReturnId: record.id } }) >= RETURN_PHOTO_MAX) throw new BadRequestException(`A return can have at most ${RETURN_PHOTO_MAX} photos.`);
    const id = randomUUID();
    const objectName = this.storage.returnPhotoObjectName(record.id, id, contentType);
    await this.storage.upload(objectName, contentType, body);
    const photo = await prisma.afterSaleReturnPhoto.create({
      data: { id, afterSaleReturnId: record.id, storageUrl: `gs://${this.storage.bucket}/${objectName}`, contentType, sizeBytes: body.length, uploadedByAdminUserId: adminUserId },
      select: PHOTO_SELECT
    });
    await prisma.auditLog.create({ data: { actorType: ActorType.EMPLOYEE, actorId: session.adminUser?.linkedEmployeeId ?? null, actorAdminUserId: adminUserId, sourceApp: SourceApp.OPERATIONS, module: "after-sales", entityType: "AfterSaleReturn", entityId: record.id, action: "PHOTO_ADDED", beforeJson: {}, afterJson: json({ photoId: photo.id, contentType, sizeBytes: body.length }), reason: "Photo of returned item added." } });
    return { photo };
  }

  /** The people who handle returns and the people who approve refunds may look at the photos. */
  async photoContent(orderId: string, returnId: string, photoId: string, adminUserId: string) {
    if (!await this.access.hasPermission(adminUserId, "orders.view") && !await this.access.hasPermission(adminUserId, "customer-service.refund-approve")) {
      throw new ForbiddenException("This admin account does not have permission for this operation.");
    }
    if (!this.storage) throw new InternalServerErrorException("Photo storage is not available.");
    const photo = await prisma.afterSaleReturnPhoto.findFirst({ where: { id: photoId, afterSaleReturnId: returnId, afterSaleReturn: { orderId } }, select: { storageUrl: true } });
    const prefix = `gs://${this.storage.bucket}/`;
    if (!photo || !photo.storageUrl.startsWith(prefix)) throw new NotFoundException("Photo was not found.");
    return this.storage.download(photo.storageUrl.slice(prefix.length));
  }

  private async request(tx: Prisma.TransactionClient, order: Order, input: AfterSalesInput, adminUserId: string, note: string, now: Date) {
    if (order.status !== OrderStatus.COMPLETED || !order.payments.some((payment) => payment.status === PaymentStatus.SUCCESS)) throw new BadRequestException("A return requires a paid and completed order.");
    assertReturnWindow(order.fulfillment?.completedAt, now);
    if (!RETURN_REASONS.includes(input.reason as typeof RETURN_REASONS[number])) throw new BadRequestException("Select an eligible MVP return reason.");
    if (input.reason === "MEASUREMENT_DIFFERENCE" && (!Number.isFinite(input.measurementDifferenceCm) || input.measurementDifferenceCm! <= 3)) throw new BadRequestException("A measurement return requires a key measurement difference greater than 3 cm.");
    const item = order.items.find((row) => row.id === input.orderItemId);
    if (!item || item.quantity !== 1) throw new BadRequestException("Select one unique item belonging to this order.");
    if (order.afterSaleReturns.some((row) => row.orderItemId === item.id)) throw new ConflictException("This sold item already has an after-sales record; continue that record.");
    // A named store is where the customer is told to bring the item; it also
    // puts the return on that store's "to receive" list. Null keeps the old
    // behaviour, which was always the warehouse.
    const returnNodeId = input.returnNodeId?.trim() || null;
    if (returnNodeId && !await tx.fulfillmentNode.findFirst({ where: { id: returnNodeId, status: FulfillmentNodeStatus.ACTIVE }, select: { id: true } })) {
      throw new BadRequestException("Choose an active fulfillment node for the customer to return the item to.");
    }
    const ticket = await tx.customerServiceCase.create({ data: { orderId: order.id, customerId: order.customerId, createdByAdminUserId: adminUserId, issueType: CustomerServiceIssueType.AFTER_SALE, caseType: CustomerServiceCaseType.RETURN_REQUEST, title: `Return: ${item.snapshot?.title ?? item.id}`, description: note, afterSaleReason: input.reason, customerRequest: note, requiresReturn: true, requiresRefund: true, affectsAffiliateCommission: true } });
    return tx.afterSaleReturn.create({ data: { orderId: order.id, orderItemId: item.id, serviceCaseId: ticket.id, reason: input.reason as AfterSaleReturnReason, measurementDifferenceCm: input.reason === "MEASUREMENT_DIFFERENCE" ? input.measurementDifferenceCm : null, requestNote: note, returnNodeId, requestedByAdminUserId: adminUserId, requestedAt: now }, include: RETURN_INCLUDE });
  }

  private async refund(tx: Prisma.TransactionClient, order: Order, record: Return, input: AfterSalesInput, adminUserId: string, now: Date) {
    if (record.status !== AfterSaleReturnStatus.RECEIVED && record.status !== AfterSaleReturnStatus.REFUND_RECORDED) throw new BadRequestException("Record receipt and inspection before recording an external refund.");
    const externalReference = requiredText(input.externalReference, "External refund reference", 160).toUpperCase();
    const evidenceNote = requiredText(input.evidenceNote, "External refund verification evidence");
    const refundedAt = new Date(requiredText(input.refundedAt, "Actual refund timestamp", 50));
    if (!Number.isFinite(refundedAt.getTime()) || refundedAt > now || refundedAt < record.receivedAt!) throw new BadRequestException("Actual refund time must be after item receipt and cannot be in the future.");
    const itemRefunded = record.refunds.reduce((sum, row) => sum + row.amountKsh, 0);
    // A return accepted with photos has a refund request. The refund can only be
    // recorded once an approver other than the person who accepted the item has
    // approved it, and never for more than was approved.
    const requests = await tx.refundRequest.findMany({ where: { afterSaleReturnId: record.id }, select: { id: true, status: true, amountKsh: true } });
    const approvedRequest = approvedRequestFor(requests);
    if (refundNeedsApprovedRequest(await tx.afterSaleReturnPhoto.count({ where: { afterSaleReturnId: record.id } }), requests)) {
      if (!approvedRequest) throw new BadRequestException("This return needs an approved refund request before the refund is recorded. Approve it under Customer service > Refund approvals.");
      if (itemRefunded + (input.amountKsh ?? 0) > approvedRequest.amountKsh) throw new BadRequestException("The refund would exceed the amount that was approved.");
    }
    const totalRefunded = order.afterSaleReturns.flatMap((row) => row.refunds).reduce((sum, row) => sum + row.amountKsh, 0);
    const paymentAmount = order.payments.filter((row) => row.status === PaymentStatus.SUCCESS).reduce((sum, row) => sum + row.amountKsh, 0);
    assertRefundAmount(input.amountKsh, record.orderItem.lineTotalKsh, itemRefunded, order.totalKsh, totalRefunded, paymentAmount);
    const refundRecord = await tx.refundRecord.create({ data: { orderId: order.id, afterSaleReturnId: record.id, amountKsh: input.amountKsh, externalReference, evidenceNote, refundedAt, recordedByAdminUserId: adminUserId } });
    // The existing return policy has no negotiated partial-compensation settlement.
    // Keep the case and commission hold open until the sold item's full price is recorded.
    const fullyRefunded = itemRefunded + input.amountKsh === record.orderItem.lineTotalKsh;
    await tx.afterSaleReturn.update({ where: { id: record.id }, data: { status: fullyRefunded ? AfterSaleReturnStatus.REFUND_RECORDED : AfterSaleReturnStatus.RECEIVED } });
    if (fullyRefunded) await this.closeCase(tx, record.serviceCaseId, now);
    if (fullyRefunded && approvedRequest) {
      await tx.refundRequest.update({ where: { id: approvedRequest.id }, data: { status: RefundRequestStatus.REFUNDED, refundRecordId: refundRecord.id, completedAt: now } });
      await tx.auditLog.create({ data: { actorType: ActorType.EMPLOYEE, actorId: null, actorAdminUserId: adminUserId, sourceApp: SourceApp.OPERATIONS, module: "customer-service", entityType: "RefundRequest", entityId: approvedRequest.id, action: "REFUND_REQUEST_COMPLETE", beforeJson: { status: RefundRequestStatus.APPROVED }, afterJson: { status: RefundRequestStatus.REFUNDED, refundRecordId: refundRecord.id }, reason: input.evidenceNote ?? "" } });
    }
    if (totalRefunded + input.amountKsh === order.totalKsh) await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.REFUNDED } });
    const commission = order.commission;
    if (commission && !record.commissionAdjustment) {
      const original = commission.commissionAmountKsh + commission.adjustments.filter((row) => row.kind === CommissionAdjustmentKind.REVERSAL).reduce((sum, row) => sum + row.amountKsh, 0);
      const amount = commissionShares(order.items, original).get(record.orderItemId)!;
      const paid = commission.status === CommissionStatus.PAID;
      const afterAmount = paid ? commission.commissionAmountKsh : commission.commissionAmountKsh - amount;
      if (afterAmount < 0) throw new ConflictException("Commission adjustment is inconsistent; finance review is required.");
      await tx.commissionAdjustment.create({ data: { commissionId: commission.id, afterSaleReturnId: record.id, kind: paid ? CommissionAdjustmentKind.RECOVERY_REQUIRED : CommissionAdjustmentKind.REVERSAL, amountKsh: amount, beforeAmountKsh: commission.commissionAmountKsh, afterAmountKsh: afterAmount, recordedByAdminUserId: adminUserId } });
      if (!paid) await tx.commission.update({ where: { id: commission.id }, data: { commissionAmountKsh: afterAmount, ...(afterAmount === 0 ? { status: CommissionStatus.REJECTED, rejectedAt: now, holdReason: "All attributable items were refunded." } : {}) } });
    }
  }

  private async restock(tx: Prisma.TransactionClient, order: Order, record: Return, input: AfterSalesInput, adminUserId: string, employeeId: string | null, note: string, now: Date) {
    if (record.status !== AfterSaleReturnStatus.REFUND_RECORDED || !record.receivedAt || !record.restockable || record.restockedAt) throw new BadRequestException("Only an inspected restockable item with a recorded refund can be restocked once.");
    const locationCode = requiredText(input.locationCode, "Destination shelf code", 100);
    // Match existing shelf management lock order, then lock the unique inventory row.
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "WarehouseLocation" ORDER BY "id" FOR UPDATE`);
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "InventoryItem" WHERE "productId" = ${record.orderItem.productId} FOR UPDATE`);
    const inventory = await tx.inventoryItem.findUnique({ where: { productId: record.orderItem.productId } });
    if (!inventory || inventory.status !== InventoryItemStatus.DELIVERED || inventory.barcode !== record.receivedBarcode || inventory.updatedAt.getTime() !== record.inventoryUpdatedAt?.getTime()) throw new ConflictException("Inventory changed after receipt or is no longer the original delivered item. Review without overwriting it.");
    const newerSale = await tx.orderItem.findFirst({ where: {
      productId: inventory.productId, orderId: { not: order.id }, order: { OR: [
        { status: { in: [OrderStatus.PAID, OrderStatus.PENDING_PAYMENT, OrderStatus.PAYMENT_PROCESSING, OrderStatus.DEPOSIT_PAID, OrderStatus.FULFILLING] } },
        { status: OrderStatus.COMPLETED, OR: [
          { createdAt: { gte: order.createdAt } },
          { fulfillment: { completedAt: { gte: order.fulfillment!.completedAt! } } }
        ] }
      ] }
    } });
    if (newerSale) throw new ConflictException("This garment belongs to a newer reservation or sale; it cannot be restocked from this order.");
    const destination = await tx.warehouseLocation.findUnique({ where: { locationCode } });
    if (!destination?.active || destination.status === WarehouseLocationStatus.INACTIVE) throw new BadRequestException("Destination shelf is missing or inactive.");
    const count = await tx.inventoryItem.count({ where: { locationId: destination.id, status: { in: WAREHOUSE_OCCUPYING_STATUSES } } });
    if (count >= destination.capacity) throw new BadRequestException("Destination shelf is full.");
    const changed = await tx.inventoryItem.updateMany({ where: { id: inventory.id, status: InventoryItemStatus.DELIVERED, updatedAt: inventory.updatedAt }, data: { status: InventoryItemStatus.AVAILABLE, locationId: destination.id, checkedInAt: now } });
    if (changed.count !== 1) throw new ConflictException("Inventory changed; retry after reviewing current ownership.");
    const productBefore = await tx.product.findUniqueOrThrow({ where: { id: inventory.productId }, select: { status: true, publishedAt: true, approvedByEmployeeId: true } });
    await tx.product.update({ where: { id: inventory.productId }, data: { status: ProductStatus.REVIEW_PENDING, approvedByEmployeeId: null, publishedAt: null, unpublishedAt: now } });
    await tx.inventoryMovement.create({ data: { inventoryItemId: inventory.id, productId: inventory.productId, movementType: InventoryMovementType.STOCK_IN, fromLocationId: inventory.locationId, toLocationId: destination.id, employeeId, reason: `Return ${record.id}: ${note}` } });
    await refreshWarehouseLocationStatuses(tx, [inventory.locationId ?? "", destination.id]);
    await tx.auditLog.create({ data: { actorType: ActorType.EMPLOYEE, actorId: employeeId, actorAdminUserId: adminUserId, sourceApp: SourceApp.OPERATIONS, module: "after-sales", entityType: "InventoryItem", entityId: inventory.id, action: "RETURN_RESTOCKED", reason: note,
      beforeJson: json({ inventoryStatus: inventory.status, locationId: inventory.locationId, product: productBefore }),
      afterJson: { inventoryStatus: InventoryItemStatus.AVAILABLE, locationId: destination.id, productStatus: ProductStatus.REVIEW_PENDING, afterSaleReturnId: record.id }
    } });
    await tx.afterSaleReturn.update({ where: { id: record.id }, data: { restockedAt: now, restockedByAdminUserId: adminUserId, restockedLocationId: destination.id } });
  }

  private closeCase(tx: Prisma.TransactionClient, id: string, now: Date) {
    return tx.customerServiceCase.update({ where: { id }, data: { status: CustomerServiceCaseStatus.RESOLVED, resolvedAt: now, requiresReturn: false, requiresRefund: false, affectsAffiliateCommission: false } });
  }
}

function auditReturn(record: Return): Prisma.InputJsonValue { const { events: _events, ...state } = record; return json(state); }
function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}
