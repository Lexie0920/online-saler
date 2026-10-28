import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import {
  ActorType,
  CommissionStatus,
  FulfillmentStatus,
  PayoutBatchLineStatus,
  PayoutBatchStatus,
  PayoutPayeeType,
  Prisma,
  SourceApp,
  prisma
} from "@online-saler/database";
import { OperationsAccessService } from "./operations-access.service";
import { commissionOrderInclude } from "./operations-affiliate.service";
import { commissionEligibility } from "./operations-commission-policy";
import { bulkPhone } from "./mpesa-bulk-format";
import { EXPORT_ROW_LIMIT, buildPayoutList, type ExportItem } from "./operations-payout-export";
import {
  buildPayoutSheet,
  normalizeMpesaCode,
  payoutSheetCsv,
  payoutWeek,
  selfPaymentMatch,
  type PayeeIdentity,
  type Payer,
  type PayoutRow,
  type PayoutWeek,
  type SheetCommission,
  type SheetRiderFee
} from "./operations-payout-sheet";

/**
 * 周结付款 — weekly manual M-Pesa payouts (owner, 2026-10-14, "做法一").
 *
 * The sheet lists, per person, what the shop owes for one Monday–Sunday week:
 * promoters' confirmed commissions and riders' delivery fees. Finance sends
 * each amount by hand with M-Pesa Send Money and records the transaction code
 * here. Recording a code marks every item in that person's row paid, in one
 * database transaction: commissions take the existing CONFIRMED → PAID step,
 * rider fees are linked to the new Payout row. The same code is never
 * accepted twice and a paid item is never listed again.
 *
 * Nothing here moves money and nothing touches an order, payment, stock or
 * return state.
 */

export const FINANCE_PAYOUT = "finance.payout";

export type Db = Prisma.TransactionClient;

export type PayoutSheetInput = { adminUserId?: string; week?: string };

export type PayoutExportInput = { adminUserId?: string; /** "true": only the people and amount, for the button label. */ summaryOnly?: string };

export type MarkPayoutPaidInput = {
  adminUserId?: string;
  week?: string;
  payeeKey?: string;
  mpesaCode?: string;
  note?: string;
  /** What the screen showed; refused if the row has changed since. */
  expectedAmountKsh?: number;
};

export const SELF_PAYMENT_MESSAGE =
  "You cannot record a payout to yourself. Another finance or super admin account has to record this one.";

const riderSelect = {
  id: true,
  type: true,
  name: true,
  phone: true,
  adminUserId: true,
  employeeId: true,
  fulfillmentNodeId: true
} as const;

@Injectable()
export class OperationsPayoutService {
  constructor(private readonly access: OperationsAccessService) {}

  /** The sheet for one week, with what was already paid for it and a CSV. */
  async weeklySheet(input: PayoutSheetInput) {
    const session = await this.access.requirePermission(input.adminUserId, FINANCE_PAYOUT);
    const week = parseWeek(input.week);
    const now = new Date();
    return prisma.$transaction(async (tx) => {
      const payer = await loadPayer(tx, session.adminUser!.id);
      const { rows, identities } = await loadSheet(tx, week, now);
      const exported = await pendingBatchLines(tx, week);
      const batches = await loadWeekBatches(tx, week);
      const [paid, olderCommissions, olderRiderFees, pending] = await Promise.all([
        tx.payout.findMany({
          where: { periodStart: week.start },
          orderBy: { paidAt: "desc" },
          select: {
            id: true,
            payeeType: true,
            payeeKey: true,
            payeeName: true,
            payeePhone: true,
            amountKsh: true,
            itemCount: true,
            mpesaCode: true,
            paidAt: true,
            note: true,
            paidByAdminUser: { select: { name: true } }
          }
        }),
        tx.commission.aggregate({
          where: { ...payableCommissionWhere, confirmedAt: { lt: week.start } },
          _sum: { commissionAmountKsh: true },
          _count: { _all: true }
        }),
        tx.orderFulfillment.aggregate({
          where: { ...unpaidRiderFeeWhere, completedAt: { lt: week.start } },
          _sum: { riderFeeKsh: true },
          _count: { _all: true }
        }),
        tx.commission.findMany({
          where: { status: CommissionStatus.PENDING, holdReason: null },
          select: {
            commissionAmountKsh: true,
            holdReason: true,
            rateBps: true,
            orderSubtotalKsh: true,
            order: { include: commissionOrderInclude }
          }
        })
      ]);
      const readyToConfirm = pending.filter((commission) => !commissionEligibility(commission, now).blockingReason);
      const affiliateRows = rows.filter((row) => row.payeeType === "AFFILIATE");
      const riderRows = rows.filter((row) => row.payeeType === "RIDER");
      return {
        week: { start: week.start.toISOString(), end: week.end.toISOString(), firstDay: week.firstDay, lastDay: week.lastDay },
        totals: {
          people: rows.length,
          amountKsh: sumBy(rows, (row) => row.amountKsh),
          affiliateKsh: sumBy(affiliateRows, (row) => row.amountKsh),
          affiliatePeople: affiliateRows.length,
          riderKsh: sumBy(riderRows, (row) => row.amountKsh),
          riderPeople: riderRows.length,
          paidKsh: sumBy(paid, (payout) => payout.amountKsh),
          paidPeople: paid.length
        },
        rows: rows.map((row) => {
          const match = selfPaymentMatch(payer, identities.get(row.payeeKey)!);
          const line = exported.get(row.payeeKey);
          return {
            ...row,
            selfPayment: match ? { by: match, message: SELF_PAYMENT_MESSAGE } : null,
            /** 2547XXXXXXXX for the bulk file, or null: this person cannot go into a bulk file. */
            bulkPhone: bulkPhone(row.phone),
            /** In an exported bulk file still waiting for its M-Pesa results. */
            exported: line ? { batchId: line.batchId, batchReference: line.batchReference, lineReference: line.lineReference } : null
          };
        }),
        /** M-Pesa bulk files exported for this week, newest first. */
        batches,
        paid: paid.map((payout) => ({
          ...payout,
          paidAt: payout.paidAt.toISOString(),
          paidByName: payout.paidByAdminUser.name,
          paidByAdminUser: undefined
        })),
        /** Unpaid items that belong to earlier weeks: open that week to pay them. */
        earlierUnpaid: {
          commissionKsh: olderCommissions._sum.commissionAmountKsh ?? 0,
          commissionCount: olderCommissions._count._all,
          riderFeeKsh: olderRiderFees._sum.riderFeeKsh ?? 0,
          riderFeeCount: olderRiderFees._count._all
        },
        /** PENDING commissions already past the 3-day window, waiting for 确认. */
        awaitingConfirmation: {
          count: readyToConfirm.length,
          amountKsh: sumBy(readyToConfirm, (commission) => commission.commissionAmountKsh)
        },
        csv: payoutSheetCsv(rows, week)
      };
    });
  }

  /**
   * 导出: the payment list. Every confirmed, unpaid promoter commission from every week,
   * one row per promoter and week. Read-only. With summaryOnly the lines are left out, which
   * is what the page asks for to show "4 people · KSh 5,703" on the button.
   */
  async exportList(input: PayoutExportInput) {
    await this.access.requirePermission(input.adminUserId, FINANCE_PAYOUT);
    const now = new Date();
    const { items, truncated } = await loadExportItems(prisma, now);
    const list = buildPayoutList(items, truncated, now);
    if (input.summaryOnly === "true") return { fileName: list.fileName, summary: list.summary, lines: [] };
    return list;
  }

  /**
   * Records one M-Pesa payment to one person and marks every item in their row
   * paid. Double submissions of the same code for the same person and week
   * return the payout already recorded instead of failing.
   */
  async markPaid(input: MarkPayoutPaidInput) {
    const session = await this.access.requirePermission(input.adminUserId, FINANCE_PAYOUT);
    const actor = session.adminUser!;
    const week = parseWeek(input.week);
    const payeeKey = input.payeeKey?.trim();
    if (!payeeKey) throw new BadRequestException("Choose who this payout is for.");
    const mpesaCode = normalizeMpesaCode(input.mpesaCode);
    if (!mpesaCode) {
      throw new BadRequestException("Enter the M-Pesa transaction code from the confirmation SMS: 10 letters and digits, e.g. SJK3ABC12X.");
    }
    const note = input.note?.trim().slice(0, 300) || null;
    const now = new Date();

    try {
      return await prisma.$transaction(async (tx) => {
        const existing = await tx.payout.findUnique({ where: { mpesaCode } });
        if (existing) {
          if (existing.payeeKey === payeeKey && existing.periodStart.getTime() === week.start.getTime()) {
            return { payout: existing, alreadyRecorded: true };
          }
          throw new ConflictException(`M-Pesa code ${mpesaCode} was already recorded for another payout (${existing.payeeName}). Check the code.`);
        }

        // Read the row, lock what it covers, then read it again: an item that
        // was paid, held or reversed in between drops out before anything is written.
        const first = (await loadSheet(tx, week, now)).rows.find((row) => row.payeeKey === payeeKey);
        if (!first) throw new NotFoundException("Nothing is waiting to be paid to this person for this week. It may already be paid; refresh the sheet.");
        await lockItems(tx, first);
        const { rows, identities } = await loadSheet(tx, week, now);
        const row = rows.find((candidate) => candidate.payeeKey === payeeKey);
        if (!row) throw new NotFoundException("Nothing is waiting to be paid to this person for this week. It may already be paid; refresh the sheet.");
        if (row.amountKsh !== first.amountKsh || row.count !== first.count
          || (input.expectedAmountKsh !== undefined && input.expectedAmountKsh !== null && Number(input.expectedAmountKsh) !== row.amountKsh)) {
          throw new ConflictException(`This person's total has changed and is now KSh ${row.amountKsh} for ${row.count} orders. Refresh the sheet and check before recording.`);
        }

        const payer = await loadPayer(tx, actor.id);
        if (selfPaymentMatch(payer, identities.get(row.payeeKey)!)) throw new ForbiddenException(SELF_PAYMENT_MESSAGE);
        const exported = (await pendingBatchLines(tx, week)).get(row.payeeKey);
        if (exported) {
          throw new ConflictException(`This person is in M-Pesa bulk file ${exported.batchReference}, which is waiting for its results. Upload the portal's results report, or cancel that export, before recording a payment by hand.`);
        }

        const payout = await recordPayout(tx, { row, week, mpesaCode, note, actor, now });
        return { payout, alreadyRecorded: false };
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException(`M-Pesa code ${mpesaCode} has already been recorded.`);
      }
      throw error;
    }
  }
}

export type PayoutActor = { id: string; linkedEmployeeId: string | null };

/**
 * Writes one Payout for one person and marks the items in `row` paid: the
 * existing CONFIRMED → PAID step for commissions, the payout link for rider
 * fees, and the audit trail. Used by the manual "登记已付" and by the M-Pesa
 * bulk results upload. The caller has locked the items and re-read the row.
 * `amountKsh` is what was actually sent when it differs from the items' sum
 * (a bulk line whose item dropped out after export).
 */
export async function recordPayout(tx: Db, input: {
  row: PayoutRow;
  week: PayoutWeek;
  mpesaCode: string;
  note: string | null;
  actor: PayoutActor;
  now: Date;
  amountKsh?: number;
  phone?: string | null;
  source?: Record<string, unknown>;
}) {
  const { row, week, mpesaCode, note, actor, now } = input;
  const payout = await tx.payout.create({
    data: {
      payeeType: row.payeeType === "AFFILIATE" ? PayoutPayeeType.AFFILIATE : PayoutPayeeType.RIDER,
      payeeKey: row.payeeKey,
      affiliateId: row.affiliateId,
      deliveryRiderId: row.deliveryRiderId,
      payeeName: row.name,
      payeePhone: input.phone !== undefined ? input.phone : row.phone,
      amountKsh: input.amountKsh ?? row.amountKsh,
      itemCount: row.items.length,
      mpesaCode,
      periodStart: week.start,
      periodEnd: week.end,
      paidByAdminUserId: actor.id,
      paidAt: now,
      note
    }
  });

  const commissionIds = row.items.filter((item) => item.kind === "COMMISSION").map((item) => item.id);
  const feeIds = row.items.filter((item) => item.kind === "RIDER_FEE").map((item) => item.id);
  const paymentNote = [`Weekly payout ${week.firstDay}~${week.lastDay}`, `M-Pesa ${mpesaCode}`, note].filter(Boolean).join(" · ");

  if (commissionIds.length) {
    // The existing CONFIRMED → PAID step, for every commission at once.
    const changed = await tx.commission.updateMany({
      where: { id: { in: commissionIds }, ...payableCommissionWhere },
      data: { status: CommissionStatus.PAID, paidAt: now, payoutId: payout.id, note: paymentNote }
    });
    if (changed.count !== commissionIds.length) {
      throw new ConflictException("A commission in this row changed while recording. Nothing was saved; refresh and try again.");
    }
  }
  if (feeIds.length) {
    const changed = await tx.orderFulfillment.updateMany({
      where: { id: { in: feeIds }, ...unpaidRiderFeeWhere },
      data: { riderFeePayoutId: payout.id }
    });
    if (changed.count !== feeIds.length) {
      throw new ConflictException("A delivery in this row changed while recording. Nothing was saved; refresh and try again.");
    }
  }

  const audit = {
    actorType: ActorType.EMPLOYEE,
    actorId: actor.linkedEmployeeId,
    actorAdminUserId: actor.id,
    sourceApp: SourceApp.OPERATIONS,
    reason: paymentNote
  };
  await tx.auditLog.create({
    data: {
      ...audit,
      module: "FINANCE",
      entityType: "Payout",
      entityId: payout.id,
      action: "PAYOUT_RECORDED",
      afterJson: {
        payeeType: payout.payeeType,
        payeeKey: payout.payeeKey,
        payeeName: payout.payeeName,
        payeePhone: payout.payeePhone,
        amountKsh: payout.amountKsh,
        itemCount: payout.itemCount,
        mpesaCode: payout.mpesaCode,
        periodStart: payout.periodStart.toISOString(),
        periodEnd: payout.periodEnd.toISOString(),
        commissionIds,
        riderFeeFulfillmentIds: feeIds,
        ...(input.source ?? {})
      } as Prisma.InputJsonValue
    }
  });
  for (const item of row.items) {
    await tx.auditLog.create({
      data: item.kind === "COMMISSION"
        ? {
            ...audit,
            module: "AFFILIATE",
            entityType: "Commission",
            entityId: item.id,
            action: "COMMISSION_RECORD_PAYMENT",
            beforeJson: { status: CommissionStatus.CONFIRMED, paidAt: null, payoutId: null, commissionAmountKsh: item.amountKsh },
            afterJson: { status: CommissionStatus.PAID, paidAt: now.toISOString(), payoutId: payout.id, commissionAmountKsh: item.amountKsh }
          }
        : {
            ...audit,
            module: "FINANCE",
            entityType: "OrderFulfillment",
            entityId: item.id,
            action: "RIDER_FEE_PAID",
            beforeJson: { riderFeeKsh: item.amountKsh, riderFeePayoutId: null },
            afterJson: { riderFeeKsh: item.amountKsh, riderFeePayoutId: payout.id }
          }
    });
  }
  return payout;
}

/** The bulk files exported for a week with each person's result, newest first. */
export async function loadWeekBatches(tx: Db, week: PayoutWeek) {
  const batches = await tx.payoutBatch.findMany({
    where: { periodStart: week.start },
    orderBy: { exportedAt: "desc" },
    include: { exportedByAdminUser: { select: { name: true } } }
  });
  if (!batches.length) return [];
  const lines = await tx.payoutBatchLine.findMany({
    where: { batchId: { in: batches.map((batch) => batch.id) } },
    orderBy: { reference: "asc" },
    select: {
      id: true, batchId: true, reference: true, status: true, payeeType: true, payeeKey: true, payeeName: true,
      phone: true, amountKsh: true, mpesaCode: true, resultStatus: true, resultReason: true, resultAt: true
    }
  });
  return batches.map((batch) => {
    const own = lines.filter((line) => line.batchId === batch.id);
    const count = (status: PayoutBatchLineStatus) => own.filter((line) => line.status === status);
    return {
      id: batch.id,
      reference: batch.reference,
      status: batch.status,
      lineCount: batch.lineCount,
      totalKsh: batch.totalKsh,
      exportedAt: batch.exportedAt.toISOString(),
      exportedByName: batch.exportedByAdminUser?.name ?? null,
      cancelledAt: batch.cancelledAt?.toISOString() ?? null,
      reconciledAt: batch.reconciledAt?.toISOString() ?? null,
      counts: {
        pending: count(PayoutBatchLineStatus.PENDING).length,
        paid: count(PayoutBatchLineStatus.PAID).length,
        paidKsh: sumBy(count(PayoutBatchLineStatus.PAID), (line) => line.amountKsh),
        failed: count(PayoutBatchLineStatus.FAILED).length,
        cancelled: count(PayoutBatchLineStatus.CANCELLED).length
      },
      lines: own.map((line) => ({ ...line, resultAt: line.resultAt?.toISOString() ?? null }))
    };
  });
}

export type PendingBatchLine = { batchId: string; batchReference: string; lineId: string; lineReference: string };

/** People in an exported bulk file that is still waiting for its results, by payee key. */
export async function pendingBatchLines(tx: Db, week: PayoutWeek): Promise<Map<string, PendingBatchLine>> {
  const batches = await tx.payoutBatch.findMany({
    where: { periodStart: week.start, status: PayoutBatchStatus.OPEN },
    select: { id: true, reference: true }
  });
  const pending = new Map<string, PendingBatchLine>();
  if (!batches.length) return pending;
  const references = new Map(batches.map((batch) => [batch.id, batch.reference]));
  const lines = await tx.payoutBatchLine.findMany({
    where: { batchId: { in: batches.map((batch) => batch.id) }, status: PayoutBatchLineStatus.PENDING },
    select: { id: true, batchId: true, reference: true, payeeKey: true }
  });
  for (const line of lines) {
    pending.set(line.payeeKey, { batchId: line.batchId, batchReference: references.get(line.batchId) ?? "", lineId: line.id, lineReference: line.reference });
  }
  return pending;
}

/** CONFIRMED, unpaid, not on hold, above zero: the payout export's rule. */
export const payableCommissionWhere = {
  status: CommissionStatus.CONFIRMED,
  holdReason: null,
  paidAt: null,
  payoutId: null,
  commissionAmountKsh: { gt: 0 }
} satisfies Prisma.CommissionWhereInput;

export const unpaidRiderFeeWhere = {
  status: FulfillmentStatus.COMPLETED,
  riderFeeKsh: { gt: 0 },
  riderFeePayoutId: null
} satisfies Prisma.OrderFulfillmentWhereInput;

export function parseWeek(day?: string): PayoutWeek {
  try {
    return payoutWeek(day);
  } catch (error) {
    throw new BadRequestException(error instanceof Error ? error.message : "Invalid week.");
  }
}

export async function loadSheet(tx: Db, week: PayoutWeek, now: Date): Promise<{ rows: PayoutRow[]; identities: Map<string, PayeeIdentity> }> {
  const [commissions, fees] = await Promise.all([
    tx.commission.findMany({
      where: { ...payableCommissionWhere, confirmedAt: { gte: week.start, lt: week.end } },
      include: {
        affiliate: { include: { customer: { select: { phone: true, email: true } } } },
        order: { include: commissionOrderInclude }
      },
      orderBy: { confirmedAt: "asc" }
    }),
    tx.orderFulfillment.findMany({
      where: { ...unpaidRiderFeeWhere, completedAt: { gte: week.start, lt: week.end } },
      select: {
        id: true,
        riderFeeKsh: true,
        completedAt: true,
        deliveryRiderId: true,
        deliveryRiderName: true,
        deliveryRiderPhone: true,
        deliveryRider: { select: riderSelect },
        order: { select: { orderNumber: true } }
      },
      orderBy: { completedAt: "asc" }
    })
  ]);
  // Same gate as the payout export: a confirmed commission whose order has
  // since gained a return or a refund case is not paid until it is resolved.
  const payable = commissions.filter((commission) => !commissionEligibility(commission, now).blockingReason);
  const rows = buildPayoutSheet(payable as unknown as SheetCommission[], fees as unknown as SheetRiderFee[]);

  const identities = new Map<string, PayeeIdentity>();
  for (const commission of payable) {
    identities.set(`affiliate:${commission.affiliateId}`, {
      payeeType: "AFFILIATE",
      displayName: commission.affiliate.displayName,
      phone: commission.affiliate.phone,
      email: commission.affiliate.email,
      customer: commission.affiliate.customer ?? null
    });
  }
  for (const row of rows) {
    if (row.payeeType !== "RIDER") continue;
    const sample = fees.find((fee) => row.items.some((item) => item.id === fee.id));
    identities.set(row.payeeKey, {
      payeeType: "RIDER",
      name: row.name,
      phone: row.phone,
      adminUserId: sample?.deliveryRider?.adminUserId ?? null,
      employeeId: sample?.deliveryRider?.employeeId ?? null
    });
  }
  return { rows, identities };
}

/**
 * Every promoter commission that is confirmed and not paid, oldest first. They pass the same
 * eligibility gate as the weekly sheet: an order with an open return or refund is not payable
 * yet, and a frozen commission is not listed.
 */
export async function loadExportItems(tx: Db, now: Date): Promise<{ items: ExportItem[]; truncated: boolean }> {
  const commissions = await tx.commission.findMany({
    where: payableCommissionWhere,
    include: {
      affiliate: { include: { customer: { select: { phone: true, email: true } } } },
      order: { include: commissionOrderInclude }
    },
    orderBy: { confirmedAt: "asc" },
    take: EXPORT_ROW_LIMIT
  });
  const items: ExportItem[] = [];
  for (const commission of commissions) {
    if (commissionEligibility(commission, now).blockingReason) continue;
    items.push({
      payeeKey: `affiliate:${commission.affiliateId}`,
      name: commission.affiliate.displayName,
      phone: commission.affiliate.phone ?? commission.affiliate.customer?.phone ?? null,
      orderNumber: commission.order.orderNumber,
      confirmedAt: commission.confirmedAt,
      amountKsh: commission.commissionAmountKsh
    });
  }
  return { items, truncated: commissions.length >= EXPORT_ROW_LIMIT };
}

export async function lockItems(tx: Db, row: Pick<PayoutRow, "items">) {
  const commissionIds = row.items.filter((item) => item.kind === "COMMISSION").map((item) => item.id);
  const feeIds = row.items.filter((item) => item.kind === "RIDER_FEE").map((item) => item.id);
  // Commissions are locked through their order, the lock after-sales and
  // commission transitions already share.
  if (commissionIds.length) {
    await tx.$queryRaw`SELECT o."id" FROM "Order" o JOIN "Commission" c ON c."orderId" = o."id" WHERE c."id" IN (${Prisma.join(commissionIds)}) FOR UPDATE OF o`;
  }
  if (feeIds.length) {
    await tx.$queryRaw`SELECT "id" FROM "OrderFulfillment" WHERE "id" IN (${Prisma.join(feeIds)}) FOR UPDATE`;
  }
}

export async function loadPayer(tx: Db, adminUserId: string): Promise<Payer> {
  const admin = await tx.adminUser.findUnique({
    where: { id: adminUserId },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      loginAccount: true,
      linkedEmployeeId: true,
      linkedEmployee: { select: { name: true, phone: true } }
    }
  });
  if (!admin) throw new ForbiddenException("Admin session is not valid.");
  return {
    adminUserId: admin.id,
    linkedEmployeeId: admin.linkedEmployeeId,
    name: admin.name,
    employeeName: admin.linkedEmployee?.name ?? null,
    // The login account is often a phone number or an email address.
    phones: [admin.phone, admin.loginAccount, admin.linkedEmployee?.phone ?? null],
    emails: [admin.email, admin.loginAccount]
  };
}

function sumBy<T>(rows: T[], pick: (row: T) => number) {
  return rows.reduce((total, row) => total + pick(row), 0);
}
