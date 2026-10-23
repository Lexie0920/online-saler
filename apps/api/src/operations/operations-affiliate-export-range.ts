import { BadRequestException } from "@nestjs/common";

const DAY_MS = 24 * 60 * 60 * 1000;
const NAIROBI_OFFSET_MS = 3 * 60 * 60 * 1000;

export type ExportRange = { gte?: Date; lt?: Date };

function nairobiMidnight(day: string, label: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  const utc = match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : Number.NaN;
  if (!match || !Number.isFinite(utc) || new Date(utc).toISOString().slice(0, 10) !== day.trim()) {
    throw new BadRequestException(`${label} must be a real date written YYYY-MM-DD.`);
  }
  return new Date(utc - NAIROBI_OFFSET_MS);
}

/**
 * The payment list's date filter, in Nairobi days and on the day the commission was
 * confirmed (the same date the weekly payout sheet uses). Both ends are included:
 * from 2026-10-01 to 2026-10-07 covers all of the 7th. Leave a side empty for no limit.
 */
export function exportRange(from?: string, to?: string): ExportRange {
  const range: ExportRange = {};
  if (from?.trim()) range.gte = nairobiMidnight(from, "From date");
  if (to?.trim()) range.lt = new Date(nairobiMidnight(to, "To date").getTime() + DAY_MS);
  if (range.gte && range.lt && range.gte.getTime() >= range.lt.getTime()) {
    throw new BadRequestException("The From date must not be after the To date.");
  }
  return range;
}
