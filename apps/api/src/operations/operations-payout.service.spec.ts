import "reflect-metadata";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { prisma } from "@online-saler/database";
import {
  COMMISSION_CONFIRMATION_HOURS,
  RETURN_REQUEST_WINDOW_HOURS,
  createCommissionEligibleAt
} from "@online-saler/business-rules";
import type { OperationsAccessService } from "./operations-access.service";
import { OperationsPayoutService } from "./operations-payout.service";
import { buildPayoutSheet, normalizeMpesaCode, payoutSheetCsv, payoutWeek, selfPaymentMatch } from "./operations-payout-sheet";

/**
 * 周结付款 (owner, 2026-10-14). The week Mon 5 – Sun 11 October 2026, Nairobi,
 * runs from 2026-10-04T21:00Z to 2026-10-11T21:00Z.
 */
const WEEK = "2026-10-05";
const START = new Date("2026-10-04T21:00:00.000Z");
const END = new Date("2026-10-11T21:00:00.000Z");
const IN_WEEK = new Date("2026-10-07T09:00:00.000Z");
const HOUR = 60 * 60 * 1000;

type Row = Record<string, unknown>;

// ------------------------------------------------------------ fake database ---

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, condition]) => {
    const value = row[key];
    if (condition === null) return value === null || value === undefined;
    if (condition instanceof Date) return value instanceof Date && value.getTime() === condition.getTime();
    if (typeof condition === "object") {
      const c = condition as Record<string, unknown>;
      if ("in" in c) return (c.in as unknown[]).includes(value);
      const n = value instanceof Date ? value.getTime() : (value as number);
      if (value === null || value === undefined) return false;
      const v = (x: unknown) => (x instanceof Date ? x.getTime() : (x as number));
      if ("gt" in c && !(n > v(c.gt))) return false;
      if ("gte" in c && !(n >= v(c.gte))) return false;
      if ("lt" in c && !(n < v(c.lt))) return false;
      return true;
    }
    return value === condition;
  });
}

function commission(id: string, options: {
  affiliate: Row;
  amount?: number;
  status?: string;
  confirmedAt?: Date | null;
  holdReason?: string | null;
  openReturn?: boolean;
}): Row {
  const amount = options.amount ?? 250;
  return {
    id,
    affiliateId: options.affiliate.id,
    status: options.status ?? "CONFIRMED",
    commissionAmountKsh: amount,
    rateBps: 2500,
    orderSubtotalKsh: amount * 4,
    holdReason: options.holdReason ?? null,
    confirmedAt: options.confirmedAt === undefined ? IN_WEEK : options.confirmedAt,
    paidAt: null,
    payoutId: null,
    note: null,
    affiliate: options.affiliate,
    order: {
      orderNumber: `DL-${id}`,
      status: "COMPLETED",
      totalKsh: amount * 4,
      payments: [{ status: "SUCCESS", amountKsh: amount * 4 }],
      fulfillment: { status: "COMPLETED", completedAt: new Date(IN_WEEK.getTime() - 80 * HOUR) },
      customerServiceCases: [],
      afterSaleReturns: options.openReturn ? [{ status: "REQUESTED" }] : []
    }
  };
}

function fee(id: string, rider: Row | null, options: { ksh?: number | null; completedAt?: Date; name?: string; phone?: string; status?: string } = {}): Row {
  return {
    id,
    status: options.status ?? "COMPLETED",
    riderFeeKsh: options.ksh === undefined ? 100 : options.ksh,
    completedAt: options.completedAt ?? IN_WEEK,
    riderFeePayoutId: null,
    deliveryRiderId: rider?.id ?? null,
    deliveryRiderName: options.name ?? (rider?.name as string | undefined) ?? null,
    deliveryRiderPhone: options.phone ?? (rider?.phone as string | undefined) ?? null,
    deliveryRider: rider,
    order: { orderNumber: `DL-${id}` }
  };
}

const WANJIKU = { id: "aff-wanjiku", displayName: "Wanjiku Kamau", affiliateCode: "WANJIKU", phone: "0711000001", email: "wanjiku@example.com", customer: null };
const OTIENO = { id: "aff-otieno", displayName: "Otieno Ochieng", affiliateCode: "OTIENO", phone: "0711000002", email: null, customer: null };
const STORE_RIDER = { id: "rider-kamau", type: "INTERNAL", name: "Peter Kamau", phone: "0722000001", adminUserId: "admin-rider", employeeId: "emp-rider", fulfillmentNodeId: "node-kinoo" };
const BOLT_A = { id: "rider-bolt-1", type: "EXTERNAL", name: "James Bolt", phone: "0733000001", adminUserId: null, employeeId: null, fulfillmentNodeId: null };
const BOLT_B = { id: "rider-bolt-2", type: "EXTERNAL", name: "James  bolt", phone: "+254733000001", adminUserId: null, employeeId: null, fulfillmentNodeId: null };

type Admin = { id: string; name: string; email: string | null; phone: string | null; loginAccount: string; linkedEmployeeId: string | null; linkedEmployee: { name: string; phone: string | null } | null };
const TITUS: Admin = { id: "admin-titus", name: "Titus Mwangi", email: "titus@example.com", phone: "0700000099", loginAccount: "titus", linkedEmployeeId: null, linkedEmployee: null };

function fixture(t: TestContext, options: { commissions?: Row[]; fees?: Row[]; payer?: Admin; permissions?: string[] } = {}) {
  const commissions = options.commissions ?? [
    commission("c1", { affiliate: WANJIKU, amount: 250 }),
    commission("c2", { affiliate: WANJIKU, amount: 125, confirmedAt: START }),
    commission("c3", { affiliate: OTIENO, amount: 500 }),
    commission("held", { affiliate: OTIENO, holdReason: "ORDER_CANCELLED" }),
    commission("pending", { affiliate: OTIENO, status: "PENDING", confirmedAt: null }),
    commission("paid", { affiliate: WANJIKU, status: "PAID" }),
    commission("returning", { affiliate: WANJIKU, openReturn: true }),
    commission("zero", { affiliate: OTIENO, amount: 0 }),
    commission("last-sunday", { affiliate: WANJIKU, confirmedAt: new Date(START.getTime() - 1) }),
    commission("next-monday", { affiliate: WANJIKU, confirmedAt: END })
  ];
  const fees = options.fees ?? [
    fee("f1", STORE_RIDER, { ksh: 100 }),
    fee("f2", STORE_RIDER, { ksh: 50 }),
    fee("b1", BOLT_A, { ksh: 100 }),
    fee("b2", BOLT_B, { ksh: 50 }),
    fee("unset", STORE_RIDER, { ksh: null }),
    fee("failed", STORE_RIDER, { status: "DELIVERY_FAILED" }),
    fee("old", STORE_RIDER, { completedAt: new Date(START.getTime() - HOUR) })
  ];
  const payouts: Row[] = [];
  const audits: Row[] = [];
  const locks: unknown[] = [];
  const payer = options.payer ?? TITUS;

  const tx = {
    $queryRaw: async (...args: unknown[]) => { locks.push(args); return []; },
    commission: {
      findMany: async ({ where }: { where: Row }) => commissions.filter((row) => matches(row, where)),
      aggregate: async ({ where }: { where: Row }) => {
        const rows = commissions.filter((row) => matches(row, where));
        return { _sum: { commissionAmountKsh: rows.reduce((s, r) => s + (r.commissionAmountKsh as number), 0) }, _count: { _all: rows.length } };
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const rows = commissions.filter((row) => matches(row, where));
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      }
    },
    orderFulfillment: {
      findMany: async ({ where }: { where: Row }) => fees.filter((row) => matches(row, where)),
      aggregate: async ({ where }: { where: Row }) => {
        const rows = fees.filter((row) => matches(row, where));
        return { _sum: { riderFeeKsh: rows.reduce((s, r) => s + ((r.riderFeeKsh as number) ?? 0), 0) }, _count: { _all: rows.length } };
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const rows = fees.filter((row) => matches(row, where));
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      }
    },
    payout: {
      findUnique: async ({ where }: { where: { mpesaCode: string } }) => payouts.find((p) => p.mpesaCode === where.mpesaCode) ?? null,
      findMany: async ({ where }: { where: Row }) =>
        payouts.filter((p) => matches(p, where)).map((p) => ({ ...p, paidByAdminUser: { name: "Titus Mwangi" } })),
      create: async ({ data }: { data: Row }) => {
        if (payouts.some((p) => p.mpesaCode === data.mpesaCode)) throw new Error("unique");
        const row = { id: `payout-${payouts.length + 1}`, ...data };
        payouts.push(row);
        return row;
      }
    },
    // No M-Pesa bulk files in these tests; see operations-payout-batch.service.spec.ts.
    payoutBatch: { findMany: async () => [] },
    payoutBatchLine: { findMany: async () => [] },
    auditLog: { create: async ({ data }: { data: Row }) => { audits.push(data); return data; } },
    adminUser: { findUnique: async () => payer }
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
      return { adminUser: { id: payer.id, linkedEmployeeId: payer.linkedEmployeeId }, roles: [], permissions };
    }
  } as unknown as OperationsAccessService;

  return { service: new OperationsPayoutService(access), commissions, fees, payouts, audits, locks };
}

// ------------------------------------------------------------------- rules ---

test("commission is confirmable 72 hours after handover, the same as the return window", () => {
  assert.equal(COMMISSION_CONFIRMATION_HOURS, 72);
  assert.equal(COMMISSION_CONFIRMATION_HOURS, RETURN_REQUEST_WINDOW_HOURS);
  const handover = new Date("2026-10-01T08:00:00Z");
  assert.equal(createCommissionEligibleAt(handover).toISOString(), "2026-10-04T08:00:00.000Z");
});

test("the payout week is Monday to Sunday in Nairobi, last week by default", () => {
  const byDefault = payoutWeek(undefined, new Date("2026-10-14T06:00:00Z"));
  assert.equal(byDefault.start.toISOString(), START.toISOString());
  assert.equal(byDefault.end.toISOString(), END.toISOString());
  assert.equal(byDefault.firstDay, "2026-10-05");
  assert.equal(byDefault.lastDay, "2026-10-11");
  // Monday 01:00 in Nairobi is still Sunday 22:00 UTC: the new week, so "last week" is 5–11 Oct.
  assert.equal(payoutWeek(undefined, new Date("2026-10-11T22:00:00Z")).firstDay, "2026-10-05");
  // Sunday 23:00 Nairobi: still the week of 5–11 Oct, so last week is 28 Sep – 4 Oct.
  assert.equal(payoutWeek(undefined, new Date("2026-10-11T20:00:00Z")).firstDay, "2026-09-28");
  for (const day of ["2026-10-05", "2026-10-08", "2026-10-11"]) assert.equal(payoutWeek(day).firstDay, "2026-10-05");
  assert.throws(() => payoutWeek("5/10/2026"), /YYYY-MM-DD/);
  assert.throws(() => payoutWeek("2026-02-30"), /real calendar date/);
});

test("an M-Pesa code is 10 letters and digits, upper-cased", () => {
  assert.equal(normalizeMpesaCode("sjk3abc12x"), "SJK3ABC12X");
  assert.equal(normalizeMpesaCode(" SJK3 ABC12X "), "SJK3ABC12X");
  for (const bad of ["", "SJK3ABC12", "SJK3ABC12XY", "SJK3-ABC12", "0712345678", null, 12345]) {
    assert.equal(normalizeMpesaCode(bad), null, String(bad));
  }
});

// ------------------------------------------------------------------- sheet ---

test("the sheet has one row per person and only this week's unpaid, unheld, confirmed items", async (t) => {
  const h = fixture(t);
  const sheet = await h.service.weeklySheet({ adminUserId: "admin-titus", week: WEEK });
  const byName = Object.fromEntries(sheet.rows.map((row) => [row.name, row]));

  assert.deepEqual(Object.keys(byName).sort(), ["James Bolt", "Otieno Ochieng", "Peter Kamau", "Wanjiku Kamau"]);
  assert.deepEqual(byName["Wanjiku Kamau"].items.map((i) => i.id), ["c2", "c1"], "Monday 00:00 is in; held, paid, returning, last Sunday and next Monday are out");
  assert.equal(byName["Wanjiku Kamau"].amountKsh, 375);
  assert.equal(byName["Wanjiku Kamau"].count, 2);
  assert.equal(byName["Wanjiku Kamau"].payeeType, "AFFILIATE");
  assert.equal(byName["Wanjiku Kamau"].phone, "0711000001");
  assert.deepEqual(byName["Otieno Ochieng"].items.map((i) => i.id), ["c3"], "held, pending and zero are out");

  assert.equal(byName["Peter Kamau"].payeeType, "RIDER");
  assert.equal(byName["Peter Kamau"].payeeKey, "rider:rider-kamau");
  assert.deepEqual(byName["Peter Kamau"].items.map((i) => i.id).sort(), ["f1", "f2"], "unset fee, failed delivery and last week's delivery are out");
  assert.equal(byName["Peter Kamau"].amountKsh, 150);
  assert.deepEqual(byName["James Bolt"].items.map((i) => i.id).sort(), ["b1", "b2"], "a Bolt rider typed in twice is one person by phone and name");
  assert.equal(byName["James Bolt"].amountKsh, 150);

  assert.equal(sheet.totals.amountKsh, 375 + 500 + 150 + 150);
  assert.equal(sheet.totals.affiliateKsh, 875);
  assert.equal(sheet.totals.riderKsh, 300);
  assert.equal(sheet.totals.people, 4);
  assert.equal(sheet.earlierUnpaid.commissionCount, 1, "last Sunday's commission waits in its own week");
  assert.equal(sheet.earlierUnpaid.riderFeeCount, 1);
  assert.match(sheet.csv, /^week,type,name,mpesa_phone,amount_ksh,orders,order_numbers\n/);
  assert.match(sheet.csv, /2026-10-05~2026-10-11,affiliate,Wanjiku Kamau,0711000001,375,2,DL-c2 DL-c1/);
});

test("the CSV cannot smuggle a spreadsheet formula", () => {
  const rows = buildPayoutSheet([], [{
    id: "x", riderFeeKsh: 50, completedAt: IN_WEEK, deliveryRiderId: null, deliveryRiderName: "=HYPERLINK(\"x\")", deliveryRiderPhone: "0700000000", deliveryRider: null, order: { orderNumber: "DL-1" }
  }]);
  assert.match(payoutSheetCsv(rows, { firstDay: "a", lastDay: "b" }), /"'=HYPERLINK\(""x""\)"/);
});

// --------------------------------------------------------------- mark paid ---

test("recording a payout marks every commission in the row paid, once", async (t) => {
  const h = fixture(t);
  const result = await h.service.markPaid({ adminUserId: "admin-titus", week: WEEK, payeeKey: "affiliate:aff-wanjiku", mpesaCode: "sjk3abc12x", note: "Week 41", expectedAmountKsh: 375 });

  assert.equal(result.alreadyRecorded, false);
  assert.equal(result.payout.mpesaCode, "SJK3ABC12X");
  assert.equal(result.payout.amountKsh, 375);
  assert.equal(result.payout.itemCount, 2);
  assert.equal(result.payout.payeeType, "AFFILIATE");
  assert.equal(result.payout.affiliateId, "aff-wanjiku");
  assert.equal((result.payout.periodStart as Date).toISOString(), START.toISOString());
  assert.equal(result.payout.paidByAdminUserId, "admin-titus");
  for (const id of ["c1", "c2"]) {
    const row = h.commissions.find((c) => c.id === id)!;
    assert.equal(row.status, "PAID");
    assert.equal(row.payoutId, result.payout.id);
    assert.ok(row.paidAt instanceof Date);
    assert.match(String(row.note), /M-Pesa SJK3ABC12X · Week 41/);
  }
  assert.equal(h.commissions.find((c) => c.id === "c3")!.status, "CONFIRMED", "another person's row is untouched");
  assert.equal(h.commissions.find((c) => c.id === "returning")!.status, "CONFIRMED", "a blocked commission is not swept in");
  assert.deepEqual(h.audits.map((a) => a.action), ["PAYOUT_RECORDED", "COMMISSION_RECORD_PAYMENT", "COMMISSION_RECORD_PAYMENT"]);
  assert.ok(h.locks.length >= 1, "the orders are locked before writing");

  const after = await h.service.weeklySheet({ adminUserId: "admin-titus", week: WEEK });
  assert.equal(after.rows.some((row) => row.payeeKey === "affiliate:aff-wanjiku"), false, "a paid person is not listed again");
  assert.equal(after.paid.length, 1);
  assert.equal(after.totals.paidKsh, 375);

  // A double click with the same code returns the same payout; nothing more is written.
  const again = await h.service.markPaid({ adminUserId: "admin-titus", week: WEEK, payeeKey: "affiliate:aff-wanjiku", mpesaCode: "SJK3ABC12X" });
  assert.equal(again.alreadyRecorded, true);
  assert.equal(h.payouts.length, 1);
  // The same code for somebody else is refused.
  await assert.rejects(
    h.service.markPaid({ adminUserId: "admin-titus", week: WEEK, payeeKey: "affiliate:aff-otieno", mpesaCode: "SJK3ABC12X" }),
    /already recorded for another payout/
  );
  // Nothing left to pay for a person already paid.
  await assert.rejects(
    h.service.markPaid({ adminUserId: "admin-titus", week: WEEK, payeeKey: "affiliate:aff-wanjiku", mpesaCode: "TJK3ABC12X" }),
    /Nothing is waiting to be paid/
  );
  assert.equal(h.payouts.length, 1);
});

test("rider fees are paid through a payout record linked from each delivery", async (t) => {
  const h = fixture(t);
  const result = await h.service.markPaid({ adminUserId: "admin-titus", week: WEEK, payeeKey: "rider:rider-kamau", mpesaCode: "RK12345ABC" });
  assert.equal(result.payout.payeeType, "RIDER");
  assert.equal(result.payout.deliveryRiderId, "rider-kamau");
  assert.equal(result.payout.amountKsh, 150);
  for (const id of ["f1", "f2"]) assert.equal(h.fees.find((f) => f.id === id)!.riderFeePayoutId, result.payout.id);
  assert.equal(h.fees.find((f) => f.id === "old")!.riderFeePayoutId, null, "last week's delivery waits for its own week");
  assert.deepEqual(h.audits.map((a) => a.action), ["PAYOUT_RECORDED", "RIDER_FEE_PAID", "RIDER_FEE_PAID"]);

  const bolt = await h.service.markPaid({ adminUserId: "admin-titus", week: WEEK, payeeKey: "external:254733000001|james bolt", mpesaCode: "BK12345ABC" });
  assert.equal(bolt.payout.amountKsh, 150);
  assert.equal(bolt.payout.payeePhone, "0733000001");
  assert.ok(["b1", "b2"].every((id) => h.fees.find((f) => f.id === id)!.riderFeePayoutId === bolt.payout.id));
});

test("a bad code, a changed total and a missing permission are refused before anything is written", async (t) => {
  const h = fixture(t);
  await assert.rejects(h.service.markPaid({ adminUserId: "admin-titus", week: WEEK, payeeKey: "affiliate:aff-otieno", mpesaCode: "12345" }), /10 letters and digits/);
  await assert.rejects(h.service.markPaid({ adminUserId: "admin-titus", week: WEEK, payeeKey: "affiliate:aff-otieno" }), /10 letters and digits/);
  await assert.rejects(h.service.markPaid({ adminUserId: "admin-titus", week: WEEK, mpesaCode: "SJK3ABC12X" }), /Choose who/);
  await assert.rejects(
    h.service.markPaid({ adminUserId: "admin-titus", week: WEEK, payeeKey: "affiliate:aff-otieno", mpesaCode: "SJK3ABC12X", expectedAmountKsh: 400 }),
    /has changed and is now KSh 500/
  );
  assert.equal(h.payouts.length, 0);
  assert.equal(h.commissions.find((c) => c.id === "c3")!.status, "CONFIRMED");

  const noPermission = fixture(t, { permissions: ["action.affiliate.approve", "action.affiliate.export"] });
  await assert.rejects(noPermission.service.weeklySheet({ adminUserId: "admin-x", week: WEEK }), /permission/);
  await assert.rejects(
    noPermission.service.markPaid({ adminUserId: "admin-x", week: WEEK, payeeKey: "affiliate:aff-otieno", mpesaCode: "SJK3ABC12X" }),
    /permission/
  );
  assert.equal(noPermission.payouts.length, 0);
});

// ------------------------------------------------------------ self-payment ---

test("the paying admin cannot record a payout to themselves", async (t) => {
  // Titus is also a promoter, signed up with the same phone written another way.
  const titusAffiliate = { id: "aff-titus", displayName: "Titus M", affiliateCode: "TITUS", phone: "+254700000099", email: null, customer: null };
  const h = fixture(t, { commissions: [commission("t1", { affiliate: titusAffiliate })], fees: [] });
  const sheet = await h.service.weeklySheet({ adminUserId: "admin-titus", week: WEEK });
  assert.equal(sheet.rows[0].selfPayment?.by, "phone");
  assert.match(String(sheet.rows[0].selfPayment?.message), /cannot record a payout to yourself/);
  await assert.rejects(
    h.service.markPaid({ adminUserId: "admin-titus", week: WEEK, payeeKey: "affiliate:aff-titus", mpesaCode: "SJK3ABC12X" }),
    /cannot record a payout to yourself/
  );
  assert.equal(h.payouts.length, 0);
  assert.equal(h.commissions[0].status, "CONFIRMED");

  // A rider who signs in with the payer's own account.
  const riderAdmin: Admin = { id: "admin-rider", name: "Peter", email: null, phone: null, loginAccount: "peter", linkedEmployeeId: null, linkedEmployee: null };
  const r = fixture(t, { commissions: [], fees: [fee("f1", STORE_RIDER)], payer: riderAdmin });
  await assert.rejects(
    r.service.markPaid({ adminUserId: "admin-rider", week: WEEK, payeeKey: "rider:rider-kamau", mpesaCode: "SJK3ABC12X" }),
    /cannot record a payout to yourself/
  );
});

test("self-payment matching follows the business report's staff rules", () => {
  const payer = { adminUserId: "a", linkedEmployeeId: "e", name: "Titus Mwangi", employeeName: "Titus Mwangi", phones: ["0700000099", "titus"], emails: ["Titus@Example.com", "titus"] };
  const affiliate = (over: Record<string, unknown>) => ({ payeeType: "AFFILIATE" as const, displayName: "Someone Else", phone: null, email: null, customer: null, ...over });
  assert.equal(selfPaymentMatch(payer, affiliate({ phone: "254700000099" })), "phone");
  assert.equal(selfPaymentMatch(payer, affiliate({ customer: { phone: "0700000099", email: null } })), "phone");
  assert.equal(selfPaymentMatch(payer, affiliate({ email: "titus@example.com" })), "email");
  assert.equal(selfPaymentMatch(payer, affiliate({ displayName: "titus  MWANGI" })), "name");
  assert.equal(selfPaymentMatch(payer, affiliate({ displayName: "Titus" })), null, "a first name alone proves nothing");
  assert.equal(selfPaymentMatch(payer, affiliate({})), null);
  const rider = { payeeType: "RIDER" as const, name: "Peter Kamau", phone: "0722000001", adminUserId: null, employeeId: "e" };
  assert.equal(selfPaymentMatch(payer, rider), "account", "the rider row belongs to the payer's employee record");
  assert.equal(selfPaymentMatch(payer, { ...rider, employeeId: null }), null);
});
