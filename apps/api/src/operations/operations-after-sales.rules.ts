import { BadRequestException, ConflictException } from "@nestjs/common";
import { RETURN_REQUEST_WINDOW_HOURS } from "@online-saler/business-rules";

export const RETURN_REASONS = ["WRONG_ITEM", "PHOTO_MISMATCH", "UNDISCLOSED_DEFECT", "MEASUREMENT_DIFFERENCE", "DELIVERY_DAMAGE", "NOT_SATISFIED"] as const;
export const ACTIVE_RETURN_STATUSES = ["REQUESTED", "APPROVED", "RECEIVED"] as const;

export function requiredText(value: unknown, label: string, max = 2000): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new BadRequestException(`${label} is required (maximum ${max} characters).`);
  return value.trim();
}

export function assertReturnWindow(completedAt: Date | null | undefined, now: Date) {
  if (!completedAt || now.getTime() < completedAt.getTime() || now.getTime() - completedAt.getTime() > RETURN_REQUEST_WINDOW_HOURS * 60 * 60 * 1000) {
    throw new BadRequestException("Return requests must be received within 3 days after completed delivery or pickup.");
  }
}

export function assertRefundAmount(amount: unknown, lineTotal: number, itemRefunded: number, orderTotal: number, orderRefunded: number, successfulPayment: number): asserts amount is number {
  if (!Number.isSafeInteger(amount) || (amount as number) <= 0) throw new BadRequestException("Refund amount must be a positive integer KSh amount.");
  if ((amount as number) + itemRefunded > lineTotal || (amount as number) + orderRefunded > Math.min(orderTotal, successfulPayment)) {
    throw new BadRequestException("Recorded refunds would exceed the original paid item/order amount.");
  }
}

/** Largest remainder allocation preserves the original integer order commission exactly. */
export function commissionShares(items: readonly { id: string; lineTotalKsh: number }[], originalAmount: number): Map<string, number> {
  const total = items.reduce((sum, item) => sum + item.lineTotalKsh, 0);
  if (!Number.isSafeInteger(originalAmount) || originalAmount < 0 || total <= 0) throw new BadRequestException("Original commission allocation is inconsistent; finance review is required.");
  const rows = items.map((item) => ({ id: item.id, amount: Math.floor(originalAmount * item.lineTotalKsh / total), remainder: (originalAmount * item.lineTotalKsh) % total }));
  let remaining = originalAmount - rows.reduce((sum, row) => sum + row.amount, 0);
  rows.sort((a, b) => b.remainder - a.remainder || a.id.localeCompare(b.id));
  for (const row of rows) if (remaining > 0) { row.amount += 1; remaining -= 1; }
  return new Map(rows.map((row) => [row.id, row.amount]));
}

/** A returned item must be photographed at the counter before it is accepted. */
export const RETURN_PHOTO_MIN = 1;
export const RETURN_PHOTO_MAX = 5;
export const RETURN_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const RETURN_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export function assertReturnPhotoCount(count: number) {
  if (!Number.isInteger(count) || count < RETURN_PHOTO_MIN) throw new BadRequestException(`Add at least ${RETURN_PHOTO_MIN} photo of the returned item before accepting it.`);
  if (count > RETURN_PHOTO_MAX) throw new BadRequestException(`A return can have at most ${RETURN_PHOTO_MAX} photos.`);
}

/** Returns the bare media type (no parameters) or rejects anything that is not a supported photo. */
export function returnPhotoContentType(header: string | undefined, size: number): (typeof RETURN_PHOTO_TYPES)[number] {
  const type = header?.split(";", 1)[0]?.trim().toLowerCase();
  if (!type || !(RETURN_PHOTO_TYPES as readonly string[]).includes(type)) throw new BadRequestException("Photos must be JPEG, PNG or WEBP images.");
  if (!Number.isInteger(size) || size <= 0 || size > RETURN_PHOTO_MAX_BYTES) throw new BadRequestException("A photo must be between 1 byte and 10 MB.");
  return type as (typeof RETURN_PHOTO_TYPES)[number];
}

/**
 * A refund for a returned item needs an approved refund request.
 *
 * Accepting a return opens a request (see OperationsAfterSalesService). Whoever
 * reviews the photos approves or rejects it, and only then may the refund be
 * logged. Returns accepted before this rule existed have no request at all and
 * keep working the old way, so `request` is null for them.
 *
 * Partial recordings are allowed up to the approved amount: the request is
 * finished only when the last of it has been recorded.
 */
export type ReturnRefundRequest = { id: string; status: string; amountKsh: number };

export function refundGate(requests: readonly ReturnRefundRequest[], alreadyRefundedKsh: number, amountKsh: number): { request: ReturnRefundRequest | null; completes: boolean } {
  if (requests.length === 0) return { request: null, completes: false };
  const approved = requests.find((row) => row.status === "APPROVED");
  if (!approved) {
    if (requests.some((row) => row.status === "PENDING_APPROVAL")) throw new ConflictException("The refund request for this return is still waiting for approval. Ask the approver to review the photos first.");
    if (requests.some((row) => row.status === "REFUNDED")) throw new ConflictException("The approved refund for this return has already been recorded in full.");
    throw new ConflictException("The refund request for this return was rejected or withdrawn. Raise a new refund request before recording a refund.");
  }
  if (alreadyRefundedKsh + amountKsh > approved.amountKsh) {
    throw new ConflictException(`The approved refund is KSh ${approved.amountKsh}; recording KSh ${alreadyRefundedKsh + amountKsh} in total would go beyond it.`);
  }
  return { request: approved, completes: alreadyRefundedKsh + amountKsh === approved.amountKsh };
}
