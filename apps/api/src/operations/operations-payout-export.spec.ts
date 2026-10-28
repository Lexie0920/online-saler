import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPayoutList,
  payoutListFileName,
  phoneNote,
  weekLabel,
  type ExportItem,
  type PayoutListLine
} from "./operations-payout-export";

// Wednesday 28 Oct 2026, 10:00 in Nairobi.
const NOW = new Date("2026-10-28T07:00:00.000Z");

function item(partial: Partial<ExportItem>): ExportItem {
  return {
    payeeKey: "affiliate:a1",
    name: "Faith Njeri",
    phone: "0717834529",
    orderNumber: "DL-1",
    confirmedAt: new Date("2026-10-21T09:00:00.000Z"),
    amountKsh: 100,
    ...partial
  };
}

const OCT_12 = new Date("2026-10-14T09:00:00.000Z");
const OCT_19 = new Date("2026-10-21T09:00:00.000Z");

test("the file is named after today in Nairobi, and is an .xlsx", () => {
  assert.equal(payoutListFileName(NOW), "payout-list-2026-10-28.xlsx");
  // 22:00 UTC on the 27th is already the 28th in Nairobi.
  assert.equal(payoutListFileName(new Date("2026-10-27T22:00:00.000Z")), "payout-list-2026-10-28.xlsx");
});

test("a week reads 12 Oct–18 Oct, and carries the year only when it is not this year", () => {
  assert.equal(weekLabel(OCT_12, NOW), "12 Oct–18 Oct");
  // A week that runs over New Year says the year it ends in.
  assert.equal(weekLabel(new Date("2025-12-31T09:00:00.000Z"), NOW), "29 Dec–4 Jan 2026");
  assert.equal(weekLabel(new Date("2025-11-12T09:00:00.000Z"), NOW), "10 Nov–16 Nov 2025");
  assert.equal(weekLabel(null, NOW), "");
});

test("a Sunday night in Kenya belongs to that Sunday's week, not Monday's", () => {
  // 21:30 UTC on Sunday 18 Oct is 00:30 on Monday 19 Oct in Nairobi.
  assert.equal(weekLabel(new Date("2026-10-18T21:30:00.000Z"), NOW), "19 Oct–25 Oct");
  assert.equal(weekLabel(new Date("2026-10-18T20:30:00.000Z"), NOW), "12 Oct–18 Oct");
});

test("phone notes are in English, and a usable number has none", () => {
  assert.equal(phoneNote("0717834529"), "");
  assert.equal(phoneNote("+254 717 834 529"), "");
  assert.equal(phoneNote(null), "No phone number");
  assert.equal(phoneNote("  "), "No phone number");
  assert.equal(phoneNote("12345"), "Phone is not a valid M-Pesa number");
});

test("nothing owed gives an empty list with no total line", () => {
  const list = buildPayoutList([], false, NOW);
  assert.deepEqual(list.lines, []);
  assert.deepEqual(list.summary, { people: 0, rows: 0, orders: 0, amountKsh: 0, phoneProblems: 0, truncated: false });
});

test("orders of one promoter in one week become one row", () => {
  const list = buildPayoutList([item({ amountKsh: 100, orderNumber: "DL-1" }), item({ amountKsh: 250, orderNumber: "DL-2" })], false, NOW);
  assert.deepEqual(list.lines, [
    { kind: "item", block: null, promoter: "Faith Njeri", phone: "254717834529", week: "19 Oct–25 Oct", orders: 2, amountKsh: 350, note: "" },
    { kind: "total", people: 1, orders: 2, amountKsh: 350 }
  ]);
});

test("a promoter owed for two weeks gets two rows, a colour block and a subtotal; one-row promoters stay plain", () => {
  const list = buildPayoutList(
    [
      item({ payeeKey: "affiliate:g", name: "Grace Wanjiru", phone: "0712000101", confirmedAt: OCT_19, amountKsh: 1200, orderNumber: "DL-5" }),
      item({ payeeKey: "affiliate:g", name: "Grace Wanjiru", phone: "0712000101", confirmedAt: OCT_12, amountKsh: 900, orderNumber: "DL-4" }),
      item({ payeeKey: "affiliate:a", name: "Amina Otieno", phone: "0712000103", confirmedAt: OCT_19, amountKsh: 1200, orderNumber: "DL-6" }),
      item({ payeeKey: "affiliate:f", name: "Faith Njeri", phone: "0712000102", confirmedAt: OCT_12, amountKsh: 500, orderNumber: "DL-7" }),
      item({ payeeKey: "affiliate:f", name: "Faith Njeri", phone: "0712000102", confirmedAt: OCT_19, amountKsh: 1303, orderNumber: "DL-8" }),
      item({ payeeKey: "affiliate:k", name: "Kamau Mwangi", phone: null, confirmedAt: OCT_12, amountKsh: 600, orderNumber: "DL-9" })
    ],
    false,
    NOW
  );
  const shape = list.lines.map((line) =>
    line.kind === "item" ? `${line.promoter} | ${line.week} | ${line.amountKsh} | block ${line.block}`
      : line.kind === "subtotal" ? `SUBTOTAL ${line.promoter} | ${line.orders} | ${line.amountKsh} | block ${line.block} | ${line.note}`
        : `TOTAL ${line.people} people | ${line.orders} | ${line.amountKsh}`
  );
  assert.deepEqual(shape, [
    "Amina Otieno | 19 Oct–25 Oct | 1200 | block null",
    "Faith Njeri | 12 Oct–18 Oct | 500 | block 0",
    "Faith Njeri | 19 Oct–25 Oct | 1303 | block 0",
    "SUBTOTAL Faith Njeri | 2 | 1803 | block 0 | Send KSh 1,803",
    "Grace Wanjiru | 12 Oct–18 Oct | 900 | block 1",
    "Grace Wanjiru | 19 Oct–25 Oct | 1200 | block 1",
    "SUBTOTAL Grace Wanjiru | 2 | 2100 | block 1 | Send KSh 2,100",
    "Kamau Mwangi | 12 Oct–18 Oct | 600 | block null",
    "TOTAL 4 people | 6 | 5703"
  ]);
  assert.deepEqual(list.summary, { people: 4, rows: 6, orders: 6, amountKsh: 5703, phoneProblems: 1, truncated: false });
  const kamau = list.lines.find((line): line is Extract<PayoutListLine, { kind: "item" }> => line.kind === "item" && line.promoter === "Kamau Mwangi");
  assert.equal(kamau?.note, "No phone number");
  assert.equal(kamau?.phone, "");
});

test("two different promoters with the same name are not merged", () => {
  const list = buildPayoutList(
    [
      item({ payeeKey: "affiliate:1", name: "Faith Njeri", phone: "0712000001", amountKsh: 100 }),
      item({ payeeKey: "affiliate:2", name: "Faith Njeri", phone: "0712000002", amountKsh: 200 })
    ],
    false,
    NOW
  );
  assert.equal(list.summary.people, 2);
  assert.equal(list.lines.filter((line) => line.kind === "item").length, 2);
  assert.equal(list.lines.filter((line) => line.kind === "subtotal").length, 0);
});

test("a promoter whose phone is only on one order still shows it on every row", () => {
  const list = buildPayoutList(
    [item({ phone: null, confirmedAt: OCT_12 }), item({ phone: "0717834529", confirmedAt: OCT_19 })],
    false,
    NOW
  );
  const rows = list.lines.filter((line): line is Extract<PayoutListLine, { kind: "item" }> => line.kind === "item");
  assert.deepEqual(rows.map((row) => [row.phone, row.note]), [["254717834529", ""], ["254717834529", ""]]);
  assert.equal(list.summary.phoneProblems, 0);
});

test("the truncation flag is passed on so the page can warn", () => {
  assert.equal(buildPayoutList([item({})], true, NOW).summary.truncated, true);
});

test("a name that looks like a spreadsheet formula is only text in the list", () => {
  const list = buildPayoutList([item({ name: "=HYPERLINK(\"http://x\")" })], false, NOW);
  const row = list.lines[0];
  assert.equal(row?.kind === "item" ? row.promoter : "", "=HYPERLINK(\"http://x\")");
});
