/**
 * The returns record sheet (the 导出 button on the after-sales orders page), as pure functions.
 *
 * One line per returned garment: what came back, why, who handled it, and where its
 * refund stands. Finance uses it to find the refunds still to be sent by hand in
 * M-Pesa; the team uses it to look back at what is being returned and why.
 *
 * Exchanges will add their own lines to this sheet later, so the columns that only
 * an exchange fills (the new garment, the top-up, the discount) are already here
 * and stay empty for returns. Nothing in this file changes data; the loader that
 * reads the database lives in operations-after-sales.service.ts.
 */
import { NAIROBI_OFFSET_MS, nairobiDay } from "./operations-payout-sheet";

const DAY_MS = 24 * 60 * 60 * 1000;

type CsvCell = string | number | null;

/** One CSV cell. A name or note that Excel would read as a formula is turned into plain text. */
function csvCell(value: CsvCell): string {
  let text = value === null || value === undefined ? "" : String(value);
  const startsLikeFormula = /^[=@\t\r]/.test(text) || (/^[+-]/.test(text) && !/^[+-]?[\d\s().-]+$/.test(text));
  if (startsLikeFormula) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvText(header: string[], rows: CsvCell[][]): string {
  return `${[header, ...rows].map((line) => line.map(csvCell).join(",")).join("\n")}\n`;
}

/** The most lines one file carries. Past this the file says it is cut short. */
export const AFTER_SALES_EXPORT_ROW_LIMIT = 5000;

export type AfterSalesExportFilter = "all" | "to-refund";

export type AfterSalesExportInput = { from?: string; to?: string; filter?: string };

export type AfterSalesExportOptions = {
  filter: AfterSalesExportFilter;
  /** Requested-at window [start, end). */
  start: Date;
  end: Date;
  firstDay: string;
  lastDay: string;
};

/** One returned garment, flattened so this file needs no database types. */
export type AfterSalesExportItem = {
  type: "RETURN";
  requestedAt: Date;
  completedAt: Date | null;
  orderNumber: string;
  barcode: string | null;
  title: string;
  reason: string;
  note: string;
  customerName: string | null;
  customerPhone: string | null;
  returnStatus: string;
  itemPriceKsh: number;
  refundRequestStatus: string | null;
  refundApprovedKsh: number | null;
  refundedKsh: number;
  refundedAt: Date | null;
  mpesaReference: string | null;
  requestedBy: string | null;
  receivedBy: string | null;
  approvedBy: string | null;
  photoCount: number;
};

function realDay(value: string | undefined, name: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec((value ?? "").trim());
  if (!match) throw new Error(`${name} must be a date written YYYY-MM-DD.`);
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0, 10) !== (value ?? "").trim()) {
    throw new Error(`${name} must be a real calendar date.`);
  }
  return utc;
}

/** Validates the choices. A bad value is refused, never replaced by a default; no dates means the last 30 days. */
export function parseAfterSalesExportOptions(input: AfterSalesExportInput, now = new Date()): AfterSalesExportOptions {
  const filter = (input.filter?.trim() || "all") as AfterSalesExportFilter;
  if (filter !== "all" && filter !== "to-refund") throw new Error("filter must be all or to-refund.");
  const hasFrom = Boolean(input.from?.trim());
  const hasTo = Boolean(input.to?.trim());
  if (hasFrom !== hasTo) throw new Error("Give both a start and an end date, or neither.");
  let from: number;
  let to: number;
  if (hasFrom) {
    from = realDay(input.from, "from");
    to = realDay(input.to, "to");
    if (from > to) throw new Error("The start date must not be after the end date.");
  } else {
    to = Date.parse(`${nairobiDay(now)}T00:00:00Z`);
    from = to - 29 * DAY_MS;
  }
  return {
    filter,
    start: new Date(from - NAIROBI_OFFSET_MS),
    end: new Date(to + DAY_MS - NAIROBI_OFFSET_MS),
    firstDay: new Date(from).toISOString().slice(0, 10),
    lastDay: new Date(to).toISOString().slice(0, 10)
  };
}

export function afterSalesExportFileName(options: AfterSalesExportOptions): string {
  return `returns-${options.filter}-${options.firstDay}_${options.lastDay}.csv`;
}

/** An approved refund the money has not yet gone out for. */
export function needsRefund(item: AfterSalesExportItem): boolean {
  return item.refundRequestStatus === "APPROVED";
}

export const AFTER_SALES_EXPORT_HEADER = [
  "Type",
  "Requested",
  "Completed",
  "Order",
  "Barcode",
  "Item",
  "Reason",
  "Customer",
  "Phone",
  "Return status",
  "Item price (KSh)",
  "Refund request",
  "Refund approved (KSh)",
  "Refunded (KSh)",
  "Refunded on",
  "M-Pesa reference",
  "Requested by",
  "Received by",
  "Refund approved by",
  "Photos",
  "Note",
  // Filled by exchanges once they exist; empty for returns.
  "New item",
  "Top-up (KSh)",
  "Discount (KSh)"
];

function day(value: Date | null): string {
  return value ? nairobiDay(value) : "";
}

export function buildAfterSalesExportRows(items: AfterSalesExportItem[], filter: AfterSalesExportFilter): CsvCell[][] {
  return items
    .filter((item) => filter === "all" || needsRefund(item))
    .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime())
    .map((item) => [
      item.type === "RETURN" ? "Return" : item.type,
      day(item.requestedAt),
      day(item.completedAt),
      item.orderNumber,
      item.barcode,
      item.title,
      item.reason,
      item.customerName,
      item.customerPhone,
      item.returnStatus,
      item.itemPriceKsh,
      item.refundRequestStatus,
      item.refundApprovedKsh,
      item.refundedKsh,
      day(item.refundedAt),
      item.mpesaReference,
      item.requestedBy,
      item.receivedBy,
      item.approvedBy,
      item.photoCount,
      item.note,
      null,
      null,
      null
    ]);
}

export function buildAfterSalesExport(items: AfterSalesExportItem[], options: AfterSalesExportOptions, truncated: boolean) {
  const rows = buildAfterSalesExportRows(items, options.filter);
  return {
    fileName: afterSalesExportFileName(options),
    lineCount: rows.length,
    summary: {
      lines: rows.length,
      toRefundKsh: items.filter(needsRefund).reduce((sum, item) => sum + (item.refundApprovedKsh ?? 0) - item.refundedKsh, 0),
      truncated
    },
    csv: csvText(AFTER_SALES_EXPORT_HEADER, rows)
  };
}
