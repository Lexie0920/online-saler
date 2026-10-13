import assert from "node:assert/strict";
import { buildAffiliateTeam, matchStaffAffiliates, normalizePhone, type AffiliateRow, type StaffRow } from "./affiliate-team";
import { change, renderBusinessReportEmail } from "./business-report-email";
import { prisma } from "@online-saler/database";
import { collectWarehouse, type BusinessReport } from "./business-report-service";
import { reportRecipients, sendReportEmail } from "./email-sender";
import { reportPeriod } from "./report-period";

// --- Periods -----------------------------------------------------------------

// 07:00 Nairobi on Monday 2026-09-28 is 04:00 UTC. The daily report is about
// Sunday, midnight to midnight in Nairobi, which is 21:00 UTC the day before.
const mondayMorning = new Date("2026-09-28T04:00:00Z");
const daily = reportPeriod("daily", mondayMorning);
assert.equal(daily.label, "2026-09-27");
assert.equal(daily.start.toISOString(), "2026-09-26T21:00:00.000Z");
assert.equal(daily.end.toISOString(), "2026-09-27T21:00:00.000Z");
assert.equal(daily.previousStart.toISOString(), "2026-09-25T21:00:00.000Z");
assert.equal(daily.previousEnd.toISOString(), daily.start.toISOString());

// Just after midnight in Nairobi it is still the previous evening in UTC. The
// report must follow the Nairobi calendar, not the server's.
assert.equal(reportPeriod("daily", new Date("2026-09-27T21:30:00Z")).label, "2026-09-27");
assert.equal(reportPeriod("daily", new Date("2026-09-27T20:30:00Z")).label, "2026-09-26");

// The Monday weekly report covers last Monday to Sunday, never the week that
// has only just started.
const weekly = reportPeriod("weekly", mondayMorning);
assert.equal(weekly.label, "2026-09-21 ~ 2026-09-27");
assert.equal(weekly.start.toISOString(), "2026-09-20T21:00:00.000Z");
assert.equal(weekly.end.toISOString(), "2026-09-27T21:00:00.000Z");
assert.equal(weekly.previousStart.toISOString(), "2026-09-13T21:00:00.000Z");

// Monthly on the 1st is about the month that just ended, and its comparison is
// the month before — lengths differ and that is fine.
const monthly = reportPeriod("monthly", new Date("2026-10-01T04:10:00Z"));
assert.equal(monthly.label, "2026-09");
assert.equal(monthly.firstDay, "2026-09-01");
assert.equal(monthly.lastDay, "2026-09-30");
assert.equal(monthly.start.toISOString(), "2026-08-31T21:00:00.000Z");
assert.equal(monthly.end.toISOString(), "2026-09-30T21:00:00.000Z");
assert.equal(monthly.previousStart.toISOString(), "2026-07-31T21:00:00.000Z");
assert.equal(reportPeriod("monthly", new Date("2027-01-01T04:10:00Z")).label, "2026-12");

// A hand-picked date reports on the period that holds it.
assert.equal(reportPeriod("weekly", mondayMorning, "2026-09-16").label, "2026-09-14 ~ 2026-09-20");
assert.equal(reportPeriod("monthly", mondayMorning, "2026-02-10").lastDay, "2026-02-28");
assert.equal(reportPeriod("daily", mondayMorning, "2026-09-01").start.toISOString(), "2026-08-31T21:00:00.000Z");
assert.throws(() => reportPeriod("daily", mondayMorning, "2026-02-30"), RangeError);
assert.throws(() => reportPeriod("daily", mondayMorning, "yesterday"), RangeError);

// --- Change against the previous period ----------------------------------------

assert.equal(change({ current: 150, previous: 100 }, "上周"), "比上周↑ 50%");
assert.equal(change({ current: 50, previous: 100 }, "上周"), "比上周↓ 50%");
assert.equal(change({ current: 3, previous: 3 }, "上周"), "和上周持平");
assert.equal(change({ current: 0, previous: 0 }, "上周"), "和上周持平");
assert.equal(change({ current: 4, previous: 0 }, "上周"), "上周为 0");

// --- Affiliate team: staff vs external, dormant, previous period ----------------

assert.equal(normalizePhone("0712 345 678"), "254712345678");
assert.equal(normalizePhone("+254 712-345-678"), "254712345678");
assert.equal(normalizePhone("712345678"), "254712345678");
assert.equal(normalizePhone("Faith2026"), null, "a login name is not a phone");
assert.equal(normalizePhone(null), null);

const day = 24 * 60 * 60 * 1000;
const at = (daysBeforeReport: number) => new Date(mondayMorning.getTime() - daysBeforeReport * day);
function affiliate(id: string, overrides: Partial<AffiliateRow> = {}): AffiliateRow {
  return {
    id,
    displayName: id,
    affiliateCode: id.toUpperCase(),
    phone: null,
    email: null,
    status: "ACTIVE",
    createdAt: at(60),
    disabledAt: null,
    customer: null,
    ...overrides
  };
}

const team: AffiliateRow[] = [
  // Staff by phone: 07xx on the promoter, +2547xx on the operations account.
  affiliate("faith", { displayName: "Faith Nyambura", affiliateCode: "FAITH", phone: "0712345678" }),
  // Staff by email, found on the shop account the promoter was enabled from.
  affiliate("peter", { displayName: "Peter Otieno", customer: { phone: null, email: "Peter@Example.com" } }),
  // Staff by full name only.
  affiliate("john", { displayName: "john  KAMAU" }),
  // A lone first name equal to a staff first name proves nothing.
  affiliate("mary", { displayName: "Mary" }),
  // External, joined during the report day, with a name that must be escaped.
  affiliate("ext", { displayName: "Wanjiru <b>& Co", affiliateCode: "WANJ", phone: "0799000111", createdAt: at(1) }),
  // External, quiet for eight days.
  affiliate("quiet", { displayName: "Quiet One", createdAt: at(30) }),
  // External, joined the day before and never clicked.
  affiliate("never", { displayName: "Never Clicked", createdAt: at(2) }),
  // Disabled before both periods: not a current promoter anywhere.
  affiliate("gone", { status: "DISABLED", disabledAt: at(5), createdAt: at(40) })
];
const staffAccounts: StaffRow[] = [
  { label: "Faith2026", name: "Faith", phones: ["+254712345678", "Faith2026"], emails: [null, "Faith2026"] },
  { label: "peter.o", name: "Peter O.", phones: [null], emails: ["peter@example.com"] },
  { label: "EMP-007", name: "John Kamau", phones: ["0700111222"], emails: [] },
  { label: "EMP-008", name: "Mary", phones: [], emails: [] }
];

const matches = matchStaffAffiliates(team, staffAccounts);
assert.deepEqual(matches.get("faith"), { staffLabel: "Faith2026", by: "phone" });
assert.deepEqual(matches.get("peter"), { staffLabel: "peter.o", by: "email" });
assert.deepEqual(matches.get("john"), { staffLabel: "EMP-007", by: "name" });
assert.equal(matches.has("mary"), false, "a single first name is not a match");
assert.equal(matches.has("ext"), false);
assert.equal(matches.size, 3);

// daily is 2026-09-27 in Nairobi; the previous period is 2026-09-26.
const inPeriod = new Date(daily.start.getTime() + 2 * 60 * 60 * 1000);
const affiliateTeam = buildAffiliateTeam({
  period: daily,
  now: mondayMorning,
  affiliates: team,
  staff: staffAccounts,
  clicks: {
    current: [
      { affiliateId: "faith", count: 40 },
      { affiliateId: "ext", count: 10 }
    ],
    previous: [{ affiliateId: "faith", count: 20 }]
  },
  lastClicks: [
    { affiliateId: "faith", lastClickAt: inPeriod },
    { affiliateId: "ext", lastClickAt: inPeriod },
    { affiliateId: "peter", lastClickAt: at(6) },
    { affiliateId: "john", lastClickAt: at(6) },
    { affiliateId: "mary", lastClickAt: at(6) },
    { affiliateId: "quiet", lastClickAt: at(8) }
  ],
  orders: {
    current: [
      { affiliateId: "faith", itemSubtotalKsh: 1000 },
      { affiliateId: "faith", itemSubtotalKsh: 500 },
      { affiliateId: "ext", itemSubtotalKsh: 800 },
      { affiliateId: null, itemSubtotalKsh: 9999 }
    ],
    previous: [{ affiliateId: "ext", itemSubtotalKsh: 400 }]
  },
  commission: {
    current: [
      { affiliateId: "faith", amountKsh: 150 },
      { affiliateId: "ext", amountKsh: 80 }
    ],
    previous: [{ affiliateId: "ext", amountKsh: 40 }]
  },
  commissionPaidKsh: 60
});

assert.deepEqual(affiliateTeam.totalAffiliates, { current: 7, previous: 6 }, "as of each period end");
assert.deepEqual(affiliateTeam.newAffiliates, { current: 1, previous: 1 });
assert.deepEqual(affiliateTeam.activeAffiliates, { current: 2, previous: 1 });
assert.deepEqual(affiliateTeam.all, {
  clicks: { current: 50, previous: 20 },
  orders: { current: 3, previous: 1 },
  gmvKsh: { current: 2300, previous: 400 },
  commissionKsh: { current: 230, previous: 40 }
});
assert.deepEqual(affiliateTeam.external, {
  clicks: { current: 10, previous: 0 },
  orders: { current: 1, previous: 1 },
  gmvKsh: { current: 800, previous: 400 },
  commissionKsh: { current: 80, previous: 40 }
});
assert.equal(affiliateTeam.staff.orders.current, 2, "Faith's orders are staff orders");
assert.deepEqual(
  affiliateTeam.ranking.map((row) => [row.code, row.orders, row.clicks, row.isStaff]),
  [
    ["FAITH", 2, 40, true],
    ["WANJ", 1, 10, false]
  ],
  "ranked by orders, then clicks"
);

// Dormant: active promoters with no click in the 7 days before the report.
// Six days ago is still awake; eight days ago and never are asleep.
assert.equal(affiliateTeam.dormant.of, 7);
assert.equal(affiliateTeam.dormant.count, 2);
assert.deepEqual(
  affiliateTeam.dormant.list.map((row) => [row.name, row.daysSinceLastClick, row.daysSinceJoined]),
  [
    ["Quiet One", 8, 30],
    ["Never Clicked", null, 2]
  ]
);
assert.deepEqual(
  affiliateTeam.staffAffiliates.map((row) => [row.name, row.by]),
  [
    ["Faith Nyambura", "phone"],
    ["Peter Otieno", "email"],
    ["john  KAMAU", "name"]
  ]
);

// --- Email ---------------------------------------------------------------------

function sampleReport(): BusinessReport {
  const same = (current: number, previous = current) => ({ current, previous });
  return {
    period: daily,
    generatedAt: mondayMorning,
    sales: {
      paidOrders: same(4, 2),
      revenueKsh: same(3200, 1600),
      itemsSold: same(5, 2),
      cashInKsh: same(3500, 1600),
      newDepositHolds: 1,
      paymentAttempts: 8,
      paymentSuccesses: 6,
      paymentFailures: 2,
      refundsKsh: same(400, 200),
      refundCount: 1,
      pickupOrders: 3,
      deliveryOrders: 1,
      paymentsInManualReview: 1
    },
    inventory: {
      stockedIn: same(20, 10),
      published: same(18),
      onSale: 640,
      onSaleValueKsh: 512000,
      heldInCarts: 2,
      heldByDeposit: 1,
      inDigitisation: 37,
      slowestSellers: [{ productCode: "P-0001", title: "Denim <jacket> & co", priceKsh: 900, daysListed: 41 }]
    },
    warehouse: {
      queues: { toPick: 1, toPack: 2, packedNotSent: 0, awaitingPickup: 3, outForDelivery: 1, exceptions: 0 },
      overdue: 2,
      packed: same(4),
      completed: same(3),
      deliveryFailures: 0,
      codelessCompletions: 2,
      byEmployee: [{ name: "Wanjiku", picked: 3, packed: 4 }]
    },
    affiliates: affiliateTeam,
    afterSales: {
      returnsRequested: same(1, 0),
      returnsReceived: 0,
      casesOpened: same(2, 4),
      openCases: 3,
      overdueCases: 0,
      refundsAwaitingApproval: 0,
      refundsAwaitingApprovalKsh: 0
    }
  };
}

const email = renderBusinessReportEmail(sampleReport());
assert.equal(email.subject, "Direct Loop 日报 · 2026-09-27 · 收款 KSh 3,500");
for (const heading of ["销售和收款", "库存和上架", "仓库作业", "分销团队增长", "退货和客服"]) {
  assert.ok(email.html.includes(heading), `html has ${heading}`);
  assert.ok(email.text.includes(`【${heading}】`), `text has ${heading}`);
}
assert.ok(email.html.includes("比前一天↑ 100%"), "revenue doubled against the day before");
assert.ok(email.html.includes("⚠ 待人工核对的付款"), "a payment waiting for review is flagged");
assert.ok(email.html.includes("⚠ 付款超过 48 小时还没交付"), "late orders are flagged");
assert.ok(!email.html.includes("⚠ 异常订单"), "no exceptions, no warning");
// 无码补登 is counted so the owner sees how often the code is skipped.
assert.ok(email.text.includes("⚠ 无码补登：2 单"), "code-less completions are counted and flagged");
const noCodeless = sampleReport();
noCodeless.warehouse = { ...noCodeless.warehouse, codelessCompletions: 0 };
assert.ok(renderBusinessReportEmail(noCodeless).text.includes("- 无码补登：0 单"), "none, no warning");

// The affiliate team section.
for (const label of ["推广员总数", "新增推广员", "活跃推广员", "总点击", "点击→下单转化率", "推广员排行（前 10）", "⚠ 现在沉睡的推广员"]) {
  assert.ok(email.html.includes(label), `html has ${label}`);
}
assert.ok(email.html.includes("比前一天↑ 150%"), "clicks 20 → 50 against the day before");
assert.ok(email.text.includes("- 点击→下单转化率：6.0% — 已付款订单 ÷ 点击；前一天 5.0%"), "conversion now and before");
assert.ok(email.text.includes("  订单 | 3 | 1 和前一天持平"), "external orders sit next to the total");
assert.ok(email.text.includes("  点击 | 50 | 10 前一天为 0"));
assert.ok(email.text.includes("  Faith Nyambura FAITH · 员工 | 40 | 2 | KSh 1,500 | KSh 150"));
assert.ok(email.text.includes("  Quiet One QUIET | 8 天"));
assert.ok(email.text.includes("  Never Clicked NEVER | 从没有点击（加入 2 天）"));
assert.ok(email.text.includes("Faith Nyambura（手机号对上员工账号 Faith2026）"), "the staff rule is shown");
// Promoter names come from people and must not become markup.
assert.ok(email.html.includes("Wanjiru &lt;b&gt;&amp; Co"));
assert.ok(!email.html.includes("<b>&"));
assert.ok(email.text.includes("  Wanjiru <b>& Co WANJ | 10 | 1 | KSh 800 | KSh 80"));

const quietReport = sampleReport();
quietReport.affiliates = { ...affiliateTeam, ranking: [], dormant: { count: 0, of: 7, list: [] }, staffAffiliates: [] };
const quietEmail = renderBusinessReportEmail(quietReport);
assert.ok(quietEmail.html.includes("期间没有推广点击或分销订单"), "an empty table says so instead of vanishing");
assert.ok(quietEmail.html.includes("没有沉睡的推广员"));
assert.ok(!quietEmail.html.includes("⚠ 现在沉睡的推广员"));
assert.ok(quietEmail.html.includes("全部算外部推广员"));

// Product titles come from staff input and must not become markup.
assert.ok(email.html.includes("Denim &lt;jacket&gt; &amp; co"));
assert.ok(!email.html.includes("<jacket>"));
assert.ok(email.text.includes("Denim <jacket> & co P-0001"), "plain text reads naturally");

// More refunds is bad news and must not be painted green.
const refundRow = email.html.slice(email.html.indexOf("已退款"), email.html.indexOf("已退款") + 600);
assert.ok(refundRow.includes("#b91c1c"), "a rise in refunds is red");

// --- Sending -------------------------------------------------------------------

assert.deepEqual(reportRecipients({ BUSINESS_REPORT_EMAIL_TO: " a@example.com, ,b@example.com " }), [
  "a@example.com",
  "b@example.com"
]);

const calls: Array<{ url: string; init: RequestInit }> = [];
const fakeFetch = (async (url: string, init: RequestInit) => {
  calls.push({ url, init });
  return new Response(JSON.stringify({ id: "email_123" }), { status: 200 });
}) as unknown as typeof fetch;

(async () => {
  const outgoing = { ...email, idempotencyKey: "business-report/daily/2026-09-27" };

  await assert.rejects(sendReportEmail(outgoing, { BUSINESS_REPORT_EMAIL_TO: "a@example.com" }, fakeFetch), /RESEND_API_KEY/);
  await assert.rejects(sendReportEmail(outgoing, { RESEND_API_KEY: "re_test" }, fakeFetch), /BUSINESS_REPORT_EMAIL_TO/);
  assert.equal(calls.length, 0, "nothing is sent while unconfigured");

  const sent = await sendReportEmail(outgoing, { RESEND_API_KEY: "re_test", BUSINESS_REPORT_EMAIL_TO: "a@example.com" }, fakeFetch);
  assert.deepEqual(sent, { id: "email_123", to: ["a@example.com"] });
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  assert.equal(headers["idempotency-key"], "business-report/daily/2026-09-27", "a scheduler retry cannot send twice");
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.from, "Direct Loop Reports <onboarding@resend.dev>");
  assert.deepEqual(body.to, ["a@example.com"]);

  const refusing = (async () => new Response(JSON.stringify({ message: "invalid key" }), { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(
    sendReportEmail(outgoing, { RESEND_API_KEY: "re_bad", BUSINESS_REPORT_EMAIL_TO: "a@example.com" }, refusing),
    /HTTP 401\): invalid key/
  );

  // 无码补登 is read from the fulfillment events in the period, by its action.
  const eventCounts: unknown[] = [];
  const db = prisma as unknown as Record<string, Record<string, unknown>>;
  const saved = { count: db.orderFulfillment.count, groupBy: db.orderFulfillment.groupBy, eventCount: db.fulfillmentEvent.count, employees: db.employee.findMany };
  db.orderFulfillment.count = async () => 0;
  db.orderFulfillment.groupBy = async () => [];
  db.fulfillmentEvent.count = async (args: unknown) => { eventCounts.push(args); return 3; };
  db.employee.findMany = async () => [];
  try {
    const range = { gte: daily.start, lt: daily.end };
    const warehouse = await collectWarehouse(range, { gte: daily.previousStart, lt: daily.previousEnd }, mondayMorning);
    assert.equal(warehouse.codelessCompletions, 3);
    assert.deepEqual(eventCounts, [{ where: { action: "CODELESS_COMPLETION", createdAt: range } }]);
  } finally {
    db.orderFulfillment.count = saved.count;
    db.orderFulfillment.groupBy = saved.groupBy;
    db.fulfillmentEvent.count = saved.eventCount;
    db.employee.findMany = saved.employees;
  }

  console.log("business report tests ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
