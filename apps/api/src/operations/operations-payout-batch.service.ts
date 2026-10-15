import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import {
  ActorType,
  PayoutBatchLineStatus,
  PayoutBatchStatus,
  PayoutPayeeType,
  Prisma,
  SourceApp,
  prisma
} from "@online-saler/database";
import { OperationsAccessService } from "./operations-access.service";
import {
  buildBulkExportFile,
  matchResults,
  newBatchReference,
  parseResultsFile,
  planBulkExport,
  type BatchLineForMatch,
  type BulkFileFormat,
  type MatchDecision
} from "./mpesa-bulk-format";
import { payoutWeek, selfPaymentMatch, type PayoutItem, type PayoutRow, type PayoutWeek } from "./operations-payout-sheet";
import {
  FINANCE_PAYOUT,
  loadPayer,
  loadSheet,
  lockItems,
  parseWeek,
  pendingBatchLines,
  recordPayout,
  type Db
} from "./operations-payout.service";

/**
 * M-Pesa for Business bulk payouts (owner, 2026-10-14): the semi-automatic
 * way to pay the weekly sheet.
 *
 *   导出   — one bulk payment file for the week's unpaid people. Each person
 *            becomes a PENDING line of a PayoutBatch and is locked: not
 *            exported again and not recordable by hand until the batch is
 *            settled or cancelled.
 *   上传结果 — the portal's results report. Each successful row records a
 *            Payout with the M-Pesa receipt through the same path as the manual
 *            "登记已付"; failed rows release the person; anything that cannot
 *            be tied safely to one person is listed and changes nothing.
 *            Uploading the same report again changes nothing.
 *   作废    — cancel an export nobody has a result for yet.
 *
 * File layouts are in mpesa-bulk-format.ts. Nothing here moves money.
 */

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export type ExportBatchInput = { adminUserId?: string; week?: string; format?: string };
export type BatchFileInput = { adminUserId?: string; batchId?: string; format?: string };
export type CancelBatchInput = { adminUserId?: string; batchId?: string; pendingOnly?: boolean };
export type ReconcileBatchInput = { adminUserId?: string; batchId?: string; fileName?: string; contentBase64?: string };

@Injectable()
export class OperationsPayoutBatchService {
  constructor(private readonly access: OperationsAccessService) {}

  /** 导出 M-Pesa 批量付款文件 for one week. */
  async exportBatch(input: ExportBatchInput) {
    const session = await this.access.requirePermission(input.adminUserId, FINANCE_PAYOUT);
    const actor = session.adminUser!;
    const week = parseWeek(input.week);
    const format = parseFormat(input.format);
    const now = new Date();

    return prisma.$transaction(async (tx) => {
      // One export at a time, and the same row locks the manual "登记已付" takes.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('payout-batch-export'))`;
      const first = await loadSheet(tx, week, now);
      for (const row of first.rows) await lockItems(tx, row);
      const { rows, identities } = await loadSheet(tx, week, now);
      const payer = await loadPayer(tx, actor.id);
      const locked = await pendingBatchLines(tx, week);

      let reference = newBatchReference();
      for (let attempt = 0; attempt < 5 && await tx.payoutBatch.findUnique({ where: { reference } }); attempt += 1) {
        reference = newBatchReference();
      }
      const plan = planBulkExport(rows.map((row) => ({
        payeeKey: row.payeeKey,
        payeeType: row.payeeType,
        name: row.name,
        phone: row.phone,
        amountKsh: row.amountKsh,
        selfPayment: !!selfPaymentMatch(payer, identities.get(row.payeeKey)!),
        lockedBy: locked.get(row.payeeKey)?.batchReference ?? null
      })), reference);

      if (!plan.lines.length) {
        return { batch: null, lines: [], excluded: plan.excluded, file: null };
      }
      const totalKsh = plan.lines.reduce((sum, line) => sum + line.amountKsh, 0);
      const batch = await tx.payoutBatch.create({
        data: {
          reference,
          status: PayoutBatchStatus.OPEN,
          periodStart: week.start,
          periodEnd: week.end,
          lineCount: plan.lines.length,
          totalKsh,
          exportedByAdminUserId: actor.id,
          exportedAt: now
        }
      });
      const byKey = new Map(rows.map((row) => [row.payeeKey, row]));
      for (const line of plan.lines) {
        await tx.payoutBatchLine.create({
          data: {
            batchId: batch.id,
            reference: line.reference,
            status: PayoutBatchLineStatus.PENDING,
            payeeType: line.payeeType === "AFFILIATE" ? PayoutPayeeType.AFFILIATE : PayoutPayeeType.RIDER,
            payeeKey: line.payeeKey,
            payeeName: line.name,
            phone: line.phone,
            amountKsh: line.amountKsh,
            items: byKey.get(line.payeeKey)!.items as unknown as Prisma.InputJsonValue
          }
        });
      }
      await tx.auditLog.create({
        data: {
          ...auditActor(actor),
          module: "FINANCE",
          entityType: "PayoutBatch",
          entityId: batch.id,
          action: "PAYOUT_BATCH_EXPORTED",
          reason: `M-Pesa bulk file ${reference} for ${week.firstDay}~${week.lastDay}`,
          afterJson: {
            reference,
            periodStart: week.start.toISOString(),
            periodEnd: week.end.toISOString(),
            lineCount: plan.lines.length,
            totalKsh,
            format,
            lines: plan.lines.map((line) => ({ reference: line.reference, payeeKey: line.payeeKey, amountKsh: line.amountKsh })),
            excluded: plan.excluded
          } as Prisma.InputJsonValue
        }
      });
      const file = buildBulkExportFile(plan.lines, { batchReference: reference, firstDay: week.firstDay, format });
      return {
        batch: { id: batch.id, reference, lineCount: plan.lines.length, totalKsh },
        lines: plan.lines,
        excluded: plan.excluded,
        file: encodeFile(file)
      };
    });
  }

  /** Download an exported file again (same rows, same references). */
  async batchFile(input: BatchFileInput) {
    await this.access.requirePermission(input.adminUserId, FINANCE_PAYOUT);
    const format = parseFormat(input.format);
    return prisma.$transaction(async (tx) => {
      const batch = await findBatch(tx, input.batchId);
      if (batch.status === PayoutBatchStatus.CANCELLED) throw new ConflictException("This export was cancelled. Do not upload it to M-Pesa.");
      const lines = await tx.payoutBatchLine.findMany({ where: { batchId: batch.id }, orderBy: { reference: "asc" } });
      const week = weekOf(batch.periodStart);
      return encodeFile(buildBulkExportFile(lines.map((line) => ({
        reference: line.reference,
        phone: line.phone,
        amountKsh: line.amountKsh,
        name: line.payeeName,
        payeeType: line.payeeType
      })), { batchReference: batch.reference, firstDay: week.firstDay, format }));
    });
  }

  /**
   * 作废这批导出. Only while nobody in it has a result. With `pendingOnly`, a
   * batch that is partly settled releases just the people still waiting
   * (finance must first check in the portal that they were not paid).
   */
  async cancelBatch(input: CancelBatchInput) {
    const session = await this.access.requirePermission(input.adminUserId, FINANCE_PAYOUT);
    const actor = session.adminUser!;
    const now = new Date();
    return prisma.$transaction(async (tx) => {
      const batch = await findBatch(tx, input.batchId, true);
      if (batch.status !== PayoutBatchStatus.OPEN) throw new ConflictException("This export is already closed or cancelled.");
      const lines = await tx.payoutBatchLine.findMany({ where: { batchId: batch.id } });
      const settled = lines.filter((line) => line.status !== PayoutBatchLineStatus.PENDING);
      const pending = lines.filter((line) => line.status === PayoutBatchLineStatus.PENDING);
      if (settled.length && !input.pendingOnly) {
        throw new ConflictException(`${settled.length} people in this export already have an M-Pesa result, so it cannot be cancelled as a whole. You can release only the ${pending.length} still waiting.`);
      }
      if (pending.length) {
        await tx.payoutBatchLine.updateMany({
          where: { batchId: batch.id, status: PayoutBatchLineStatus.PENDING },
          data: { status: PayoutBatchLineStatus.CANCELLED, resultAt: now }
        });
      }
      const status = settled.length ? PayoutBatchStatus.RECONCILED : PayoutBatchStatus.CANCELLED;
      await tx.payoutBatch.update({
        where: { id: batch.id },
        data: settled.length
          ? { status, reconciledAt: now, cancelledAt: now, cancelledByAdminUserId: actor.id }
          : { status, cancelledAt: now, cancelledByAdminUserId: actor.id }
      });
      await tx.auditLog.create({
        data: {
          ...auditActor(actor),
          module: "FINANCE",
          entityType: "PayoutBatch",
          entityId: batch.id,
          action: "PAYOUT_BATCH_CANCELLED",
          reason: settled.length ? `Released ${pending.length} people still waiting in ${batch.reference}` : `Cancelled M-Pesa bulk file ${batch.reference}`,
          beforeJson: { status: batch.status, pending: pending.length, settled: settled.length },
          afterJson: { status, releasedLineReferences: pending.map((line) => line.reference) } as Prisma.InputJsonValue
        }
      });
      return { batchId: batch.id, reference: batch.reference, status, released: pending.length };
    });
  }

  /** 上传 M-Pesa 结果文件 for one exported batch. */
  async reconcile(input: ReconcileBatchInput) {
    const session = await this.access.requirePermission(input.adminUserId, FINANCE_PAYOUT);
    const actor = session.adminUser!;
    const content = decodeUpload(input.contentBase64);
    let results;
    try {
      results = parseResultsFile(content);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : "Could not read the file.");
    }
    if (!results.length) throw new BadRequestException("The file has a header row but no payment rows.");
    const fileName = (input.fileName ?? "").replace(/[^\w .()-]/g, "").slice(0, 120) || "results";
    const now = new Date();

    return prisma.$transaction(async (tx) => {
      const batch = await findBatch(tx, input.batchId, true);
      if (batch.status === PayoutBatchStatus.CANCELLED) throw new ConflictException("This export was cancelled; its results cannot be recorded.");
      const week = weekOf(batch.periodStart);
      const lines = await tx.payoutBatchLine.findMany({ where: { batchId: batch.id }, orderBy: { reference: "asc" } });
      const decisions = matchResults(results, lines.map(toMatchLine), batch.reference);

      // Lock every item of every person about to be paid, then read the sheet once.
      const toPay = decisions.filter((decision) => decision.outcome === "PAY");
      const lineById = new Map(lines.map((line) => [line.id, line]));
      for (const decision of toPay) await lockItems(tx, { items: lineItems(lineById.get(decision.lineId!)!) });
      const { rows, identities } = await loadSheet(tx, week, now);
      const payer = await loadPayer(tx, actor.id);

      const outcomes: Array<MatchDecision & { payoutId?: string; itemsNoLongerPayable?: string[] }> = [];
      let changed = 0;
      for (const decision of decisions) {
        const line = decision.lineId ? lineById.get(decision.lineId)! : null;
        if (decision.outcome === "FAILED" && line) {
          if (line.status === PayoutBatchLineStatus.PENDING) {
            await tx.payoutBatchLine.update({
              where: { id: line.id },
              data: {
                status: PayoutBatchLineStatus.FAILED,
                resultStatus: decision.result.statusText.slice(0, 120) || "FAILED",
                resultReason: (decision.result.reason || decision.result.statusText).slice(0, 300) || null,
                resultCompletedAt: decision.result.completedAt.slice(0, 60) || null,
                resultAt: now
              }
            });
            changed += 1;
          }
          outcomes.push(decision);
          continue;
        }
        if (decision.outcome !== "PAY" || !line) { outcomes.push(decision); continue; }

        const receipt = decision.result.receipt!;
        const taken = await tx.payout.findUnique({ where: { mpesaCode: receipt } });
        if (taken) {
          outcomes.push({ ...decision, outcome: "UNMATCHED", reason: "RECEIPT_REUSED", detail: `${receipt} ${taken.payeeName}` });
          continue;
        }
        const exportedItems = lineItems(line);
        const current = rows.find((row) => row.payeeKey === line.payeeKey);
        const identity = identities.get(line.payeeKey);
        if (identity && selfPaymentMatch(payer, identity)) {
          outcomes.push({ ...decision, outcome: "UNMATCHED", reason: "SELF_PAYMENT" });
          continue;
        }
        const stillPayable = new Set((current?.items ?? []).map((item) => item.id));
        const items = exportedItems.filter((item) => stillPayable.has(item.id));
        const dropped = exportedItems.filter((item) => !stillPayable.has(item.id)).map((item) => item.orderNumber);
        const row: PayoutRow = current
          ? { ...current, items, count: items.length, amountKsh: line.amountKsh }
          : {
              payeeKey: line.payeeKey,
              payeeType: line.payeeType === PayoutPayeeType.AFFILIATE ? "AFFILIATE" : "RIDER",
              name: line.payeeName,
              phone: line.phone,
              affiliateId: line.payeeKey.startsWith("affiliate:") ? line.payeeKey.slice("affiliate:".length) : null,
              affiliateCode: null,
              deliveryRiderId: line.payeeKey.startsWith("rider:") ? line.payeeKey.slice("rider:".length) : null,
              riderType: null,
              amountKsh: line.amountKsh,
              count: 0,
              items: []
            };
        const payout = await recordPayout(tx, {
          row,
          week,
          mpesaCode: receipt,
          note: `M-Pesa bulk ${line.reference}${dropped.length ? ` · not marked paid (no longer payable): ${dropped.join(" ")}` : ""}`,
          actor,
          now,
          amountKsh: line.amountKsh,
          phone: line.phone,
          source: { batchId: batch.id, batchReference: batch.reference, lineReference: line.reference, resultsFile: fileName, fileRow: decision.result.fileRow }
        });
        await tx.payoutBatchLine.update({
          where: { id: line.id },
          data: {
            status: PayoutBatchLineStatus.PAID,
            payoutId: payout.id,
            mpesaCode: receipt,
            resultStatus: decision.result.statusText.slice(0, 120) || "SUCCESS",
            resultReason: null,
            resultCompletedAt: decision.result.completedAt.slice(0, 60) || null,
            resultAt: now
          }
        });
        line.status = PayoutBatchLineStatus.PAID;
        changed += 1;
        outcomes.push({ ...decision, payoutId: payout.id, ...(dropped.length ? { itemsNoLongerPayable: dropped } : {}) });
      }

      const after = await tx.payoutBatchLine.findMany({ where: { batchId: batch.id } });
      const stillPending = after.filter((line) => line.status === PayoutBatchLineStatus.PENDING).length;
      if (!stillPending && batch.status === PayoutBatchStatus.OPEN) {
        await tx.payoutBatch.update({ where: { id: batch.id }, data: { status: PayoutBatchStatus.RECONCILED, reconciledAt: now } });
      }
      const summary = summarize(outcomes, lineById, stillPending);
      if (changed) {
        await tx.auditLog.create({
          data: {
            ...auditActor(actor),
            module: "FINANCE",
            entityType: "PayoutBatch",
            entityId: batch.id,
            action: "PAYOUT_BATCH_RECONCILED",
            reason: `M-Pesa results ${fileName} for ${batch.reference}`,
            afterJson: { fileName, rows: results.length, changed, ...summary } as Prisma.InputJsonValue
          }
        });
      }
      return {
        batch: { id: batch.id, reference: batch.reference, status: !stillPending ? PayoutBatchStatus.RECONCILED : batch.status },
        changed,
        summary,
        rows: outcomes.map((outcome) => ({
          fileRow: outcome.result.fileRow,
          outcome: outcome.outcome,
          reason: outcome.reason,
          detail: outcome.detail ?? null,
          matchedBy: outcome.matchedBy,
          lineReference: outcome.lineReference,
          payeeName: outcome.lineId ? lineById.get(outcome.lineId)?.payeeName ?? null : null,
          receipt: outcome.result.receipt ?? (outcome.result.receiptText || null),
          phone: outcome.result.phone,
          amountKsh: outcome.result.amountKsh,
          statusText: outcome.result.statusText,
          itemsNoLongerPayable: outcome.itemsNoLongerPayable ?? []
        }))
      };
    }, { timeout: 60_000, maxWait: 10_000 });
  }
}

type BatchLineRow = Awaited<ReturnType<Db["payoutBatchLine"]["findMany"]>>[number];

function toMatchLine(line: BatchLineRow): BatchLineForMatch {
  return { id: line.id, reference: line.reference, phone: line.phone, amountKsh: line.amountKsh, status: line.status, mpesaCode: line.mpesaCode };
}

function lineItems(line: BatchLineRow): PayoutItem[] {
  return Array.isArray(line.items) ? (line.items as unknown as PayoutItem[]) : [];
}

function summarize(outcomes: Array<MatchDecision & { payoutId?: string }>, lines: Map<string, BatchLineRow>, stillPending: number) {
  const paid = outcomes.filter((o) => o.outcome === "PAY" || o.outcome === "ALREADY_PAID");
  return {
    paidPeople: paid.length,
    paidKsh: paid.reduce((sum, o) => sum + (lines.get(o.lineId!)?.amountKsh ?? 0), 0),
    newlyPaid: outcomes.filter((o) => o.outcome === "PAY").length,
    alreadyPaid: outcomes.filter((o) => o.outcome === "ALREADY_PAID").length,
    failed: outcomes.filter((o) => o.outcome === "FAILED").length,
    unmatched: outcomes.filter((o) => o.outcome === "UNMATCHED").length,
    duplicates: outcomes.filter((o) => o.outcome === "DUPLICATE").length,
    stillPending
  };
}

async function findBatch(tx: Db, batchId: string | undefined, lock = false) {
  const id = batchId?.trim();
  if (!id) throw new BadRequestException("Choose which export this is for.");
  if (lock) await tx.$queryRaw`SELECT "id" FROM "PayoutBatch" WHERE "id" = ${id} FOR UPDATE`;
  const batch = await tx.payoutBatch.findUnique({ where: { id } });
  if (!batch) throw new NotFoundException("This export was not found. Refresh the page.");
  return batch;
}

function weekOf(periodStart: Date): PayoutWeek {
  // periodStart is Monday 00:00 Nairobi; any Nairobi day of that week gives the week back.
  return payoutWeek(new Date(periodStart.getTime() + 12 * 60 * 60 * 1000).toISOString().slice(0, 10));
}

function parseFormat(format?: string): BulkFileFormat | undefined {
  if (format === undefined || format === null || format === "") return undefined;
  if (format === "csv" || format === "xlsx") return format;
  throw new BadRequestException("File format must be csv or xlsx.");
}

function encodeFile(file: { fileName: string; contentType: string; content: Buffer }) {
  return { fileName: file.fileName, contentType: file.contentType, base64: file.content.toString("base64") };
}

function decodeUpload(base64?: string): Buffer {
  if (!base64 || typeof base64 !== "string") throw new BadRequestException("Choose the results file to upload.");
  const cleaned = base64.replace(/^data:[^,]*,/, "");
  const content = Buffer.from(cleaned, "base64");
  if (!content.length) throw new BadRequestException("The file is empty.");
  if (content.length > MAX_UPLOAD_BYTES) throw new BadRequestException("The file is larger than 5 MB. Upload the portal's results report for this batch only.");
  return content;
}

function auditActor(actor: { id: string; linkedEmployeeId: string | null }) {
  return {
    actorType: ActorType.EMPLOYEE,
    actorId: actor.linkedEmployeeId,
    actorAdminUserId: actor.id,
    sourceApp: SourceApp.OPERATIONS
  };
}
