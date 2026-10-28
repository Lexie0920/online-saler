import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";

import { PAYOUT_LIST_HEADER, buildPayoutListXlsx, type PayoutListLine } from "./payout-list-xlsx";

const LINES: PayoutListLine[] = [
  { kind: "item", block: null, promoter: "Amina Otieno", phone: "254712000103", week: "19 Oct–25 Oct", orders: 4, amountKsh: 1200, note: "" },
  { kind: "item", block: 0, promoter: "Faith Njeri", phone: "254712000102", week: "12 Oct–18 Oct", orders: 2, amountKsh: 500, note: "" },
  { kind: "item", block: 0, promoter: "Faith Njeri", phone: "254712000102", week: "19 Oct–25 Oct", orders: 4, amountKsh: 1303, note: "" },
  { kind: "subtotal", block: 0, promoter: "Faith Njeri", orders: 6, amountKsh: 1803, note: "Send KSh 1,803" },
  { kind: "item", block: null, promoter: "=HYPERLINK(\"http://x\") & <b>", phone: "", week: "12 Oct–18 Oct", orders: 2, amountKsh: 600, note: "No phone number" },
  { kind: "total", people: 3, orders: 12, amountKsh: 3603 }
];

async function open(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes);
  const read = async (name: string) => {
    const file = zip.file(name);
    assert.ok(file, `${name} is missing from the file`);
    return file.async("string");
  };
  return { zip, read };
}

test("the file is a zip with the parts Excel, Google Sheets and Numbers need", async () => {
  const bytes = await buildPayoutListXlsx(LINES);
  assert.ok(bytes.length > 500, "the file is not empty");
  // A zip starts with "PK".
  assert.equal(bytes[0], 0x50);
  assert.equal(bytes[1], 0x4b);
  const { zip } = await open(bytes);
  for (const name of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml"]) {
    assert.ok(zip.file(name), `${name} is missing`);
  }
});

test("the header row and every line are written, with numbers as numbers and text as text", async () => {
  const { read } = await open(await buildPayoutListXlsx(LINES));
  const sheet = await read("xl/worksheets/sheet1.xml");
  for (const heading of PAYOUT_LIST_HEADER) assert.ok(sheet.includes(`>${heading}</t>`), `heading ${heading}`);
  // Amount and Orders are numeric cells, so a column can be summed.
  assert.match(sheet, /<c r="E2" s="\d+"><v>1200<\/v><\/c>/);
  assert.match(sheet, /<c r="D3" s="\d+"><v>2<\/v><\/c>/);
  // The phone number stays text, so a leading digit is never dropped.
  assert.match(sheet, /<c r="B2" s="\d+" t="inlineStr"><is><t xml:space="preserve">254712000103<\/t><\/is><\/c>/);
  assert.ok(sheet.includes("Subtotal · Faith Njeri"));
  assert.ok(sheet.includes("Send KSh 1,803"));
  assert.ok(sheet.includes("Total (3 people)"));
  assert.match(sheet, /<c r="E7" s="\d+"><v>3603<\/v><\/c>/);
  assert.ok(sheet.includes('<dimension ref="A1:F7"/>'));
});

test("a name that looks like a formula or like markup is written as plain, escaped text", async () => {
  const { read } = await open(await buildPayoutListXlsx(LINES));
  const sheet = await read("xl/worksheets/sheet1.xml");
  assert.ok(sheet.includes("=HYPERLINK(&quot;http://x&quot;) &amp; &lt;b&gt;"));
  assert.ok(!sheet.includes("<f>"), "no formula cell is written");
});

test("promoters with one row are white, colour blocks alternate, subtotal and total are bold", async () => {
  const { read } = await open(await buildPayoutListXlsx(LINES));
  const styles = await read("xl/styles.xml");
  const sheet = await read("xl/worksheets/sheet1.xml");
  const xfs = [...styles.matchAll(/<xf numFmtId="(\d+)" fontId="(\d+)" fillId="(\d+)" borderId="(\d+)"/g)].slice(1).map((m) => ({
    number: m[1] === "3",
    bold: m[2] === "1",
    fill: Number(m[3]),
    border: Number(m[4])
  }));
  const styleOf = (ref: string) => {
    const match = new RegExp(`<c r="${ref}" s="(\\d+)"`).exec(sheet);
    assert.ok(match, `cell ${ref} not found`);
    // cellXfs starts after the single cellStyleXfs entry that the slice above dropped.
    return xfs[Number(match[1])];
  };
  assert.equal(styleOf("A2")?.fill, 0, "a single-row promoter has no fill");
  assert.equal(styleOf("A3")?.fill, 3, "first colour block is blue");
  assert.equal(styleOf("A4")?.fill, 3);
  assert.equal(styleOf("A5")?.fill, 5, "its subtotal is the darker blue");
  assert.equal(styleOf("A5")?.bold, true);
  assert.equal(styleOf("A6")?.fill, 0, "another single-row promoter is white again");
  assert.equal(styleOf("E7")?.bold, true);
  assert.equal(styleOf("E7")?.number, true, "amounts are shown with thousands separators");
  assert.equal(styleOf("A1")?.bold, true, "the header is bold");
});

test("an empty list still produces a valid file with only the header", async () => {
  const { read } = await open(await buildPayoutListXlsx([]));
  const sheet = await read("xl/worksheets/sheet1.xml");
  assert.ok(sheet.includes('<dimension ref="A1:F1"/>'));
});
