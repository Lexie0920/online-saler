import "reflect-metadata";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { BadRequestException, ConflictException, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { prisma, type Commission, type Prisma } from "@online-saler/database";
import { OperationsAffiliateService } from "./operations-affiliate.service";
import { OperationsAffiliateController } from "./operations-affiliate.controller";
import { OperationsAccessService } from "./operations-access.service";

function harness(t: TestContext, status: Commission["status"] = "PENDING") {
  const now = new Date();
  let record = {
    id: "commission-1", affiliateId: "affiliate-1", orderId: "order-1", attributionId: null,
    status, rateBps: 1000, orderSubtotalKsh: 1000, commissionAmountKsh: 100,
    eligibleAt: null, confirmedAt: null, rejectedAt: null, paidAt: null, holdReason: null,
    note: "Original note", createdAt: now, updatedAt: now
  } as Commission;
  const order = {
    status: "COMPLETED",
    totalKsh: 1000,
    payments: [{ status: "SUCCESS", amountKsh: 1000 }],
    fulfillment: { status: "COMPLETED", completedAt: new Date(now.getTime() - 96 * 60 * 60 * 1000) },
    customerServiceCases: [], afterSaleReturns: [] as Array<{ status: string }>
  };
  const events: string[] = [];
  const audits: Array<Record<string, unknown>> = [];
  let concurrentChange = false;
  const tx = {
    $queryRaw: async () => { events.push("lock-order"); return [{ id: record.orderId }]; },
    commission: {
      findUnique: async () => { events.push("read"); return { ...record, order }; },
      findUniqueOrThrow: async () => ({ ...record }),
      updateMany: async ({ where, data }: { where: Prisma.CommissionWhereInput; data: Partial<Commission> }) => {
        assert.equal(where.status, record.status);
        assert.equal(where.updatedAt, record.updatedAt);
        assert.equal(where.paidAt, null);
        if (concurrentChange) return { count: 0 };
        record = { ...record, ...data };
        events.push("write");
        return { count: 1 };
      }
    },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push(data); return data; } }
  };
  const originalTransaction = prisma.$transaction;
  prisma.$transaction = (async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx)) as unknown as typeof prisma.$transaction;
  t.after(() => { prisma.$transaction = originalTransaction; });
  const access = {
    requirePermission: async (actor: string | undefined, permission: string) => {
      assert.equal(permission, "action.affiliate.approve");
      if (actor !== "admin-1") throw new ForbiddenException();
      return { adminUser: { id: "admin-1", linkedEmployeeId: null } };
    }
  } as unknown as OperationsAccessService;
  return {
    service: new OperationsAffiliateService(access), events, audits, order,
    record: () => record,
    loseUpdate: () => { concurrentChange = true; }
  };
}

test("confirmation locks and re-reads the order, preserves rate/amount and audits the authenticated actor", async (t) => {
  const h = harness(t);
  const result = await h.service.confirmCommission("commission-1", { adminUserId: "admin-1" });
  assert.deepEqual(h.events, ["read", "lock-order", "read", "write"]);
  assert.equal(result.status, "CONFIRMED");
  assert.equal(result.rateBps, 1000);
  assert.equal(result.commissionAmountKsh, 100);
  assert.equal(result.note, "Original note");
  assert.equal(result.eligibleAt?.getTime(), h.order.fulfillment.completedAt.getTime() + 72 * 60 * 60 * 1000);
  assert.equal(h.audits[0]?.actorAdminUserId, "admin-1");
  assert.equal(h.audits[0]?.actorId, null);
  assert.equal(h.audits[0]?.action, "COMMISSION_CONFIRM");
  await assert.rejects(h.service.confirmCommission("commission-1", { adminUserId: "admin-1" }), ConflictException);
  assert.equal(h.audits.length, 1);
});

test("an ineligible manual confirmation does not write or clear its return", async (t) => {
  const h = harness(t);
  h.order.afterSaleReturns.push({ status: "REQUESTED" });
  await assert.rejects(h.service.confirmCommission("commission-1", { adminUserId: "admin-1" }), BadRequestException);
  assert.equal(h.record().status, "PENDING");
  assert.equal(h.audits.length, 0);
});

test("payment recording rechecks eligibility and requires a receipt; repeated record/reject cannot rewrite paid history", async (t) => {
  const h = harness(t, "CONFIRMED");
  await assert.rejects(h.service.markCommissionPaid("commission-1", { adminUserId: "admin-1" }), BadRequestException);
  h.order.afterSaleReturns.push({ status: "APPROVED" });
  await assert.rejects(h.service.markCommissionPaid("commission-1", { adminUserId: "admin-1", note: "MPESA receipt ABC123" }), BadRequestException);
  h.order.afterSaleReturns.length = 0;
  const paid = await h.service.markCommissionPaid("commission-1", { adminUserId: "admin-1", note: "MPESA receipt ABC123" });
  assert.equal(paid.status, "PAID");
  assert.ok(paid.paidAt);
  await assert.rejects(h.service.markCommissionPaid("commission-1", { adminUserId: "admin-1", note: "other receipt" }), ConflictException);
  await assert.rejects(h.service.rejectCommission("commission-1", { adminUserId: "admin-1", note: "cancel" }), ConflictException);
  assert.equal(h.record().note, "MPESA receipt ABC123");
  assert.equal(h.record().paidAt, paid.paidAt);
  assert.equal(h.audits.length, 1);
});

test("permission and optimistic concurrency failures leave no audit of a successful transition", async (t) => {
  const h = harness(t);
  await assert.rejects(h.service.confirmCommission("commission-1", { adminUserId: "forged" }), ForbiddenException);
  assert.deepEqual(h.events, []);
  h.loseUpdate();
  await assert.rejects(h.service.confirmCommission("commission-1", { adminUserId: "admin-1" }), ConflictException);
  assert.equal(h.record().status, "PENDING");
  assert.equal(h.audits.length, 0);
});

test("payout export excludes historical confirmations with unresolved after-sales or invalid handover", async (t) => {
  const h = harness(t, "CONFIRMED");
  const rows = [
    { ...h.record(), id: "eligible", affiliate: { affiliateCode: "AFF", displayName: "Affiliate", phone: null, customer: { phone: "254700000001" } }, order: { ...h.order, orderNumber: "ORDER-1" } },
    { ...h.record(), id: "returned", affiliate: { affiliateCode: "AFF", displayName: "Affiliate", phone: null }, order: { ...h.order, orderNumber: "ORDER-2", afterSaleReturns: [{ status: "REQUESTED" }] } },
    { ...h.record(), id: "undelivered", affiliate: { affiliateCode: "AFF", displayName: "Affiliate", phone: null }, order: { ...h.order, orderNumber: "ORDER-3", fulfillment: null } }
  ];
  const originalFindMany = prisma.commission.findMany;
  prisma.commission.findMany = (async () => rows) as unknown as typeof prisma.commission.findMany;
  t.after(() => { prisma.commission.findMany = originalFindMany; });
  const access = { requirePermission: async (_actor: string, permission: string) => { assert.equal(permission, "action.affiliate.export"); } } as unknown as OperationsAccessService;
  const exported = await new OperationsAffiliateService(access).payoutExport("admin-1");
  assert.deepEqual(exported.map((row) => row.commissionId), ["eligible"]);
  // 推广员自己没有电话时，导出使用绑定顾客账号的电话。
  assert.equal(exported[0]?.phone, "254700000001");
});

test("affiliate controller rejects unsigned requests and overrides a forged body actor", async () => {
  let called = 0;
  const service = { confirmCommission: async (_id: string, body: { adminUserId?: string }) => { called++; return body; } } as unknown as OperationsAffiliateService;
  const access = { requireAccessToken: async (authorization?: string) => {
    if (authorization !== "Bearer signed-session") throw new UnauthorizedException();
    return "verified-admin";
  } } as OperationsAccessService;
  const controller = new OperationsAffiliateController(service, access);
  await assert.rejects(controller.confirmCommission("commission-1", undefined, { adminUserId: "forged-admin" }), UnauthorizedException);
  assert.equal(called, 0);
  const result = await controller.confirmCommission("commission-1", "Bearer signed-session", { adminUserId: "forged-admin" });
  assert.equal((result as unknown as { adminUserId: string }).adminUserId, "verified-admin");
});
