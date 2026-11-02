import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

test("real database MVP order: two garments, payment, verified pickup, staged refunds and reviewed restock", { timeout: 120_000 }, async () => {
  const databaseUrl = process.env.MVP_INTEGRATION_DATABASE_URL;
  assert.ok(databaseUrl, "MVP_INTEGRATION_DATABASE_URL must identify a disposable local test database.");
  const target = new URL(databaseUrl);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname), "Only a local integration database is allowed.");
  assert.match(target.pathname, /test/i, "The integration database name must contain test.");
  process.env.DATABASE_URL = databaseUrl;
  Object.assign(process.env, {
    MPESA_ENV: "sandbox", MPESA_ENVIRONMENT: "sandbox", MPESA_CONSUMER_KEY: "integration-mock",
    MPESA_CONSUMER_SECRET: "integration-mock", MPESA_SHORTCODE: "174379", MPESA_PASSKEY: "integration-mock",
    MPESA_CALLBACK_BASE_URL: "https://example.invalid"
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("External network requests are forbidden in the MVP integration test."); };
  const { prisma } = await import("@online-saler/database");
  const { startCheckout } = await import("../../apps/storefront/src/checkout/checkout-service");
  const { initiateMpesaPayment, handleMpesaCallback } = await import("../../apps/storefront/src/payments/payment-service");
  const { MpesaClient, mpesaConfigFromEnv } = await import("../../apps/storefront/src/payments/mpesa-client");
  const { OperationsAccessService } = await import("../../apps/api/src/operations/operations-access.service");
  const { OperationsFulfillmentService } = await import("../../apps/api/src/operations/operations-fulfillment.service");
  const { OperationsAfterSalesService } = await import("../../apps/api/src/operations/operations-after-sales.service");
  const { hashPassword, issueOperationsAccessToken } = await import("../../apps/api/src/operations/operations-access-policy");
  const key = `mvp-${randomUUID()}`;
  const customerIds: string[] = [];
  const productIds: string[] = [];
  const employeeIds: string[] = [];
  const adminIds: string[] = [];
  const roleIds: string[] = [];
  const createdPermissionIds: string[] = [];
  const affiliateIds: string[] = [];
  const locationIds: string[] = [];
  const nodeIds: string[] = [];
  const returnIds: string[] = [];
  const orderIds: string[] = [];
  const callbackId = `${key}-provider`;

  try {
    // Exercise the real token and database permission services with an isolated
    // test role. No authentication mock and no bootstrap of global admins.
    const permissionCodes = ["orders.view", "orders.pick", "orders.pack", "orders.complete", "orders.after-sale", "orders.assign-node", "orders.node-receive", "action.customer-service.approve"];
    const permissionIds: string[] = [];
    for (const code of permissionCodes) {
      let permission = await prisma.permission.findUnique({ where: { code } });
      if (!permission) {
        permission = await prisma.permission.create({ data: { code, module: "orders" } });
        createdPermissionIds.push(permission.id);
      }
      permissionIds.push(permission.id);
    }
    const role = await prisma.role.create({ data: {
      code: `${key}-role`, name: "MVP isolated integration role",
      permissions: { create: permissionIds.map((permissionId) => ({ permissionId })) }
    } });
    roleIds.push(role.id);
    const employee = await prisma.employee.create({ data: { employeeCode: `${key}-employee`, name: "MVP integration operator" } });
    employeeIds.push(employee.id);
    const admin = await prisma.adminUser.create({ data: {
      loginAccount: `${key}-admin`, name: "MVP integration actor", linkedEmployeeId: employee.id,
      passwordHash: hashPassword(`${key}-password`), roles: { create: { roleId: role.id } }
    } });
    adminIds.push(admin.id);
    const unauthorized = await prisma.adminUser.create({ data: { loginAccount: `${key}-no-permission`, name: "No order permission" } });
    adminIds.push(unauthorized.id);
    const access = new OperationsAccessService();
    const token = issueOperationsAccessToken(admin.id, admin.passwordHash!);
    const actorId = await access.requireAccessToken(`Bearer ${token.accessToken}`);
    assert.equal(actorId, admin.id);
    await assert.rejects(access.requireAccessToken(`Bearer ${token.accessToken}.tampered`));
    await assert.rejects(access.requirePermission(unauthorized.id, "orders.after-sale"), /permission/);
    const fulfillment = new OperationsFulfillmentService(access);
    const afterSales = new OperationsAfterSalesService(access);
    const actor = { adminUserId: actorId, note: "Integration test operator action" };

    const customer = await prisma.customer.create({ data: {
      googleSubjectId: `${key}-customer`, email: `${key}@example.invalid`, normalizedEmail: `${key}@example.invalid`,
      displayName: "MVP integration customer", phone: "254712345679"
    } });
    customerIds.push(customer.id);
    const affiliateCode = `MVP${randomUUID().replace(/-/g, "").slice(0, 25).toUpperCase()}`;
    const affiliate = await prisma.affiliate.create({ data: {
      affiliateCode, slug: `${key}-affiliate`, displayName: "MVP integration affiliate", commissionRateBps: 3000
    } });
    affiliateIds.push(affiliate.id);
    const location = await prisma.warehouseLocation.create({ data: { locationCode: `${key}-shelf`, capacity: 10 } });
    locationIds.push(location.id);
    // Product publication itself has separate readiness tests. Start this
    // cross-module scenario with the approved, labelled and shelved result.
    const products: Array<{ id: string }> = [];
    for (const [index, priceKsh] of [200, 300].entries()) {
      const barcode = `${key}-item-${index}`;
      const product = await prisma.product.create({ data: {
        productCode: barcode, barcode, status: "PUBLISHED", title: `Integration garment ${index + 1}`,
        description: "Inspected integration garment", category: "TOPS", finalSizeLabel: "M", conditionGrade: "GOOD", priceKsh,
        approvedByEmployeeId: employee.id, labelPrintedAt: new Date(), labelAppliedAt: new Date(), publishedAt: new Date(),
        images: { create: { type: "FRONT", originalUrl: `https://example.invalid/${barcode}.jpg`, publicUrl: `https://example.invalid/${barcode}.jpg` } },
        inventoryItem: { create: { barcode, status: "AVAILABLE", locationId: location.id, checkedInAt: new Date() } }
      } });
      products.push(product);
      productIds.push(product.id);
    }
    const node = await prisma.fulfillmentNode.create({
      data: { code: `${key}-node`, name: "Integration pickup point", type: "STORE" }
    });
    nodeIds.push(node.id);
    const checkout = await startCheckout({
      customerId: customer.id, productIds: products.map((product) => product.id), phone: "0712345679", fulfillmentMethod: "PICKUP",
      fulfillmentNodeId: node.id, attribution: { affiliateCode, source: "integration" }
    });
    orderIds.push(checkout.orderId);
    assert.equal(checkout.totalKsh, 500);
    assert.equal(await prisma.inventoryItem.count({ where: { productId: { in: productIds }, status: "RESERVED" } }), 2);
    let providerCalls = 0;
    const client = new MpesaClient(mpesaConfigFromEnv());
    client.initiateStkPush = async (input) => {
      providerCalls += 1;
      assert.equal(input.amountKsh, 500);
      assert.equal(input.phone, "254712345679");
      return { checkoutRequestId: callbackId, merchantRequestId: `${key}-merchant`, responseCode: "0", responseDescription: "mock accepted", customerMessage: "mock", raw: { mock: true } };
    };
    const payment = await initiateMpesaPayment(checkout.orderId, customer.id, client);
    assert.equal(providerCalls, 1);
    const paidResult = await handleMpesaCallback({ Body: { stkCallback: {
      CheckoutRequestID: callbackId, MerchantRequestID: `${key}-merchant`, ResultCode: 0, ResultDesc: "integration paid",
      CallbackMetadata: { Item: [
        { Name: "Amount", Value: 500 }, { Name: "MpesaReceiptNumber", Value: `${key}-receipt` }, { Name: "PhoneNumber", Value: 254712345679 }
      ] }
    } } });
    assert.equal(paidResult.status, "SUCCESS");
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: payment.paymentId } })).status, "SUCCESS");
    assert.equal((await prisma.commission.findUniqueOrThrow({ where: { orderId: checkout.orderId } })).commissionAmountKsh, 125);

    // A separate commission is an isolation sentinel; after-sales must never
    // affect other orders belonging to the same affiliate or customer.
    const untouchedOrder = await prisma.order.create({ data: {
      orderNumber: `${key}-untouched-order`, customerId: customer.id, affiliateId: affiliate.id,
      status: "COMPLETED", fulfillmentMethod: "PICKUP", itemSubtotalKsh: 100, totalKsh: 100,
      commission: { create: { affiliateId: affiliate.id, status: "CONFIRMED", rateBps: 3000, orderSubtotalKsh: 100, commissionAmountKsh: 30 } }
    } });
    orderIds.push(untouchedOrder.id);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: checkout.orderId }, include: { items: { include: { snapshot: true } } } });
    const itemA = order.items.find((item) => item.productId === products[0].id)!;
    const itemB = order.items.find((item) => item.productId === products[1].id)!;
    await fulfillment.claimPicking(order.id, actor);
    await assert.rejects(fulfillment.scanItem(order.id, itemA.id, { ...actor, barcode: "WRONG-GARMENT" }), /Barcode does not match/);
    assert.equal((await prisma.fulfillmentItem.findUniqueOrThrow({ where: { orderItemId: itemA.id } })).status, "PENDING");
    assert.equal(await prisma.fulfillmentEvent.count({ where: { orderId: order.id, action: "BARCODE_REJECTED" } }), 1);
    await assert.rejects(fulfillment.startPacking(order.id, actor), /every item is verified/);
    await fulfillment.scanItem(order.id, itemA.id, { ...actor, barcode: itemA.snapshot!.barcode! });
    await fulfillment.scanItem(order.id, itemB.id, { ...actor, barcode: itemB.snapshot!.barcode! });
    assert.equal((await prisma.orderFulfillment.findUniqueOrThrow({ where: { orderId: order.id } })).status, "READY_TO_PACK");
    await fulfillment.startPacking(order.id, actor);
    await fulfillment.completePacking(order.id, { ...actor, packagingMethod: "BAG", packageCount: 1 });
    // The order is collected from a store, so the package has to travel and be
    // scanned in before anyone can hand it over.
    await assert.rejects(fulfillment.readyForPickup(order.id, actor), /cannot move from PACKED/);
    // The store checks the parcel in by scanning its sticker, so it may not
    // leave until the label has been printed.
    await assert.rejects(fulfillment.sendToNode(order.id, actor), /Print the package label/);
    const packed = await prisma.orderFulfillment.findUniqueOrThrow({ where: { orderId: order.id } });
    await fulfillment.markPackageLabelPrinted(order.id, { ...actor, packageCode: packed.packageCode! });
    assert.ok((await prisma.orderFulfillment.findUniqueOrThrow({ where: { orderId: order.id } })).packageLabelPrintedAt);
    await fulfillment.sendToNode(order.id, actor);
    const inTransit = await prisma.orderFulfillment.findUniqueOrThrow({ where: { orderId: order.id } });
    assert.equal(inTransit.status, "IN_TRANSIT_TO_NODE");
    assert.ok(inTransit.packageCode);
    await assert.rejects(fulfillment.receiveAtNode(order.id, { ...actor, packageCode: "PKG-WRONG-LABEL" }), /Check the label/);
    await fulfillment.receiveAtNode(order.id, { ...actor, packageCode: inTransit.packageCode! });
    const atNode = await prisma.orderFulfillment.findUniqueOrThrow({ where: { orderId: order.id } });
    assert.equal(atNode.status, "ARRIVED_AT_NODE");
    assert.ok(atNode.arrivedAtNodeAt);
    await fulfillment.readyForPickup(order.id, actor);
    // The order number is printed on the parcel sitting on the counter, so it
    // proves nothing. Only the four digits on the customer's own order page do.
    assert.match(order.pickupCode!, /^\d{4}$/, "the counter verifies four digits and nothing else");
    await assert.rejects(fulfillment.confirmPickup(order.id, { ...actor, verificationMethod: "PICKUP_CODE", verificationValue: order.orderNumber }), /Enter the 4 digits/);
    const wrongCode = String((Number(order.pickupCode) + 1) % 10000).padStart(4, "0");
    await assert.rejects(fulfillment.confirmPickup(order.id, { ...actor, verificationMethod: "PICKUP_CODE", verificationValue: wrongCode }), /code is wrong/);
    await fulfillment.confirmPickup(order.id, { ...actor, verificationMethod: "PICKUP_CODE", verificationValue: order.pickupCode! });
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status, "COMPLETED");
    assert.equal(await prisma.inventoryItem.count({ where: { productId: { in: productIds }, status: "DELIVERED" } }), 2);
    assert.ok((await prisma.orderFulfillment.findUniqueOrThrow({ where: { orderId: order.id } })).completedAt);

    async function requestAndReceive(item: typeof itemA, suffix: string) {
      const request = { idempotencyKey: `${key}-${suffix}-request`, note: "Customer reported an undisclosed major defect", orderItemId: item.id, reason: "UNDISCLOSED_DEFECT" };
      const result = await afterSales.execute(order.id, undefined, "REQUEST", request, actorId);
      const record = result.returns.find((row) => row.orderItemId === item.id)!;
      returnIds.push(record.id);
      const retry = await afterSales.execute(order.id, undefined, "REQUEST", request, actorId);
      assert.equal(retry.returns.filter((row) => row.orderItemId === item.id).length, 1);
      await afterSales.execute(order.id, record.id, "DECISION", { idempotencyKey: `${key}-${suffix}-decision`, note: "Evidence meets existing return policy", approved: true }, actorId);
      // The counter must photograph the returned garment before it can be accepted.
      await assert.rejects(afterSales.execute(order.id, record.id, "RECEIVE", { idempotencyKey: `${key}-${suffix}-no-photo`, note: "Counter staff did not take a photo", receivedBarcode: item.snapshot!.barcode!, restockable: true }, actorId), /at least 1 photo/);
      await prisma.afterSaleReturnPhoto.create({ data: { afterSaleReturnId: record.id, storageUrl: `gs://integration-test/returns/${record.id}/photo.jpg`, contentType: "image/jpeg", sizeBytes: 1024, uploadedByAdminUserId: actorId } });
      await assert.rejects(afterSales.execute(order.id, record.id, "RECEIVE", { idempotencyKey: `${key}-${suffix}-wrong-receive`, note: "Wrong physical garment scanned", receivedBarcode: "WRONG-RETURN", restockable: true }, actorId), /mismatched returned barcode/);
      await afterSales.execute(order.id, record.id, "RECEIVE", { idempotencyKey: `${key}-${suffix}-receive`, note: "Original garment received and inspected", receivedBarcode: item.snapshot!.barcode!, restockable: true }, actorId);
      return await prisma.afterSaleReturn.findUniqueOrThrow({ where: { id: record.id } });
    }
    const returnA = await requestAndReceive(itemA, "a");
    function refundInput(id: string, amountKsh: number, externalReference: string) {
      return { idempotencyKey: `${key}-${id}`, note: "Record a verified external test refund", amountKsh, externalReference, evidenceNote: "Simulated finance verification; no provider transfer", refundedAt: new Date().toISOString() };
    }
    const firstRefund = refundInput("a-refund-first", 1, `${key}-refund-a-first`);
    await afterSales.execute(order.id, returnA.id, "REFUND", firstRefund, actorId);
    await afterSales.execute(order.id, returnA.id, "REFUND", firstRefund, actorId);
    assert.equal(await prisma.refundRecord.count({ where: { afterSaleReturnId: returnA.id } }), 1);
    assert.equal((await prisma.afterSaleReturn.findUniqueOrThrow({ where: { id: returnA.id } })).status, "RECEIVED");
    const openCase = await prisma.customerServiceCase.findUniqueOrThrow({ where: { id: returnA.serviceCaseId } });
    assert.notEqual(openCase.status, "RESOLVED");
    assert.equal(openCase.requiresRefund, true);
    assert.equal(openCase.affectsAffiliateCommission, true);
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status, "COMPLETED");
    assert.equal((await prisma.commission.findUniqueOrThrow({ where: { orderId: order.id } })).commissionAmountKsh, 75);
    await assert.rejects(afterSales.execute(order.id, returnA.id, "RESTOCK", { idempotencyKey: `${key}-too-early-restock`, note: "Attempt before completing the refund", locationCode: location.locationCode }, actorId), /refund/i);
    await assert.rejects(afterSales.execute(order.id, returnA.id, "REFUND", { ...firstRefund, amountKsh: 2 }, actorId), /Idempotency key/);
    await assert.rejects(afterSales.execute(order.id, returnA.id, "REFUND", refundInput("a-duplicate-reference", 1, firstRefund.externalReference), actorId), /already been recorded/);
    await assert.rejects(afterSales.execute(order.id, returnA.id, "REFUND", refundInput("a-over-refund", 200, `${key}-too-much`), actorId), /exceed/);
    assert.equal(await prisma.refundRecord.count({ where: { afterSaleReturnId: returnA.id } }), 1);
    const remainingRefund = refundInput("a-refund-rest", 199, `${key}-refund-a-rest`);
    await afterSales.execute(order.id, returnA.id, "REFUND", remainingRefund, actorId);
    assert.equal((await prisma.afterSaleReturn.findUniqueOrThrow({ where: { id: returnA.id } })).status, "REFUND_RECORDED");
    assert.equal((await prisma.customerServiceCase.findUniqueOrThrow({ where: { id: returnA.serviceCaseId } })).status, "RESOLVED");
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status, "COMPLETED", "Refunding one item must not mark the whole order refunded");
    assert.equal((await prisma.commission.findUniqueOrThrow({ where: { orderId: order.id } })).commissionAmountKsh, 75);
    assert.equal(await prisma.commissionAdjustment.count({ where: { afterSaleReturnId: returnA.id } }), 1);
    const restockA = { idempotencyKey: `${key}-a-restock`, note: "Move inspected return into the review queue", locationCode: location.locationCode };
    await afterSales.execute(order.id, returnA.id, "RESTOCK", restockA, actorId);
    await afterSales.execute(order.id, returnA.id, "RESTOCK", restockA, actorId);
    await assert.rejects(afterSales.execute(order.id, returnA.id, "RESTOCK", { ...restockA, idempotencyKey: `${key}-a-restock-again` }, actorId), /restocked once/);
    const returnedProduct = await prisma.product.findUniqueOrThrow({ where: { id: itemA.productId } });
    assert.equal(returnedProduct.status, "REVIEW_PENDING");
    assert.equal(returnedProduct.approvedByEmployeeId, null);
    assert.equal(returnedProduct.publishedAt, null);
    assert.equal((await prisma.inventoryItem.findUniqueOrThrow({ where: { productId: itemA.productId } })).status, "AVAILABLE");
    assert.equal(await prisma.inventoryMovement.count({ where: { productId: itemA.productId, movementType: "STOCK_IN" } }), 1);
    await assert.rejects(startCheckout({ customerId: customer.id, productIds: [itemA.productId], phone: "0712345679", fulfillmentMethod: "PICKUP", fulfillmentNodeId: nodeIds[0] }), /changed before payment/);

    const returnB = await requestAndReceive(itemB, "b");
    await assert.rejects(afterSales.execute(order.id, returnB.id, "REFUND", refundInput("b-reused-reference", 1, remainingRefund.externalReference), actorId), /already been recorded/);
    const refundB = refundInput("b-refund", 300, `${key}-refund-b`);
    await afterSales.execute(order.id, returnB.id, "REFUND", refundB, actorId);
    await afterSales.execute(order.id, returnB.id, "REFUND", refundB, actorId);
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status, "REFUNDED");
    const revoked = await prisma.commission.findUniqueOrThrow({ where: { orderId: order.id }, include: { adjustments: true } });
    assert.equal(revoked.status, "REJECTED");
    assert.equal(revoked.commissionAmountKsh, 0);
    assert.deepEqual(revoked.adjustments.map((row) => row.amountKsh).sort((a, b) => a - b), [50, 75]);
    assert.ok(revoked.adjustments.every((row) => row.kind === "REVERSAL"));
    const untouched = await prisma.commission.findUniqueOrThrow({ where: { orderId: untouchedOrder.id } });
    assert.equal(untouched.status, "CONFIRMED");
    assert.equal(untouched.commissionAmountKsh, 30);
    assert.equal((await prisma.refundRecord.aggregate({ where: { afterSaleReturnId: { in: returnIds } }, _sum: { amountKsh: true } }))._sum.amountKsh, 500);
    assert.equal(await prisma.refundRecord.count({ where: { afterSaleReturnId: { in: returnIds } } }), 3);
    await afterSales.execute(order.id, returnB.id, "RESTOCK", { idempotencyKey: `${key}-b-restock`, note: "Second returned garment queued for review", locationCode: location.locationCode }, actorId);
    assert.equal(await prisma.product.count({ where: { id: { in: productIds }, status: "REVIEW_PENDING" } }), 2);
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: payment.paymentId } })).status, "SUCCESS", "Refund recording preserves the original incoming payment history");
    const events = await prisma.afterSaleEvent.findMany({ where: { orderId: order.id } });
    assert.ok(events.length >= 11);
    assert.ok(events.every((event) => event.actorAdminUserId === actorId && event.sourceApp === "OPERATIONS" && event.reason));
  } finally {
    // Restrict cleanup to this run's records and respect append-only financial
    // foreign keys; this deletion is only valid in the disposable test database.
    await prisma.afterSaleEvent.deleteMany({ where: { orderId: { in: orderIds } } });
    // RefundRequest restricts deletion of its order, so it goes before the
    // refunds it points at and well before the orders themselves.
    await prisma.refundRequest.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.commissionAdjustment.deleteMany({ where: { afterSaleReturnId: { in: returnIds } } });
    await prisma.refundRecord.deleteMany({ where: { OR: [{ afterSaleReturnId: { in: returnIds } }, { orderId: { in: orderIds } }] } });
    await prisma.afterSaleReturnPhoto.deleteMany({ where: { afterSaleReturnId: { in: returnIds } } });
    await prisma.afterSaleReturn.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.customerServiceCase.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.mpesaCallback.deleteMany({ where: { providerCheckoutRequestId: callbackId } });
    await prisma.notification.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.affiliate.deleteMany({ where: { id: { in: affiliateIds } } });
    await prisma.auditLog.deleteMany({ where: { actorAdminUserId: { in: adminIds } } });
    await prisma.adminUser.deleteMany({ where: { id: { in: adminIds } } });
    await prisma.employee.deleteMany({ where: { id: { in: employeeIds } } });
    await prisma.rolePermission.deleteMany({ where: { roleId: { in: roleIds } } });
    await prisma.role.deleteMany({ where: { id: { in: roleIds } } });
    await prisma.permission.deleteMany({ where: { id: { in: createdPermissionIds } } });
    await prisma.warehouseLocation.deleteMany({ where: { id: { in: locationIds } } });
    await prisma.fulfillmentNode.deleteMany({ where: { id: { in: nodeIds } } });
    await prisma.$disconnect();
    globalThis.fetch = originalFetch;
  }
});
