import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const testDatabaseUrl = process.env.MVP_INTEGRATION_DATABASE_URL;
const nativeConcurrencyOnly = process.env.MVP_TEST_DATABASE_ENGINE === "pglite"
  ? "PGlite uses one database connection; native PostgreSQL is required to verify concurrent transactions."
  : false;

test("commission persistence, concurrent payment recording and after-sales guard", { skip: !testDatabaseUrl, timeout: 120_000 }, async (t) => {
  const target = new URL(testDatabaseUrl!);
  assert.ok(["localhost", "127.0.0.1"].includes(target.hostname), "Integration database must be local.");
  assert.match(target.pathname, /test|ci/i, "Integration database name must identify a disposable test database.");
  process.env.DATABASE_URL = testDatabaseUrl;
  const { prisma } = await import("@online-saler/database");
  const { OperationsAffiliateService } = await import("../../apps/api/src/operations/operations-affiliate.service");
  const { OperationsAccessService } = await import("../../apps/api/src/operations/operations-access.service");
  t.after(async () => { await prisma.$disconnect(); });
  const runId = randomUUID();
  const permission = await prisma.permission.upsert({
    where: { code: "action.affiliate.approve" }, update: {},
    create: { code: "action.affiliate.approve", module: "AFFILIATE" }
  });
  const role = await prisma.role.create({ data: {
    code: `COMMISSION_TEST_${runId}`, name: "Commission integration test",
    permissions: { create: { permissionId: permission.id } }
  } });
  const admin = await prisma.adminUser.create({ data: {
    loginAccount: `commission-${runId}`, name: "Commission integration actor",
    roles: { create: { roleId: role.id } }
  } });
  const unauthorized = await prisma.adminUser.create({ data: { loginAccount: `unauthorized-${runId}`, name: "No commission permission" } });
  const customer = await prisma.customer.create({ data: {
    googleSubjectId: runId, email: `${runId}@example.test`, normalizedEmail: `${runId}@example.test`
  } });
  const affiliate = await prisma.affiliate.create({ data: {
    affiliateCode: `COMM-${runId}`, slug: `comm-${runId}`, displayName: "Integration affiliate", commissionRateBps: 3000
  } });
  const service = new OperationsAffiliateService(new OperationsAccessService());
  async function fixture(hoursSinceHandover = 96, status: "PENDING" | "CONFIRMED" = "PENDING") {
    const order = await prisma.order.create({ data: {
      orderNumber: `COMM-${randomUUID()}`, customerId: customer.id, affiliateId: affiliate.id,
      status: "COMPLETED", fulfillmentMethod: "PICKUP", itemSubtotalKsh: 1000, totalKsh: 1000,
      payments: { create: { status: "SUCCESS", amountKsh: 1000, phone: "254700000000", idempotencyKey: `commission-test-${randomUUID()}` } },
      fulfillment: { create: { status: "COMPLETED", completedAt: new Date(Date.now() - hoursSinceHandover * 60 * 60 * 1000) } },
      commission: { create: { affiliateId: affiliate.id, status, rateBps: 3000, orderSubtotalKsh: 1000, commissionAmountKsh: 300 } }
    }, include: { commission: true } });
    return { order, commission: order.commission! };
  }

  await t.test("permission and 72-hour checks leave the persistent commission pending", async () => {
    const { commission } = await fixture(71);
    await assert.rejects(service.confirmCommission(commission.id, { adminUserId: unauthorized.id }), /permission/);
    await assert.rejects(service.confirmCommission(commission.id, { adminUserId: admin.id }), /72 hours/);
    assert.equal((await prisma.commission.findUniqueOrThrow({ where: { id: commission.id } })).status, "PENDING");
    assert.equal(await prisma.auditLog.count({ where: { entityType: "Commission", entityId: commission.id } }), 0);
  });

  await t.test("confirmation records the real actor and preserves the configured 30% snapshot", async () => {
    const { commission } = await fixture();
    const result = await service.confirmCommission(commission.id, { adminUserId: admin.id });
    assert.equal(result.status, "CONFIRMED");
    assert.equal(result.rateBps, 3000);
    assert.equal(result.commissionAmountKsh, 300);
    assert.ok(result.eligibleAt);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: commission.id, action: "COMMISSION_CONFIRM" } });
    assert.equal(audit.actorAdminUserId, admin.id);
    assert.equal(audit.actorId, null);
    assert.equal(audit.sourceApp, "OPERATIONS");
  });

  await t.test("simultaneous payment recording writes one payment status and one audit", { skip: nativeConcurrencyOnly }, async () => {
    const { commission } = await fixture(96, "CONFIRMED");
    const results = await Promise.allSettled([
      service.markCommissionPaid(commission.id, { adminUserId: admin.id, note: "TEST-RECEIPT-A" }),
      service.markCommissionPaid(commission.id, { adminUserId: admin.id, note: "TEST-RECEIPT-B" })
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const stored = await prisma.commission.findUniqueOrThrow({ where: { id: commission.id } });
    assert.equal(stored.status, "PAID");
    assert.ok(stored.paidAt);
    assert.equal(await prisma.auditLog.count({ where: { entityId: commission.id, action: "COMMISSION_RECORD_PAYMENT" } }), 1);
    await assert.rejects(service.rejectCommission(commission.id, { adminUserId: admin.id, note: "Cannot erase paid history" }), /already recorded|changed/);
    assert.deepEqual(await prisma.commission.findUniqueOrThrow({ where: { id: commission.id } }), stored);
  });

  await t.test("a return committed under the order lock blocks payment recording", { skip: nativeConcurrencyOnly }, async () => {
    const { order, commission } = await fixture(96, "CONFIRMED");
    let releaseWriter!: () => void;
    let writerLocked!: () => void;
    const ready = new Promise<void>((resolve) => { writerLocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const writer = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${order.id} FOR UPDATE`;
      await tx.customerServiceCase.create({ data: {
        customerId: customer.id, orderId: order.id, issueType: "AFTER_SALE", title: "Test return", requiresReturn: true
      } });
      writerLocked();
      await release;
    });
    await Promise.race([ready, writer]);
    const attempt = assert.rejects(service.markCommissionPaid(commission.id, { adminUserId: admin.id, note: "TEST-RECEIPT" }), /after-sales/);
    releaseWriter();
    await writer;
    await attempt;
    assert.equal((await prisma.commission.findUniqueOrThrow({ where: { id: commission.id } })).status, "CONFIRMED");
    assert.equal(await prisma.auditLog.count({ where: { entityId: commission.id } }), 0);
  });

  await t.test("audit failure rolls back a commission transition", async () => {
    const { commission } = await fixture();
    const brokenAuditAccess = {
      requirePermission: async () => ({ adminUser: { id: randomUUID(), linkedEmployeeId: null } })
    } as unknown as InstanceType<typeof OperationsAccessService>;
    await assert.rejects(new OperationsAffiliateService(brokenAuditAccess).confirmCommission(commission.id, { adminUserId: admin.id }));
    const stored = await prisma.commission.findUniqueOrThrow({ where: { id: commission.id } });
    assert.equal(stored.status, "PENDING");
    assert.equal(stored.confirmedAt, null);
    assert.equal(await prisma.auditLog.count({ where: { entityId: commission.id } }), 0);
  });
});
