import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildExportRows,
  exportCsv,
  exportCsvCell,
  exportFileName,
  parseExportOptions,
  summarizeExport,
  type ExportItem
} from "./operations-payout-export";

const NOW = new Date("2026-10-25T10:00:00.000Z");

function item(partial: Partial<ExportItem>): ExportItem {
  return {
    status: "pending",
    kind: "COMMISSION",
    payeeKey: "affiliate:a1",
    payeeType: "AFFILIATE",
    name: "Faith",
    phone: "254717834529",
    orderNumber: "DL-1",
    orderDate: new Date("2026-10-05T08:00:00.000Z"),
    attributedAt: new Date("2026-10-14T09:00:00.000Z"),
    amountKsh: 100,
    payoutId: null,
    paidAt: null,
    mpesaCode: null,
    ...partial
  };
}

test("defaults to last week, unpaid, promoters and riders, one line per person", () => {
  const options = parseExportOptions({}, NOW);
  assert.equal(options.scope, "week");
  assert.equal(options.status, "pending");
  assert.equal(options.format, "summary");
  assert.equal(options.includeAffiliate && options.includeRider, true);
  // Today is Sunday 25 Oct (Nairobi); last finished week is Mon 12 – Sun 18 Oct.
  assert.equal(options.start?.toISOString(), "2026-10-11T21:00:00.000Z");
  assert.equal(options.end?.toISOString(), "2026-10-18T21:00:00.000Z");
  assert.equal(exportFileName(options), "payouts-pending-summary-2026-10-12_2026-10-18.csv");
});

test("a date range is whole Nairobi days, both ends included", () => {
  const options = parseExportOptions({ scope: "range", from: "2026-09-25", to: "2026-10-25" }, NOW);
  assert.equal(options.start?.toISOString(), "2026-09-24T21:00:00.000Z");
  assert.equal(options.end?.toISOString(), "2026-10-25T21:00:00.000Z");
  assert.equal(options.label, "2026-09-25_2026-10-25");
});

test("all has no window and earlier ends where the chosen week starts", () => {
  const all = parseExportOptions({ scope: "all" }, NOW);
  assert.equal(all.start, null);
  assert.equal(all.end, null);
  assert.equal(all.label, "all-2026-10-25");
  const earlier = parseExportOptions({ scope: "earlier", week: "2026-10-14" }, NOW);
  assert.equal(earlier.start, null);
  assert.equal(earlier.end?.toISOString(), "2026-10-11T21:00:00.000Z");
});

test("refuses choices it cannot honour instead of replacing them", () => {
  assert.throws(() => parseExportOptions({ scope: "month" }, NOW), /scope/);
  assert.throws(() => parseExportOptions({ status: "done" }, NOW), /status/);
  assert.throws(() => parseExportOptions({ format: "xlsx" }, NOW), /format/);
  assert.throws(() => parseExportOptions({ include: "boss" }, NOW), /include/);
  assert.throws(() => parseExportOptions({ include: " , " }, NOW), /Choose/);
  assert.throws(() => parseExportOptions({ scope: "range", from: "2026-10-05" }, NOW), /to must/);
  assert.throws(() => parseExportOptions({ scope: "range", from: "2026-10-30", to: "2026-10-05" }, NOW), /not be after/);
  assert.throws(() => parseExportOptions({ scope: "range", from: "2026-02-31", to: "2026-03-05" }, NOW), /real calendar date/);
});

test("summary: one line per person per week, unpaid first, oldest week first, bigger amount first", () => {
  const items = [
    item({ payeeKey: "affiliate:a2", name: "Grace", phone: "254723456789", amountKsh: 50, orderNumber: "DL-2" }),
    item({ amountKsh: 100, orderNumber: "DL-1" }),
    item({ amountKsh: 200, orderNumber: "DL-3" }),
    item({ payeeKey: "affiliate:a1", attributedAt: new Date("2026-10-06T09:00:00.000Z"), amountKsh: 70, orderNumber: "DL-0" }),
    item({ status: "paid", payeeKey: "affiliate:a3", name: "Esther", payoutId: "p1", mpesaCode: "SJK3ABC12X", paidAt: new Date("2026-10-20T09:00:00.000Z"), amountKsh: 300, orderNumber: "DL-9" })
  ];
  const { header, rows } = buildExportRows(items, "summary");
  assert.equal(header.length, rows[0]!.length);
  assert.deepEqual(rows.map((row) => [row[0], row[2], row[4], row[5], row[6]]), [
    ["待付", "Faith", 1, 70, "2026-10-05~2026-10-11"],
    ["待付", "Faith", 2, 300, "2026-10-12~2026-10-18"],
    ["待付", "Grace", 1, 50, "2026-10-12~2026-10-18"],
    ["已付", "Esther", 1, 300, "2026-10-12~2026-10-18"]
  ]);
  const paid = rows[3]!;
  assert.equal(paid[7], "2026-10-20");
  assert.equal(paid[8], "SJK3ABC12X");
});

test("a person with no phone, or a phone M-Pesa cannot use, is flagged on unpaid lines only", () => {
  const { rows } = buildExportRows([
    item({ payeeKey: "affiliate:a1", name: "NoPhone", phone: null }),
    item({ payeeKey: "affiliate:a2", name: "BadPhone", phone: "12345" }),
    item({ payeeKey: "affiliate:a3", name: "Fine" }),
    item({ status: "paid", payeeKey: "affiliate:a4", name: "PaidNoPhone", phone: null, payoutId: "p", mpesaCode: "SJK3ABC12X", paidAt: new Date("2026-10-20T09:00:00.000Z") })
  ], "summary");
  const notes = Object.fromEntries(rows.map((row) => [row[2], row[9]]));
  assert.equal(notes.NoPhone, "没有手机号");
  assert.equal(notes.BadPhone, "手机号不是有效的 M-Pesa 号码");
  assert.equal(notes.Fine, "");
  assert.equal(notes.PaidNoPhone, "");
});

test("detail: one line per order with order date, attributed date and week", () => {
  const { header, rows } = buildExportRows([item({ kind: "RIDER_FEE", payeeType: "RIDER", payeeKey: "rider:r1", name: "Kamau", amountKsh: 150, orderNumber: "DL-7" })], "detail");
  assert.equal(header.length, rows[0]!.length);
  assert.deepEqual(rows[0], ["待付", "骑手", "Kamau", "254717834529", "DL-7", "2026-10-05", "2026-10-14", "2026-10-12~2026-10-18", 150, "", null, ""]);
});

test("the Nairobi day is used, not the UTC day, for dates and weeks", () => {
  // 22:30 UTC on Sunday 18 Oct is 01:30 Monday 19 Oct in Nairobi: next week.
  const { rows } = buildExportRows([item({ attributedAt: new Date("2026-10-18T22:30:00.000Z") })], "detail");
  assert.equal(rows[0]![6], "2026-10-19");
  assert.equal(rows[0]![7], "2026-10-19~2026-10-25");
});

test("summary counts people once, even across weeks, and counts people without a phone", () => {
  const summary = summarizeExport([
    item({ amountKsh: 100 }),
    item({ attributedAt: new Date("2026-10-06T09:00:00.000Z"), amountKsh: 50 }),
    item({ payeeKey: "affiliate:a2", name: "NoPhone", phone: null, amountKsh: 25 }),
    item({ kind: "RIDER_FEE", payeeType: "RIDER", payeeKey: "rider:r1", name: "Kamau", amountKsh: 10 })
  ], false);
  assert.deepEqual(summary, {
    people: 3,
    affiliatePeople: 2,
    riderPeople: 1,
    amountKsh: 185,
    itemCount: 4,
    missingPhonePeople: 1,
    truncated: false
  });
});

test("csv: quotes where needed, defuses formulas, leaves phone numbers alone", () => {
  assert.equal(exportCsvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
  assert.equal(exportCsvCell("+254717834529"), "+254717834529");
  assert.equal(exportCsvCell("-cmd"), "'-cmd");
  assert.equal(exportCsvCell('say "hi", ok'), '"say ""hi"", ok"');
  assert.equal(exportCsvCell(null), "");
  assert.equal(exportCsv(["a", "b"], [["x", 1]]), "a,b\nx,1\n");
});
