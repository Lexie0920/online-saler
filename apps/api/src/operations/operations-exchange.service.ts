import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ActorType, FulfillmentItemStatus, FulfillmentStatus, InventoryItemStatus, InventoryMovementType, OrderExchangeKind, PaymentKind, PaymentStatus, Prisma, SourceApp, WarehouseLocationStatus, prisma } from "@online-saler/database";
import { OperationsAccessService } from "./operations-access.service";
import { assertCandidateAvailable, assertCanExchange, assertCommissionRecalculable, commissionForSubtotal, exchangePricing, exchangeReason, exchangeReopensPicking, oldItemLeftShelf } from "./operations-exchange.rules";
import { refreshWarehouseLocationStatuses, WAREHOUSE_OCCUPYING_STATUSES } from "./warehouse-capacity";

export type ExchangeInput = { orderItemId?: string; newBarcode?: string; reason?: string; topUpAmountKsh?: number; topUpMpesaCode?: string;
  /** Where the old garment goes back when it had already been taken off its shelf for picking or packing. Defaults to its own shelf. */
  oldItemLocationCode?: string };

/**
 * Records the money a customer paid for an exchange as a settled Payment, so it
 * counts as cash received and the order's payments still cover its (raised) total.
 * The phone is the number the order was first paid from. Nothing is sent to M-Pesa.
 */
export async function recordTopUpPayment(
  tx: Prisma.TransactionClient,
  input: { orderId: string; exchangeId: string; amountKsh: number; mpesaCode: string }
) {
  const earlier = await tx.payment.findFirst({ where: { orderId: input.orderId }, orderBy: { requestedAt: "asc" }, select: { phone: true } });
  if (!earlier) throw new BadRequestException("This order has no payment on record to attach the top-up to.");
  const now = new Date();
  return tx.payment.create({
    data: {
      orderId: input.orderId,
      kind: PaymentKind.EXCHANGE_TOPUP,
      status: PaymentStatus.SUCCESS,
      amountKsh: input.amountKsh,
      phone: earlier.phone,
      idempotencyKey: `exchange-topup:${input.exchangeId}`,
      providerReceiptNumber: input.mpesaCode,
      providerResultDescription: "Recorded by staff for an exchange",
      requestedAt: now,
      completedAt: now
    }
  });
}

export const PRODUCT_INCLUDE = {
  images: { orderBy: { sortOrder: "asc" as const }, take: 1 },
  measurements: true,
  defects: true,
  inventoryItem: true
} as const;

type ExchangeProduct = Prisma.ProductGetPayload<{ include: typeof PRODUCT_INCLUDE }>;

/** What the order line shows the customer for a garment, the same fields checkout records. */
export function snapshotData(product: ExchangeProduct, priceKsh: number) {
  return {
    productCode: product.productCode,
    barcode: product.barcode,
    title: product.title || "Second-hand item",
    category: product.category,
    subcategory: product.subcategory,
    brand: product.brand,
    color: product.color,
    sizeLabel: product.finalSizeLabel || product.tagSize,
    conditionGrade: product.conditionGrade,
    imageUrl: product.images[0]?.publicUrl || product.images[0]?.originalUrl || null,
    measurements: product.measurements.map((item) => ({ type: item.measurementType, valueCm: item.finalValueCm?.toString() || null })),
    defects: product.defects.map((item) => ({ type: item.defectType, severity: item.severity, description: item.customerSafeDescription || item.description })),
    unitPriceKsh: priceKsh
  };
}

/**
 * Swaps one garment on a paid order for another.
 *
 * The order line keeps its place and takes the new garment, so the order's
 * totals, payments and commission are untouched (step 1 is same-price only).
 * What changes: the stock of both garments, the line's snapshot (what the
 * customer is shown), the picking task's expected barcode, and one
 * OrderExchange row that remembers what was swapped and why.
 *
 * It all happens in one transaction under the order lock: either every part
 * lands or none does. The new garment is claimed with a conditional update, so
 * two people swapping to the same garment at once cannot both win.
 */
@Injectable()
export class OperationsExchangeService {
  constructor(private readonly access: OperationsAccessService) {}

  async exchange(orderId: string, input: ExchangeInput, adminUserId: string) {
    const session = await this.access.requirePermission(adminUserId, "orders.after-sale");
    const orderItemId = input.orderItemId?.trim();
    const barcode = input.newBarcode?.trim();
    if (!orderItemId) throw new BadRequestException("Choose the item to exchange.");
    if (!barcode) throw new BadRequestException("Scan or type the barcode of the new item.");
    const reason = exchangeReason(input.reason);
    if (!session.adminUser) throw new ForbiddenException("This admin account does not have permission for this operation.");

    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`);
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: { items: { include: { fulfillmentItem: true, afterSaleReturn: { select: { id: true } } } }, fulfillment: { select: { id: true, status: true, currentHolderType: true } }, commission: { select: { id: true, status: true, rateBps: true, payoutId: true } } }
      });
      if (!order) throw new NotFoundException("Order was not found.");
      const line = order.items.find((item) => item.id === orderItemId);
      if (!line) throw new NotFoundException("That item is not on this order.");

      const oldInventory = await tx.inventoryItem.findUnique({ where: { productId: line.productId }, select: { id: true, productId: true, status: true, locationId: true } });
      assertCanExchange({
        orderStatus: order.status,
        fulfillmentStatus: order.fulfillment?.status ?? null,
        holderType: order.fulfillment?.currentHolderType ?? null,
        inventoryStatus: oldInventory?.status ?? null,
        hasReturn: Boolean(line.afterSaleReturn)
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
      const pricing = exchangePricing(line.unitPriceKsh, product.priceKsh!, { amountKsh: input.topUpAmountKsh, mpesaCode: input.topUpMpesaCode });
      let recalculateCommission = false;
      if (pricing.topUpKsh > 0) {
        recalculateCommission = assertCommissionRecalculable(order.commission);
        // One M-Pesa payment can cover one top-up, and cannot be a payment the shop already recorded.
        const usedOnExchange = await tx.orderExchange.findFirst({ where: { topUpMpesaCode: pricing.mpesaCode }, select: { id: true } });
        const usedOnPayment = await tx.payment.findFirst({ where: { providerReceiptNumber: pricing.mpesaCode }, select: { id: true } });
        if (usedOnExchange || usedOnPayment) throw new ConflictException("That M-Pesa code has already been used for another payment.");
      }

      // Claim the new garment first: if somebody else just took it, nothing else has moved yet.
      const claimed = await tx.inventoryItem.updateMany({
        where: { id: product.inventoryItem!.id, status: InventoryItemStatus.AVAILABLE },
        data: { status: InventoryItemStatus.PAID }
      });
      if (claimed.count !== 1) throw new ConflictException("Another customer has just taken that item.");
      // The old garment goes back on sale. If it was still on its shelf (nothing picked yet) it simply
      // changes status. If it had been taken off the shelf for picking or packing, it is put back on a shelf.
      const leftShelf = oldItemLeftShelf(oldInventory!.status);
      let destinationId = oldInventory!.locationId;
      if (leftShelf) {
        const code = input.oldItemLocationCode?.trim();
        const destination = code
          ? await tx.warehouseLocation.findUnique({ where: { locationCode: code } })
          : oldInventory!.locationId ? await tx.warehouseLocation.findUnique({ where: { id: oldInventory!.locationId } }) : null;
        if (!destination) throw new BadRequestException("The old item was already taken off its shelf. Enter the shelf code it is being put back on.");
        if (!destination.active || destination.status === WarehouseLocationStatus.INACTIVE) throw new BadRequestException("The shelf for the old item is inactive. Enter another shelf code.");
        const occupied = await tx.inventoryItem.count({ where: { locationId: destination.id, status: { in: WAREHOUSE_OCCUPYING_STATUSES } } });
        if (occupied >= destination.capacity) throw new BadRequestException("The shelf for the old item is full. Enter another shelf code.");
        destinationId = destination.id;
      }
      const released = await tx.inventoryItem.updateMany({
        where: { id: oldInventory!.id, status: oldInventory!.status },
        data: { status: InventoryItemStatus.AVAILABLE, ...(leftShelf ? { locationId: destinationId } : {}) }
      });
      if (released.count !== 1) throw new ConflictException("The item on this order changed while it was being exchanged. Reload and try again.");
      if (leftShelf) {
        await tx.inventoryMovement.create({
          data: {
            inventoryItemId: oldInventory!.id,
            productId: oldInventory!.productId,
            movementType: InventoryMovementType.STOCK_IN,
            fromLocationId: oldInventory!.locationId,
            toLocationId: destinationId,
            employeeId: session.adminUser!.linkedEmployeeId ?? null,
            reason: `Old item put back after exchange: ${reason}`
          }
        });
      }

      await tx.orderItem.update({
        where: { id: line.id },
        data: { productId: product.id, ...(pricing.topUpKsh > 0 ? { unitPriceKsh: product.priceKsh!, lineTotalKsh: product.priceKsh! } : {}) }
      });
      if (pricing.topUpKsh > 0) {
        const newSubtotal = order.itemSubtotalKsh + pricing.topUpKsh;
        await tx.order.update({ where: { id: order.id }, data: { itemSubtotalKsh: newSubtotal, totalKsh: order.totalKsh + pricing.topUpKsh } });
        if (recalculateCommission && order.commission) {
          await tx.commission.update({
            where: { id: order.commission.id },
            data: { orderSubtotalKsh: newSubtotal, commissionAmountKsh: commissionForSubtotal(newSubtotal, order.commission.rateBps) }
          });
        }
      }
      await tx.orderSnapshot.update({
        where: { orderItemId: line.id },
        data: {
          productCode: product.productCode,
          barcode: product.barcode,
          title: product.title || "Second-hand item",
          category: product.category,
          subcategory: product.subcategory,
          brand: product.brand,
          color: product.color,
          sizeLabel: product.finalSizeLabel || product.tagSize,
          conditionGrade: product.conditionGrade,
          imageUrl: product.images[0]?.publicUrl || product.images[0]?.originalUrl || null,
          measurements: product.measurements.map((item) => ({ type: item.measurementType, valueCm: item.finalValueCm?.toString() || null })),
          defects: product.defects.map((item) => ({ type: item.defectType, severity: item.severity, description: item.customerSafeDescription || item.description })),
          unitPriceKsh: product.priceKsh!
        }
      });
      if (line.fulfillmentItem) {
        // The new garment has to be scanned at picking, whatever had been verified before.
        await tx.fulfillmentItem.update({
          where: { id: line.fulfillmentItem.id },
          data: { expectedBarcode: product.barcode?.trim() || null, status: FulfillmentItemStatus.PENDING, scannedBarcode: null, verifiedByEmployeeId: null, verifiedAt: null }
        });
      }
      const fulfillment = order.fulfillment;
      let reopened = false;
      if (fulfillment && exchangeReopensPicking(fulfillment.status)) {
        reopened = true;
        // Picking and packing were finished for the old set of garments. Re-open picking: the other
        // garments stay scanned but go back to "held for the order" so the normal scan of the new one
        // can finish picking, and the parcel is packed again.
        await tx.inventoryItem.updateMany({
          where: { productId: { in: order.items.filter((item) => item.id !== line.id).map((item) => item.productId) }, status: { in: [InventoryItemStatus.PICKED, InventoryItemStatus.PACKED] } },
          data: { status: InventoryItemStatus.PAID }
        });
        await tx.orderFulfillment.update({
          where: { id: fulfillment.id },
          data: {
            status: FulfillmentStatus.PICKING,
            pickedAt: null,
            packingStartedAt: null,
            packingStartedByEmployeeId: null,
            packedAt: null,
            packedByEmployeeId: null,
            packagingMethod: null,
            packageCount: null,
            packingStatus: null,
            packingNote: null,
            readyForPickupAt: null,
            readyForDispatchAt: null
          }
        });
      }
      if (fulfillment) {
        await tx.fulfillmentEvent.create({
          data: {
            fulfillmentId: fulfillment.id,
            orderId: order.id,
            actorAdminUserId: session.adminUser!.id,
            actorEmployeeId: session.adminUser!.linkedEmployeeId ?? null,
            orderItemId: line.id,
            action: reopened ? "EXCHANGE_REOPENED_PICKING" : "ITEM_EXCHANGED",
            oldStatus: fulfillment.status,
            newStatus: reopened ? FulfillmentStatus.PICKING : fulfillment.status,
            note: reason,
            expectedBarcode: product.barcode?.trim() || null
          }
        });
      }
      await refreshWarehouseLocationStatuses(tx, [oldInventory!.locationId ?? "", destinationId ?? "", product.inventoryItem!.locationId ?? ""]);

      const exchange = await tx.orderExchange.create({
        data: {
          orderId,
          orderItemId: line.id,
          kind: OrderExchangeKind.STANDARD,
          oldProductId: line.productId,
          newProductId: product.id,
          oldPriceKsh: line.unitPriceKsh,
          newPriceKsh: product.priceKsh!,
          topUpKsh: pricing.topUpKsh,
          topUpMpesaCode: pricing.mpesaCode,
          reason,
          performedByAdminUserId: session.adminUser!.id
        }
      });
      if (pricing.topUpKsh > 0) await recordTopUpPayment(tx, { orderId: order.id, exchangeId: exchange.id, amountKsh: pricing.topUpKsh, mpesaCode: pricing.mpesaCode! });
      await tx.auditLog.create({
        data: {
          actorType: ActorType.EMPLOYEE,
          actorId: session.adminUser!.linkedEmployeeId ?? null,
          actorAdminUserId: session.adminUser!.id,
          sourceApp: SourceApp.OPERATIONS,
          module: "after-sales",
          entityType: "OrderExchange",
          entityId: exchange.id,
          action: "EXCHANGE_ITEM",
          beforeJson: { orderItemId: line.id, productId: line.productId, priceKsh: line.unitPriceKsh },
          afterJson: { orderItemId: line.id, productId: product.id, priceKsh: product.priceKsh!, barcode: product.barcode ?? product.inventoryItem!.barcode, topUpKsh: pricing.topUpKsh, topUpMpesaCode: pricing.mpesaCode },
          reason
        }
      });
      return { exchange };
    });
  }
}
