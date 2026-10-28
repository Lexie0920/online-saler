import JSZip from "jszip";

/**
 * The payment list as an Excel file (.xlsx).
 *
 * A .csv cannot hold colours or bold rows, and the list needs both: a promoter owed for more than
 * one week gets a colour block and a bold subtotal. An .xlsx opens in Excel, Google Sheets and
 * Numbers with them kept. It is a zip of a few XML files, written here with jszip (already a
 * dependency) so no spreadsheet library is added. Text goes in as plain text, so a name that
 * starts with "=" is never read as a formula.
 */

/** The lines the API sends (apps/api payout export), in the shape this file needs. */
export type PayoutListLine =
  | { kind: "item"; block: 0 | 1 | null; promoter: string; phone: string; week: string; orders: number; amountKsh: number; note: string }
  | { kind: "subtotal"; block: 0 | 1; promoter: string; orders: number; amountKsh: number; note: string }
  | { kind: "total"; people: number; orders: number; amountKsh: number };

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const PAYOUT_LIST_HEADER = ["Promoter", "Phone", "Week", "Orders", "Amount (KSh)", "Note"] as const;
const COLUMN_WIDTHS = [28, 16, 22, 9, 15, 34];

// Fills, in the order they are written into styles.xml (0 and 1 are fixed by the format).
const FILL = {
  none: 0,
  header: 2,
  blue: 3,
  yellow: 4,
  blueDark: 5,
  yellowDark: 6,
  total: 7
} as const;
const FILL_COLOURS = ["E7E6E6", "EAF1FB", "FFF4CC", "C9DCF5", "FBE49A", "D9D9D9"];

type StyleKey = { fill: number; bold: boolean; number: boolean; border: 0 | 1 | 2 };

/** Hands out one cell format per distinct look and remembers it. */
class Styles {
  private readonly list: StyleKey[] = [];
  private readonly index = new Map<string, number>();

  constructor() {
    this.use({ fill: FILL.none, bold: false, number: false, border: 0 });
  }

  use(key: StyleKey): number {
    const id = `${key.fill}|${key.bold}|${key.number}|${key.border}`;
    const found = this.index.get(id);
    if (found !== undefined) return found;
    this.list.push(key);
    this.index.set(id, this.list.length - 1);
    return this.list.length - 1;
  }

  xml(): string {
    const fills = [
      `<fill><patternFill patternType="none"/></fill>`,
      `<fill><patternFill patternType="gray125"/></fill>`,
      ...FILL_COLOURS.map((rgb) => `<fill><patternFill patternType="solid"><fgColor rgb="FF${rgb}"/><bgColor indexed="64"/></patternFill></fill>`)
    ];
    const xfs = this.list.map((style) =>
      `<xf numFmtId="${style.number ? 3 : 0}" fontId="${style.bold ? 1 : 0}" fillId="${style.fill}" borderId="${style.border}" xfId="0"` +
      `${style.number ? ' applyNumberFormat="1"' : ""} applyFont="1" applyFill="1" applyBorder="1"/>`
    );
    return (
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
      `<fills count="${fills.length}">${fills.join("")}</fills>` +
      `<borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border>` +
      `<border><left/><right/><top/><bottom style="thin"><color auto="1"/></bottom><diagonal/></border>` +
      `<border><left/><right/><top style="thin"><color auto="1"/></top><bottom/><diagonal/></border></borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `<cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs>` +
      `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
      `</styleSheet>`
    );
  }
}

function escapeXml(value: string): string {
  return value
    // Characters XML 1.0 cannot carry would make Excel refuse the file.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function columnLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

type Cell = string | number | null;

const NUMBER_COLUMNS = [3, 4];

/** One row: text cells use `text`, the Orders and Amount columns use `numeric`. */
function rowXml(rowNumber: number, cells: Cell[], text: number, numeric: number): string {
  const body = cells
    .map((cell, column) => {
      const ref = `${columnLetter(column)}${rowNumber}`;
      const style = NUMBER_COLUMNS.includes(column) ? numeric : text;
      if (cell === null || cell === "") return `<c r="${ref}" s="${style}"/>`;
      if (typeof cell === "number") return `<c r="${ref}" s="${style}"><v>${cell}</v></c>`;
      return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell)}</t></is></c>`;
    })
    .join("");
  return `<row r="${rowNumber}">${body}</row>`;
}

/** The whole workbook as bytes. */
export async function buildPayoutListXlsx(lines: PayoutListLine[]): Promise<Uint8Array> {
  const styles = new Styles();
  const rows: string[] = [];

  const header = styles.use({ fill: FILL.header, bold: true, number: false, border: 1 });
  rows.push(rowXml(1, [...PAYOUT_LIST_HEADER], header, header));
  lines.forEach((line, offset) => {
    const rowNumber = offset + 2;
    let fill: number = FILL.none;
    let bold = false;
    let border: 0 | 1 | 2 = 0;
    let cells: Cell[];
    if (line.kind === "item") {
      fill = line.block === 0 ? FILL.blue : line.block === 1 ? FILL.yellow : FILL.none;
      cells = [line.promoter, line.phone, line.week, line.orders, line.amountKsh, line.note];
    } else if (line.kind === "subtotal") {
      fill = line.block === 0 ? FILL.blueDark : FILL.yellowDark;
      bold = true;
      cells = [`Subtotal · ${line.promoter}`, "", "", line.orders, line.amountKsh, line.note];
    } else {
      fill = FILL.total;
      bold = true;
      border = 2;
      cells = [`Total (${line.people} ${line.people === 1 ? "person" : "people"})`, "", "", line.orders, line.amountKsh, ""];
    }
    const text = styles.use({ fill, bold, number: false, border });
    const numeric = styles.use({ fill, bold, number: true, border });
    rows.push(rowXml(rowNumber, cells, text, numeric));
  });

  const lastRow = lines.length + 1;
  const sheet =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<dimension ref="A1:F${lastRow}"/>` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    `<cols>${COLUMN_WIDTHS.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join("")}</cols>` +
    `<sheetData>${rows.join("")}</sheetData>` +
    `</worksheet>`;

  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      `</Types>`
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`
  );
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets><sheet name="Payment list" sheetId="1" r:id="rId1"/></sheets></workbook>`
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
      `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `</Relationships>`
  );
  zip.file("xl/styles.xml", styles.xml());
  zip.file("xl/worksheets/sheet1.xml", sheet);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

/** Saves bytes as a file in the browser. Returns false when there was nothing to save. */
export function downloadBytes(fileName: string, bytes: Uint8Array, mimeType: string): boolean {
  if (!bytes.length) return false;
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  // Some browsers ignore a click on an anchor that is not in the page.
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}
