/**
 * 周结付款 export (the "导出" panel on the weekly payouts page), as pure functions.
 *
 * One export for everything finance needs to hand out or check: a week, a date
 * range, everything still unpaid, or everything unpaid from before a week; with
 * promoter commissions and rider delivery fees together; unpaid, paid or both;
 * one line per person per week, or one line per order.
 *
 * Which date an item is "attributed" to is the same rule the weekly sheet uses:
 * a commission to the day it was CONFIRMED, a rider fee to the day the delivery
 * was COMPLETED, both read as Nairobi calendar days. Nothing here changes
 * data; the loader that reads the database lives in operations-payout.service.ts.
 */
import { NAIROBI_OFFSET_MS, nairobiDay, normalizeKenyaPhone, payoutWeek, type PayoutWeek } from "./operations-payout-sheet";

const DAY_MS = 24 * 60 * 60 * 1000;

export type ExportScope = "week" | "range" | "all" | "earlier";
export type ExportStatus = "pending" | "paid" | "all";
export type ExportFormat = "summary" | "detail";

export type ExportInput = {
  scope?: string;
  /** Any Nairobi YYYY-MM-DD inside the week (scope week, earlier); default last week. */
  week?: string;
  /** Nairobi YYYY-MM-DD, both inclusive (scope range). */
  from?: string;
  to?: string;
  status?: string;
  /** Comma list of "affiliate", "rider"; default both. */
  include?: string;
  format?: string;
};

export type ExportOptions = {
  scope: ExportScope;
  status: ExportStatus;
  format: ExportFormat;
  includeAffiliate: boolean;
  includeRider: boolean;
  /** Attribution window [start, end); null = unbounded on that side. */
  start: Date | null;
  end: Date | null;
  /** The part of the file name that says what range this is. */
  label: string;
};

export type ExportItem = {
  status: "pending" | "paid";
  kind: "COMMISSION" | "RIDER_FEE";
  payeeKey: string;
  payeeType: "AFFILIATE" | "RIDER";
  name: string;
  phone: string | null;
  orderNumber: string;
  orderDate: Date | null;
  /** confirmedAt for a commission, completedAt for a delivery. */
  attributedAt: Date | null;
  amountKsh: number;
  payoutId: string | null;
  paidAt: Date | null;
  mpesaCode: string | null;
};

export type ExportSummary = {
  people: number;
  affiliatePeople: number;
  riderPeople: number;
  amountKsh: number;
  itemCount: number;
  /** People in the export with no usable M-Pesa phone number. */
  missingPhonePeople: number;
  /** True when the export hit the safety cap on rows and may be incomplete. */
  truncated: boolean;
};

export const EXPORT_ROW_LIMIT = 20000;

const SCOPES: ExportScope[] = ["week", "range", "all", "earlier"];
const STATUSES: ExportStatus[] = ["pending", "paid", "all"];
const FORMATS: ExportFormat[] = ["summary", "detail"];

function realDay(value: string | undefined, name: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value?.trim() ?? "");
  if (!match) throw new Error(`${name} must be a date written YYYY-MM-DD.`);
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0, 10) !== (value ?? "").trim()) {
    throw new Error(`${name} must be a real calendar date.`);
  }
  return utc;
}

/** Validates the panel's choices. A bad value is refused, never replaced by a default. */
export function parseExportOptions(input: ExportInput, now = new Date()): ExportOptions {
  const scope = (input.scope?.trim() || "week") as ExportScope;
  if (!SCOPES.includes(scope)) throw new Error("scope must be week, range, all or earlier.");
  const status = (input.status?.trim() || "pending") as ExportStatus;
  if (!STATUSES.includes(status)) throw new Error("status must be pending, paid or all.");
  const format = (input.format?.trim() || "summary") as ExportFormat;
  if (!FORMATS.includes(format)) throw new Error("format must be summary or detail.");

  const parts = (input.include?.trim() ? input.include : "affiliate,rider").split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.some((part) => part !== "affiliate" && part !== "rider")) throw new Error("include must list affiliate and/or rider.");
  const includeAffiliate = parts.includes("affiliate");
  const includeRider = parts.includes("rider");
  if (!includeAffiliate && !includeRider) throw new Error("Choose promoter commissions, rider fees or both.");

  let start: Date | null = null;
  let end: Date | null = null;
  let label: string;
  if (scope === "week") {
    const week: PayoutWeek = payoutWeek(input.week, now);
    start = week.start;
    end = week.end;
    label = `${week.firstDay}_${week.lastDay}`;
  } else if (scope === "earlier") {
    const week: PayoutWeek = payoutWeek(input.week, now);
    end = week.start;
    label = `before-${week.firstDay}`;
  } else if (scope === "range") {
    const from = realDay(input.from, "from");
    const to = realDay(input.to, "to");
    if (from > to) throw new Error("The start date must not be after the end date.");
    start = new Date(from - NAIROBI_OFFSET_MS);
    end = new Date(to + DAY_MS - NAIROBI_OFFSET_MS);
    label = `${input.from!.trim()}_${input.to!.trim()}`;
  } else {
    label = `all-${nairobiDay(now)}`;
  }
  return { scope, status, format, includeAffiliate, includeRider, start, end, label };
}

export function exportFileName(options: ExportOptions): string {
  return `payouts-${options.status}-${options.format}-${options.label}.csv`;
}

function weekOf(item: ExportItem): { firstDay: string; lastDay: string } | null {
  if (!item.attributedAt) return null;
  const week = payoutWeek(nairobiDay(item.attributedAt));
  return { firstDay: week.firstDay, lastDay: week.lastDay };
}

function weekLabel(week: { firstDay: string; lastDay: string } | null): string {
  return week ? `${week.firstDay}~${week.lastDay}` : "";
}

function dayOrEmpty(value: Date | null): string {
  return value ? nairobiDay(value) : "";
}

/** The note a person doing the payments needs to see on the line. */
function phoneNote(item: Pick<ExportItem, "status" | "phone">): string {
  if (item.status !== "pending") return "";
  if (!item.phone || !item.phone.trim()) return "没有手机号";
  if (!normalizeKenyaPhone(item.phone)) return "手机号不是有效的 M-Pesa 号码";
  return "";
}

export type CsvCell = string | number | null;

export const SUMMARY_HEADER = ["状态", "类型", "姓名", "电话", "笔数", "金额(KSh)", "所属周", "付款日期", "M-Pesa 交易码", "备注"];
export const DETAIL_HEADER = ["状态", "类型", "姓名", "电话", "订单号", "下单日期", "归属日期", "所属周", "金额(KSh)", "付款日期", "M-Pesa 交易码", "备注"];

const STATUS_LABEL = { pending: "待付", paid: "已付" } as const;
const TYPE_LABEL = { AFFILIATE: "推广员", RIDER: "骑手" } as const;

function compareItems(a: ExportItem, b: ExportItem): number {
  return (a.status === b.status ? 0 : a.status === "pending" ? -1 : 1)
    || weekLabel(weekOf(a)).localeCompare(weekLabel(weekOf(b)))
    || a.payeeType.localeCompare(b.payeeType)
    || a.name.localeCompare(b.name)
    || (a.attributedAt?.getTime() ?? 0) - (b.attributedAt?.getTime() ?? 0)
    || a.orderNumber.localeCompare(b.orderNumber);
}

/** Pending first, then oldest week first; within a week promoters, then riders, biggest amount first. */
export function buildExportRows(items: ExportItem[], format: ExportFormat): { header: string[]; rows: CsvCell[][] } {
  if (format === "detail") {
    const rows = [...items].sort(compareItems).map((item) => [
      STATUS_LABEL[item.status],
      TYPE_LABEL[item.payeeType],
      item.name,
      item.phone,
      item.orderNumber,
      dayOrEmpty(item.orderDate),
      dayOrEmpty(item.attributedAt),
      weekLabel(weekOf(item)),
      item.amountKsh,
      dayOrEmpty(item.paidAt),
      item.mpesaCode,
      phoneNote(item)
    ] as CsvCell[]);
    return { header: DETAIL_HEADER, rows };
  }

  type Group = { sample: ExportItem; amountKsh: number; count: number };
  const groups = new Map<string, Group>();
  for (const item of items) {
    const key = [item.status, item.payeeKey, weekLabel(weekOf(item)), item.payoutId ?? ""].join("|");
    const group = groups.get(key);
    if (group) {
      group.amountKsh += item.amountKsh;
      group.count += 1;
    } else {
      groups.set(key, { sample: item, amountKsh: item.amountKsh, count: 1 });
    }
  }
  const ordered = [...groups.values()].sort((a, b) =>
    (a.sample.status === b.sample.status ? 0 : a.sample.status === "pending" ? -1 : 1)
    || weekLabel(weekOf(a.sample)).localeCompare(weekLabel(weekOf(b.sample)))
    || a.sample.payeeType.localeCompare(b.sample.payeeType)
    || b.amountKsh - a.amountKsh
    || a.sample.name.localeCompare(b.sample.name));
  const rows = ordered.map(({ sample, amountKsh, count }) => [
    STATUS_LABEL[sample.status],
    TYPE_LABEL[sample.payeeType],
    sample.name,
    sample.phone,
    count,
    amountKsh,
    weekLabel(weekOf(sample)),
    dayOrEmpty(sample.paidAt),
    sample.mpesaCode,
    phoneNote(sample)
  ] as CsvCell[]);
  return { header: SUMMARY_HEADER, rows };
}

export function summarizeExport(items: ExportItem[], truncated: boolean): ExportSummary {
  const people = new Map<string, ExportItem>();
  for (const item of items) {
    const seen = people.get(item.payeeKey);
    // A person counts as missing a phone only if none of their items has one.
    if (!seen || (!seen.phone && item.phone)) people.set(item.payeeKey, item);
  }
  const list = [...people.values()];
  return {
    people: list.length,
    affiliatePeople: list.filter((item) => item.payeeType === "AFFILIATE").length,
    riderPeople: list.filter((item) => item.payeeType === "RIDER").length,
    amountKsh: items.reduce((sum, item) => sum + item.amountKsh, 0),
    itemCount: items.length,
    missingPhonePeople: list.filter((item) => !item.phone || !item.phone.trim()).length,
    truncated
  };
}

/** One CSV cell. A name that Excel would read as a formula is turned into plain text. */
export function exportCsvCell(value: CsvCell): string {
  let text = value === null || value === undefined ? "" : String(value);
  const startsLikeFormula = /^[=@\t\r]/.test(text) || (/^[+-]/.test(text) && !/^[+-]?[\d\s().-]+$/.test(text));
  if (startsLikeFormula) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function exportCsv(header: string[], rows: CsvCell[][]): string {
  return `${[header, ...rows].map((line) => line.map(exportCsvCell).join(",")).join("\n")}\n`;
}
