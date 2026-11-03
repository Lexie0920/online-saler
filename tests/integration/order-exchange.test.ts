import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const testDatabaseUrl = process.env.MVP_INTEGRATION_DATABASE_URL;

/** A fresh, valid-looking M-Pesa transaction code: 10 letters and digits. */
function mpesaCode() {
  return randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();
}

test("exchanges: top-up recorded as a payment, commission follows what was paid, delivered flow with review", { skip: !testDatabaseUrl, timeout: 120_000 }, async (t) => {
  const target = new URL(testDatabaseUrl!);
  assert.ok(["localhost", "127.0.0.1"].includes(target.hostname), "Integration database must be local.");
  assert.match(target.pathname, /test|ci/i, "Integration database name must identify a disposable test database.");
  process.env.DATABASE_URL = testDatabaseUrl;
  const { prisma } = await import("@online-saler/database");
  const { OperationsAccessService } = await import("../../apps/api/src/operations/operations-access.service");
  const { OperationsExchangeService } = await import("../../apps/api/src/operations/operations-exchange.service");
  const { OperationsDeliveredExchangeService } = await import("../../apps/api/src/operations/operations-exchange-delivered.service");
  t.after(async () => { await prisma.$disconnect(); });

  const runId = randomUUID();
  async function permission(code: string) {
    return prisma.permission.upsert({ where: { code }, update: {}, create: { code, module: "orders" } });
  }
  async function staff(name: string, codes: string[]) {
    const permissions = await Promise.all(codes.map(permission));
    const role = await prisma.role.create({ data: {
      code: `EXCH_${name}_${runId}`, name: `Exchange test ${name}`,
      permissions: { create: permissions.map((row) => ({ permissionId: row.id })) }
    } });
    const employee = await prisma.employee.create({ data: { employeeCode: `exch-${name}-${runId}`, name: `Exchange ${name}` } });
    return prisma.adminUser.create({ data: {
      loginAccount: `exch-${name}-${runId}`, name: `Exchange ${name}`, linkedEmployeeId: employee.id, roles: { create: { roleId: role.id } }
    } });
  }
  const counter = await staff("counter", ["orders.view", "orders.after-sale"]);
  const approver = await staff("approver", ["orders.view", "orders.after-sale", "action.customer-service.approve"]);
  const customer = await prisma.customer.create({ data: {
    googleSubjectId: runId, email: `${runId}@example.test`, normalizedEmail: `${runId}@example.test`
  } });
  const affiliate = await prisma.affiliate.create({ data: {
    affiliateCode: `EXCH-${runId}`, slug: `exch-${runId}`, displayName: "Exchange affiliate", commissionRateBps: 3000
  } });
  const shelf = await prisma.warehouseLocation.create({ data: { locationCode: `exch-shelf-${runId}`, capacity: 50 } });
  const access = new OperationsAccessService();
  const ordinary = new OperationsExchangeService(access);
  const delivered = new OperationsDeliveredExchangeService(access);

  async function product(priceKsh: number, inventoryStatus: "AVAILABLE" | "PAID" | "DELIVERED") {
    const barcode = `exch-${randomUUID()}`;
    return prisma.product.create({ data: {
      productCode: barcode, barcode, status: "PUBLISHED", title: `Exchange garment ${priceKsh}`,
      description: "Exchange integration garment", category: "TOPS", finalSizeLabel: "M", conditionGrade: "GOOD", priceKsh,
      publishedAt: new Date(),
      inventoryItem: { create: { barcode, status: inventoryStatus, locationId: shelf.id, checkedInAt: new Date() } }
    } });
  }

  /** A one-garment order paid in full, with the commission the checkout would have created. */
  async function order(old: { id: string; barcode: string | null; productCode: string }, priceKsh: number, options: { delivered?: boolean; commissionPaid?: boolean } = {}) {
    const commissionAmountKsh = Math.round((priceKsh * 3000) / 10000);
    return prisma.order.create({ data: {
      orderNumber: `EXCH-${randomUUID()}`, customerId: customer.id, affiliateId: affiliate.id,
      status: options.delivered ? "COMPLETED" : "PAID", fulfillmentMethod: "PICKUP", itemSubtotalKsh: priceKsh, totalKsh: priceKsh,
      items: { create: {
        productId: old.id, unitPriceKsh: priceKsh, lineTotalKsh: priceKsh,
        snapshot: { create: { productCode: old.productCode, barcode: old.barcode, title: "Old garment", unitPriceKsh: priceKsh } }
      } },
      payments: { create: { status: "SUCCESS", amountKsh: priceKsh, phone: "254700000000", idempotencyKey: `exch-test-${randomUUID()}`, completedAt: new Date() } },
      ...(options.delivered ? { fulfillment: { create: { status: "COMPLETED", completedAt: new Date(Date.now() - 60 * 60 * 1000) } } } : {}),
      commission: { create: {
        affiliateId: affiliate.id, status: options.commissionPaid ? "PAID" : "PENDING", rateBps: 3000,
        orderSubtotalKsh: priceKsh, commissionAmountKsh, ...(options.commissionPaid ? { paidAt: new Date() } : {})
      } }
    }, include: { items: true } });
  }

  await t.test("a dearer garment: the top-up becomes a payment and the commission follows what was paid", async () => {
    const oldProduct = await product(400, "PAID");
    const newProduct = await product(550, "AVAILABLE");
    const created = await order(oldProduct, 400);
    const code = mpesaCode();
    await ordinary.exchange(created.id, { orderItemId: created.items[0].id, newBarcode: newProduct.barcode!, reason: "Customer prefers the coat", topUpAmountKsh: 150, topUpMpesaCode: code }, counter.id);

    const stored = await prisma.order.findUniqueOrThrow({ where: { id: created.id }, include: { payments: true, commission: true, items: { include: { snapshot: true } } } });
    assert.equal(stored.totalKsh, 550);
    assert.equal(stored.itemSubtotalKsh, 550);
    assert.equal(stored.items[0].productId, newProduct.id);
    assert.equal(stored.items[0].unitPriceKsh, 550);
    assert.equal(stored.commission!.commissionAmountKsh, 165);
    assert.equal(stored.commission!.orderSubtotalKsh, 550);
    const topUp = stored.payments.filter((row) => row.kind === "EXCHANGE_TOPUP");
    assert.equal(topUp.length, 1);
    assert.equal(topUp[0].status, "SUCCESS");
    assert.equal(topUp[0].amountKsh, 150);
    assert.equal(topUp[0].providerReceiptNumber, code);
    assert.equal(stored.payments.filter((row) => row.status === "SUCCESS").reduce((sum, row) => sum + row.amountKsh, 0), stored.totalKsh);
    assert.equal((await prisma.inventoryItem.findUniqueOrThrow({ where: { productId: oldProduct.id } })).status, "AVAILABLE");
    assert.equal((await prisma.inventoryItem.findUniqueOrThrow({ where: { productId: newProduct.id } })).status, "PAID");

    // The same M-Pesa code cannot cover a second exchange.
    const otherOld = await product(400, "PAID");
    const otherNew = await product(550, "AVAILABLE");
    const other = await order(otherOld, 400);
    await assert.rejects(
      ordinary.exchange(other.id, { orderItemId: other.items[0].id, newBarcode: otherNew.barcode!, reason: "Same code again", topUpAmountKsh: 150, topUpMpesaCode: code }, counter.id),
      /already been used/
    );
    assert.equal((await prisma.inventoryItem.findUniqueOrThrow({ where: { productId: otherNew.id } })).status, "AVAILABLE");
  });

  await t.test("a top-up that is not the whole difference changes nothing", async () => {
    const oldProduct = await product(400, "PAID");
    const newProduct = await product(550, "AVAILABLE");
    const created = await order(oldProduct, 400);
    await assert.rejects(
      ordinary.exchange(created.id, { orderItemId: created.items[0].id, newBarcode: newProduct.barcode!, reason: "Short payment", topUpAmountKsh: 100, topUpMpesaCode: mpesaCode() }, counter.id),
      /150/
    );
    const stored = await prisma.order.findUniqueOrThrow({ where: { id: created.id }, include: { payments: true } });
    assert.equal(stored.totalKsh, 400);
    assert.equal(stored.payments.length, 1);
    assert.equal((await prisma.inventoryItem.findUniqueOrThrow({ where: { productId: newProduct.id } })).status, "AVAILABLE");
    assert.equal((await prisma.inventoryItem.findUniqueOrThrow({ where: { productId: oldProduct.id } })).status, "PAID");
  });

  await t.test("a delivered order: the new item is held, the old one is photographed and a different person approves; a paid commission is left alone and an adjustment recorded", async () => {
    const oldProduct = await product(400, "DELIVERED");
    const newProduct = await product(550, "AVAILABLE");
    const created = await order(oldProduct, 400, { delivered: true, commissionPaid: true });
    const code = mpesaCode();
    const { exchange } = await delivered.request(created.id, {
      orderItemId: created.items[0].id, newBarcode: newProduct.barcode!, reason: "Wrong size for the customer", topUpAmountKsh: 150, topUpMpesaCode: code
    }, counter.id);
    assert.equal(exchange.status, "AWAITING_RETURN");
    assert.equal((await prisma.inventoryItem.findUniqueOrThrow({ where: { productId: newProduct.id } })).status, "PAID");
    assert.equal(await prisma.payment.count({ where: { orderId: created.id, kind: "EXCHANGE_TOPUP", providerReceiptNumber: code } }), 1);

    // Receiving needs at least one photo.
    await assert.rejects(delivered.receive(created.id, exchange.id, { receivedBarcode: oldProduct.barcode!, note: "Checked at the counter" }, counter.id));
    await prisma.orderExchangePhoto.create({ data: {
      orderExchangeId: exchange.id, storageUrl: `returns/exchange-${exchange.id}/photo.jpg`, contentType: "image/jpeg", sizeBytes: 10, uploadedByAdminUserId: counter.id
    } });
    await assert.rejects(delivered.receive(created.id, exchange.id, { receivedBarcode: "not-the-barcode", note: "Checked at the counter" }, counter.id), /barcode/);
    await delivered.receive(created.id, exchange.id, { receivedBarcode: oldProduct.barcode!, note: "Checked at the counter" }, counter.id);

    // Review needs the approve permission; the person who received it cannot be the one who approves.
    await assert.rejects(delivered.review(created.id, exchange.id, { approved: true, note: "Looks fine", locationCode: shelf.locationCode }, counter.id), /permission/);
    await delivered.review(created.id, exchange.id, { approved: true, note: "Looks fine", locationCode: shelf.locationCode }, approver.id);

    const done = await prisma.orderExchange.findUniqueOrThrow({ where: { id: exchange.id } });
    assert.equal(done.status, "COMPLETED");
    const stored = await prisma.order.findUniqueOrThrow({ where: { id: created.id }, include: { commission: true, items: true } });
    assert.equal(stored.totalKsh, 550);
    assert.equal(stored.items[0].productId, newProduct.id);
    const oldInventory = await prisma.inventoryItem.findUniqueOrThrow({ where: { productId: oldProduct.id } });
    assert.equal(oldInventory.status, "AVAILABLE");
    assert.equal(oldInventory.locationId, shelf.id);
    assert.equal((await prisma.inventoryItem.findUniqueOrThrow({ where: { productId: newProduct.id } })).status, "DELIVERED");
    // The paid commission is untouched; the difference is waiting for the next payout export.
    assert.equal(stored.commission!.status, "PAID");
    assert.equal(stored.commission!.commissionAmountKsh, 120);
    const adjustment = await prisma.commissionExchangeAdjustment.findUniqueOrThrow({ where: { orderExchangeId: exchange.id } });
    assert.equal(adjustment.amountKsh, 45);
    assert.equal(adjustment.beforeAmountKsh, 120);
    assert.equal(adjustment.afterAmountKsh, 165);
    assert.equal(adjustment.settledAt, null);
  });

  await t.test("cancelling a delivered exchange releases the held item and reports the top-up as owed back", async () => {
    const oldProduct = await product(400, "DELIVERED");
    const newProduct = await product(550, "AVAILABLE");
    const created = await order(oldProduct, 400, { delivered: true });
    const { exchange } = await delivered.request(created.id, {
      orderItemId: created.items[0].id, newBarcode: newProduct.barcode!, reason: "Customer changed her mind", topUpAmountKsh: 150, topUpMpesaCode: mpesaCode()
    }, counter.id);
    const result = await delivered.cancel(created.id, exchange.id, { note: "Customer did not come back" }, counter.id);
    assert.equal(result.refundDueKsh, 150);
    assert.equal((await prisma.inventoryItem.findUniqueOrThrow({ where: { productId: newProduct.id } })).status, "AVAILABLE");
    assert.equal((await prisma.orderExchange.findUniqueOrThrow({ where: { id: exchange.id } })).status, "CANCELLED");
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: created.id } })).totalKsh, 400);
  });
});
