import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertRefundAmount, assertReturnPhotoCount, assertReturnWindow, commissionShares, requiredText, returnPhotoContentType } from "./operations-after-sales.rules";
import { OperationsAfterSalesController } from "./operations-after-sales.controller";
import { OperationsAfterSalesService } from "./operations-after-sales.service";
import { OperationsAccessService } from "./operations-access.service";
import { prisma } from "@online-saler/database";

const completedAt = new Date("2026-09-06T08:00:00Z");
test("3-day eligibility accepts the exact boundary and rejects undelivered, future and expired requests", () => {
  assert.doesNotThrow(() => assertReturnWindow(completedAt, new Date("2026-09-09T08:00:00Z")));
  assert.throws(() => assertReturnWindow(completedAt, new Date("2026-09-09T08:00:00.001Z")), /3 days/);
  assert.throws(() => assertReturnWindow(undefined, completedAt), /3 days/);
  assert.throws(() => assertReturnWindow(new Date("2026-09-07T08:00:00Z"), completedAt), /3 days/);
});

test("refunds cannot exceed sold line, order total, or actual successful payments across installments", () => {
  assert.doesNotThrow(() => assertRefundAmount(75, 200, 125, 450, 325, 450));
  assert.throws(() => assertRefundAmount(76, 200, 125, 450, 325, 450), /exceed/);
  assert.throws(() => assertRefundAmount(75, 200, 0, 450, 400, 450), /exceed/);
  assert.throws(() => assertRefundAmount(75, 200, 0, 450, 325, 350), /exceed/);
  for (const amount of [0, -1, 1.5, Number.NaN, "100", Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => assertRefundAmount(amount, 200, 0, 450, 0, 450), /positive integer/);
});

test("item commission allocation preserves every shilling and is stable across item ordering", () => {
  const items = [{ id: "c", lineTotalKsh: 100 }, { id: "b", lineTotalKsh: 100 }, { id: "a", lineTotalKsh: 100 }];
  assert.deepEqual([...commissionShares(items, 10)], [["a", 4], ["b", 3], ["c", 3]]);
  assert.deepEqual([...commissionShares([...items].reverse(), 10)], [["a", 4], ["b", 3], ["c", 3]]);
  const shares = commissionShares([{ id: "a", lineTotalKsh: 350 }, { id: "b", lineTotalKsh: 99 }, { id: "c", lineTotalKsh: 51 }], 37);
  assert.equal([...shares.values()].reduce((a, b) => a + b, 0), 37);
  assert.deepEqual([...shares.values()].sort((a, b) => a - b), [4, 7, 26]);
});

test("financial evidence and idempotency text reject missing, malformed, and oversized values", () => {
  assert.equal(requiredText("  receipt  ", "Evidence"), "receipt");
  for (const value of [undefined, null, 123, "   ", "x".repeat(2001)]) assert.throws(() => requiredText(value, "Evidence"), /Evidence/);
});

test("controller derives actor from bearer token regardless of body admin ID", async () => {
  let observed: unknown[] = [];
  const service = { execute: async (...args: unknown[]) => { observed = args; return {}; } } as unknown as OperationsAfterSalesService;
  const access = { requireAccessToken: async (token: string) => { assert.equal(token, "Bearer real"); return "authenticated-actor"; } } as unknown as OperationsAccessService;
  await new OperationsAfterSalesController(service, access).refund("Bearer real", "order-1", "return-1", { note: "verified", idempotencyKey: "refund-1", ...{ adminUserId: "forged" } });
  assert.equal(observed[4], "authenticated-actor");
});

test("decision and refund demand approval permission before opening a transaction", async () => {
  const permissions: string[] = [];
  const access = { requirePermission: async (_actor: string, permission: string) => { permissions.push(permission); if (permission === "action.customer-service.approve") throw new Error("Approval forbidden"); return { adminUser: { linkedEmployeeId: null } }; } } as unknown as OperationsAccessService;
  for (const action of ["DECISION", "REFUND"] as const) await assert.rejects(() => new OperationsAfterSalesService(access).execute("order", "return", action, { note: "verified", idempotencyKey: "key" }, "actor"), /Approval forbidden/);
  assert.deepEqual(permissions, ["orders.after-sale", "action.customer-service.approve", "orders.after-sale", "action.customer-service.approve"]);
});

test("same order is locked before checking a replay; payload conflict cannot mutate a financial record", async () => {
  const original = prisma.$transaction;
  const calls: string[] = [];
  prisma.$transaction = (async (callback: (tx: unknown) => unknown) => callback({
    $queryRaw: async (query: { strings: string[] }) => { calls.push("lock"); assert.match(query.strings.join("?"), /Order.*FOR UPDATE/); },
    order: { findUnique: async () => { calls.push("order"); return { id: "order", afterSaleReturns: [] }; } },
    afterSaleEvent: { findUnique: async () => { calls.push("replay"); return { requestHash: "different", actorAdminUserId: "actor" }; } }
  })) as typeof prisma.$transaction;
  try {
    const access = { requirePermission: async () => ({ adminUser: { linkedEmployeeId: null } }) } as unknown as OperationsAccessService;
    await assert.rejects(() => new OperationsAfterSalesService(access).execute("order", "return", "REFUND", { note: "verified", idempotencyKey: "key" }, "actor"), /different request/);
    assert.deepEqual(calls, ["lock", "order", "replay"]);
  } finally { prisma.$transaction = original; }
});

test("a 1/200 refund installment cannot close the case or restock; the remaining 199 completes only the item", async () => {
  const original = prisma.$transaction;
  const receivedAt = new Date(Date.now() - 10_000);
  const record = {
    id: "return", orderId: "order", serviceCaseId: "case", orderItemId: "item", status: "RECEIVED",
    receivedAt, restockable: true, refunds: [] as Array<{ amountKsh: number }>, events: [],
    commissionAdjustment: null, orderItem: { id: "item", lineTotalKsh: 200 }
  };
  const order = { id: "order", status: "COMPLETED", totalKsh: 250, payments: [{ status: "SUCCESS", amountKsh: 250 }], afterSaleReturns: [record], commission: null };
  const caseUpdates: unknown[] = [];
  const orderUpdates: unknown[] = [];
  const tx = {
    $queryRaw: async () => [],
    order: { findUnique: async () => order, update: async (data: unknown) => { orderUpdates.push(data); } },
    afterSaleEvent: { findUnique: async () => null, create: async () => ({}) },
    afterSaleReturn: {
      update: async ({ data }: { data: { status: string } }) => { Object.assign(record, data); return record; },
      findUniqueOrThrow: async () => record, findMany: async () => [record]
    },
    refundRecord: { create: async ({ data }: { data: { amountKsh: number } }) => { record.refunds.push(data); return data; } },
    customerServiceCase: { update: async (args: unknown) => { caseUpdates.push(args); return {}; } },
    auditLog: { create: async () => ({}) }
  };
  prisma.$transaction = (async (callback: (transaction: unknown) => unknown) => callback(tx)) as typeof prisma.$transaction;
  try {
    const access = { requirePermission: async () => ({ adminUser: { linkedEmployeeId: null } }) } as unknown as OperationsAccessService;
    const service = new OperationsAfterSalesService(access);
    const evidence = { note: "Verified external receipt", evidenceNote: "Provider statement inspected", refundedAt: new Date(Date.now() - 1_000).toISOString() };
    const first = await service.execute("order", "return", "REFUND", { ...evidence, amountKsh: 1, externalReference: "part-1", idempotencyKey: "refund-1" }, "actor");
    assert.equal(first.returns[0]?.status, "RECEIVED");
    assert.equal(caseUpdates.length, 0, "service ticket flags must remain active");
    await assert.rejects(() => service.execute("order", "return", "RESTOCK", { note: "Cannot restore an incomplete refund", locationCode: "SHELF", idempotencyKey: "restock-early" }, "actor"), /recorded refund/);
    const completed = await service.execute("order", "return", "REFUND", { ...evidence, amountKsh: 199, externalReference: "part-2", idempotencyKey: "refund-2" }, "actor");
    assert.equal(completed.returns[0]?.status, "REFUND_RECORDED");
    assert.equal(caseUpdates.length, 1);
    assert.deepEqual(caseUpdates[0], { where: { id: "case" }, data: { status: "RESOLVED", resolvedAt: (caseUpdates[0] as { data: { resolvedAt: Date } }).data.resolvedAt, requiresReturn: false, requiresRefund: false, affectsAffiliateCommission: false } });
    assert.equal(orderUpdates.length, 0, "delivery fee has not been refunded, so the order must remain COMPLETED");
    assert.equal(record.refunds.reduce((sum, refund) => sum + refund.amountKsh, 0), 200);
  } finally { prisma.$transaction = original; }
});

test("a returned item needs between 1 and 5 photos", () => {
  assert.throws(() => assertReturnPhotoCount(0), /at least 1 photo/);
  assert.doesNotThrow(() => assertReturnPhotoCount(1));
  assert.doesNotThrow(() => assertReturnPhotoCount(5));
  assert.throws(() => assertReturnPhotoCount(6), /at most 5/);
});

test("only JPEG, PNG and WEBP photos up to 10 MB are accepted", () => {
  assert.equal(returnPhotoContentType("image/jpeg", 1000), "image/jpeg");
  assert.equal(returnPhotoContentType("IMAGE/PNG; charset=binary", 1000), "image/png");
  assert.equal(returnPhotoContentType("image/webp", 10 * 1024 * 1024), "image/webp");
  assert.throws(() => returnPhotoContentType("text/html", 1000), /JPEG, PNG or WEBP/);
  assert.throws(() => returnPhotoContentType(undefined, 1000), /JPEG, PNG or WEBP/);
  assert.throws(() => returnPhotoContentType("image/jpeg", 0), /between 1 byte and 10 MB/);
  assert.throws(() => returnPhotoContentType("image/jpeg", 10 * 1024 * 1024 + 1), /between 1 byte and 10 MB/);
});

function receiveFixture(photoCount: number) {
  const record = {
    id: "return", orderId: "order", serviceCaseId: "case", orderItemId: "item", status: "APPROVED", receivedAt: null as Date | null,
    restockable: null as boolean | null, refunds: [], events: [], photos: [], commissionAdjustment: null,
    orderItem: { id: "item", productId: "product", lineTotalKsh: 200, snapshot: { barcode: "B1" } }
  };
  const order = { id: "order", status: "COMPLETED", totalKsh: 250, payments: [{ status: "SUCCESS", amountKsh: 250 }], afterSaleReturns: [record], commission: null };
  const tx = {
    $queryRaw: async () => [],
    order: { findUnique: async () => order },
    afterSaleEvent: { findUnique: async () => null, create: async () => ({}) },
    afterSaleReturnPhoto: { count: async () => photoCount },
    inventoryItem: { findUnique: async () => ({ barcode: "B1", updatedAt: new Date("2026-11-02T10:00:00Z") }) },
    afterSaleReturn: {
      update: async ({ data }: { data: Record<string, unknown> }) => { Object.assign(record, data); return record; },
      findUniqueOrThrow: async () => record, findMany: async () => [record]
    },
    auditLog: { create: async () => ({}) }
  };
  return { record, tx };
}

test("accepting a returned item is refused without a photo and succeeds with one", async () => {
  const original = prisma.$transaction;
  const access = { requirePermission: async () => ({ adminUser: { linkedEmployeeId: null } }) } as unknown as OperationsAccessService;
  const input = { note: "Checked at the counter", receivedBarcode: "B1", restockable: true, idempotencyKey: "receive-1" };
  try {
    const without = receiveFixture(0);
    prisma.$transaction = (async (callback: (transaction: unknown) => unknown) => callback(without.tx)) as typeof prisma.$transaction;
    await assert.rejects(() => new OperationsAfterSalesService(access).execute("order", "return", "RECEIVE", input, "actor"), /at least 1 photo/);
    assert.equal(without.record.status, "APPROVED", "a refused acceptance must not change the return");

    const withPhoto = receiveFixture(2);
    prisma.$transaction = (async (callback: (transaction: unknown) => unknown) => callback(withPhoto.tx)) as typeof prisma.$transaction;
    const result = await new OperationsAfterSalesService(access).execute("order", "return", "RECEIVE", input, "actor");
    assert.equal(result.returns[0]?.status, "RECEIVED");
  } finally { prisma.$transaction = original; }
});

function photoStorage() {
  const uploads: Array<{ objectName: string; contentType: string; size: number }> = [];
  return {
    uploads,
    storage: {
      bucket: "bucket",
      returnPhotoObjectName: (returnId: string, photoId: string, type: string) => `returns/${returnId}/${photoId}.${type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg"}`,
      upload: async (objectName: string, contentType: string, body: Buffer) => { uploads.push({ objectName, contentType, size: body.length }); },
      download: async (objectName: string) => ({ body: new TextEncoder().encode(objectName).buffer, contentType: "image/jpeg" })
    } as never
  };
}

test("photos can only be added to an approved return, at most five, and are stored privately", async () => {
  const db = prisma as unknown as Record<string, Record<string, unknown>>;
  const saved = { afterSaleReturn: db.afterSaleReturn, afterSaleReturnPhoto: db.afterSaleReturnPhoto, auditLog: db.auditLog };
  const access = { requirePermission: async () => ({ adminUser: { linkedEmployeeId: null } }) } as unknown as OperationsAccessService;
  const { storage, uploads } = photoStorage();
  const service = new OperationsAfterSalesService(access, storage);
  let status = "APPROVED";
  let count = 0;
  const created: Array<{ data: { storageUrl: string; afterSaleReturnId: string; sizeBytes: number } }> = [];
  db.afterSaleReturn = { findFirst: async ({ where }: { where: { id: string; orderId: string } }) => where.orderId === "order" ? { id: where.id, status } : null };
  db.afterSaleReturnPhoto = { count: async () => count, create: async (args: { data: { storageUrl: string; afterSaleReturnId: string; sizeBytes: number } }) => { created.push(args); return { id: "p" }; } };
  db.auditLog = { create: async () => ({}) };
  try {
    const bytes = Buffer.from("fake-image");
    await assert.rejects(() => service.uploadPhoto("other-order", "return", "actor", "image/jpeg", bytes), /Return was not found/);
    await assert.rejects(() => service.uploadPhoto("order", "return", "actor", "text/plain", bytes), /JPEG, PNG or WEBP/);
    status = "REQUESTED";
    await assert.rejects(() => service.uploadPhoto("order", "return", "actor", "image/jpeg", bytes), /approved/);
    status = "RECEIVED";
    await assert.rejects(() => service.uploadPhoto("order", "return", "actor", "image/jpeg", bytes), /approved/);
    status = "APPROVED";
    count = 5;
    await assert.rejects(() => service.uploadPhoto("order", "return", "actor", "image/jpeg", bytes), /at most 5/);
    assert.equal(uploads.length, 0, "no file may be written when a photo is refused");
    count = 4;
    await service.uploadPhoto("order", "return", "actor", "image/jpeg", bytes);
    assert.equal(uploads.length, 1);
    assert.match(uploads[0]!.objectName, /^returns\/return\/[0-9a-f-]+\.jpg$/);
    assert.match(created[0]!.data.storageUrl, /^gs:\/\/bucket\/returns\/return\//);
    assert.equal(created[0]!.data.sizeBytes, bytes.length);
  } finally { Object.assign(db, saved); }
});

test("photos are served only to order viewers and refund approvers, for the right return", async () => {
  const db = prisma as unknown as Record<string, Record<string, unknown>>;
  const saved = db.afterSaleReturnPhoto;
  const { storage } = photoStorage();
  let allowed: string[] = [];
  const access = { hasPermission: async (_actor: string, code: string) => allowed.includes(code) } as unknown as OperationsAccessService;
  const service = new OperationsAfterSalesService(access, storage);
  db.afterSaleReturnPhoto = { findFirst: async ({ where }: { where: { id: string; afterSaleReturnId: string } }) => where.id === "photo" && where.afterSaleReturnId === "return" ? { storageUrl: "gs://bucket/returns/return/photo.jpg" } : null };
  try {
    await assert.rejects(() => service.photoContent("order", "return", "photo", "actor"), /permission/);
    allowed = ["customer-service.refund-approve"];
    const stored = await service.photoContent("order", "return", "photo", "actor");
    assert.equal(stored.contentType, "image/jpeg");
    allowed = ["orders.view"];
    await assert.rejects(() => service.photoContent("order", "other-return", "photo", "actor"), /Photo was not found/);
    db.afterSaleReturnPhoto = { findFirst: async () => ({ storageUrl: "gs://another-bucket/returns/x.jpg" }) };
    await assert.rejects(() => service.photoContent("order", "return", "photo", "actor"), /Photo was not found/);
  } finally { db.afterSaleReturnPhoto = saved; }
});
