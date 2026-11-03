import "reflect-metadata";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { prisma, type Prisma } from "@online-saler/database";
import { OperationsAccessService } from "./operations-access.service";
import { OperationsRefundRequestService } from "./operations-refund-request.service";

/**
 * These tests are about one thing: money cannot leave the business on the say-so
 * of a single person. Everything else here is in service of proving that.
 */

type RequestRow = {
  id: string;
  orderId: string;
  serviceCaseId: string | null;
  afterSaleReturnId: string | null;
  status: string;
  kind: string;
  amountKsh: number;
  reason: string;
  requestedByAdminUserId: string;
  reviewedByAdminUserId: string | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  refundRecordId: string | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
};

type HarnessOptions = {
  paidKsh?: number;
  refundedKsh?: number;
  existingRequests?: Array<{ amountKsh: number; status: string }>;
  request?: Partial<RequestRow>;
  returnStatus?: string;
  liveRequestsForReturn?: number;
};

function harness(t: TestContext, options: HarnessOptions = {}) {
  const events: string[] = [];
  const audits: Array<Prisma.AuditLogUncheckedCreateInput> = [];
  const refundRecords: Array<Record<string, unknown>> = [];
  const caseWrites: Array<Record<string, unknown>> = [];
  let missingOrder = false;

  let row: RequestRow = {
    id: "request-1",
    orderId: "order-1",
    serviceCaseId: "case-1",
    afterSaleReturnId: null,
    status: "PENDING_APPROVAL",
    kind: "AFTER_SALE_RETURN",
    amountKsh: 800,
    reason: "Garment arrived torn",
    requestedByAdminUserId: "agent",
    reviewedByAdminUserId: null,
    reviewedAt: null,
    reviewNote: null,
    refundRecordId: null,
    completedAt: null,
    cancelledAt: null,
    ...options.request
  };

  const tx = {
    $queryRaw: async (sql: unknown) => {
      const text = String((sql as { strings?: string[] }).strings?.join("?") ?? sql);
      events.push(text.includes('"Order"') ? "lock-order" : "lock-request");
      return [];
    },
    order: {
      findUnique: async () => {
        events.push("read-order");
        if (missingOrder) return null;
        return {
          id: "order-1",
          payments: [{ amountKsh: options.paidKsh ?? 1000 }],
          refunds: options.refundedKsh ? [{ amountKsh: options.refundedKsh }] : [],
          refundRequests: options.existingRequests ?? []
        };
      }
    },
    orderExchange: { findMany: async () => [] },
    customerServiceCase: {
      findUnique: async () => ({ orderId: "order-1" }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        events.push("update-case");
        caseWrites.push(data);
        return data;
      }
    },
    afterSaleReturn: { findUnique: async () => ({ orderId: "order-1", status: options.returnStatus ?? "RECEIVED" }) },
    refundRecord: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        events.push("create-refund-record");
        refundRecords.push(data);
        return { id: "record-1", ...data };
      }
    },
    refundRequest: {
      count: async () => options.liveRequestsForReturn ?? 0,
      findUnique: async () => {
        events.push("read-request");
        return { ...row };
      },
      create: async ({ data }: { data: Partial<RequestRow> }) => {
        events.push("create-request");
        row = { ...row, ...data, id: "request-1" };
        return { ...row };
      },
      update: async ({ data }: { data: Partial<RequestRow> }) => {
        events.push("update-request");
        row = { ...row, ...data };
        return { ...row };
      }
    },
    auditLog: {
      create: async ({ data }: { data: Prisma.AuditLogUncheckedCreateInput }) => {
        events.push("audit");
        audits.push(data);
        return data;
      }
    }
  };

  const originalTransaction = prisma.$transaction;
  prisma.$transaction = (async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)) as unknown as typeof prisma.$transaction;
  t.after(() => { prisma.$transaction = originalTransaction; });

  // "agent" may only ask; "finance" may only decide; "titus" may do both, which
  // is what makes the same-person check worth testing at all.
  const permissionsByActor: Record<string, string[]> = {
    agent: ["customer-service.refund-request"],
    finance: ["customer-service.refund-approve", "orders.refund"],
    titus: ["customer-service.refund-request", "customer-service.refund-approve", "orders.refund"],
    // Holds the approval permission but not the bookkeeping one.
    reviewer: ["customer-service.refund-approve"]
  };
  const access = {
    requirePermission: async (adminUserId: string | undefined, code: string) => {
      const held = permissionsByActor[adminUserId ?? ""] ?? [];
      if (!held.includes(code)) throw new ForbiddenException();
      return { adminUser: { id: adminUserId, linkedEmployeeId: `${adminUserId}-employee` } };
    },
    session: async (adminUserId: string | undefined) => ({
      adminUser: { id: adminUserId, linkedEmployeeId: `${adminUserId}-employee` },
      permissions: permissionsByActor[adminUserId ?? ""] ?? []
    })
  } as unknown as OperationsAccessService;

  return {
    service: new OperationsRefundRequestService(access),
    events, audits, refundRecords, caseWrites,
    read: () => row,
    removeOrder: () => { missingOrder = true; }
  };
}

const CREATE = { adminUserId: "agent", orderId: "order-1", amountKsh: 800, reason: "Garment arrived torn" };

test("customer service can raise a refund request, and doing so moves no money", async (t) => {
  const h = harness(t);
  const created = await h.service.create(CREATE);
  assert.equal(created.status, "PENDING_APPROVAL");
  assert.equal(created.requestedByAdminUserId, "agent");
  // The order lock is taken before the money is read, exactly as every other
  // write against an order's balance does.
  assert.deepEqual(h.events, ["lock-order", "read-order", "create-request", "audit"]);
  assert.equal(h.refundRecords.length, 0, "no refund record exists until finance records one");
  assert.equal(h.audits[0]?.action, "REFUND_REQUEST_CREATE");
});

test("a request raised against a case marks that case as waiting on money", async (t) => {
  const h = harness(t);
  await h.service.create({ ...CREATE, serviceCaseId: "case-1" });
  assert.equal(h.caseWrites.at(-1)?.requiresRefund, true);
});

test("customer service cannot approve, review, or record a refund", async (t) => {
  const h = harness(t);
  await assert.rejects(h.service.review("request-1", { adminUserId: "agent", approved: true, reviewNote: "ok" }), ForbiddenException);
  await assert.rejects(
    h.service.complete("request-1", { adminUserId: "agent", externalReference: "QK1", evidenceNote: "sent", refundedAt: new Date().toISOString() }),
    ForbiddenException
  );
  assert.equal(h.refundRecords.length, 0);
  assert.equal(h.audits.length, 0);
});

test("finance cannot raise a request, so a payout still needs two people", async (t) => {
  const h = harness(t);
  await assert.rejects(h.service.create({ ...CREATE, adminUserId: "finance" }), ForbiddenException);
  assert.deepEqual(h.events, []);
});

test("the person who asked for the refund cannot approve it, even holding both permissions", async (t) => {
  const h = harness(t, { request: { requestedByAdminUserId: "titus" } });
  await assert.rejects(
    h.service.review("request-1", { adminUserId: "titus", approved: true, reviewNote: "Looks fine to me" }),
    ConflictException
  );
  assert.equal(h.read().status, "PENDING_APPROVAL");
  assert.equal(h.audits.length, 0);
});

test("approval is only permission: it still writes no refund record", async (t) => {
  const h = harness(t);
  const reviewed = await h.service.review("request-1", { adminUserId: "finance", approved: true, reviewNote: "Photos check out" });
  assert.equal(reviewed.status, "APPROVED");
  assert.equal(h.refundRecords.length, 0);
  assert.equal(h.audits[0]?.action, "REFUND_REQUEST_APPROVE");
});

test("a rejection is recorded with its reason and closes the request", async (t) => {
  const h = harness(t);
  const reviewed = await h.service.review("request-1", { adminUserId: "finance", approved: false, reviewNote: "Item was worn" });
  assert.equal(reviewed.status, "REJECTED");
  assert.equal(reviewed.reviewNote, "Item was worn");
  assert.equal(h.audits[0]?.action, "REFUND_REQUEST_REJECT");
});

test("a review must be an explicit yes or no", async (t) => {
  const h = harness(t);
  await assert.rejects(h.service.review("request-1", { adminUserId: "finance", reviewNote: "hmm" }), BadRequestException);
  // A silent approval is the failure mode this guards against.
  await assert.rejects(h.service.review("request-1", { adminUserId: "finance", approved: true }), BadRequestException);
  assert.equal(h.audits.length, 0);
});

test("only an approved request can be recorded as refunded", async (t) => {
  const h = harness(t);
  await assert.rejects(
    h.service.complete("request-1", { adminUserId: "finance", externalReference: "QK1", evidenceNote: "Sent", refundedAt: new Date().toISOString() }),
    ConflictException
  );
  assert.equal(h.refundRecords.length, 0);
});

test("recording the executed refund needs the bookkeeping permission too", async (t) => {
  const h = harness(t, { request: { status: "APPROVED", reviewedAt: new Date(Date.now() - 60_000) } });
  await assert.rejects(
    h.service.complete("request-1", { adminUserId: "reviewer", externalReference: "QK1", evidenceNote: "Sent", refundedAt: new Date().toISOString() }),
    ForbiddenException
  );
  assert.equal(h.refundRecords.length, 0);
});

test("completing an approved request records the M-Pesa reference and resolves the case", async (t) => {
  const reviewedAt = new Date(Date.now() - 60_000);
  const h = harness(t, { request: { status: "APPROVED", reviewedAt } });
  const done = await h.service.complete("request-1", {
    adminUserId: "finance",
    externalReference: "qk12ab34cd",
    evidenceNote: "M-Pesa confirmation screenshot filed",
    refundedAt: new Date().toISOString()
  });
  assert.equal(done.status, "REFUNDED");
  assert.equal(h.refundRecords.length, 1);
  // References are matched against M-Pesa statements, which are upper case.
  assert.equal(h.refundRecords[0]?.externalReference, "QK12AB34CD");
  assert.equal(h.refundRecords[0]?.amountKsh, 800);
  assert.equal(h.caseWrites.at(-1)?.status, "RESOLVED");
  assert.equal(h.audits.at(-1)?.action, "REFUND_REQUEST_COMPLETE");
});

test("a refund cannot be dated before it was approved or in the future", async (t) => {
  const reviewedAt = new Date(Date.now() - 60_000);
  const base = { adminUserId: "finance", externalReference: "QK1", evidenceNote: "Sent" };
  const early = harness(t, { request: { status: "APPROVED", reviewedAt } });
  await assert.rejects(
    early.service.complete("request-1", { ...base, refundedAt: new Date(Date.now() - 3_600_000).toISOString() }),
    BadRequestException
  );
  const future = harness(t, { request: { status: "APPROVED", reviewedAt } });
  await assert.rejects(
    future.service.complete("request-1", { ...base, refundedAt: new Date(Date.now() + 3_600_000).toISOString() }),
    BadRequestException
  );
  assert.equal(early.refundRecords.length + future.refundRecords.length, 0);
});

test("a request cannot exceed what the customer actually paid", async (t) => {
  const h = harness(t, { paidKsh: 1000 });
  await assert.rejects(h.service.create({ ...CREATE, amountKsh: 1200 }), BadRequestException);
  assert.equal(h.events.includes("create-request"), false);
});

test("refunds already recorded count against the ceiling", async (t) => {
  const h = harness(t, { paidKsh: 1000, refundedKsh: 600 });
  await assert.rejects(h.service.create({ ...CREATE, amountKsh: 500 }), BadRequestException);
  // What is genuinely left is still refundable.
  const created = await h.service.create({ ...CREATE, amountKsh: 400 });
  assert.equal(created.amountKsh, 400);
});

test("a request still awaiting finance holds its share of the money", async (t) => {
  // Two agents must not each promise the customer the full order value.
  const h = harness(t, { paidKsh: 1000, existingRequests: [{ amountKsh: 700, status: "PENDING_APPROVAL" }] });
  await assert.rejects(h.service.create({ ...CREATE, amountKsh: 400 }), BadRequestException);
});

test("a rejected or cancelled request releases the money it was holding", async (t) => {
  const h = harness(t, {
    paidKsh: 1000,
    existingRequests: [{ amountKsh: 700, status: "REJECTED" }, { amountKsh: 900, status: "CANCELLED" }]
  });
  const created = await h.service.create({ ...CREATE, amountKsh: 1000 });
  assert.equal(created.amountKsh, 1000);
});

test("an order with no successful payment has nothing to refund", async (t) => {
  const h = harness(t, { paidKsh: 0 });
  await assert.rejects(h.service.create(CREATE), BadRequestException);
});

test("a refund amount must be a positive whole shilling amount", async (t) => {
  const h = harness(t);
  for (const amountKsh of [0, -100, 12.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(h.service.create({ ...CREATE, amountKsh }), BadRequestException, `rejects ${amountKsh}`);
  }
  assert.deepEqual(h.events, []);
});

test("a request must say why, and name an order that exists", async (t) => {
  const h = harness(t);
  await assert.rejects(h.service.create({ ...CREATE, reason: "   " }), BadRequestException);
  await assert.rejects(h.service.create({ ...CREATE, orderId: "" }), BadRequestException);
  h.removeOrder();
  await assert.rejects(h.service.create(CREATE), NotFoundException);
});

test("customer service can withdraw its own request, but only before finance looks", async (t) => {
  const pending = harness(t);
  const cancelled = await pending.service.cancel("request-1", { adminUserId: "agent", reason: "Customer changed their mind" });
  assert.equal(cancelled.status, "CANCELLED");
  assert.equal(pending.audits.at(-1)?.action, "REFUND_REQUEST_CANCEL");

  const approved = harness(t, { request: { status: "APPROVED" } });
  await assert.rejects(approved.service.cancel("request-1", { adminUserId: "agent", reason: "Too late" }), ConflictException);
});

test("a decision that has already been made cannot be made again", async (t) => {
  const h = harness(t, { request: { status: "REJECTED" } });
  await assert.rejects(
    h.service.review("request-1", { adminUserId: "finance", approved: true, reviewNote: "Second thoughts" }),
    ConflictException
  );
  assert.equal(h.read().status, "REJECTED");
});

test("a refund request for a return needs the returned item to have been received", async (t) => {
  for (const returnStatus of ["REQUESTED", "APPROVED", "REJECTED"]) {
    const h = harness(t, { returnStatus });
    await assert.rejects(h.service.create({ ...CREATE, afterSaleReturnId: "return-1" }), /received and inspected/);
    assert.equal(h.read().status, "PENDING_APPROVAL", "nothing was created");
    assert.ok(!h.events.includes("create-request"));
  }
});

test("a received return that already has a live refund request cannot get a second one", async (t) => {
  const h = harness(t, { liveRequestsForReturn: 1 });
  await assert.rejects(h.service.create({ ...CREATE, afterSaleReturnId: "return-1" }), ConflictException);
  assert.ok(!h.events.includes("create-request"));
});

test("a received return whose request was rejected or withdrawn can be given a new one", async (t) => {
  const h = harness(t, { liveRequestsForReturn: 0 });
  const created = await h.service.create({ ...CREATE, afterSaleReturnId: "return-1" });
  assert.equal(created.afterSaleReturnId, "return-1");
  assert.equal(created.status, "PENDING_APPROVAL");
});

test("a refund for a returned item cannot be recorded from the refund approvals page", async (t) => {
  // Recording it here would skip the commission reversal, the return status
  // and the restock rules, which only the order page applies.
  const h = harness(t, { request: { status: "APPROVED", afterSaleReturnId: "return-1", requestedByAdminUserId: "agent", reviewedByAdminUserId: "finance", reviewedAt: new Date(Date.now() - 60_000) } });
  await assert.rejects(
    h.service.complete("request-1", { adminUserId: "finance", externalReference: "QK9", evidenceNote: "sent", refundedAt: new Date().toISOString() }),
    /order page/
  );
  assert.equal(h.refundRecords.length, 0);
  assert.equal(h.read().status, "APPROVED");
});
