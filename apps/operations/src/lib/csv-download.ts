/**
 * CSV files staff open in Excel. Kept free of React so the file contents can be tested
 * without a browser; only `downloadCsv` touches the page.
 */

/** A UTF-8 byte-order mark. Without it Excel reads the file as ANSI and garbles non-ASCII names. */
export const CSV_BOM = "﻿";

/**
 * One quoted CSV cell.
 *
 * A cell that Excel would read as a formula (a promoter types their own display name)
 * is turned into plain text with a leading apostrophe. Phone numbers and amounts that
 * merely start with "+" or "-" are left alone.
 */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  const startsLikeFormula = /^[=@\t\r]/.test(text) || (/^[+-]/.test(text) && !/^[+-]?[\d\s().-]+$/.test(text));
  if (startsLikeFormula) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** Header row from the first row's keys, then one line per row. No rows gives an empty string. */
export function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0] ?? {});
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))
  ].join("\n");
}

/** `payout-list-2026-10-23.csv`, dated in Nairobi time because the payout week is. */
export function payoutListFileName(now: Date = new Date()): string {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
  return `payout-list-${day}.csv`;
}

/** Saves the CSV as a file in the browser, with the byte-order mark Excel needs. */
export function downloadCsv(fileName: string, csv: string) {
  const url = URL.createObjectURL(new Blob([CSV_BOM, csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  // Some browsers ignore a click on an anchor that is not in the page.
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
