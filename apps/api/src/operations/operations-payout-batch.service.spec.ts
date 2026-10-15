import "reflect-metadata";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { prisma } from "@online-saler/database";
import type { OperationsAccessService } from "./operations-access.service";
import { OperationsPayoutBatchService } from "./operations-payout-batch.service";
import { OperationsPayoutService } from "./operations-payout.service";
import { readXlsx, writeXlsx } from "./simple-xlsx";

/**
 * M-Pesa bulk payouts: export locks people, results settle them, cancel
 * releases them. Week Mon 5 – Sun 11 October 2026 (Nairobi). Every phone
 * number here is made up.
 */
const WEEK = "2026-10-05";
const IN_WEEK = new Date("2026-10-07T09:00:00.000Z");
const HOUR = 60 * 60 * 1000;

type Row = Record<string, unknown>;

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key];
    if (condition === null) return value === null || value === undefined;
    if (condition instanceof Date) return value instanceof Date && value.getTime() === condition.getTime();
    if (typeof condition === "object") {
      const c = condition as Record<string, unknown>;
      if ("in" in c) return (c.in as unknown[]).includes(value);
      if (value === null || value === undefined) return false;
      const v = (x: unknown) => (x instanceof Date ? x.getTime() : (x as number));
      const n = v(value);
      if ("gt" in c && !(n > v(c.gt))) return false;
      if ("gte" in c && !(n >= v(c.gte))) return false;
      if ("lt" in c && !(n < v(c.lt))) return false;
      return true;
    }
    return value === condition;
  });
}

function commission(id: string, affiliate: Row, amount: number): Row {
  return {
    id,
    affiliateId: affiliate.id,
    status: "CONFIRMED",
    commissionAmountKsh: amount,
    rateBps: 2500,
    orderSubtotalKsh: amount * 4,
    holdReason: null,
    confirmedAt: IN_WEEK,
    paidAt: null,
    payoutId: null,
    note: null,
    affiliate,
    order: {
      orderNumber: `DL-${id}`,
      status: "COMPLETED",
      totalKsh: amount * 4,
      payments: [{ status: "SUCCESS", amountKsh: amount * 4 }],
      fulfillment: { status: "COMPLETED", completedAt: new Date(IN_WEEK.getTime() - 80 * HOUR) },
      customerServiceCases: [],
      afterSaleReturns: []
    }
  };
}

function fee(id: string, rider: Row | null, ksh: number, extra: Row = {}): Row {
  return {
    id,
    status: "COMPLETED",
    riderFeeKsh: ksh,
    completedAt: IN_WEEK,
    riderFeePayoutId: null,
    deliveryRiderId: rider?.id ?? null,
    deliveryRiderName: (rider?.name as string | undefined) ?? null,
    deliveryRiderPhone: (rider?.phone as string | undefined) ?? null,
    deliveryRider: rider,
    order: { orderNumber: `DL-${id}` },
    ...extra
  };
}

const WANJIKU = { id: "aff-wanjiku", displayName: "Wanjiku Kamau", affiliateCode: "WANJIKU", phone: "0711000001", email: "wanjiku@example.com", customer: null };
const OTIENO = { id: "aff-otieno", displayName: "Otieno Ochieng", affiliateCode: "OTIENO", phone: "0711000002", email: null, customer: null };
const TITUS_AFF = { id: "aff-titus", displayName: "Titus M", affiliateCode: "TITUS", phone: "+254700000099", email: null, customer: null };
const PETER = { id: "rider-kamau", type: "INTERNAL", name: "Peter Kamau", phone: "0722000001", adminUserId: "admin-rider", employeeId: "emp-rider", fulfillmentNodeId: "node-kinoo" };
const BOLT = { id: "rider-bolt-1", type: "EXTERNAL", name: "James Bolt", phone: "0733000001", adminUserId: null, employeeId: null, fulfillmentNodeId: null };

type Admin = { id: string; name: string; email: string | null; phone: string | null; loginAccount: string; linkedEmployeeId: string | null; linkedEmployee: null };
const TITUS: Admin = { id: "admin-titus", name: "Titus Mwangi", email: "titus@example.com", phone: "0700000099", loginAccount: "titus", linkedEmployeeId: null, linkedEmployee: null };
const WANJIKU_ADMIN: Admin = { id: "admin-wanjiku", name: "Wanjiku Kamau", email: "wanjiku@example.com", phone: null, loginAccount: "wanjiku", linkedEmployeeId: null, linkedEmployee: null };

function fixture(t: TestContext, options: { permissions?: string[] } = {}) {
  const commissions = [
    commission("c1", WANJIKU, 250),
    commission("c2", WANJIKU, 125),
    commission("c3", OTIENO, 500),
    commission("t1", TITUS_AFF, 200)
  ];
  const fees = [
    fee("f1", PETER, 100),
    fee("f2", PETER, 50),
    fee("b1", BOLT, 150),
    fee("np", null, 80, { deliveryRiderName: "No Phone Rider", deliveryRiderPhone: null })
  ];
  const payouts: Row[] = [];
  const batches: Row[] = [];
  const lines: Row[] = [];
  const audits: Row[] = [];
  const state = { payer: TITUS };
  let seq = 0;
  const id = (prefix: string) => `${prefix}-${++seq}`;

  const tx = {
    $queryRaw: async () => [],
    commission: {
      findMany: async ({ where }: { where: Row }) => commissions.filter((row) => matches(row, where)),
      aggregate: async () => ({ _sum: { commissionAmountKsh: 0 }, _count: { _all: 0 } }),
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const rows = commissions.filter((row) => matches(row, where));
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      }
    },
    orderFulfillment: {
      findMany: async ({ where }: { where: Row }) => fees.filter((row) => matches(row, where)),
      aggregate: async () => ({ _sum: { riderFeeKsh: 0 }, _count: { _all: 0 } }),
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const rows = fees.filter((row) => matches(row, where));
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      }
    },
    payout: {
      findUnique: async ({ where }: { where: { mpesaCode: string } }) => payouts.find((p) => p.mpesaCode === where.mpesaCode) ?? null,
      findMany: async ({ where }: { where: Row }) => payouts.filter((p) => matches(p, where)).map((p) => ({ ...p, paidByAdminUser: { name: "Titus Mwangi" } })),
      create: async ({ data }: { data: Row }) => {
        if (payouts.some((p) => p.mpesaCode === data.mpesaCode)) throw new Error("unique mpesaCode");
        const row = { id: id("payout"), ...data };
        payouts.push(row);
        return row;
      }
    },
    payoutBatch: {
      findMany: async ({ where }: { where: Row }) => batches.filter((b) => matches(b, where)).map((b) => ({ ...b, exportedByAdminUser: { name: "Titus Mwangi" } })),
      findUnique: async ({ where }: { where: Row }) => batches.find((b) => matches(b, where)) ?? null,
      create: async ({ data }: { data: Row }) => {
        const row = { id: id("batch"), cancelledAt: null, reconciledAt: null, cancelledByAdminUserId: null, ...data };
        batches.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => Object.assign(batches.find((b) => b.id === where.id)!, data)
    },
    payoutBatchLine: {
      findMany: async ({ where }: { where: Row }) => lines.filter((l) => matches(l, where)).map((l) => ({ ...l })),
      create: async ({ data }: { data: Row }) => {
        if (lines.some((l) => l.reference === data.reference)) throw new Error("unique reference");
        const row = { id: id("line"), payoutId: null, mpesaCode: null, resultStatus: null, resultReason: null, resultCompletedAt: null, resultAt: null, ...data };
        lines.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => Object.assign(lines.find((l) => l.id === where.id)!, data),
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const rows = lines.filter((l) => matches(l, where));
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      }
    },
    auditLog: { create: async ({ data }: { data: Row }) => { audits.push(data); return data; } },
    adminUser: { findUnique: async () => state.payer }
  };

  const originalTransaction = prisma.$transaction;
  prisma.$transaction = (async (callback: (value: unknown) => unknown) => callback(tx)) as typeof prisma.$transaction;
  t.after(() => { prisma.$transaction = originalTransaction; });

  const permissions = options.permissions ?? ["finance.payout"];
  const access = {
    requirePermission: async (_id: string | undefined, permission: string) => {
      if (!permissions.includes(permission)) {
        const { ForbiddenException } = await import("@nestjs/common");
        throw new ForbiddenException("This admin account does not have permission for this operation.");
      }
      return { adminUser: { id: state.payer.id, linkedEmployeeId: state.payer.linkedEmployeeId }, roles: [], permissions };
    }
  } as unknown as OperationsAccessService;

  return {
    batches: new OperationsPayoutBatchService(access),
    sheet: new OperationsPayoutService(access),
    commissions, fees, payouts, batchRows: batches, lines, audits, state
  };
}

function resultsFile(rows: string[][]): string {
  return writeXlsx([["Receipt No.", "Mobile Number", "Amount", "Status", "Purpose Of Payment", "Completion Time"], ...rows]).toString("base64");
}

// ------------------------------------------------------------------ export ---

test("exporting puts every payable person in one file, leaves out yourself and people without a phone, and locks them", async (t) => {
  const h = fixture(t);
  const exported = await h.batches.exportBatch({ adminUserId: "admin-titus", week: WEEK });
  assert.ok(exported.batch && exported.file);
  assert.match(exported.batch.reference, /^PB[A-Z0-9]{6}$/);
  const ref = exported.batch.reference;
  assert.deepEqual(exported.lines.map((line) => [line.payeeKey, line.phone, line.amountKsh]).sort(), [
    ["affiliate:aff-otieno", "254711000002", 500],
    ["affiliate:aff-wanjiku", "254711000001", 375],
    ["external:254733000001|james bolt", "254733000001", 150],
    ["rider:rider-kamau", "254722000001", 150]
  ]);
  assert.deepEqual(exported.excluded.map((row) => [row.name, row.reason]).sort(), [["No Phone Rider", "NO_PHONE"], ["Titus M", "SELF_PAYMENT"]]);
  assert.equal(exported.batch.totalKsh, 375 + 500 + 150 + 150);

  const cells = readXlsx(Buffer.from(exported.file.base64, "base64"));
  assert.deepEqual(cells[0], ["MobileNumber", "DocumentType", "DocumentNumber", "Amount", "PurposeOfPayment", "Name"]);
  assert.equal(cells.length, 5);
  assert.ok(cells.slice(1).every((row) => new RegExp(`^DL (commission|rider fee) ${ref}-0[1-4]$`).test(row[4])), "every row carries the batch reference");

  assert.equal(h.batchRows[0].status, "OPEN");
  assert.equal(h.lines.length, 4);
  assert.ok(h.lines.every((line) => line.status === "PENDING"));
  assert.deepEqual(h.audits.map((a) => a.action), ["PAYOUT_BATCH_EXPORTED"]);
  assert.equal(h.payouts.length, 0, "exporting pays nobody");
  assert.equal(h.commissions.find((c) => c.id === "c1")!.status, "CONFIRMED");

  // The sheet shows them as exported; a second export finds nobody new.
  const sheet = await h.sheet.weeklySheet({ adminUserId: "admin-titus", week: WEEK });
  const wanjiku = sheet.rows.find((row) => row.payeeKey === "affiliate:aff-wanjiku")!;
  assert.equal(wanjiku.exported?.batchReference, ref);
  assert.equal(sheet.rows.find((row) => row.name === "No Phone Rider")!.bulkPhone, null);
  assert.equal(sheet.batches.length, 1);
  assert.equal(sheet.batches[0].counts.pending, 4);

  const again = await h.batches.exportBatch({ adminUserId: "admin-titus", week: WEEK });
  assert.equal(again.batch, null);
  assert.equal(again.excluded.filter((row) => row.reason === "ALREADY_EXPORTED").length, 4);
  assert.equal(h.batchRows.length, 1);

  // The manual fallback refuses someone waiting for bulk results.
  await assert.rejects(
    h.sheet.markPaid({ adminUserId: "admin-titus", week: WEEK, payeeKey: "affiliate:aff-wanjiku", mpesaCode: "SJK3ABC12X" }),
    /bulk file .* waiting for its results/
  );
  // ...but still works for someone not in the file.
  const manual = await h.sheet.markPaid({ adminUserId: "admin-titus", week: WEEK, payeeKey: "external:|no phone rider", mpesaCode: "NPK3ABC12X" });
  assert.equal(manual.payout.amountKsh, 80);

  // The file can be downloaded again, same rows.
  const copy = await h.batches.batchFile({ adminUserId: "admin-titus", batchId: exported.batch.id, format: "csv" });
  assert.match(Buffer.from(copy.base64, "base64").toString("utf8"), new RegExp(`${ref}-01`));
});

// --------------------------------------------------------------- reconcile ---

test("results mark successful people paid with their receipt, release failed ones, and a re-upload changes nothing", async (t) => {
  const h = fixture(t);
  const exported = await h.batches.exportBatch({ adminUserId: "admin-titus", week: WEEK });
  const byKey = (key: string) => exported.lines.find((line) => line.payeeKey === key)!;
  const file = resultsFile([
    ["SJK3ABC12X", "2547*****001", "375.00", "Completed", `DL commission ${byKey("affiliate:aff-wanjiku").reference}`, "2026-10-12 10:15"],
    ["TJK3ABC12X", "0711000002", "500", "Completed", "", "2026-10-12 10:16"], // no reference: phone + amount
    ["", "254722000001", "150", "Failed", `DL rider fee ${byKey("rider:rider-kamau").reference}`, ""],
    ["UJK3ABC12X", "0799000009", "999", "Completed", "", ""] // somebody else entirely
  ]);
  const first = await h.batches.reconcile({ adminUserId: "admin-titus", batchId: exported.batch!.id, fileName: "results.xlsx", contentBase64: file });

  assert.deepEqual(first.summary, { paidPeople: 2, paidKsh: 875, newlyPaid: 2, alreadyPaid: 0, failed: 1, unmatched: 1, duplicates: 0, stillPending: 1 });
  assert.equal(first.changed, 3);
  assert.deepEqual(first.rows.map((row) => [row.fileRow, row.outcome, row.reason, row.matchedBy]), [
    [2, "PAY", null, "reference"],
    [3, "PAY", null, "phone_amount"],
    [4, "FAILED", null, "reference"],
    [5, "UNMATCHED", "NO_MATCH", null]
  ]);

  // Commissions took the existing CONFIRMED → PAID step, with the receipt.
  const wanjikuPayout = h.payouts.find((p) => p.mpesaCode === "SJK3ABC12X")!;
  assert.equal(wanjikuPayout.amountKsh, 375);
  assert.equal(wanjikuPayout.payeePhone, "254711000001");
  for (const id of ["c1", "c2"]) {
    const row = h.commissions.find((c) => c.id === id)!;
    assert.equal(row.status, "PAID");
    assert.equal(row.payoutId, wanjikuPayout.id);
  }
  assert.equal(h.commissions.find((c) => c.id === "c3")!.payoutId, h.payouts.find((p) => p.mpesaCode === "TJK3ABC12X")!.id);
  assert.equal(h.fees.find((f) => f.id === "f1")!.riderFeePayoutId, null, "a failed payment pays nothing");
  assert.equal(h.lines.find((l) => l.payeeKey === "rider:rider-kamau")!.status, "FAILED");
  assert.equal(h.lines.find((l) => l.payeeKey === "affiliate:aff-wanjiku")!.mpesaCode, "SJK3ABC12X");
  assert.equal(h.batchRows[0].status, "OPEN", "one person still has no result");
  const actions = h.audits.map((a) => a.action);
  assert.equal(actions.filter((a) => a === "PAYOUT_RECORDED").length, 2);
  assert.equal(actions.filter((a) => a === "COMMISSION_RECORD_PAYMENT").length, 3);
  assert.equal(actions.at(-1), "PAYOUT_BATCH_RECONCILED");

  // Same file again: nothing changes.
  const auditCount = h.audits.length;
  const again = await h.batches.reconcile({ adminUserId: "admin-titus", batchId: exported.batch!.id, fileName: "results.xlsx", contentBase64: file });
  assert.equal(again.changed, 0);
  assert.equal(again.summary.alreadyPaid, 2);
  assert.equal(again.summary.newlyPaid, 0);
  assert.equal(h.payouts.length, 2);
  assert.equal(h.audits.length, auditCount, "no audit noise for a no-op upload");

  // The failed rider is free again: pay by hand or in a new file.
  const manual = await h.sheet.markPaid({ adminUserId: "admin-titus", week: WEEK, payeeKey: "rider:rider-kamau", mpesaCode: "RK12345ABC" });
  assert.equal(manual.payout.amountKsh, 150);

  // The batch cannot be cancelled as a whole any more, but the one still waiting can be released.
  await assert.rejects(h.batches.cancelBatch({ adminUserId: "admin-titus", batchId: exported.batch!.id }), /cannot be cancelled as a whole/);
  const released = await h.batches.cancelBatch({ adminUserId: "admin-titus", batchId: exported.batch!.id, pendingOnly: true });
  assert.equal(released.released, 1);
  assert.equal(h.batchRows[0].status, "RECONCILED");
  const next = await h.batches.exportBatch({ adminUserId: "admin-titus", week: WEEK });
  assert.deepEqual(next.lines.map((line) => line.payeeKey), ["external:254733000001|james bolt"]);
});

test("a later successful retry pays a failed person; a receipt already used elsewhere is refused", async (t) => {
  const h = fixture(t);
  const exported = await h.batches.exportBatch({ adminUserId: "admin-titus", week: WEEK });
  const ref = (key: string) => exported.lines.find((line) => line.payeeKey === key)!.reference;
  await h.batches.reconcile({ adminUserId: "admin-titus", batchId: exported.batch!.id, contentBase64: resultsFile([
    ["", "254722000001", "150", "Failed", ref("rider:rider-kamau"), ""]
  ]) });
  const retry = await h.batches.reconcile({ adminUserId: "admin-titus", batchId: exported.batch!.id, contentBase64: resultsFile([
    ["", "254722000001", "150", "Failed", ref("rider:rider-kamau"), ""],
    ["RK12345ABC", "254722000001", "150", "Completed", ref("rider:rider-kamau"), ""],
    ["RK12345ABC", "254733000001", "150", "Completed", ref("external:254733000001|james bolt"), ""]
  ]) });
  assert.deepEqual(retry.rows.map((row) => [row.outcome, row.reason]), [["DUPLICATE", null], ["PAY", null], ["UNMATCHED", "RECEIPT_REUSED"]]);
  assert.equal(h.fees.find((f) => f.id === "f1")!.riderFeePayoutId, h.payouts[0].id);
  assert.equal(h.fees.find((f) => f.id === "b1")!.riderFeePayoutId, null);
});

test("an item that stopped being payable after export is not marked paid, and is reported", async (t) => {
  const h = fixture(t);
  const exported = await h.batches.exportBatch({ adminUserId: "admin-titus", week: WEEK });
  h.commissions.find((c) => c.id === "c2")!.holdReason = "ORDER_CANCELLED";
  const line = exported.lines.find((l) => l.payeeKey === "affiliate:aff-wanjiku")!;
  const result = await h.batches.reconcile({ adminUserId: "admin-titus", batchId: exported.batch!.id, contentBase64: resultsFile([
    ["SJK3ABC12X", "254711000001", "375", "Completed", line.reference, ""]
  ]) });
  assert.deepEqual(result.rows[0].itemsNoLongerPayable, ["DL-c2"]);
  const payout = h.payouts[0];
  assert.equal(payout.amountKsh, 375, "the payout records what M-Pesa actually sent");
  assert.equal(payout.itemCount, 1);
  assert.equal(h.commissions.find((c) => c.id === "c1")!.status, "PAID");
  assert.equal(h.commissions.find((c) => c.id === "c2")!.status, "CONFIRMED", "only CONFIRMED → PAID for payable commissions");
  assert.match(String(payout.note), /no longer payable\): DL-c2/);
});

// ------------------------------------------------------------------ cancel ---

test("cancelling an export with no results releases everybody", async (t) => {
  const h = fixture(t);
  const exported = await h.batches.exportBatch({ adminUserId: "admin-titus", week: WEEK });
  const cancelled = await h.batches.cancelBatch({ adminUserId: "admin-titus", batchId: exported.batch!.id });
  assert.equal(cancelled.status, "CANCELLED");
  assert.equal(cancelled.released, 4);
  assert.ok(h.lines.every((line) => line.status === "CANCELLED"));
  assert.equal(h.audits.at(-1)!.action, "PAYOUT_BATCH_CANCELLED");
  await assert.rejects(h.batches.cancelBatch({ adminUserId: "admin-titus", batchId: exported.batch!.id }), /already closed or cancelled/);
  await assert.rejects(h.batches.batchFile({ adminUserId: "admin-titus", batchId: exported.batch!.id }), /cancelled/);
  await assert.rejects(h.batches.reconcile({ adminUserId: "admin-titus", batchId: exported.batch!.id, contentBase64: resultsFile([["SJK3ABC12X", "254711000001", "375", "Completed", "", ""]]) }), /cancelled/);
  const next = await h.batches.exportBatch({ adminUserId: "admin-titus", week: WEEK });
  assert.equal(next.lines.length, 4, "everyone can be exported again");
  assert.notEqual(next.batch!.reference, exported.batch!.reference);
});

// -------------------------------------------------- permission / self-payment ---

test("all bulk actions need finance.payout", async (t) => {
  const h = fixture(t, { permissions: ["action.affiliate.export"] });
  await assert.rejects(h.batches.exportBatch({ adminUserId: "admin-x", week: WEEK }), /permission/);
  await assert.rejects(h.batches.batchFile({ adminUserId: "admin-x", batchId: "b" }), /permission/);
  await assert.rejects(h.batches.cancelBatch({ adminUserId: "admin-x", batchId: "b" }), /permission/);
  await assert.rejects(h.batches.reconcile({ adminUserId: "admin-x", batchId: "b", contentBase64: "eA==" }), /permission/);
  assert.equal(h.batchRows.length, 0);
});

test("whoever uploads the results cannot settle their own payment", async (t) => {
  const h = fixture(t);
  const exported = await h.batches.exportBatch({ adminUserId: "admin-titus", week: WEEK });
  const line = exported.lines.find((l) => l.payeeKey === "affiliate:aff-wanjiku")!;
  h.state.payer = WANJIKU_ADMIN;
  const result = await h.batches.reconcile({ adminUserId: "admin-wanjiku", batchId: exported.batch!.id, contentBase64: resultsFile([
    ["SJK3ABC12X", "254711000001", "375", "Completed", line.reference, ""]
  ]) });
  assert.deepEqual([result.rows[0].outcome, result.rows[0].reason], ["UNMATCHED", "SELF_PAYMENT"]);
  assert.equal(h.payouts.length, 0);
  assert.equal(h.commissions.find((c) => c.id === "c1")!.status, "CONFIRMED");
});

test("an unreadable or empty upload is refused before anything is touched", async (t) => {
  const h = fixture(t);
  const exported = await h.batches.exportBatch({ adminUserId: "admin-titus", week: WEEK });
  await assert.rejects(h.batches.reconcile({ adminUserId: "admin-titus", batchId: exported.batch!.id }), /Choose the results file/);
  await assert.rejects(h.batches.reconcile({ adminUserId: "admin-titus", batchId: exported.batch!.id, contentBase64: Buffer.from("hello,world\n1,2").toString("base64") }), /header row/);
  await assert.rejects(h.batches.reconcile({ adminUserId: "admin-titus", batchId: exported.batch!.id, contentBase64: resultsFile([]) }), /no payment rows/);
  assert.ok(h.lines.every((line) => line.status === "PENDING"));
});
