import assert from "node:assert/strict";
import test from "node:test";
import {
  AFTER_SALES_EXPORT_HEADER,
  buildAfterSalesExport,
  parseAfterSalesExportOptions,
  type AfterSalesExportItem
} from "./operations-after-sales-export";

const NOW = new Date("2026-11-03T10:00:00Z");

function item(overrides: Partial<AfterSalesExportItem> = {}): AfterSalesExportItem {
  return {
    type: "RETURN",
    requestedAt: new Date("2026-11-01T09:00:00Z"),
    completedAt: null,
    orderNumber: "OS-1001",
    barcode: "B0001",
    title: "Blue shirt",
    reason: "NOT_SATISFIED",
    note: "too small",
    customerName: "Amina",
    customerPhone: "254700000001",
    returnStatus: "RECEIVED",
    itemPriceKsh: 400,
    refundRequestStatus: "APPROVED",
    refundApprovedKsh: 400,
    refundedKsh: 0,
    refundedAt: null,
    mpesaReference: null,
    requestedBy: "Faith",
    receivedBy: "Joseph",
    approvedBy: "Eric",
    photoCount: 3,
    ...overrides
  };
}

test("no dates means the last 30 Nairobi days, today included", () => {
  const options = parseAfterSalesExportOptions({}, NOW);
  assert.equal(options.firstDay, "2026-10-05");
  assert.equal(options.lastDay, "2026-11-03");
  assert.equal(options.filter, "all");
  assert.equal(options.end.toISOString(), "2026-11-03T21:00:00.000Z");
});

test("a bad filter, a half-given range or an impossible date is refused", () => {
  assert.throws(() => parseAfterSalesExportOptions({ filter: "paid" }, NOW), /filter/);
  assert.throws(() => parseAfterSalesExportOptions({ from: "2026-10-01" }, NOW), /both/);
  assert.throws(() => parseAfterSalesExportOptions({ from: "2026-10-05", to: "2026-10-01" }, NOW), /after/);
  assert.throws(() => parseAfterSalesExportOptions({ from: "2026-02-30", to: "2026-03-01" }, NOW), /real calendar date/);
});

test("every line has one cell per header, exchange columns empty", () => {
  const file = buildAfterSalesExport([item()], parseAfterSalesExportOptions({}, NOW), false);
  const lines = file.csv.trim().split("\n");
  assert.equal(lines[0].split(",").length, AFTER_SALES_EXPORT_HEADER.length);
  assert.equal(lines[1].split(",").length, AFTER_SALES_EXPORT_HEADER.length);
  assert.match(lines[1], /^Return,2026-11-01,,OS-1001,B0001,Blue shirt,NOT_SATISFIED,Amina,254700000001,/);
  assert.ok(lines[1].endsWith(",,,"));
});

test("to-refund keeps only approved refunds not yet paid out, and totals what is owed", () => {
  const items = [
    item(),
    item({ orderNumber: "OS-1002", refundRequestStatus: "PENDING_APPROVAL", refundApprovedKsh: 300 }),
    item({ orderNumber: "OS-1003", refundRequestStatus: "REFUNDED", refundedKsh: 250, refundApprovedKsh: 250 }),
    item({ orderNumber: "OS-1004", refundRequestStatus: null, refundApprovedKsh: null })
  ];
  const file = buildAfterSalesExport(items, parseAfterSalesExportOptions({ filter: "to-refund" }, NOW), false);
  assert.equal(file.lineCount, 1);
  assert.match(file.csv, /OS-1001/);
  assert.doesNotMatch(file.csv, /OS-1002|OS-1003|OS-1004/);
  assert.equal(file.summary.toRefundKsh, 400);
  const all = buildAfterSalesExport(items, parseAfterSalesExportOptions({}, NOW), false);
  assert.equal(all.lineCount, 4);
});

test("a customer-typed name that Excel would read as a formula is neutralised, and lines are oldest first", () => {
  const file = buildAfterSalesExport(
    [item({ orderNumber: "OS-2", requestedAt: new Date("2026-11-02T09:00:00Z"), customerName: "=HYPERLINK(\"x\")" }), item({ orderNumber: "OS-1" })],
    parseAfterSalesExportOptions({}, NOW),
    true
  );
  const lines = file.csv.trim().split("\n");
  assert.match(lines[1], /OS-1/);
  assert.match(lines[2], /'=HYPERLINK/);
  assert.equal(file.summary.truncated, true);
});
