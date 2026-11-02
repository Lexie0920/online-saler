import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import {
  ActorType,
  AfterSaleReturnStatus,
  CustomerServiceCaseStatus,
  PaymentStatus,
  Prisma,
  RefundKind,
  RefundRequestStatus,
  SourceApp,
  prisma
} from "@online-saler/database";
import { OperationsAccessService } from "./operations-access.service";

/**
 * Money only ever leaves the business through two people.
 *
 * Customer service raises a request and can do nothing else with it. Finance
 * approves or rejects it, and only then may record the refund it actually
 * executed in M-Pesa. The split is the control: an agent who is being shouted
 * at on the phone cannot refund their way out of the call, and finance cannot
 * pay out something no one asked for.
 *
 * This service never talks to M-Pesa. Refunds are executed by hand in the
 * M-Pesa portal, exactly as they were before; `complete` records the reference
 * of a payout that has already happened.
 */

const REQUEST = "customer-service.refund-request";
const APPROVE = "customer-service.refund-approve";

const REQUEST_INCLUDE = {
  order: {
    select: {
      id: true,
      orderNumber: true,
      status: true,
      totalKsh: true,
      customer: { select: { id: true, displayName: true, phone: true } }
    }
  },
  serviceCase: { select: { id: true, title: true, status: true, caseType: true } },
  // Photo metadata only: the picture itself is served by the after-sales photo endpoint.
  afterSaleReturn: { select: { id: true, status: true, orderItemId: true, photos: { select: { id: true, contentType: true, sizeBytes: true, createdAt: true }, orderBy: { createdAt: "asc" as const } } } },
  requestedByAdminUser: { select: { id: true, name: true } },
  reviewedByAdminUser: { select: { id: true, name: true } },
  refundRecord: { select: { id: true, externalReference: true, refundedAt: true, amountKsh: true } }
} as const;

export type CreateRefundRequestInput = {
  adminUserId?: string;
  orderId?: string;
  serviceCaseId?: string;
  afterSaleReturnId?: string;
  kind?: RefundKind;
  amountKsh?: number;
  reason?: string;
};

export type ReviewRefundRequestInput = {
  adminUserId?: string;
  approved?: boolean;
  reviewNote?: string;
};

export type CompleteRefundRequestInput = {
  adminUserId?: string;
  externalReference?: string;
  evidenceNote?: string;
  refundedAt?: string;
};

export type ListRefundRequestInput = {
  adminUserId?: string;
  status?: RefundRequestStatus;
  orderId?: string;
};

@Injectable()
export class OperationsRefundRequestService {
  constructor(private readonly access: OperationsAccessService) {}

  async list(input: ListRefundRequestInput) {
    // Either side of the desk may read the queue: customer service needs to
    // tell the customer where their request has got to.
    await this.requireAny(input.adminUserId, [REQUEST, APPROVE]);
    return prisma.refundRequest.findMany({
      where: {
        ...(validStatus(input.status) ? { status: input.status } : {}),
        ...(input.orderId ? { orderId: input.orderId } : {})
      },
      include: REQUEST_INCLUDE,
      orderBy: [{ status: "asc" }, { requestedAt: "asc" }],
      take: 200
    });
  }

  /** Customer service asks. Nothing moves; a row appears in finance's queue. */
  async create(input: CreateRefundRequestInput) {
    const session = await this.access.requirePermission(input.adminUserId, REQUEST);
    const adminUserId = session.adminUser!.id;
    const orderId = clean(input.orderId);
    if (!orderId) throw new BadRequestException("A refund request must name an order.");
    const reason = requiredText(input.reason, "Refund reason");
    const amountKsh = input.amountKsh;
    if (!Number.isSafeInteger(amountKsh) || (amountKsh as number) <= 0) {
      throw new BadRequestException("Refund amount must be a positive whole KSh amount.");
    }

    return prisma.$transaction(async (tx) => {
      // Same lock order as every other write that touches an order's money.
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`);
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: {
          payments: { where: { status: PaymentStatus.SUCCESS }, select: { amountKsh: true } },
          refunds: { select: { amountKsh: true } },
          refundRequests: { select: { amountKsh: true, status: true } }
        }
      });
      if (!order) throw new NotFoundException("Order was not found.");

      const paidKsh = order.payments.reduce((sum, payment) => sum + payment.amountKsh, 0);
      if (paidKsh <= 0) throw new BadRequestException("This order has no successful payment to refund.");
      const refundedKsh = order.refunds.reduce((sum, refund) => sum + refund.amountKsh, 0);
      // A request that is still live already has a claim on the money, so it
      // counts against the ceiling. Two agents cannot each promise the full
      // amount to the same customer.
      const committedKsh = order.refundRequests
        .filter((row) => row.status === RefundRequestStatus.PENDING_APPROVAL || row.status === RefundRequestStatus.APPROVED)
        .reduce((sum, row) => sum + row.amountKsh, 0);
      if (refundedKsh + committedKsh + (amountKsh as number) > paidKsh) {
        throw new BadRequestException(
          `Refunds already recorded or requested (KSh ${refundedKsh + committedKsh}) plus this request would exceed the KSh ${paidKsh} actually paid.`
        );
      }

      const serviceCaseId = clean(input.serviceCaseId) ?? null;
      if (serviceCaseId) {
        const serviceCase = await tx.customerServiceCase.findUnique({ where: { id: serviceCaseId }, select: { orderId: true } });
        if (!serviceCase) throw new NotFoundException("Customer service case was not found.");
        if (serviceCase.orderId && serviceCase.orderId !== orderId) {
          throw new BadRequestException("That case belongs to a different order.");
        }
      }
      const afterSaleReturnId = clean(input.afterSaleReturnId) ?? null;
      if (afterSaleReturnId) {
        const record = await tx.afterSaleReturn.findUnique({ where: { id: afterSaleReturnId }, select: { orderId: true, status: true } });
        if (!record) throw new NotFoundException("Return was not found.");
        if (record.orderId !== orderId) throw new BadRequestException("That return belongs to a different order.");
        // Accepting the returned item opens its request automatically; a manual
        // one is only for the case where that request was rejected or withdrawn.
        if (record.status !== AfterSaleReturnStatus.RECEIVED) {
          throw new BadRequestException("A refund can only be requested for a return whose item has been received and inspected.");
        }
        const open = await tx.refundRequest.count({
          where: { afterSaleReturnId, status: { in: [RefundRequestStatus.PENDING_APPROVAL, RefundRequestStatus.APPROVED, RefundRequestStatus.REFUNDED] } }
        });
        if (open > 0) throw new ConflictException("This return already has a refund request.");
      }

      const created = await tx.refundRequest.create({
        data: {
          orderId,
          serviceCaseId,
          afterSaleReturnId,
          kind: validKind(input.kind) ?? RefundKind.AFTER_SALE_RETURN,
          amountKsh: amountKsh as number,
          reason,
          requestedByAdminUserId: adminUserId
        },
        include: REQUEST_INCLUDE
      });
      if (serviceCaseId) {
        await tx.customerServiceCase.update({ where: { id: serviceCaseId }, data: { requiresRefund: true } });
      }
      await writeAudit(tx, session, created.id, "REFUND_REQUEST_CREATE", {}, auditState(created), reason);
      return created;
    });
  }

  /** Finance decides. Still nothing moves; an approval is only permission. */
  async review(requestId: string, input: ReviewRefundRequestInput) {
    const session = await this.access.requirePermission(input.adminUserId, APPROVE);
    if (typeof input.approved !== "boolean") {
      throw new BadRequestException("A refund review must be an explicit approval or rejection.");
    }
    const reviewNote = requiredText(input.reviewNote, "Review note");

    return prisma.$transaction(async (tx) => {
      const existing = await this.lockRequest(tx, requestId);
      if (existing.status !== RefundRequestStatus.PENDING_APPROVAL) {
        throw new ConflictException(`This request is already ${existing.status.toLowerCase().replace(/_/g, " ")}.`);
      }
      // Whoever asked for the money cannot be the one who approves it, even if
      // they hold both permissions.
      if (existing.requestedByAdminUserId === session.adminUser!.id) {
        throw new ConflictException("A refund request cannot be approved by the person who raised it.");
      }
      const now = new Date();
      const updated = await tx.refundRequest.update({
        where: { id: requestId },
        data: {
          status: input.approved ? RefundRequestStatus.APPROVED : RefundRequestStatus.REJECTED,
          reviewedByAdminUserId: session.adminUser!.id,
          reviewedAt: now,
          reviewNote
        },
        include: REQUEST_INCLUDE
      });
      await writeAudit(
        tx,
        session,
        requestId,
        input.approved ? "REFUND_REQUEST_APPROVE" : "REFUND_REQUEST_REJECT",
        auditState(existing),
        auditState(updated),
        reviewNote
      );
      return updated;
    });
  }

  /** Customer service withdraws its own request before finance has looked. */
  async cancel(requestId: string, input: { adminUserId?: string; reason?: string }) {
    const session = await this.access.requirePermission(input.adminUserId, REQUEST);
    const reason = requiredText(input.reason, "Cancellation reason");
    return prisma.$transaction(async (tx) => {
      const existing = await this.lockRequest(tx, requestId);
      if (existing.status !== RefundRequestStatus.PENDING_APPROVAL) {
        throw new ConflictException("Only a request still waiting for finance can be withdrawn.");
      }
      const updated = await tx.refundRequest.update({
        where: { id: requestId },
        data: { status: RefundRequestStatus.CANCELLED, cancelledAt: new Date(), reviewNote: reason },
        include: REQUEST_INCLUDE
      });
      await writeAudit(tx, session, requestId, "REFUND_REQUEST_CANCEL", auditState(existing), auditState(updated), reason);
      return updated;
    });
  }

  /**
   * Finance records the payout it has already made in the M-Pesa portal.
   *
   * This is the only step that writes a RefundRecord, and it requires the
   * separate `orders.refund` permission on top of the approval one -- recording
   * money as returned is a bookkeeping act, not a customer service one.
   */
  async complete(requestId: string, input: CompleteRefundRequestInput) {
    const session = await this.access.requirePermission(input.adminUserId, APPROVE);
    await this.access.requirePermission(input.adminUserId, "orders.refund");
    const externalReference = requiredText(input.externalReference, "M-Pesa refund reference", 160).toUpperCase();
    const evidenceNote = requiredText(input.evidenceNote, "Refund verification evidence");
    const refundedAt = new Date(requiredText(input.refundedAt, "Actual refund time", 50));
    const now = new Date();
    if (!Number.isFinite(refundedAt.getTime()) || refundedAt > now) {
      throw new BadRequestException("The actual refund time must be a real time that is not in the future.");
    }

    try {
      return await prisma.$transaction(async (tx) => {
        const existing = await this.lockRequest(tx, requestId);
        if (existing.status !== RefundRequestStatus.APPROVED) {
          throw new ConflictException("Only an approved request can be recorded as refunded.");
        }
        // A refund for a returned item must be recorded on the order page: only
        // that path reverses the affiliate commission, closes the return and
        // keeps the restock rules. Recording it here would skip all three.
        if (existing.afterSaleReturnId) {
          throw new ConflictException("This is a refund for a returned item. Record it on the order page so the return, the commission and the stock stay in step.");
        }
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Order" WHERE "id" = ${existing.orderId} FOR UPDATE`);
        if (refundedAt < existing.reviewedAt!) {
          throw new BadRequestException("The refund cannot have happened before it was approved.");
        }
        const record = await tx.refundRecord.create({
          data: {
            orderId: existing.orderId,
            afterSaleReturnId: existing.afterSaleReturnId,
            kind: existing.kind,
            reason: existing.reason,
            amountKsh: existing.amountKsh,
            externalReference,
            evidenceNote,
            refundedAt,
            recordedByAdminUserId: session.adminUser!.id
          }
        });
        const updated = await tx.refundRequest.update({
          where: { id: requestId },
          data: { status: RefundRequestStatus.REFUNDED, refundRecordId: record.id, completedAt: now },
          include: REQUEST_INCLUDE
        });
        if (existing.serviceCaseId) {
          await tx.customerServiceCase.update({
            where: { id: existing.serviceCaseId },
            data: { requiresRefund: false, status: CustomerServiceCaseStatus.RESOLVED, resolvedAt: now }
          });
        }
        await writeAudit(tx, session, requestId, "REFUND_REQUEST_COMPLETE", auditState(existing), auditState(updated), evidenceNote);
        return updated;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("That M-Pesa refund reference has already been recorded.");
      }
      throw error;
    }
  }

  private async lockRequest(tx: Prisma.TransactionClient, requestId: string) {
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "RefundRequest" WHERE "id" = ${requestId} FOR UPDATE`);
    const existing = await tx.refundRequest.findUnique({ where: { id: requestId } });
    if (!existing) throw new NotFoundException("Refund request was not found.");
    return existing;
  }

  private async requireAny(adminUserId: string | undefined, permissions: string[]) {
    const session = await this.access.session(adminUserId);
    if (!session.adminUser || !permissions.some((permission) => session.permissions.includes(permission))) {
      throw new ForbiddenException("This admin account does not have permission for this operation.");
    }
    return session;
  }
}

type SessionLike = { adminUser?: { id: string; linkedEmployeeId?: string | null } | null };

async function writeAudit(
  tx: Prisma.TransactionClient,
  session: SessionLike,
  entityId: string,
  action: string,
  beforeJson: Prisma.InputJsonValue,
  afterJson: Prisma.InputJsonValue,
  reason: string
) {
  await tx.auditLog.create({
    data: {
      actorType: ActorType.EMPLOYEE,
      actorId: session.adminUser?.linkedEmployeeId ?? null,
      actorAdminUserId: session.adminUser?.id ?? null,
      sourceApp: SourceApp.OPERATIONS,
      module: "customer-service",
      entityType: "RefundRequest",
      entityId,
      action,
      beforeJson,
      afterJson,
      reason
    }
  });
}

function auditState(record: {
  status: RefundRequestStatus;
  orderId: string;
  amountKsh: number;
  kind: RefundKind;
  reason: string;
  serviceCaseId: string | null;
  afterSaleReturnId: string | null;
  reviewedByAdminUserId?: string | null;
  reviewNote?: string | null;
  refundRecordId?: string | null;
}): Prisma.InputJsonObject {
  return {
    status: record.status,
    orderId: record.orderId,
    amountKsh: record.amountKsh,
    kind: record.kind,
    reason: record.reason,
    serviceCaseId: record.serviceCaseId,
    afterSaleReturnId: record.afterSaleReturnId,
    reviewedByAdminUserId: record.reviewedByAdminUserId ?? null,
    reviewNote: record.reviewNote ?? null,
    refundRecordId: record.refundRecordId ?? null
  };
}

function validStatus(value?: RefundRequestStatus): RefundRequestStatus | undefined {
  return value && Object.values(RefundRequestStatus).includes(value) ? value : undefined;
}

function validKind(value?: RefundKind): RefundKind | undefined {
  return value && Object.values(RefundKind).includes(value) ? value : undefined;
}

function clean(value?: string | null): string | undefined {
  return value?.trim() || undefined;
}

function requiredText(value: unknown, label: string, max = 2000): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new BadRequestException(`${label} is required (maximum ${max} characters).`);
  }
  return value.trim();
}
