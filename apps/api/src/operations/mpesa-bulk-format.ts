import { randomInt } from "node:crypto";
import { normalizeKenyaPhone, normalizeMpesaCode } from "./operations-payout-sheet";
import { looksLikeOldXls, looksLikeXlsx, readXlsx, writeXlsx, type SheetCells } from "./simple-xlsx";

/**
 * M-Pesa for Business bulk payouts: the two files that cross between our
 * weekly payout page and the Safaricom portal (owner decision, 2026-10-14).
 *
 *   1. the BULK UPLOAD FILE we export (one row per person to pay), and
 *   2. the RESULTS REPORT the portal produces after the batch has run, which
 *      finance uploads back to us so each person is marked paid with their
 *      M-Pesa receipt.
 *
 * ============================================================================
 *  EVERYTHING ABOUT COLUMNS AND HEADERS IS IN THIS FILE, AND ONLY HERE.
 *    - The upload file follows the portal's B2C bulk template the owner sent
 *      on 2026-10-15 (EXPORT_COLUMNS). If the portal rejects the phone form,
 *      flip MOBILE_NUMBER_STYLE to "0" (07XXXXXXXX).
 *    - The RESULTS REPORT layout is still unknown. RESULT_COLUMNS (exact
 *      header names) and RESULT_HEADER_WORDS (header names containing a word)
 *      are a tolerant guess; when a real report arrives, add its header names
 *      and its success / failure words (SUCCESS_WORDS / FAILURE_WORDS).
 *  Then run `node --import tsx --test src/operations/mpesa-bulk-format.spec.ts`.
 * ============================================================================
 *
 * Nothing in this file touches the database or moves money.
 */

// ===================================================================== export

export type BulkExportLine = {
  /** Our reference for this one person in this batch, e.g. "PB7K3Q9M-03". Goes in the remarks column. */
  reference: string;
  /** 2547XXXXXXXX / 2541XXXXXXXX. */
  phone: string;
  /** Whole Kenya shillings. */
  amountKsh: number;
  name: string;
  payeeType: "AFFILIATE" | "RIDER";
};

/**
 * The M-Pesa for Business B2C bulk upload template (B2C-Bulk-Template.xlsx,
 * sent by the owner 2026-10-15). One sheet "Sheet1", header in row 1, one
 * person per row from row 2:
 *
 *   | A MobileNumber | B DocumentType | C DocumentNumber | D Amount | E PurposeOfPayment         | F Name        |
 *   | 2547XXXXXXXX   | (blank)        | (blank)          | 1250     | DL commission PB7K3Q9M-03  | Jane Wanjiku  |
 *
 *   - A, B, C, E, F are Text ("@") columns; D uses the template's accounting
 *     format. MobileNumber is written as a text cell so no digit is lost.
 *   - DocumentType / DocumentNumber stay empty: we do not hold ID numbers. The
 *     template's dropdown on DocumentType is kept (blank allowed).
 *   - PurposeOfPayment carries our line reference ("PB7K3Q9M-03" = batch
 *     reference + row number) so the results report matches back row by row.
 */
export const EXPORT_SHEET_NAME = "Sheet1";

/**
 * How MobileNumber is written: "254" → 2547XXXXXXXX (12 digits), "0" → 07XXXXXXXX.
 * Switch to "0" if the portal rejects the 254 form.
 */
export const MOBILE_NUMBER_STYLE: "254" | "0" = "254";

export const DOCUMENT_TYPES = ["National Id", "Military Id", "Alien Id", "Diplomatic Id", "Passport", "Manifest"];

export type ExportColumn = {
  header: string;
  style: "text" | "accounting";
  width: number;
  value: (line: BulkExportLine) => string | number | null;
};

export const EXPORT_COLUMNS: ExportColumn[] = [
  { header: "MobileNumber", style: "text", width: 16, value: (line) => mobileNumber(line.phone) },
  { header: "DocumentType", style: "text", width: 16, value: () => null },
  { header: "DocumentNumber", style: "text", width: 18, value: () => null },
  { header: "Amount", style: "accounting", width: 14, value: (line) => line.amountKsh },
  { header: "PurposeOfPayment", style: "text", width: 30, value: (line) => purposeOfPayment(line) },
  { header: "Name", style: "text", width: 30, value: (line) => asciiName(line.name) }
];

/** The portal takes .xlsx; .csv is offered on the page only as a record copy. */
export const EXPORT_DEFAULT_FORMAT: BulkFileFormat = "xlsx";

export type BulkFileFormat = "csv" | "xlsx";

export type BulkFile = { fileName: string; contentType: string; content: Buffer };

export function buildBulkExportFile(lines: BulkExportLine[], options: { batchReference: string; firstDay: string; format?: BulkFileFormat }): BulkFile {
  const format = options.format ?? EXPORT_DEFAULT_FORMAT;
  const header = EXPORT_COLUMNS.map((column) => column.header);
  const body = lines.map((line) => EXPORT_COLUMNS.map((column) => column.value(line)));
  const baseName = `mpesa-bulk-${options.firstDay}-${options.batchReference}`;
  if (format === "csv") {
    const cells = [header, ...body.map((row) => row.map((value) => (value === null ? "" : String(value))))];
    return { fileName: `${baseName}.csv`, contentType: "text/csv; charset=utf-8", content: Buffer.from(toCsv(cells), "utf8") };
  }
  const documentTypeColumn = String.fromCharCode(65 + EXPORT_COLUMNS.findIndex((column) => column.header === "DocumentType"));
  return {
    fileName: `${baseName}.xlsx`,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    content: writeXlsx({
      sheetName: EXPORT_SHEET_NAME,
      columns: EXPORT_COLUMNS.map((column) => ({ style: column.style, width: column.width })),
      rows: [header, ...body],
      validations: documentTypeColumn >= "A" ? [{ range: `${documentTypeColumn}2:${documentTypeColumn}1048576`, list: DOCUMENT_TYPES }] : []
    })
  };
}

/** 2547XXXXXXXX → as MOBILE_NUMBER_STYLE says. */
export function mobileNumber(phone254: string): string {
  return MOBILE_NUMBER_STYLE === "0" ? `0${phone254.slice(3)}` : phone254;
}

/** "DL commission PB7K3Q9M-03" / "DL rider fee PB7K3Q9M-03": ASCII, at most 30 characters. */
export function purposeOfPayment(line: Pick<BulkExportLine, "payeeType" | "reference">): string {
  return `${line.payeeType === "AFFILIATE" ? "DL commission" : "DL rider fee"} ${line.reference}`.slice(0, 30);
}

/** Accents folded to plain letters; only letters, digits, space, . ' - kept; at most 50 long. */
export function asciiName(name: string): string {
  return name.normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9 .'-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 50).trim() || "Payee";
}

/** The phone the portal wants: 2547XXXXXXXX / 2541XXXXXXXX, or null if it is not a Kenyan mobile number. */
export function bulkPhone(value: string | null | undefined): string | null {
  return normalizeKenyaPhone(value);
}

// Letters and digits that cannot be misread for each other (no 0/O, 1/I/L).
const REFERENCE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** A short batch reference, "PB" and six characters, e.g. "PB7K3Q9M". */
export function newBatchReference(random: (max: number) => number = randomInt): string {
  let text = "PB";
  for (let i = 0; i < 6; i += 1) text += REFERENCE_ALPHABET[random(REFERENCE_ALPHABET.length)];
  return text;
}

/** "PB7K3Q9M" + 3 → "PB7K3Q9M-03". */
export function lineReference(batchReference: string, index: number): string {
  return `${batchReference}-${String(index + 1).padStart(2, "0")}`;
}

const LINE_REFERENCE = /\b(PB[A-Z0-9]{6})-(\d{2,3})\b/i;

export type ExportCandidate = {
  payeeKey: string;
  payeeType: "AFFILIATE" | "RIDER";
  name: string;
  phone: string | null;
  amountKsh: number;
  /** The exporting admin is this person (self-payment guard). */
  selfPayment: boolean;
  /** Already in an exported batch that is waiting for its results. */
  lockedBy: string | null;
};

export type ExportExclusion = { payeeKey: string; name: string; amountKsh: number; reason: "SELF_PAYMENT" | "NO_PHONE" | "ALREADY_EXPORTED" | "NOTHING_TO_PAY"; batchReference?: string };

/** Which rows go into the file, with their references, and which are left out and why. */
export function planBulkExport(candidates: ExportCandidate[], batchReference: string) {
  const lines: Array<BulkExportLine & { payeeKey: string }> = [];
  const excluded: ExportExclusion[] = [];
  for (const row of candidates) {
    const base = { payeeKey: row.payeeKey, name: row.name, amountKsh: row.amountKsh };
    if (row.lockedBy) { excluded.push({ ...base, reason: "ALREADY_EXPORTED", batchReference: row.lockedBy }); continue; }
    if (row.selfPayment) { excluded.push({ ...base, reason: "SELF_PAYMENT" }); continue; }
    if (!(row.amountKsh > 0) || !Number.isInteger(row.amountKsh)) { excluded.push({ ...base, reason: "NOTHING_TO_PAY" }); continue; }
    const phone = bulkPhone(row.phone);
    if (!phone) { excluded.push({ ...base, reason: "NO_PHONE" }); continue; }
    lines.push({
      payeeKey: row.payeeKey,
      reference: lineReference(batchReference, lines.length),
      phone,
      amountKsh: row.amountKsh,
      name: cleanName(row.name),
      payeeType: row.payeeType
    });
  }
  return { lines, excluded };
}

/** Names go into a portal field: one line, no stray characters, at most 60 long. */
function cleanName(name: string): string {
  return name.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

function toCsv(cells: SheetCells): string {
  const cell = (text: string) => {
    // A leading = + - @ would run as a formula in a spreadsheet.
    const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return `${cells.map((row) => row.map(cell).join(",")).join("\r\n")}\r\n`;
}

// ==================================================================== results

/**
 * DEFAULT results report layout. The header row may sit below a few title
 * lines; it is found by its names. Any of the names listed counts.
 *
 *   | Receipt No. | Phone Number | Amount | Status    | Reference   | Completion Time     | Reason |
 *   | SJK3ABC12X  | 254712345678 | 1250   | Completed | PB7K3Q9M-03 | 2026-10-12 10:15:00 |        |
 *
 * Phones may be masked (2547****5678); a masked phone still matches on the
 * digits it shows.
 */
export const RESULT_COLUMNS = {
  receipt: ["Transaction Receipt No", "TransactionReceipt", "Receipt No", "Receipt", "Receipt Number", "Transaction ID", "Transaction Receipt", "Mpesa Receipt", "Transaction Code"],
  phone: ["MobileNumber", "Phone Number", "Phone", "MSISDN", "Mobile Number", "Receiver", "Receiver Party", "Party B", "Recipient", "Credit Party"],
  amount: ["Amount", "Transaction Amount", "Paid Amount", "Withdrawn"],
  status: ["Status", "Transaction Status", "Result", "Result Status"],
  reference: ["PurposeOfPayment", "Purpose Of Payment", "Purpose", "Reference", "Remarks", "Remark", "Comment", "Comments", "Occasion", "Narration", "Details", "Reason Type"],
  completedAt: ["Completion Time", "Completed", "Completed At", "Transaction Date", "Date", "Initiation Time"],
  reason: ["Reason", "Result Description", "Failure Reason", "Error", "Description", "Result Desc"]
} as const;

export const SUCCESS_WORDS = ["completed", "complete", "success", "successful", "succeeded", "processed", "paid"];
export const FAILURE_WORDS = ["failed", "failure", "fail", "declined", "rejected", "cancelled", "canceled", "expired", "error", "reversed", "timeout", "unsuccessful", "invalid"];

type ResultField = keyof typeof RESULT_COLUMNS;

export type ResultRow = {
  /** Row number in the file, 1-based, as Excel shows it. */
  fileRow: number;
  receipt: string | null;
  receiptText: string;
  phone: string;
  amountKsh: number | null;
  status: "SUCCESS" | "FAILED" | "UNKNOWN";
  statusText: string;
  reference: string;
  completedAt: string;
  reason: string;
  /** "PB7K3Q9M-03" if found anywhere in the row. */
  lineReference: string | null;
};

const headerKey = (text: string) => text.toLowerCase().replace(/[\s._\-()/#:]+/g, "");

/**
 * Header names CONTAINING these words also count (checked in this order, after
 * the exact names above), so an unknown report still reads if its headers are
 * close: "Receipt No." / "Transaction ID", "Receiver Mobile", "Amount (KES)",
 * "Result Code Desc", "Purpose", "Completed Date".
 */
const RESULT_HEADER_WORDS: Array<[ResultField, string[]]> = [
  ["reason", ["reason", "desc", "error", "failure"]],
  ["receipt", ["receipt", "transactionid", "transid", "mpesacode", "transactioncode"]],
  ["phone", ["mobile", "phone", "msisdn"]],
  ["amount", ["amount"]],
  ["status", ["status", "result"]],
  ["reference", ["purpose", "reference", "remark", "comment", "occasion", "narration", "details"]],
  ["completedAt", ["date", "time", "completed"]]
];

function headerField(text: string, exact: Map<string, ResultField>): ResultField | undefined {
  const key = headerKey(text ?? "");
  if (!key) return undefined;
  const known = exact.get(key);
  if (known) return known;
  return RESULT_HEADER_WORDS.find(([, words]) => words.some((word) => key.includes(word)))?.[0];
}

/** Reads the file the portal produced (.xlsx or .csv) into result rows. */
export function parseResultsFile(content: Buffer): ResultRow[] {
  if (looksLikeOldXls(content)) {
    throw new Error("This is an old Excel .xls file. Open it in Excel and save it as .xlsx or .csv, then upload that.");
  }
  let cells: SheetCells;
  try {
    cells = looksLikeXlsx(content) ? readXlsx(content) : parseCsv(content.toString("utf8").replace(/^﻿/, ""));
  } catch (error) {
    throw new Error(error instanceof Error ? `Could not read the file: ${error.message}` : "Could not read the file.");
  }
  return parseResultCells(cells);
}

export function parseResultCells(cells: SheetCells): ResultRow[] {
  const known = new Map<string, ResultField>();
  for (const [field, names] of Object.entries(RESULT_COLUMNS) as Array<[ResultField, readonly string[]]>) {
    for (const name of names) if (!known.has(headerKey(name))) known.set(headerKey(name), field);
  }
  let headerAt = -1;
  let columns: Partial<Record<ResultField, number>> = {};
  for (let r = 0; r < Math.min(cells.length, 40); r += 1) {
    const found: Partial<Record<ResultField, number>> = {};
    cells[r].forEach((text, c) => {
      const field = headerField(text, known);
      if (field && found[field] === undefined) found[field] = c;
    });
    const hasCore = found.amount !== undefined && (found.receipt !== undefined || found.status !== undefined);
    if (hasCore) { headerAt = r; columns = found; break; }
  }
  if (headerAt < 0) {
    throw new Error("Could not find the header row. The file needs at least an Amount column and a Receipt or Status column.");
  }
  const rows: ResultRow[] = [];
  for (let r = headerAt + 1; r < cells.length; r += 1) {
    const row = cells[r] ?? [];
    if (!row.some((value) => value && value.trim())) continue;
    const get = (field: ResultField) => (columns[field] === undefined ? "" : String(row[columns[field]!] ?? "").trim());
    const receiptText = get("receipt");
    const statusText = get("status");
    const reference = get("reference");
    const status = classifyStatus(statusText, receiptText);
    rows.push({
      fileRow: r + 1,
      receipt: normalizeMpesaCode(receiptText),
      receiptText,
      phone: get("phone"),
      amountKsh: parseAmount(get("amount")),
      status,
      statusText,
      reference,
      completedAt: get("completedAt"),
      reason: get("reason"),
      lineReference: findLineReference([reference, ...row])
    });
  }
  return rows;
}

/** Success / failure from the status words; with no status column a valid receipt means success. */
export function classifyStatus(statusText: string, receiptText = ""): ResultRow["status"] {
  const words = statusText.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (words.some((word) => FAILURE_WORDS.includes(word))) return "FAILED";
  if (words.some((word) => SUCCESS_WORDS.includes(word))) return "SUCCESS";
  if (!statusText && normalizeMpesaCode(receiptText)) return "SUCCESS";
  return "UNKNOWN";
}

/** "1,250.00" → 1250, "-1250" → 1250 (statements show money out as negative), "KSh 50" → 50. */
export function parseAmount(text: string): number | null {
  const cleaned = text.replace(/ksh|kes|,|\s/gi, "");
  if (!/^[-+]?\d+(\.\d+)?$/.test(cleaned)) return null;
  const value = Math.abs(Number(cleaned));
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function findLineReference(texts: string[]): string | null {
  for (const text of texts) {
    const match = LINE_REFERENCE.exec(text ?? "");
    if (match) return `${match[1].toUpperCase()}-${match[2].padStart(2, "0")}`;
  }
  return null;
}

/**
 * Does a phone from the report (maybe masked, maybe 07xx) belong to the line's
 * 2547XXXXXXXX? Masked digits (* or x) match anything; at least 6 digits must
 * be visible so a mostly hidden number does not match by accident.
 */
export function phoneMatches(reportPhone: string, linePhone: string): boolean {
  let text = reportPhone.replace(/[^0-9*xX]/g, "").replace(/[xX]/g, "*");
  if (!text) return false;
  if (text.startsWith("0")) text = `254${text.slice(1)}`;
  else if (text.length === 9) text = `254${text}`;
  if (text.length !== linePhone.length) return false;
  if (text.replace(/\*/g, "").length < 6) return false;
  return [...text].every((char, i) => char === "*" || char === linePhone[i]);
}

/** Simple RFC 4180 CSV (quotes, doubled quotes, CRLF), also tolerating ; or tab as the separator. */
export function parseCsv(text: string): SheetCells {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const separator = [",", ";", "\t"].map((s) => [s, firstLine.split(s).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: SheetCells = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === "\"") {
        if (text[i + 1] === "\"") { cell += "\""; i += 1; } else quoted = false;
      } else cell += char;
    } else if (char === "\"") quoted = true;
    else if (char === separator) { row.push(cell); cell = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  // Undo the CSV export's formula guard.
  return rows.map((r) => r.map((value) => (/^'[=+\-@]/.test(value) ? value.slice(1) : value)));
}

// =================================================================== matching

export type BatchLineForMatch = {
  id: string;
  reference: string;
  phone: string;
  amountKsh: number;
  status: "PENDING" | "PAID" | "FAILED" | "CANCELLED";
  /** The receipt recorded when the line was paid. */
  mpesaCode: string | null;
};

export type MatchReason =
  | "NO_MATCH"
  | "OTHER_BATCH"
  | "AMOUNT_MISMATCH"
  | "AMBIGUOUS"
  | "NO_RECEIPT"
  | "UNKNOWN_STATUS"
  | "DUPLICATE_SUCCESS"
  | "RECEIPT_REUSED"
  | "LINE_CANCELLED"
  | "PAID_WITH_OTHER_CODE"
  | "SELF_PAYMENT";

export type MatchDecision = {
  result: ResultRow;
  lineId: string | null;
  lineReference: string | null;
  matchedBy: "reference" | "phone_amount" | null;
  /**
   * PAY: mark paid now. ALREADY_PAID: the same receipt was recorded before, nothing to do.
   * FAILED: the portal says this payment failed. DUPLICATE: the same row twice in the file, ignored.
   * UNMATCHED: could not be tied to one person safely; nothing changes.
   */
  outcome: "PAY" | "ALREADY_PAID" | "FAILED" | "DUPLICATE" | "UNMATCHED";
  reason: MatchReason | null;
  detail?: string;
};

/**
 * Ties each report row to one line of the batch: by our line reference first,
 * then by phone and amount among the batch's lines. Successes are decided
 * before failures, so a payment that failed and was retried successfully in
 * the same report counts once, as paid.
 */
export function matchResults(results: ResultRow[], lines: BatchLineForMatch[], batchReference: string): MatchDecision[] {
  const byReference = new Map(lines.map((line) => [line.reference, line]));
  const claimed = new Map<string, { receipt: string | null; outcome: MatchDecision["outcome"] }>();
  const receiptsUsed = new Map<string, string>();
  for (const line of lines) if (line.mpesaCode) receiptsUsed.set(line.mpesaCode, line.id);

  const ordered = [...results].sort((a, b) => rank(a) - rank(b) || a.fileRow - b.fileRow);
  const decisions: MatchDecision[] = [];
  for (const result of ordered) {
    const decide = (partial: Omit<MatchDecision, "result">) => decisions.push({ result, ...partial });

    // 1. Which line.
    let line: BatchLineForMatch | undefined;
    let matchedBy: MatchDecision["matchedBy"] = null;
    if (result.lineReference) {
      line = byReference.get(result.lineReference);
      if (!line) {
        const other = !result.lineReference.startsWith(`${batchReference}-`);
        decide({ lineId: null, lineReference: result.lineReference, matchedBy: null, outcome: "UNMATCHED", reason: other ? "OTHER_BATCH" : "NO_MATCH", detail: result.lineReference });
        continue;
      }
      matchedBy = "reference";
    } else {
      const all = lines.filter((candidate) => result.amountKsh === candidate.amountKsh && phoneMatches(result.phone, candidate.phone));
      const open = all.filter((candidate) => !claimed.has(candidate.id) || claimed.get(candidate.id)!.receipt === result.receipt);
      // Only one person fits even counting those already settled in this file: let the duplicate checks below speak.
      const candidates = open.length ? open : all;
      if (candidates.length > 1) {
        decide({ lineId: null, lineReference: null, matchedBy: null, outcome: "UNMATCHED", reason: "AMBIGUOUS" });
        continue;
      }
      line = candidates[0];
      if (!line) {
        decide({ lineId: null, lineReference: null, matchedBy: null, outcome: "UNMATCHED", reason: "NO_MATCH" });
        continue;
      }
      matchedBy = "phone_amount";
    }
    const base = { lineId: line.id, lineReference: line.reference, matchedBy };

    // 2. What happened to it.
    if (line.status === "CANCELLED") { decide({ ...base, outcome: "UNMATCHED", reason: "LINE_CANCELLED" }); continue; }
    const earlier = claimed.get(line.id);

    if (result.status === "UNKNOWN") { decide({ ...base, outcome: "UNMATCHED", reason: "UNKNOWN_STATUS", detail: result.statusText }); continue; }

    if (result.status === "FAILED") {
      // A success for the same person (in this file or recorded before) wins.
      if (earlier || line.status === "PAID") { decide({ ...base, outcome: "DUPLICATE", reason: null }); continue; }
      claimed.set(line.id, { receipt: null, outcome: "FAILED" });
      decide({ ...base, outcome: "FAILED", reason: null, detail: result.reason || result.statusText });
      continue;
    }

    // SUCCESS.
    if (!result.receipt) { decide({ ...base, outcome: "UNMATCHED", reason: "NO_RECEIPT", detail: result.receiptText }); continue; }
    if (result.amountKsh !== line.amountKsh) {
      decide({ ...base, outcome: "UNMATCHED", reason: "AMOUNT_MISMATCH", detail: `${result.amountKsh ?? "?"}/${line.amountKsh}` });
      continue;
    }
    if (earlier) {
      if (earlier.receipt === result.receipt) decide({ ...base, outcome: "DUPLICATE", reason: null });
      else decide({ ...base, outcome: "UNMATCHED", reason: "DUPLICATE_SUCCESS", detail: `${earlier.receipt} ${result.receipt}` });
      continue;
    }
    if (line.status === "PAID") {
      claimed.set(line.id, { receipt: result.receipt, outcome: "ALREADY_PAID" });
      if (line.mpesaCode === result.receipt) decide({ ...base, outcome: "ALREADY_PAID", reason: null });
      else decide({ ...base, outcome: "UNMATCHED", reason: "PAID_WITH_OTHER_CODE", detail: `${line.mpesaCode} ${result.receipt}` });
      continue;
    }
    const usedBy = receiptsUsed.get(result.receipt);
    if (usedBy && usedBy !== line.id) { decide({ ...base, outcome: "UNMATCHED", reason: "RECEIPT_REUSED", detail: result.receipt }); continue; }
    receiptsUsed.set(result.receipt, line.id);
    claimed.set(line.id, { receipt: result.receipt, outcome: "PAY" });
    decide({ ...base, outcome: "PAY", reason: null });
  }
  return decisions.sort((a, b) => a.result.fileRow - b.result.fileRow);
}

function rank(row: ResultRow) {
  return row.status === "SUCCESS" ? 0 : row.status === "FAILED" ? 1 : 2;
}
