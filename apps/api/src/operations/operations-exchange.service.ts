import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ActorType, InventoryItemStatus, OrderExchangeKind, PaymentKind, PaymentStatus, Prisma, SourceApp, prisma } from "@online-saler/database";
import { OperationsAccessService } from "./operations-access.service";
import { assertCandidateAvailable, assertCanExchange, assertCommissionRecalculable, commissionForSubtotal, exchangePricing, exchangeReason } from "./operations-exchange.rules";
import { refreshWarehouseLocationStatuses } from "./warehouse-capacity";

export type ExchangeInput = { orderItemId?: string; newBarcode?: string; reason?: string; topUpAmountKsh?: number; topUpMpesaCode?: string };

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
        include: { items: { include: { fulfillmentItem: true, afterSaleReturn: { select: { id: true } } } }, fulfillment: { select: { status: true } }, commission: { select: { id: true, status: true, rateBps: true, payoutId: true } } }
      });
      if (!order) throw new NotFoundException("Order was not found.");
      const line = order.items.find((item) => item.id === orderItemId);
      if (!line) throw new NotFoundException("That item is not on this order.");

      const oldInventory = await tx.inventoryItem.findUnique({ where: { productId: line.productId }, select: { id: true, status: true, locationId: true } });
      assertCanExchange({
        orderStatus: order.status,
        fulfillmentStatus: order.fulfillment?.status ?? null,
        fulfillmentItemStatus: line.fulfillmentItem?.status ?? null,
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
      const released = await tx.inventoryItem.updateMany({
        where: { id: oldInventory!.id, status: InventoryItemStatus.PAID },
        data: { status: InventoryItemStatus.AVAILABLE }
      });
      if (released.count !== 1) throw new ConflictException("The item on this order changed while it was being exchanged. Reload and try again.");

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
        await tx.fulfillmentItem.update({
          where: { id: line.fulfillmentItem.id },
          data: { expectedBarcode: product.barcode?.trim() || null, scannedBarcode: null, verifiedByEmployeeId: null, verifiedAt: null }
        });
      }
      await refreshWarehouseLocationStatuses(tx, [oldInventory!.locationId ?? "", product.inventoryItem!.locationId ?? ""]);

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
