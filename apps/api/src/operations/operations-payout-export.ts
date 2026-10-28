/**
 * The payment list: one file with everyone who is still owed a promoter commission.
 *
 * The 导出 button on the weekly payouts page downloads it. It holds every commission
 * that is confirmed and not yet paid, from the oldest week to the newest, and nothing
 * else: no rider fees, no unconfirmed commissions, no commissions already paid. When
 * a payment is recorded the commission leaves the list, so the next export only holds
 * what is still owed.
 *
 * This file only arranges the rows (pure functions, no database). The loader that reads
 * the database lives in operations-payout.service.ts; the .xlsx file itself is built by
 * the page from the lines made here. Nothing here changes data.
 */
import { nairobiDay, normalizeKenyaPhone, payoutWeek } from "./operations-payout-sheet";

/** One confirmed, unpaid commission. */
export type ExportItem = {
  payeeKey: string;
  name: string;
  phone: string | null;
  orderNumber: string;
  /** When staff confirmed it; this puts it in a Monday–Sunday payout week. */
  confirmedAt: Date | null;
  amountKsh: number;
};

export const EXPORT_ROW_LIMIT = 20000;

/** A colour block is shown only for a promoter who has more than one row; 0 and 1 alternate. */
export type PayoutListBlock = 0 | 1 | null;

export type PayoutListLine =
  | {
      kind: "item";
      block: PayoutListBlock;
      promoter: string;
      phone: string;
      week: string;
      orders: number;
      amountKsh: number;
      note: string;
    }
  | { kind: "subtotal"; block: 0 | 1; promoter: string; orders: number; amountKsh: number; note: string }
  | { kind: "total"; people: number; orders: number; amountKsh: number };

export type PayoutListSummary = {
  /** Different promoters, however many weeks each is owed. */
  people: number;
  /** Rows for a promoter and a week (subtotal and total rows are not counted). */
  rows: number;
  orders: number;
  amountKsh: number;
  /** People with no phone, or a phone that is not an M-Pesa number. */
  phoneProblems: number;
  /** True when the safety cap on rows was hit and the list may be incomplete. */
  truncated: boolean;
};

export type PayoutList = {
  fileName: string;
  summary: PayoutListSummary;
  lines: PayoutListLine[];
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortDay(day: string): string {
  return `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;
}

/** `12 Oct–18 Oct`, with the year added when the week is not in the current year. */
export function weekLabel(confirmedAt: Date | null, now: Date): string {
  if (!confirmedAt) return "";
  const week = payoutWeek(nairobiDay(confirmedAt));
  const label = `${shortDay(week.firstDay)}–${shortDay(week.lastDay)}`;
  const thisYear = nairobiDay(now).slice(0, 4);
  // A week that is not wholly inside this year says which year it ends in.
  return week.firstDay.slice(0, 4) === thisYear && week.lastDay.slice(0, 4) === thisYear ? label : `${label} ${week.lastDay.slice(0, 4)}`;
}

/** What the person doing the payments needs to know about this phone number. */
export function phoneNote(phone: string | null): string {
  if (!phone || !phone.trim()) return "No phone number";
  if (!normalizeKenyaPhone(phone)) return "Phone is not a valid M-Pesa number";
  return "";
}

export function payoutListFileName(now: Date): string {
  return `payout-list-${nairobiDay(now)}.xlsx`;
}

type Row = { payeeKey: string; name: string; phone: string | null; firstDay: string; label: string; orders: number; amountKsh: number };

/**
 * Sorted by promoter name, a promoter's rows together, oldest week first. A promoter who is owed
 * for more than one week gets a colour block and a subtotal line (the amount to send in one go);
 * a promoter with one row stays plain. The last line adds everything up.
 */
export function buildPayoutList(items: ExportItem[], truncated: boolean, now: Date): PayoutList {
  const rows = new Map<string, Row>();
  for (const item of items) {
    const label = weekLabel(item.confirmedAt, now);
    const firstDay = item.confirmedAt ? payoutWeek(nairobiDay(item.confirmedAt)).firstDay : "";
    const key = `${item.payeeKey}|${firstDay}`;
    const row = rows.get(key);
    if (row) {
      row.orders += 1;
      row.amountKsh += item.amountKsh;
      if (!row.phone && item.phone) row.phone = item.phone;
    } else {
      rows.set(key, { payeeKey: item.payeeKey, name: item.name, phone: item.phone, firstDay, label, orders: 1, amountKsh: item.amountKsh });
    }
  }

  const byPerson = new Map<string, Row[]>();
  for (const row of rows.values()) {
    const list = byPerson.get(row.payeeKey);
    if (list) list.push(row);
    else byPerson.set(row.payeeKey, [row]);
  }
  const people = [...byPerson.values()]
    .map((list) => list.sort((a, b) => a.firstDay.localeCompare(b.firstDay)))
    .sort((a, b) => a[0]!.name.localeCompare(b[0]!.name, "en", { sensitivity: "base" }) || a[0]!.payeeKey.localeCompare(b[0]!.payeeKey));

  const lines: PayoutListLine[] = [];
  let nextBlock: 0 | 1 = 0;
  let orders = 0;
  let amountKsh = 0;
  let phoneProblems = 0;
  for (const list of people) {
    const first = list[0]!;
    // A person's phone is whichever row has one, so every row of theirs carries the same number.
    const phone = list.find((row) => row.phone && row.phone.trim())?.phone ?? null;
    const note = phoneNote(phone);
    if (note) phoneProblems += 1;
    const shown = phone ? (normalizeKenyaPhone(phone) ?? phone.trim()) : "";
    const block: PayoutListBlock = list.length > 1 ? nextBlock : null;
    for (const row of list) {
      lines.push({ kind: "item", block, promoter: first.name, phone: shown, week: row.label, orders: row.orders, amountKsh: row.amountKsh, note });
    }
    const personOrders = list.reduce((sum, row) => sum + row.orders, 0);
    const personAmount = list.reduce((sum, row) => sum + row.amountKsh, 0);
    if (block !== null) {
      lines.push({ kind: "subtotal", block, promoter: first.name, orders: personOrders, amountKsh: personAmount, note: `Send KSh ${personAmount.toLocaleString("en-US")}` });
      nextBlock = nextBlock === 0 ? 1 : 0;
    }
    orders += personOrders;
    amountKsh += personAmount;
  }
  if (people.length) lines.push({ kind: "total", people: people.length, orders, amountKsh });

  return {
    fileName: payoutListFileName(now),
    summary: { people: people.length, rows: rows.size, orders, amountKsh, phoneProblems, truncated },
    lines
  };
}
