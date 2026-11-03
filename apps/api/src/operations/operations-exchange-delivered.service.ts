import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, ForbiddenException, Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { ActorType, InventoryItemStatus, InventoryMovementType, OrderExchangeKind, OrderExchangeStatus, Prisma, SourceApp, WarehouseLocationStatus, prisma } from "@online-saler/database";
import { ProductImageStorageService } from "../product/product-image-storage.service";
import { OperationsAccessService } from "./operations-access.service";
import { recordTopUpPayment } from "./operations-exchange.service";
import { assertReturnPhotoCount, RETURN_PHOTO_MAX, requiredText, returnPhotoContentType } from "./operations-after-sales.rules";
import {
  assertCandidateAvailable,
  assertCanExchangeDelivered,
  assertCommissionRecalculable,
  assertDifferentPeople,
  commissionForSubtotal,
  exchangePricing,
  exchangeReason,
  returnToExchangeDiscount
} from "./operations-exchange.rules";
import { PRODUCT_INCLUDE, snapshotData } from "./operations-exchange.service";
import { refreshWarehouseLocationStatuses, WAREHOUSE_OCCUPYING_STATUSES } from "./warehouse-capacity";

export type DeliveredExchangeInput = {
  orderItemId?: string;
  newBarcode?: string;
  reason?: string;
  returnToExchange?: boolean;
  discountReason?: string;
  topUpAmountKsh?: number;
  topUpMpesaCode?: string;
};
export type ReceiveExchangeInput = { receivedBarcode?: string; note?: string };
export type ReviewExchangeInput = { approved?: boolean; note?: string; locationCode?: string };
export type CancelExchangeInput = { note?: string };

/** Photo metadata only: the storage path never leaves the server. */
const PHOTO_SELECT = { id: true, contentType: true, sizeBytes: true, createdAt: true } as const;
/** An exchange in one of these states is still holding the new garment for the customer. */
const OPEN_STATUSES: OrderExchangeStatus[] = [OrderExchangeStatus.AWAITING_RETURN, OrderExchangeStatus.PENDING_REVIEW, OrderExchangeStatus.REJECTED];

/**
 * Exchanges on an order the customer already has (completed, within 3 days).
 *
 * The customer brings the old garment back to the counter and takes the new one
 * (that is the assumption: no courier leg). Steps, each its own call:
 *  1. request  - the new garment is held (PAID) and the price is settled; the order line is not touched yet.
 *  2. photos + receive - the old garment is scanned and photographed (1 to 5 photos).
 *  3. review   - a different person approves. Only then does the order line take the new
 *                garment, the old garment go straight back on a shelf as AVAILABLE (still
 *                listed, no re-review) and the new garment count as delivered.
 *  cancel      - releases the held garment if the exchange does not go ahead.
 */
@Injectable()
export class OperationsDeliveredExchangeService {
  constructor(private readonly access: OperationsAccessService, private readonly storage?: ProductImageStorageService) {}

  async list(orderId: string, adminUserId: string) {
    await this.access.requirePermission(adminUserId, "orders.view");
    const exchanges = await prisma.orderExchange.findMany({
      where: { orderId },
      orderBy: { createdAt: "asc" },
      include: { photos: { select: PHOTO_SELECT, orderBy: { createdAt: "asc" } } }
    });
    return { exchanges };
  }

  async request(orderId: string, input: DeliveredExchangeInput, adminUserId: string) {
    const session = await this.access.requirePermission(adminUserId, "orders.after-sale");
    const returnToExchange = input.returnToExchange === true;
    if (returnToExchange) await this.access.requirePermission(adminUserId, "action.customer-service.approve");
    const orderItemId = input.orderItemId?.trim();
    const barcode = input.newBarcode?.trim();
    if (!orderItemId) throw new BadRequestException("Choose the item to exchange.");
    if (!barcode) throw new BadRequestException("Scan or type the barcode of the new item.");
    const reason = exchangeReason(input.reason);
    if (!session.adminUser) throw new ForbiddenException("This admin account does not have permission for this operation.");
    const actor = session.adminUser;
    const now = new Date();

    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`);
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: { items: { include: { afterSaleReturn: { select: { id: true } } } }, fulfillment: { select: { completedAt: true } } }
      });
      if (!order) throw new NotFoundException("Order was not found.");
      const line = order.items.find((item) => item.id === orderItemId);
      if (!line) throw new NotFoundException("That item is not on this order.");
      const exchanges = await tx.orderExchange.findMany({ where: { orderId }, select: { orderItemId: true, kind: true, status: true } });
      const oldInventory = await tx.inventoryItem.findUnique({ where: { productId: line.productId }, select: { id: true, status: true } });
      assertCanExchangeDelivered({
        orderStatus: order.status,
        completedAt: order.fulfillment?.completedAt ?? null,
        now,
        inventoryStatus: oldInventory?.status ?? null,
        hasReturn: Boolean(line.afterSaleReturn),
        hasOpenExchange: exchanges.some((row) => row.orderItemId === line.id && OPEN_STATUSES.includes(row.status))
      });

      const product = await tx.product.findFirst({ where: { OR: [{ barcode }, { inventoryItem: { is: { barcode } } }] }, include: PRODUCT_INCLUDE });
      if (!product) throw new NotFoundException("No item has that barcode.");
      assertCandidateAvailable({
        status: product.status,
        priceKsh: product.priceKsh,
        inventoryStatus: product.inventoryItem?.status ?? null,
        alreadyOnOrder: order.items.some((item) => item.productId === product.id && item.id !== line.id),
        sameAsCurrent: product.id === line.productId
      });
      const discount = returnToExchangeDiscount({
        returnToExchange,
        discountReason: input.discountReason,
        alreadyUsedOnOrder: exchanges.some((row) => row.kind === OrderExchangeKind.RETURN_TO_EXCHANGE && row.status !== OrderExchangeStatus.CANCELLED)
      });
      const pricing = exchangePricing(line.unitPriceKsh, product.priceKsh!, { amountKsh: input.topUpAmountKsh, mpesaCode: input.topUpMpesaCode }, discount.discountKsh);
      if (pricing.topUpKsh > 0) {
        const usedOnExchange = await tx.orderExchange.findFirst({ where: { topUpMpesaCode: pricing.mpesaCode }, select: { id: true } });
        const usedOnPayment = await tx.payment.findFirst({ where: { providerReceiptNumber: pricing.mpesaCode }, select: { id: true } });
        if (usedOnExchange || usedOnPayment) throw new ConflictException("That M-Pesa code has already been used for another payment.");
      }

      const claimed = await tx.inventoryItem.updateMany({
        where: { id: product.inventoryItem!.id, status: InventoryItemStatus.AVAILABLE },
        data: { status: InventoryItemStatus.PAID }
      });
      if (claimed.count !== 1) throw new ConflictException("Another customer has just taken that item.");

      const exchange = await tx.orderExchange.create({
        data: {
          orderId,
          orderItemId: line.id,
          kind: returnToExchange ? OrderExchangeKind.RETURN_TO_EXCHANGE : OrderExchangeKind.STANDARD,
          status: OrderExchangeStatus.AWAITING_RETURN,
          oldProductId: line.productId,
          newProductId: product.id,
          oldPriceKsh: line.unitPriceKsh,
          newPriceKsh: product.priceKsh!,
          topUpKsh: pricing.topUpKsh,
          topUpMpesaCode: pricing.mpesaCode,
          discountKsh: pricing.discountKsh,
          discountReason: discount.discountReason,
          reason,
          performedByAdminUserId: actor.id
        }
      });
      if (pricing.topUpKsh > 0) await recordTopUpPayment(tx, { orderId, exchangeId: exchange.id, amountKsh: pricing.topUpKsh, mpesaCode: pricing.mpesaCode! });
      await this.audit(tx, actor, exchange.id, "EXCHANGE_REQUEST", reason, { orderItemId: line.id, oldProductId: line.productId }, { newProductId: product.id, topUpKsh: pricing.topUpKsh, discountKsh: pricing.discountKsh, kind: exchange.kind });
      return { exchange };
    });
  }

  async uploadPhoto(orderId: string, exchangeId: string, adminUserId: string, contentTypeHeader: string | undefined, body: Buffer) {
    const session = await this.access.requirePermission(adminUserId, "orders.after-sale");
    const contentType = returnPhotoContentType(contentTypeHeader, body.length);
    if (!this.storage) throw new InternalServerErrorException("Photo storage is not available.");
    const exchange = await prisma.orderExchange.findFirst({ where: { id: exchangeId, orderId }, select: { id: true, status: true } });
    if (!exchange) throw new NotFoundException("Exchange was not found for this order.");
    if (exchange.status !== OrderExchangeStatus.AWAITING_RETURN) throw new BadRequestException("Photos can only be added while the exchange is waiting for the old item to come back.");
    if (await prisma.orderExchangePhoto.count({ where: { orderExchangeId: exchange.id } }) >= RETURN_PHOTO_MAX) throw new BadRequestException(`An exchange can have at most ${RETURN_PHOTO_MAX} photos.`);
    const id = randomUUID();
    const objectName = this.storage.returnPhotoObjectName(`exchange-${exchange.id}`, id, contentType);
    await this.storage.upload(objectName, contentType, body);
    const photo = await prisma.orderExchangePhoto.create({
      data: { id, orderExchangeId: exchange.id, storageUrl: `gs://${this.storage.bucket}/${objectName}`, contentType, sizeBytes: body.length, uploadedByAdminUserId: adminUserId },
      select: PHOTO_SELECT
    });
    await prisma.auditLog.create({
      data: {
        actorType: ActorType.EMPLOYEE,
        actorId: session.adminUser?.linkedEmployeeId ?? null,
        actorAdminUserId: adminUserId,
        sourceApp: SourceApp.OPERATIONS,
        module: "after-sales",
        entityType: "OrderExchange",
        entityId: exchange.id,
        action: "EXCHANGE_PHOTO_ADDED",
        afterJson: { photoId: photo.id, sizeBytes: body.length },
        reason: "Photo of the old item added to an exchange."
      }
    });
    return { photo };
  }

  /** The people who handle exchanges and the people who approve them may look at the photos. */
  async photoContent(orderId: string, exchangeId: string, photoId: string, adminUserId: string) {
    if (!await this.access.hasPermission(adminUserId, "orders.view") && !await this.access.hasPermission(adminUserId, "action.customer-service.approve")) {
      throw new ForbiddenException("This admin account does not have permission for this operation.");
    }
    if (!this.storage) throw new InternalServerErrorException("Photo storage is not available.");
    const photo = await prisma.orderExchangePhoto.findFirst({ where: { id: photoId, orderExchangeId: exchangeId, orderExchange: { orderId } }, select: { storageUrl: true } });
    const prefix = `gs://${this.storage.bucket}/`;
    if (!photo || !photo.storageUrl.startsWith(prefix)) throw new NotFoundException("Photo was not found.");
    return this.storage.download(photo.storageUrl.slice(prefix.length));
  }

  async receive(orderId: string, exchangeId: string, input: ReceiveExchangeInput, adminUserId: string) {
    const session = await this.access.requirePermission(adminUserId, "orders.after-sale");
    if (!session.adminUser) throw new ForbiddenException("This admin account does not have permission for this operation.");
    const actor = session.adminUser;
    const note = requiredText(input.note, "Inspection note");
    const scanned = requiredText(input.receivedBarcode, "Scanned barcode of the returned item", 100);
    const exchange = await prisma.orderExchange.findFirst({ where: { id: exchangeId, orderId }, include: { photos: { select: { id: true } } } });
    if (!exchange) throw new NotFoundException("Exchange was not found for this order.");
    if (exchange.status !== OrderExchangeStatus.AWAITING_RETURN) throw new ConflictException("This exchange is not waiting for the old item.");
    assertReturnPhotoCount(exchange.photos.length);
    const inventory = await prisma.inventoryItem.findUnique({ where: { productId: exchange.oldProductId }, select: { barcode: true, product: { select: { barcode: true } } } });
    if (!inventory || (scanned !== inventory.barcode && scanned !== inventory.product.barcode)) throw new BadRequestException("The scanned barcode is not the item that was delivered.");
    return prisma.$transaction(async (tx) => {
      const changed = await tx.orderExchange.updateMany({
        where: { id: exchange.id, status: OrderExchangeStatus.AWAITING_RETURN },
        data: { status: OrderExchangeStatus.PENDING_REVIEW, receivedByAdminUserId: actor.id, receivedAt: new Date(), receivedBarcode: scanned, inspectionNote: note }
      });
      if (changed.count !== 1) throw new ConflictException("This exchange changed. Reload and try again.");
      await this.audit(tx, actor, exchange.id, "EXCHANGE_RECEIVED", note, { status: exchange.status }, { status: OrderExchangeStatus.PENDING_REVIEW, photos: exchange.photos.length });
      return { exchange: await tx.orderExchange.findUniqueOrThrow({ where: { id: exchange.id }, include: { photos: { select: PHOTO_SELECT } } }) };
    });
  }

  async review(orderId: string, exchangeId: string, input: ReviewExchangeInput, adminUserId: string) {
    await this.access.requirePermission(adminUserId, "orders.after-sale");
    const session = await this.access.requirePermission(adminUserId, "action.customer-service.approve");
    if (!session.adminUser) throw new ForbiddenException("This admin account does not have permission for this operation.");
    const actor = session.adminUser;
    const note = requiredText(input.note, "Review note");
    if (typeof input.approved !== "boolean") throw new BadRequestException("Say whether the old item is accepted.");
    const approved = input.approved;
    const locationCode = approved ? requiredText(input.locationCode, "Shelf code to put the old item back on", 100) : null;
    const now = new Date();

    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`);
      const exchange = await tx.orderExchange.findFirst({ where: { id: exchangeId, orderId } });
      if (!exchange) throw new NotFoundException("Exchange was not found for this order.");
      if (exchange.status !== OrderExchangeStatus.PENDING_REVIEW) throw new ConflictException("This exchange is not waiting for review.");
      assertDifferentPeople(exchange.receivedByAdminUserId, actor.id);

      if (!approved) {
        await tx.orderExchange.update({
          where: { id: exchange.id },
          data: { status: OrderExchangeStatus.REJECTED, reviewedByAdminUserId: actor.id, reviewedAt: now, reviewNote: note }
        });
        await this.audit(tx, actor, exchange.id, "EXCHANGE_REJECTED", note, { status: exchange.status }, { status: OrderExchangeStatus.REJECTED });
        return { exchange: await tx.orderExchange.findUniqueOrThrow({ where: { id: exchange.id } }) };
      }

      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: { items: { include: { fulfillmentItem: true } }, commission: { select: { id: true, status: true, rateBps: true, payoutId: true, commissionAmountKsh: true } } }
      });
      if (!order) throw new NotFoundException("Order was not found.");
      const line = order.items.find((item) => item.id === exchange.orderItemId);
      if (!line || line.productId !== exchange.oldProductId) throw new ConflictException("The order changed after this exchange was requested.");

      // Same lock order as the restock flow: shelves, then the two inventory rows.
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "WarehouseLocation" ORDER BY "id" FOR UPDATE`);
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "InventoryItem" WHERE "productId" IN (${Prisma.join([exchange.oldProductId, exchange.newProductId])}) ORDER BY "id" FOR UPDATE`);
      const oldInventory = await tx.inventoryItem.findUnique({ where: { productId: exchange.oldProductId } });
      const newInventory = await tx.inventoryItem.findUnique({ where: { productId: exchange.newProductId } });
      if (!oldInventory || oldInventory.status !== InventoryItemStatus.DELIVERED) throw new ConflictException("The old item is no longer marked as delivered. Check the stock before approving.");
      if (!newInventory || newInventory.status !== InventoryItemStatus.PAID) throw new ConflictException("The held new item is no longer held for this exchange. Check the stock before approving.");

      const destination = await tx.warehouseLocation.findUnique({ where: { locationCode: locationCode! } });
      if (!destination?.active || destination.status === WarehouseLocationStatus.INACTIVE) throw new BadRequestException("Destination shelf is missing or inactive.");
      const occupied = await tx.inventoryItem.count({ where: { locationId: destination.id, status: { in: WAREHOUSE_OCCUPYING_STATUSES } } });
      if (occupied >= destination.capacity) throw new BadRequestException("Destination shelf is full.");

      // The old item goes straight back on sale: it was photographed and checked, so no re-review.
      const putBack = await tx.inventoryItem.updateMany({
        where: { id: oldInventory.id, status: InventoryItemStatus.DELIVERED },
        data: { status: InventoryItemStatus.AVAILABLE, locationId: destination.id }
      });
      if (putBack.count !== 1) throw new ConflictException("Inventory changed; reload and try again.");
      const handedOver = await tx.inventoryItem.updateMany({
        where: { id: newInventory.id, status: InventoryItemStatus.PAID },
        data: { status: InventoryItemStatus.DELIVERED }
      });
      if (handedOver.count !== 1) throw new ConflictException("Inventory changed; reload and try again.");
      await tx.inventoryMovement.create({
        data: {
          inventoryItemId: oldInventory.id,
          productId: oldInventory.productId,
          movementType: InventoryMovementType.STOCK_IN,
          fromLocationId: oldInventory.locationId,
          toLocationId: destination.id,
          employeeId: actor.linkedEmployeeId ?? null,
          reason: `Old item put back after exchange ${exchange.id}`
        }
      });
      await refreshWarehouseLocationStatuses(tx, [oldInventory.locationId ?? "", destination.id, newInventory.locationId ?? ""]);

      // What the customer actually paid for this line: the old price plus what they topped up.
      const linePrice = exchange.oldPriceKsh + exchange.topUpKsh;
      const product = await tx.product.findUniqueOrThrow({ where: { id: exchange.newProductId }, include: PRODUCT_INCLUDE });
      await tx.orderItem.update({ where: { id: line.id }, data: { productId: product.id, unitPriceKsh: linePrice, lineTotalKsh: linePrice } });
      await tx.orderSnapshot.update({ where: { orderItemId: line.id }, data: snapshotData(product, linePrice) });
      if (line.fulfillmentItem) {
        await tx.fulfillmentItem.update({
          where: { id: line.fulfillmentItem.id },
          data: { expectedBarcode: product.barcode?.trim() || null, scannedBarcode: product.barcode?.trim() || null }
        });
      }

      let commissionNote = "unchanged";
      if (exchange.topUpKsh > 0) {
        const newSubtotal = order.itemSubtotalKsh + exchange.topUpKsh;
        await tx.order.update({ where: { id: order.id }, data: { itemSubtotalKsh: newSubtotal, totalKsh: order.totalKsh + exchange.topUpKsh } });
        const commission = order.commission;
        if (commission && commission.status !== "REJECTED") {
          if (commission.status === "PAID" || commission.payoutId) {
            // Already paid out (or in a payout batch): the paid amount stays as it is, and one
            // signed line is recorded for the next payout export so finance can settle the difference.
            const delta = commissionForSubtotal(newSubtotal, commission.rateBps) - commission.commissionAmountKsh;
            if (delta !== 0) {
              await tx.commissionExchangeAdjustment.create({
                data: {
                  commissionId: commission.id,
                  orderExchangeId: exchange.id,
                  amountKsh: delta,
                  beforeAmountKsh: commission.commissionAmountKsh,
                  afterAmountKsh: commission.commissionAmountKsh + delta,
                  recordedByAdminUserId: actor.id
                }
              });
            }
            commissionNote = delta !== 0 ? `already paid out; adjustment of KSh ${delta} recorded for the next payout export` : "already paid out; no difference";
          } else if (assertCommissionRecalculable(commission)) {
            await tx.commission.update({
              where: { id: commission.id },
              data: { orderSubtotalKsh: newSubtotal, commissionAmountKsh: commissionForSubtotal(newSubtotal, commission.rateBps) }
            });
            commissionNote = "recalculated";
          }
        }
      }

      await tx.orderExchange.update({
        where: { id: exchange.id },
        data: { status: OrderExchangeStatus.COMPLETED, reviewedByAdminUserId: actor.id, reviewedAt: now, reviewNote: note, completedAt: now }
      });
      await this.audit(tx, actor, exchange.id, "EXCHANGE_APPROVED", note, { orderItemId: line.id, productId: exchange.oldProductId, priceKsh: line.unitPriceKsh }, {
        orderItemId: line.id,
        productId: exchange.newProductId,
        priceKsh: linePrice,
        topUpKsh: exchange.topUpKsh,
        discountKsh: exchange.discountKsh,
        oldItemShelf: destination.locationCode,
        commission: commissionNote
      });
      return { exchange: await tx.orderExchange.findUniqueOrThrow({ where: { id: exchange.id } }) };
    });
  }

  /** The exchange does not go ahead: the held new garment goes back on sale. Any top-up already collected has to be refunded by hand. */
  async cancel(orderId: string, exchangeId: string, input: CancelExchangeInput, adminUserId: string) {
    const session = await this.access.requirePermission(adminUserId, "orders.after-sale");
    if (!session.adminUser) throw new ForbiddenException("This admin account does not have permission for this operation.");
    const actor = session.adminUser;
    const note = requiredText(input.note, "Cancellation note");
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`);
      const exchange = await tx.orderExchange.findFirst({ where: { id: exchangeId, orderId } });
      if (!exchange) throw new NotFoundException("Exchange was not found for this order.");
      if (!OPEN_STATUSES.includes(exchange.status)) throw new ConflictException("This exchange is already finished or cancelled.");
      const released = await tx.inventoryItem.updateMany({
        where: { productId: exchange.newProductId, status: InventoryItemStatus.PAID },
        data: { status: InventoryItemStatus.AVAILABLE }
      });
      if (released.count !== 1) throw new ConflictException("The held item is no longer held for this exchange. Check the stock.");
      await tx.orderExchange.update({ where: { id: exchange.id }, data: { status: OrderExchangeStatus.CANCELLED } });
      await this.audit(tx, actor, exchange.id, "EXCHANGE_CANCELLED", note, { status: exchange.status }, { status: OrderExchangeStatus.CANCELLED, refundDueKsh: exchange.topUpKsh });
      return { exchange: await tx.orderExchange.findUniqueOrThrow({ where: { id: exchange.id } }), refundDueKsh: exchange.topUpKsh };
    });
  }

  private async audit(
    tx: Prisma.TransactionClient,
    actor: { id: string; linkedEmployeeId?: string | null },
    entityId: string,
    action: string,
    reason: string,
    beforeJson: Prisma.InputJsonValue,
    afterJson: Prisma.InputJsonValue
  ) {
    await tx.auditLog.create({
      data: {
        actorType: ActorType.EMPLOYEE,
        actorId: actor.linkedEmployeeId ?? null,
        actorAdminUserId: actor.id,
        sourceApp: SourceApp.OPERATIONS,
        module: "after-sales",
        entityType: "OrderExchange",
        entityId,
        action,
        beforeJson,
        afterJson,
        reason
      }
    });
  }
}
