import { inflateRawSync } from "node:zlib";

/**
 * The smallest XLSX reader and writer the M-Pesa bulk payout files need: one
 * sheet of plain text and numbers, no styles, no formulas. Kept dependency-free
 * on purpose (no spreadsheet library in the API) and kept away from the column
 * layout, which lives in mpesa-bulk-format.ts.
 *
 * The writer stores text as inline-string cells (and can format whole columns
 * as Text "@"), so Excel never turns a phone number like 2547XXXXXXXX into
 * 2.54712E+11 or drops a leading zero.
 */

export type SheetCells = string[][];

// ------------------------------------------------------------------ zip ---

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A zip with every entry stored (no compression): small files, no zlib needed to read them back. */
function zipStore(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(0, 10); // time/date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + entry.data.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

/** Every file in a zip, by name. Stored and deflated entries only (what Excel writes). */
function unzip(buffer: Buffer): Map<string, Buffer> {
  let endAt = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65535); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { endAt = i; break; }
  }
  if (endAt < 0) throw new Error("This is not an .xlsx file.");
  const count = buffer.readUInt16LE(endAt + 10);
  let at = buffer.readUInt32LE(endAt + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error("The .xlsx file is damaged.");
    const method = buffer.readUInt16LE(at + 10);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localAt = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const dataAt = localAt + 30 + buffer.readUInt16LE(localAt + 26) + buffer.readUInt16LE(localAt + 28);
    const raw = buffer.subarray(dataAt, dataAt + compressedSize);
    if (method === 0) files.set(name, Buffer.from(raw));
    else if (method === 8) files.set(name, inflateRawSync(raw));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

// ------------------------------------------------------------------ xml ---

function escapeXml(text: string): string {
  return text
    // Characters XML 1.0 cannot carry at all.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function unescapeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

/** The text of every <t> inside a fragment (a shared string or an inline string may be split in runs). */
function textOf(fragment: string): string {
  let text = "";
  for (const match of fragment.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) text += unescapeXml(match[1]);
  return text;
}

/** "AB12" → 27 (0-based column index). */
function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

function columnName(index: number): string {
  let name = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

// --------------------------------------------------------------- public ---

export type XlsxCell = string | number | null;
export type XlsxColumnStyle = "general" | "text" | "accounting";

/** Excel's accounting format, as in the M-Pesa B2C bulk template. */
export const ACCOUNTING_FORMAT = '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)';

export type XlsxSheet = {
  sheetName?: string;
  /** Per column: number format applied to the whole column, and width in characters. */
  columns?: Array<{ style?: XlsxColumnStyle; width?: number }>;
  rows: XlsxCell[][];
  /** In-cell dropdown lists, e.g. { range: "B2:B1000", list: ["Passport"] }. */
  validations?: Array<{ range: string; list: string[] }>;
};

const STYLE_INDEX: Record<XlsxColumnStyle, number> = { general: 0, text: 1, accounting: 2 };

/**
 * One sheet as an .xlsx file. Strings are inline-string cells and numbers are
 * number cells; a column marked "text" is formatted "@" so a phone number typed
 * into it later also stays text.
 */
export function writeXlsx(input: XlsxSheet | SheetCells, legacySheetName = "Sheet1"): Buffer {
  const sheet: XlsxSheet = Array.isArray(input) ? { rows: input, sheetName: legacySheetName } : input;
  const columns = sheet.columns ?? [];
  const styleOf = (c: number) => STYLE_INDEX[columns[c]?.style ?? "general"];
  const sheetRows = sheet.rows.map((row, r) => {
    const cells = row.map((value, c) => {
      const ref = `${columnName(c)}${r + 1}`;
      const style = styleOf(c) ? ` s="${styleOf(c)}"` : "";
      if (value === null || value === undefined || value === "") return style ? `<c r="${ref}"${style}/>` : "";
      if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}"${style}><v>${value}</v></c>`;
      return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(value))}</t></is></c>`;
    }).join("");
    return `<row r="${r + 1}">${cells}</row>`;
  }).join("");
  const cols = columns.length
    ? `<cols>${columns.map((column, c) => `<col min="${c + 1}" max="${c + 1}" width="${column.width ?? 14}" customWidth="1"${styleOf(c) ? ` style="${styleOf(c)}"` : ""}/>`).join("")}</cols>`
    : "";
  const validations = sheet.validations?.length
    ? `<dataValidations count="${sheet.validations.length}">${sheet.validations.map((v) =>
      `<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="${escapeXml(v.range)}"><formula1>${escapeXml(`"${v.list.join(",")}"`)}</formula1></dataValidation>`).join("")}</dataValidations>`
    : "";
  const xml = (body: string) => Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`, "utf8");
  const styles = `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="${escapeXml(ACCOUNTING_FORMAT)}"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  return zipStore([
    { name: "[Content_Types].xml", data: xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>') },
    { name: "_rels/.rels", data: xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') },
    { name: "xl/workbook.xml", data: xml(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escapeXml((sheet.sheetName ?? "Sheet1").slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
    { name: "xl/_rels/workbook.xml.rels", data: xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>') },
    { name: "xl/styles.xml", data: xml(styles) },
    { name: "xl/worksheets/sheet1.xml", data: xml(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${sheetRows}</sheetData>${validations}</worksheet>`) }
  ]);
}

/** The styles a written or read sheet gives each cell (for tests): "A2" → numFmt id. */
export function readXlsxCellStyles(buffer: Buffer): Map<string, { numFmtId: number; type: string | null }> {
  const files = unzip(buffer);
  const styles = files.get("xl/styles.xml")?.toString("utf8") ?? "";
  const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? "";
  const formats = [...xfs.matchAll(/<xf\b[^>]*numFmtId="(\d+)"/g)].map((m) => Number(m[1]));
  const sheet = files.get("xl/worksheets/sheet1.xml")?.toString("utf8") ?? "";
  const result = new Map<string, { numFmtId: number; type: string | null }>();
  for (const cell of sheet.matchAll(/<c\b([^>]*?)(?:\/>|>)/g)) {
    const ref = /\br="([A-Z]+\d+)"/.exec(cell[1])?.[1];
    if (!ref) continue;
    const s = Number(/\bs="(\d+)"/.exec(cell[1])?.[1] ?? 0);
    result.set(ref, { numFmtId: formats[s] ?? 0, type: /\bt="([^"]+)"/.exec(cell[1])?.[1] ?? null });
  }
  return result;
}

/** Raw XML of a part inside an .xlsx (for tests). */
export function readXlsxPart(buffer: Buffer, name: string): string | null {
  return unzip(buffer).get(name)?.toString("utf8") ?? null;
}

/** The first sheet of an .xlsx file as rows of text. Numbers come back as Excel stored them. */
export function readXlsx(buffer: Buffer): SheetCells {
  const files = unzip(buffer);
  const shared: string[] = [];
  const sharedXml = files.get("xl/sharedStrings.xml")?.toString("utf8");
  if (sharedXml) for (const match of sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textOf(match[1]));

  // The first sheet in workbook order, through its relationship; fall back to sheet1.xml.
  let sheetPath = "xl/worksheets/sheet1.xml";
  const workbook = files.get("xl/workbook.xml")?.toString("utf8");
  const rels = files.get("xl/_rels/workbook.xml.rels")?.toString("utf8");
  const firstId = workbook ? /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1] : undefined;
  if (firstId && rels) {
    const target = new RegExp(`<Relationship\\b[^>]*Id="${firstId}"[^>]*Target="([^"]+)"`).exec(rels)?.[1]
      ?? new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${firstId}"`).exec(rels)?.[1];
    if (target) sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  }
  const sheet = files.get(sheetPath)?.toString("utf8")
    ?? [...files.entries()].find(([name]) => /^xl\/worksheets\/[^/]+\.xml$/.test(name))?.[1].toString("utf8");
  if (!sheet) throw new Error("The .xlsx file has no sheet.");

  const rows: SheetCells = [];
  for (const rowMatch of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
    const rowNumber = Number(/\br="(\d+)"/.exec(rowMatch[1] ?? rowMatch[3] ?? "")?.[1] ?? rows.length + 1);
    const cells: string[] = [];
    for (const cell of (rowMatch[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attributes = cell[1];
      const body = cell[2] ?? "";
      const ref = /\br="([A-Z]+\d*)"/.exec(attributes)?.[1];
      const type = /\bt="([^"]+)"/.exec(attributes)?.[1];
      const index = ref ? columnIndex(ref) : cells.length;
      const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let text = "";
      if (type === "s") text = shared[Number(value)] ?? "";
      else if (type === "inlineStr") text = textOf(body);
      else if (value !== undefined) text = unescapeXml(value);
      while (cells.length < index) cells.push("");
      cells[index] = text;
    }
    while (rows.length < rowNumber - 1) rows.push([]);
    rows.push(cells);
  }
  return rows;
}

/** Is this buffer a zip (an .xlsx) rather than text? */
export function looksLikeXlsx(buffer: Buffer): boolean {
  return buffer.length > 4 && buffer.readUInt32LE(0) === 0x04034b50;
}

/** Is this an old binary .xls (Excel 97–2003)? Those cannot be read here. */
export function looksLikeOldXls(buffer: Buffer): boolean {
  return buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
}
