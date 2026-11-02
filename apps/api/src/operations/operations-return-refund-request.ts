import { BadRequestException, ConflictException } from "@nestjs/common";
import { ActorType, type Prisma, RefundKind, RefundRequestStatus, SourceApp } from "@online-saler/database";

/**
 * A returned item that the warehouse has accepted raises its own refund request.
 *
 * The request is the approver's queue entry: it is created by the person who
 * accepted the item, so (by the existing rule) someone else has to approve it.
 * Nothing here moves money. The refund itself is still paid in M-Pesa and then
 * recorded on the order's returns card, which requires the request to have been
 * approved first.
 */
export type RaiseReturnRefundRequestInput = {
  orderId: string;
  paidKsh: number;
  serviceCaseId: string;
  afterSaleReturnId: string;
  amountKsh: number;
  reason: string;
  requestedByAdminUserId: string;
  actorEmployeeId: string | null;
};

const LIVE = [RefundRequestStatus.PENDING_APPROVAL, RefundRequestStatus.APPROVED];

export async function raiseReturnRefundRequest(tx: Prisma.TransactionClient, input: RaiseReturnRefundRequestInput) {
  if (!Number.isSafeInteger(input.amountKsh) || input.amountKsh <= 0) throw new BadRequestException("Refund amount must be a positive whole KSh amount.");
  const [refunds, live] = await Promise.all([
    tx.refundRecord.findMany({ where: { orderId: input.orderId }, select: { amountKsh: true } }),
    tx.refundRequest.findMany({ where: { orderId: input.orderId, status: { in: LIVE } }, select: { amountKsh: true, afterSaleReturnId: true } })
  ]);
  if (live.some((row) => row.afterSaleReturnId === input.afterSaleReturnId)) throw new ConflictException("This return already has a refund request.");
  const refundedKsh = refunds.reduce((sum, row) => sum + row.amountKsh, 0);
  const committedKsh = live.reduce((sum, row) => sum + row.amountKsh, 0);
  if (input.paidKsh <= 0) throw new BadRequestException("This order has no successful payment to refund.");
  if (refundedKsh + committedKsh + input.amountKsh > input.paidKsh) {
    throw new BadRequestException(`Refunds already recorded or requested (KSh ${refundedKsh + committedKsh}) plus this return would exceed the KSh ${input.paidKsh} actually paid.`);
  }
  const reason = input.reason.trim().slice(0, 2000);
  const created = await tx.refundRequest.create({
    data: {
      orderId: input.orderId,
      serviceCaseId: input.serviceCaseId,
      afterSaleReturnId: input.afterSaleReturnId,
      kind: RefundKind.AFTER_SALE_RETURN,
      amountKsh: input.amountKsh,
      reason,
      requestedByAdminUserId: input.requestedByAdminUserId
    }
  });
  await tx.auditLog.create({
    data: {
      actorType: ActorType.EMPLOYEE,
      actorId: input.actorEmployeeId,
      actorAdminUserId: input.requestedByAdminUserId,
      sourceApp: SourceApp.OPERATIONS,
      module: "customer-service",
      entityType: "RefundRequest",
      entityId: created.id,
      action: "REFUND_REQUEST_CREATE",
      beforeJson: {},
      afterJson: { status: created.status, orderId: input.orderId, amountKsh: input.amountKsh, afterSaleReturnId: input.afterSaleReturnId, raisedBy: "RETURN_ACCEPTED" },
      reason
    }
  });
  return created;
}

/**
 * Whether recording a refund for this return needs an approved request first.
 *
 * Every return accepted since photos became mandatory has photos and a request.
 * A return accepted before that has neither; it keeps the old, direct route so
 * nothing already in flight gets stuck.
 */
export function refundNeedsApprovedRequest(photoCount: number, requests: ReadonlyArray<{ status: RefundRequestStatus }>): boolean {
  return photoCount > 0 || requests.length > 0;
}

export function approvedRequestFor(requests: ReadonlyArray<{ id: string; status: RefundRequestStatus; amountKsh: number }>) {
  return requests.find((row) => row.status === RefundRequestStatus.APPROVED);
}
