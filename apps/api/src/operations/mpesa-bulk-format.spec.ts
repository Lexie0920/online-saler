import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXPORT_COLUMNS,
  asciiName,
  buildBulkExportFile,
  bulkPhone,
  classifyStatus,
  lineReference,
  matchResults,
  newBatchReference,
  parseAmount,
  parseCsv,
  parseResultCells,
  parseResultsFile,
  phoneMatches,
  planBulkExport,
  purposeOfPayment,
  type BatchLineForMatch,
  type ExportCandidate
} from "./mpesa-bulk-format";
import { ACCOUNTING_FORMAT, readXlsx, readXlsxCellStyles, readXlsxPart, writeXlsx } from "./simple-xlsx";

/** All phone numbers here are made up (07xx 000 0xx). */

const BATCH = "PB7K3Q9M";

function candidate(over: Partial<ExportCandidate>): ExportCandidate {
  return { payeeKey: "affiliate:a1", payeeType: "AFFILIATE", name: "Jane Wanjiku", phone: "0711000001", amountKsh: 1250, selfPayment: false, lockedBy: null, ...over };
}

// ------------------------------------------------------------------ export ---

test("phones become 2547XXXXXXXX; anything that is not a Kenyan mobile is refused", () => {
  assert.equal(bulkPhone("0711000001"), "254711000001");
  assert.equal(bulkPhone("+254 711 000 001"), "254711000001");
  assert.equal(bulkPhone("711000001"), "254711000001");
  assert.equal(bulkPhone("0110000001"), "254110000001");
  assert.equal(bulkPhone("254711000001"), "254711000001");
  for (const bad of [null, "", "12345", "0211000001", "07110000011", "not a phone"]) assert.equal(bulkPhone(bad), null, String(bad));
});

test("the export plan keeps payable people and says why the others are left out", () => {
  const plan = planBulkExport([
    candidate({ payeeKey: "affiliate:a1" }),
    candidate({ payeeKey: "affiliate:me", name: "Titus Mwangi", selfPayment: true }),
    candidate({ payeeKey: "rider:r1", payeeType: "RIDER", name: "Peter Kamau", phone: "+254722000001", amountKsh: 300 }),
    candidate({ payeeKey: "external:x|bolt", payeeType: "RIDER", name: "Bolt Rider", phone: null, amountKsh: 100 }),
    candidate({ payeeKey: "external:y|bad", payeeType: "RIDER", name: "Bad Phone", phone: "12345", amountKsh: 100 }),
    candidate({ payeeKey: "affiliate:a2", lockedBy: "PBAAAAAA" })
  ], BATCH);
  assert.deepEqual(plan.lines.map((line) => [line.payeeKey, line.reference, line.phone, line.amountKsh]), [
    ["affiliate:a1", "PB7K3Q9M-01", "254711000001", 1250],
    ["rider:r1", "PB7K3Q9M-02", "254722000001", 300]
  ]);
  assert.deepEqual(plan.excluded.map((row) => [row.payeeKey, row.reason]), [
    ["affiliate:me", "SELF_PAYMENT"],
    ["external:x|bolt", "NO_PHONE"],
    ["external:y|bad", "NO_PHONE"],
    ["affiliate:a2", "ALREADY_EXPORTED"]
  ]);
  assert.equal(plan.excluded.find((row) => row.reason === "ALREADY_EXPORTED")?.batchReference, "PBAAAAAA");
});

test("batch references are short, unambiguous and carried into each row", () => {
  const reference = newBatchReference();
  assert.match(reference, /^PB[A-HJKMNP-Z2-9]{6}$/);
  assert.equal(newBatchReference(() => 0), "PBAAAAAA");
  assert.equal(lineReference(BATCH, 0), "PB7K3Q9M-01");
  assert.equal(lineReference(BATCH, 11), "PB7K3Q9M-12");
  assert.equal(purposeOfPayment({ payeeType: "AFFILIATE", reference: "PB7K3Q9M-03" }), "DL commission PB7K3Q9M-03");
  assert.equal(purposeOfPayment({ payeeType: "RIDER", reference: "PB7K3Q9M-03" }), "DL rider fee PB7K3Q9M-03");
  assert.ok(purposeOfPayment({ payeeType: "AFFILIATE", reference: "PB7K3Q9M-123" }).length <= 30);
  assert.equal(asciiName("Zoë  Njoroge\n=SUM(A1)"), "Zoe Njoroge SUM A1");
  assert.equal(asciiName("王"), "Payee");
});

test("the .xlsx follows the portal's B2C bulk template", () => {
  const { lines } = planBulkExport([
    candidate({ payeeKey: "affiliate:a1" }),
    candidate({ payeeKey: "rider:r1", payeeType: "RIDER", name: "Peter Kamau", phone: "0722000001", amountKsh: 300 })
  ], BATCH);
  const file = buildBulkExportFile(lines, { batchReference: BATCH, firstDay: "2026-10-05" });
  assert.equal(file.fileName, "mpesa-bulk-2026-10-05-PB7K3Q9M.xlsx");
  assert.equal(EXPORT_COLUMNS.map((c) => c.header).join(","), "MobileNumber,DocumentType,DocumentNumber,Amount,PurposeOfPayment,Name");

  const cells = readXlsx(file.content);
  assert.deepEqual(cells[0], ["MobileNumber", "DocumentType", "DocumentNumber", "Amount", "PurposeOfPayment", "Name"]);
  assert.deepEqual(cells[1], ["254711000001", "", "", "1250", "DL commission PB7K3Q9M-01", "Jane Wanjiku"]);
  assert.deepEqual(cells[2], ["254722000001", "", "", "300", "DL rider fee PB7K3Q9M-02", "Peter Kamau"]);

  const styles = readXlsxCellStyles(file.content);
  assert.equal(styles.get("A2")?.type, "inlineStr", "MobileNumber is a text cell");
  assert.equal(styles.get("A2")?.numFmtId, 49, "MobileNumber column is Text (@)");
  assert.equal(styles.get("D2")?.type, null, "Amount is a number cell");
  assert.equal(styles.get("D2")?.numFmtId, 164);
  for (const ref of ["B2", "C2", "E2", "F2"]) assert.equal(styles.get(ref)?.numFmtId, 49, ref);

  const workbook = readXlsxPart(file.content, "xl/workbook.xml")!;
  assert.match(workbook, /<sheet name="Sheet1"/);
  const stylesXml = readXlsxPart(file.content, "xl/styles.xml")!;
  assert.ok(stylesXml.includes(ACCOUNTING_FORMAT.replace(/"/g, "&quot;")), "the template's accounting format");
  const sheet = readXlsxPart(file.content, "xl/worksheets/sheet1.xml")!;
  assert.match(sheet, /<dataValidation type="list" allowBlank="1"[^>]*sqref="B2:B1048576"><formula1>&quot;National Id,Military Id,Alien Id,Diplomatic Id,Passport,Manifest&quot;<\/formula1>/);
});

test("the .csv copy has the same rows and cannot smuggle a formula", () => {
  const { lines } = planBulkExport([candidate({ name: "=HYPERLINK(1)" })], BATCH);
  const file = buildBulkExportFile(lines, { batchReference: BATCH, firstDay: "2026-10-05", format: "csv" });
  const text = file.content.toString("utf8");
  assert.match(text, /^MobileNumber,DocumentType,DocumentNumber,Amount,PurposeOfPayment,Name\r\n254711000001,,,1250,DL commission PB7K3Q9M-01,HYPERLINK 1\r\n$/);
});

// ----------------------------------------------------------------- results ---

test("a results report is found below title lines; amounts and statuses are read loosely", () => {
  const rows = parseResultCells([
    ["Bulk Payment Results"],
    ["Organisation: test"],
    [],
    ["Receipt No.", "Mobile Number", "Amount (KES)", "Transaction Status", "Purpose Of Payment", "Completion Time", "Result Desc"],
    ["sjk3abc12x", "2547*****001", "1,250.00", "Completed", "DL commission PB7K3Q9M-01", "2026-10-12 10:15:00", ""],
    ["", "254722000001", "300", "Failed", "DL rider fee PB7K3Q9M-02", "", "Invalid account"],
    [],
    ["TJK3ABC12X", "0733000001", "-100", "Processed", "", "", ""]
  ]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => [r.fileRow, r.receipt, r.amountKsh, r.status, r.lineReference]), [
    [5, "SJK3ABC12X", 1250, "SUCCESS", "PB7K3Q9M-01"],
    [6, null, 300, "FAILED", "PB7K3Q9M-02"],
    [8, "TJK3ABC12X", 100, "SUCCESS", null]
  ]);
  assert.equal(rows[1].reason, "Invalid account");
  assert.equal(rows[0].completedAt, "2026-10-12 10:15:00");

  assert.throws(() => parseResultCells([["Name", "Phone"], ["x", "y"]]), /header row/);
  assert.equal(classifyStatus("Transaction Failed"), "FAILED");
  assert.equal(classifyStatus("SUCCESS"), "SUCCESS");
  assert.equal(classifyStatus("Pending"), "UNKNOWN");
  assert.equal(classifyStatus("", "SJK3ABC12X"), "SUCCESS", "no status column: a receipt means paid");
  assert.equal(parseAmount("KSh 1,000"), 1000);
  assert.equal(parseAmount("abc"), null);
});

test("results come in as .xlsx (shared or inline strings) or .csv; old .xls is refused clearly", () => {
  const xlsx = writeXlsx([["Transaction ID", "MSISDN", "Amount", "Status", "Remarks"], ["SJK3ABC12X", "254711000001", "1250", "Success", "PB7K3Q9M-01"]]);
  const fromXlsx = parseResultsFile(xlsx);
  assert.equal(fromXlsx[0].receipt, "SJK3ABC12X");
  assert.equal(fromXlsx[0].lineReference, "PB7K3Q9M-01");

  const csv = Buffer.from("﻿Receipt;Phone;Amount;Status;Reference\r\nSJK3ABC12X;0711000001;1250;Completed;\"DL commission PB7K3Q9M-01\"\r\n", "utf8");
  const fromCsv = parseResultsFile(csv);
  assert.equal(fromCsv[0].phone, "0711000001");
  assert.equal(fromCsv[0].amountKsh, 1250);
  assert.deepEqual(parseCsv("a,\"b,\"\"c\"\"\"\n1,2"), [["a", "b,\"c\""], ["1", "2"]]);

  const xls = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
  assert.throws(() => parseResultsFile(xls), /save it as \.xlsx or \.csv/);
});

test("masked phones match on the digits they show", () => {
  assert.equal(phoneMatches("2547*****001", "254711000001"), true);
  assert.equal(phoneMatches("0711000001", "254711000001"), true);
  assert.equal(phoneMatches("2547*****002", "254711000001"), false);
  assert.equal(phoneMatches("2547********", "254711000001"), false, "too little visible");
  assert.equal(phoneMatches("", "254711000001"), false);
});

// ---------------------------------------------------------------- matching ---

const LINES: BatchLineForMatch[] = [
  { id: "l1", reference: "PB7K3Q9M-01", phone: "254711000001", amountKsh: 1250, status: "PENDING", mpesaCode: null },
  { id: "l2", reference: "PB7K3Q9M-02", phone: "254722000001", amountKsh: 300, status: "PENDING", mpesaCode: null },
  { id: "l3", reference: "PB7K3Q9M-03", phone: "254733000001", amountKsh: 100, status: "PENDING", mpesaCode: null }
];

function result(over: Partial<ReturnType<typeof parseResultCells>[number]>) {
  return { fileRow: 2, receipt: null, receiptText: "", phone: "", amountKsh: null, status: "SUCCESS" as const, statusText: "Completed", reference: "", completedAt: "", reason: "", lineReference: null, ...over };
}

test("rows match by our reference first, then by phone and amount", () => {
  const decisions = matchResults([
    result({ fileRow: 2, receipt: "SJK3ABC12X", amountKsh: 1250, lineReference: "PB7K3Q9M-01" }),
    result({ fileRow: 3, receipt: "TJK3ABC12X", amountKsh: 300, phone: "0722000001" }),
    result({ fileRow: 4, status: "FAILED", statusText: "Failed", reason: "Invalid MSISDN", amountKsh: 100, lineReference: "PB7K3Q9M-03" })
  ], LINES, BATCH);
  assert.deepEqual(decisions.map((d) => [d.result.fileRow, d.outcome, d.lineId, d.matchedBy]), [
    [2, "PAY", "l1", "reference"],
    [3, "PAY", "l2", "phone_amount"],
    [4, "FAILED", "l3", "reference"]
  ]);
});

test("anything that cannot be tied safely to one person is unmatched, with a reason", () => {
  const twins: BatchLineForMatch[] = [
    { id: "t1", reference: "PB7K3Q9M-01", phone: "254711000001", amountKsh: 500, status: "PENDING", mpesaCode: null },
    { id: "t2", reference: "PB7K3Q9M-02", phone: "254711000001", amountKsh: 500, status: "PENDING", mpesaCode: null }
  ];
  assert.equal(matchResults([result({ receipt: "SJK3ABC12X", amountKsh: 500, phone: "0711000001" })], twins, BATCH)[0].reason, "AMBIGUOUS");

  const decisions = matchResults([
    result({ fileRow: 2, receipt: "AAAAAAAAA1", amountKsh: 999, phone: "0799000009" }),
    result({ fileRow: 3, receipt: "BBBBBBBBB1", amountKsh: 1250, lineReference: "PBZZZZZZ-01" }),
    result({ fileRow: 4, receipt: "CCCCCCCCC1", amountKsh: 1200, lineReference: "PB7K3Q9M-01" }),
    result({ fileRow: 5, receipt: null, receiptText: "n/a", amountKsh: 300, lineReference: "PB7K3Q9M-02" }),
    result({ fileRow: 6, status: "UNKNOWN", statusText: "Queued", amountKsh: 100, lineReference: "PB7K3Q9M-03" }),
    result({ fileRow: 7, receipt: "DDDDDDDDD1", amountKsh: 100, lineReference: "PB7K3Q9M-09" })
  ], LINES, BATCH);
  assert.deepEqual(decisions.map((d) => [d.result.fileRow, d.outcome, d.reason]), [
    [2, "UNMATCHED", "NO_MATCH"],
    [3, "UNMATCHED", "OTHER_BATCH"],
    [4, "UNMATCHED", "AMOUNT_MISMATCH"],
    [5, "UNMATCHED", "NO_RECEIPT"],
    [6, "UNMATCHED", "UNKNOWN_STATUS"],
    [7, "UNMATCHED", "NO_MATCH"]
  ]);
});

test("duplicates: the same row twice is ignored, two different successes for one person are flagged", () => {
  const same = matchResults([
    result({ fileRow: 2, receipt: "SJK3ABC12X", amountKsh: 1250, lineReference: "PB7K3Q9M-01" }),
    result({ fileRow: 3, receipt: "SJK3ABC12X", amountKsh: 1250, lineReference: "PB7K3Q9M-01" })
  ], LINES, BATCH);
  assert.deepEqual(same.map((d) => d.outcome), ["PAY", "DUPLICATE"]);

  const twice = matchResults([
    result({ fileRow: 2, receipt: "SJK3ABC12X", amountKsh: 1250, lineReference: "PB7K3Q9M-01" }),
    result({ fileRow: 3, receipt: "SJK3ABC12Y", amountKsh: 1250, lineReference: "PB7K3Q9M-01" })
  ], LINES, BATCH);
  assert.deepEqual(twice.map((d) => [d.outcome, d.reason]), [["PAY", null], ["UNMATCHED", "DUPLICATE_SUCCESS"]]);

  const reused = matchResults([
    result({ fileRow: 2, receipt: "SJK3ABC12X", amountKsh: 1250, lineReference: "PB7K3Q9M-01" }),
    result({ fileRow: 3, receipt: "SJK3ABC12X", amountKsh: 300, lineReference: "PB7K3Q9M-02" })
  ], LINES, BATCH);
  assert.deepEqual(reused.map((d) => [d.outcome, d.reason]), [["PAY", null], ["UNMATCHED", "RECEIPT_REUSED"]]);

  // A failure and a later successful retry for the same person: paid, once.
  const retried = matchResults([
    result({ fileRow: 2, status: "FAILED", statusText: "Failed", amountKsh: 300, lineReference: "PB7K3Q9M-02" }),
    result({ fileRow: 3, receipt: "TJK3ABC12X", amountKsh: 300, lineReference: "PB7K3Q9M-02" })
  ], LINES, BATCH);
  assert.deepEqual(retried.map((d) => d.outcome), ["DUPLICATE", "PAY"]);
});

test("a person already paid from an earlier upload is not paid again", () => {
  const settled: BatchLineForMatch[] = [
    { ...LINES[0], status: "PAID", mpesaCode: "SJK3ABC12X" },
    { ...LINES[1], status: "FAILED" },
    { ...LINES[2], status: "CANCELLED" }
  ];
  const decisions = matchResults([
    result({ fileRow: 2, receipt: "SJK3ABC12X", amountKsh: 1250, lineReference: "PB7K3Q9M-01" }),
    result({ fileRow: 3, receipt: "ZZZ3ABC12X", amountKsh: 1250, phone: "0711000001" }),
    result({ fileRow: 4, status: "FAILED", statusText: "Failed", amountKsh: 300, lineReference: "PB7K3Q9M-02" }),
    result({ fileRow: 5, receipt: "QJK3ABC12X", amountKsh: 100, lineReference: "PB7K3Q9M-03" })
  ], settled, BATCH);
  assert.deepEqual(decisions.map((d) => [d.outcome, d.reason]), [
    ["ALREADY_PAID", null],
    ["UNMATCHED", "DUPLICATE_SUCCESS"],
    ["FAILED", null],
    ["UNMATCHED", "LINE_CANCELLED"]
  ]);
});
