/**
 * The weekly payout sheet (周结付款), as pure functions.
 *
 * Owner decision 2026-10-14 ("做法一"): every Monday finance sends each
 * promoter's commission and each rider's delivery pay by hand with M-Pesa Send
 * Money. The system prepares one row per person for the week and records the
 * M-Pesa transaction code once it has been sent. Nothing here moves money.
 *
 * Which items belong to a week (Monday 00:00 to the next Monday 00:00, Nairobi):
 *   - a commission belongs to the week it was CONFIRMED in (confirmedAt). It
 *     must still be CONFIRMED, unpaid, not on hold, above zero, and pass the
 *     same eligibility check the payout export uses;
 *   - a rider fee belongs to the week its delivery was COMPLETED in
 *     (completedAt), and must not be linked to a payout yet.
 * Every item falls into exactly one week, so a week paid on Monday never
 * gains new items, and an item missed in an old week stays visible there.
 */

export const NAIROBI_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export type PayoutWeek = {
  /** Monday 00:00 Nairobi, inclusive. */
  start: Date;
  /** The following Monday 00:00 Nairobi, exclusive. */
  end: Date;
  /** Nairobi calendar dates of the Monday and the Sunday, YYYY-MM-DD. */
  firstDay: string;
  lastDay: string;
};

/** YYYY-MM-DD of an instant as the calendar reads in Nairobi. */
export function nairobiDay(instant: Date): string {
  return new Date(instant.getTime() + NAIROBI_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * The Monday–Sunday week holding `day` (a Nairobi YYYY-MM-DD, any day of that
 * week), or by default the last finished week: the one before the week `now`
 * is in. A malformed day is refused rather than silently replaced.
 */
export function payoutWeek(day: string | undefined | null, now = new Date()): PayoutWeek {
  let anchor: number;
  if (day && day.trim()) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
    if (!match) throw new Error("Week must be a date written YYYY-MM-DD.");
    anchor = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (!Number.isFinite(anchor) || new Date(anchor).toISOString().slice(0, 10) !== day.trim()) {
      throw new Error("Week must be a real calendar date.");
    }
  } else {
    const today = Date.parse(`${nairobiDay(now)}T00:00:00Z`);
    anchor = today - WEEK_MS;
  }
  // anchor is a Nairobi calendar date expressed at 00:00 UTC; step back to Monday.
  const weekday = (new Date(anchor).getUTCDay() + 6) % 7; // Monday = 0
  const mondayUtcDate = anchor - weekday * DAY_MS;
  const start = new Date(mondayUtcDate - NAIROBI_OFFSET_MS);
  const end = new Date(start.getTime() + WEEK_MS);
  return {
    start,
    end,
    firstDay: new Date(mondayUtcDate).toISOString().slice(0, 10),
    lastDay: new Date(mondayUtcDate + 6 * DAY_MS).toISOString().slice(0, 10)
  };
}

/**
 * An M-Pesa transaction code as Safaricom prints it: 10 letters and digits,
 * e.g. "SJK3ABC12X". Spaces are dropped and letters upper-cased; anything else
 * is refused. It must contain at least one letter so a phone number or an
 * amount typed in the wrong box is not accepted.
 */
export function normalizeMpesaCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(code) || !/[A-Z]/.test(code)) return null;
  return code;
}

/** 07xx / 7xx / +2547xx / 2541xx all become 2547xx / 2541xx; anything else null. */
export function normalizeKenyaPhone(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  if (/^0[17]\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^[17]\d{8}$/.test(digits)) return `254${digits}`;
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  return null;
}

function normalizeEmail(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed && trimmed.includes("@") ? trimmed : null;
}

/** A full name of two words or more; a single first name proves nothing. */
function normalizeFullName(value: string | null | undefined): string | null {
  const words = value?.trim().toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  return words.length >= 2 ? words.join(" ") : null;
}

export type SheetCommission = {
  id: string;
  affiliateId: string;
  commissionAmountKsh: number;
  confirmedAt: Date | null;
  affiliate: {
    id: string;
    displayName: string;
    affiliateCode: string;
    phone: string | null;
    email: string | null;
    customer?: { phone: string | null; email: string | null } | null;
  };
  order: { orderNumber: string };
};

export type SheetRider = {
  id: string;
  type: string;
  name: string;
  phone: string | null;
  adminUserId: string | null;
  employeeId: string | null;
  fulfillmentNodeId: string | null;
};

export type SheetRiderFee = {
  id: string;
  riderFeeKsh: number | null;
  completedAt: Date | null;
  deliveryRiderId: string | null;
  deliveryRiderName: string | null;
  deliveryRiderPhone: string | null;
  deliveryRider: SheetRider | null;
  order: { orderNumber: string };
};

export type PayeeType = "AFFILIATE" | "RIDER";

export type PayoutItem = {
  kind: "COMMISSION" | "RIDER_FEE";
  /** Commission id or OrderFulfillment id. */
  id: string;
  orderNumber: string;
  amountKsh: number;
  /** confirmedAt for a commission, completedAt for a delivery. */
  at: string | null;
};

export type PayoutRow = {
  payeeKey: string;
  payeeType: PayeeType;
  name: string;
  phone: string | null;
  affiliateId: string | null;
  affiliateCode: string | null;
  deliveryRiderId: string | null;
  /** INTERNAL / EXTERNAL rider, or null for a promoter. */
  riderType: string | null;
  amountKsh: number;
  count: number;
  items: PayoutItem[];
};

/**
 * Who a delivery's pay goes to. A rider on a store's roster (or a staff rider,
 * or one who signs into the rider app) is one person by their DeliveryRider
 * row. A Bolt or walk-in rider gets a fresh row each time a store types them
 * in, so those are grouped by phone and name instead.
 */
export function riderPayee(fee: SheetRiderFee): { key: string; name: string; phone: string | null; deliveryRiderId: string | null; riderType: string | null } {
  const rider = fee.deliveryRider;
  const name = (rider?.name ?? fee.deliveryRiderName ?? "").trim() || "Unknown rider";
  const phone = rider?.phone ?? fee.deliveryRiderPhone ?? null;
  if (rider && (rider.type === "INTERNAL" || rider.adminUserId || rider.employeeId || rider.fulfillmentNodeId)) {
    return { key: `rider:${rider.id}`, name, phone, deliveryRiderId: rider.id, riderType: rider.type };
  }
  const phoneKey = normalizeKenyaPhone(phone) ?? (phone ?? "").replace(/\D/g, "");
  return {
    key: `external:${phoneKey}|${name.toLowerCase().replace(/\s+/g, " ")}`,
    name,
    phone,
    deliveryRiderId: rider?.id ?? fee.deliveryRiderId ?? null,
    riderType: rider?.type ?? "EXTERNAL"
  };
}

/** One row per person, biggest amount first; items oldest first. */
export function buildPayoutSheet(commissions: SheetCommission[], riderFees: SheetRiderFee[]): PayoutRow[] {
  const rows = new Map<string, PayoutRow>();
  for (const commission of commissions) {
    if (commission.commissionAmountKsh <= 0) continue;
    const key = `affiliate:${commission.affiliateId}`;
    const row = rows.get(key) ?? {
      payeeKey: key,
      payeeType: "AFFILIATE" as const,
      name: commission.affiliate.displayName,
      phone: commission.affiliate.phone ?? commission.affiliate.customer?.phone ?? null,
      affiliateId: commission.affiliateId,
      affiliateCode: commission.affiliate.affiliateCode,
      deliveryRiderId: null,
      riderType: null,
      amountKsh: 0,
      count: 0,
      items: []
    };
    row.items.push({
      kind: "COMMISSION",
      id: commission.id,
      orderNumber: commission.order.orderNumber,
      amountKsh: commission.commissionAmountKsh,
      at: commission.confirmedAt?.toISOString() ?? null
    });
    rows.set(key, row);
  }
  for (const fee of riderFees) {
    if (!fee.riderFeeKsh || fee.riderFeeKsh <= 0) continue;
    const payee = riderPayee(fee);
    const row = rows.get(payee.key) ?? {
      payeeKey: payee.key,
      payeeType: "RIDER" as const,
      name: payee.name,
      phone: payee.phone,
      affiliateId: null,
      affiliateCode: null,
      deliveryRiderId: payee.deliveryRiderId,
      riderType: payee.riderType,
      amountKsh: 0,
      count: 0,
      items: []
    };
    row.items.push({
      kind: "RIDER_FEE",
      id: fee.id,
      orderNumber: fee.order.orderNumber,
      amountKsh: fee.riderFeeKsh,
      at: fee.completedAt?.toISOString() ?? null
    });
    rows.set(payee.key, row);
  }
  for (const row of rows.values()) {
    row.items.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? "") || a.orderNumber.localeCompare(b.orderNumber));
    row.amountKsh = row.items.reduce((sum, item) => sum + item.amountKsh, 0);
    row.count = row.items.length;
  }
  return [...rows.values()].sort((a, b) =>
    a.payeeType.localeCompare(b.payeeType) || b.amountKsh - a.amountKsh || a.name.localeCompare(b.name)
  );
}

/** The admin recording the payout, with everything that could identify them. */
export type Payer = {
  adminUserId: string;
  linkedEmployeeId: string | null;
  name: string | null;
  employeeName: string | null;
  phones: Array<string | null>;
  emails: Array<string | null>;
};

export type PayeeIdentity =
  | {
      payeeType: "AFFILIATE";
      displayName: string;
      phone: string | null;
      email: string | null;
      customer?: { phone: string | null; email: string | null } | null;
    }
  | {
      payeeType: "RIDER";
      name: string;
      phone: string | null;
      adminUserId: string | null;
      employeeId: string | null;
    };

/**
 * Self-payment guard: is the person being paid the admin who is paying?
 *
 * Direct links first (a rider row signed into by, or belonging to the employee
 * of, this admin account). Then the staff-matching rules of the business
 * report (apps/storefront/src/reports/affiliate-team.ts matchStaffAffiliates):
 * phone after normalising 07xx / +2547xx, then email (case-insensitive; a login
 * account that looks like a phone or email counts as one), then — only if
 * neither matched — the full name of two words or more. Returns how it matched,
 * or null when the payee is somebody else.
 */
export function selfPaymentMatch(payer: Payer, payee: PayeeIdentity): "account" | "phone" | "email" | "name" | null {
  if (payee.payeeType === "RIDER") {
    if (payee.adminUserId && payee.adminUserId === payer.adminUserId) return "account";
    if (payee.employeeId && payer.linkedEmployeeId && payee.employeeId === payer.linkedEmployeeId) return "account";
  }
  const payerPhones = new Set(payer.phones.map(normalizeKenyaPhone).filter((p): p is string => !!p));
  const payerEmails = new Set(payer.emails.map(normalizeEmail).filter((e): e is string => !!e));
  const payerNames = new Set([payer.name, payer.employeeName].map(normalizeFullName).filter((n): n is string => !!n));

  const phones = payee.payeeType === "AFFILIATE" ? [payee.phone, payee.customer?.phone] : [payee.phone];
  if (phones.map(normalizeKenyaPhone).some((p) => p && payerPhones.has(p))) return "phone";
  const emails = payee.payeeType === "AFFILIATE" ? [payee.email, payee.customer?.email] : [];
  if (emails.map(normalizeEmail).some((e) => e && payerEmails.has(e))) return "email";
  const name = normalizeFullName(payee.payeeType === "AFFILIATE" ? payee.displayName : payee.name);
  if (name && payerNames.has(name)) return "name";
  return null;
}

/** The sheet as a CSV, one line per person, for the M-Pesa run and the records. */
export function payoutSheetCsv(rows: PayoutRow[], week: { firstDay: string; lastDay: string }): string {
  const cell = (value: string | number | null) => {
    const text = value === null ? "" : String(value);
    // A leading = + - @ would run as a formula in a spreadsheet.
    const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = [["week", "type", "name", "mpesa_phone", "amount_ksh", "orders", "order_numbers"].join(",")];
  for (const row of rows) {
    lines.push([
      `${week.firstDay}~${week.lastDay}`,
      row.payeeType === "AFFILIATE" ? "affiliate" : "rider",
      row.name,
      row.phone,
      row.amountKsh,
      row.count,
      row.items.map((item) => item.orderNumber).join(" ")
    ].map(cell).join(","));
  }
  return `${lines.join("\n")}\n`;
}
