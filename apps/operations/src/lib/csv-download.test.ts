import assert from "node:assert/strict";
import { test } from "node:test";
import { CSV_BOM, csvCell, payoutListFileName, toCsv } from "./csv-download";

test("an empty list gives an empty string, so the page can say there is nothing to download", () => {
  assert.equal(toCsv([]), "");
});

test("the header comes from the first row and every cell is quoted", () => {
  const csv = toCsv([
    { affiliateName: "Amina", phone: "254712345678", commissionAmountKsh: 250 },
    { affiliateName: "Brian", phone: "254722000111", commissionAmountKsh: 75 }
  ]);
  assert.equal(
    csv,
    [
      "affiliateName,phone,commissionAmountKsh",
      '"Amina","254712345678","250"',
      '"Brian","254722000111","75"'
    ].join("\n")
  );
});

test("quotes and commas inside a value stay in one cell, and missing values are blank", () => {
  assert.equal(csvCell('Ann "Mama" Wanjiru, Kikuyu'), '"Ann ""Mama"" Wanjiru, Kikuyu"');
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(undefined), '""');
});

test("a name that Excel would run as a formula is turned into text", () => {
  assert.equal(csvCell("=HYPERLINK(\"http://example.com\")"), '"\'=HYPERLINK(""http://example.com"")"');
  assert.equal(csvCell("@SUM(A1)"), '"\'@SUM(A1)"');
  assert.equal(csvCell("+cmd|' /C calc'!A0"), '"\'+cmd|\' /C calc\'!A0"');
  assert.equal(csvCell("-2+3"), '"\'-2+3"');
});

test("phone numbers and amounts that start with a sign are left as they are", () => {
  assert.equal(csvCell("+254 712 345 678"), '"+254 712 345 678"');
  assert.equal(csvCell("-250"), '"-250"');
  assert.equal(csvCell(250), '"250"');
});

test("the byte-order mark is the three bytes Excel looks for", () => {
  assert.deepEqual([...Buffer.from(CSV_BOM, "utf8")], [0xef, 0xbb, 0xbf]);
});

test("the file name carries the Nairobi date, not the UTC one", () => {
  // 22:30 UTC on the 22nd is already 01:30 on the 23rd in Nairobi (UTC+3).
  assert.equal(payoutListFileName(new Date("2026-10-22T22:30:00Z")), "payout-list-2026-10-23.csv");
  assert.equal(payoutListFileName(new Date("2026-10-23T09:00:00Z")), "payout-list-2026-10-23.csv");
});

test("a chosen range is written into the file name", () => {
  assert.equal(payoutListFileName(new Date(), { from: "2026-10-01", to: "2026-10-07" }), "payout-list-2026-10-01_to_2026-10-07.csv");
  assert.equal(payoutListFileName(new Date(), { from: "2026-10-01" }), "payout-list-2026-10-01_to_latest.csv");
  assert.equal(payoutListFileName(new Date(), { to: "2026-10-07" }), "payout-list-start_to_2026-10-07.csv");
});
