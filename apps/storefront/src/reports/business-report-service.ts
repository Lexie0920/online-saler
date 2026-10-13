import {
  AdminUserStatus,
  AfterSaleReturnStatus,
  CommissionStatus,
  CustomerServiceCaseStatus,
  EmployeeStatus,
  FulfillmentStatus,
  InventoryItemStatus,
  PaymentKind,
  PaymentStatus,
  ProductStatus,
  RefundRequestStatus,
  prisma
} from "@online-saler/database";
import { buildAffiliateTeam, type AffiliateTeamReport, type Comparable, type StaffRow } from "./affiliate-team";
import type { ReportPeriod } from "./report-period";

/**
 * Everything the daily, weekly and monthly emails say, gathered in one pass.
 *
 * Read only: nothing here changes an order, payment, garment or commission.
 * Two kinds of number live side by side and the email keeps them apart:
 *
 * - "in the period" numbers count what happened between start and end, and
 *   come with the same number for the period before, so a reader sees a trend;
 * - "right now" numbers (queues, stock on sale, open cases) describe the shop
 *   at the moment the report is built. They are the to-do list, not history.
 */

export type { Comparable };

export type BusinessReport = {
  period: ReportPeriod;
  generatedAt: Date;
  sales: {
    /** Orders fully paid in the period (FULL or BALANCE payment cleared). */
    paidOrders: Comparable;
    /** Sum of those orders' totals, delivery fee included. */
    revenueKsh: Comparable;
    itemsSold: Comparable;
    /** All money that arrived through M-Pesa in the period, deposits included. */
    cashInKsh: Comparable;
    newDepositHolds: number;
    paymentAttempts: number;
    paymentSuccesses: number;
    paymentFailures: number;
    refundsKsh: Comparable;
    refundCount: number;
    pickupOrders: number;
    deliveryOrders: number;
    /** Right now: payments nobody has decided on yet. */
    paymentsInManualReview: number;
  };
  inventory: {
    stockedIn: Comparable;
    published: Comparable;
    /** Right now. */
    onSale: number;
    onSaleValueKsh: number;
    heldInCarts: number;
    heldByDeposit: number;
    inDigitisation: number;
    slowestSellers: Array<{ productCode: string; title: string; priceKsh: number | null; daysListed: number }>;
  };
  warehouse: {
    /** Right now, by stage. */
    queues: {
      toPick: number;
      toPack: number;
      packedNotSent: number;
      awaitingPickup: number;
      outForDelivery: number;
      exceptions: number;
    };
    /** Right now: paid orders still not handed over two days later. */
    overdue: number;
    packed: Comparable;
    completed: Comparable;
    deliveryFailures: number;
    /** 无码补登: orders a super admin completed without the customer's code, in the period. */
    codelessCompletions: number;
    byEmployee: Array<{ name: string; picked: number; packed: number }>;
  };
  /** 分销团队增长: see affiliate-team.ts for every definition. */
  affiliates: AffiliateTeamReport;
  afterSales: {
    returnsRequested: Comparable;
    returnsReceived: number;
    casesOpened: Comparable;
    /** Right now. */
    openCases: number;
    overdueCases: number;
    refundsAwaitingApproval: number;
    refundsAwaitingApprovalKsh: number;
  };
};

const OVERDUE_AFTER_MS = 48 * 60 * 60 * 1000;
const FAILED_PAYMENT_STATUSES = [
  PaymentStatus.FAILED,
  PaymentStatus.CANCELLED,
  PaymentStatus.TIMEOUT,
  PaymentStatus.EXPIRED
];
const OPEN_CASE_STATUSES = [CustomerServiceCaseStatus.OPEN, CustomerServiceCaseStatus.IN_PROGRESS];
const DIGITISATION_STATUSES = [
  ProductStatus.DRAFT,
  ProductStatus.PHOTOGRAPHED,
  ProductStatus.AI_PROCESSING,
  ProductStatus.AI_PROCESSED,
  ProductStatus.CALIBRATION_PENDING,
  ProductStatus.CALIBRATED,
  ProductStatus.BARCODE_ASSIGNED,
  ProductStatus.REVIEW_PENDING,
  ProductStatus.REWORK_REQUIRED,
  ProductStatus.APPROVED,
  ProductStatus.READY_FOR_STORAGE
];
const QUEUE_STAGES = {
  toPick: [FulfillmentStatus.PAID, FulfillmentStatus.PICKING],
  toPack: [FulfillmentStatus.READY_TO_PACK],
  packedNotSent: [
    FulfillmentStatus.PACKED,
    FulfillmentStatus.IN_TRANSIT_TO_NODE,
    FulfillmentStatus.ARRIVED_AT_NODE,
    FulfillmentStatus.READY_FOR_DISPATCH
  ],
  awaitingPickup: [FulfillmentStatus.READY_FOR_PICKUP],
  outForDelivery: [
    FulfillmentStatus.OUT_FOR_DELIVERY,
    FulfillmentStatus.DELIVERY_FAILED,
    FulfillmentStatus.RETURNING_TO_NODE
  ],
  exceptions: [FulfillmentStatus.EXCEPTION]
} satisfies Record<keyof BusinessReport["warehouse"]["queues"], FulfillmentStatus[]>;

export type Range = { gte: Date; lt: Date };

export async function collectBusinessReport(period: ReportPeriod, now = new Date()): Promise<BusinessReport> {
  const current: Range = { gte: period.start, lt: period.end };
  const previous: Range = { gte: period.previousStart, lt: period.previousEnd };

  const [
    salesNow,
    salesBefore,
    cashNow,
    cashBefore,
    newDepositHolds,
    paymentAttempts,
    paymentSuccesses,
    paymentFailures,
    refundsNow,
    refundsBefore,
    paymentsInManualReview,
    inventory,
    warehouse,
    affiliates,
    afterSales
  ] = await Promise.all([
    settledOrders(current),
    settledOrders(previous),
    cashIn(current),
    cashIn(previous),
    prisma.payment.count({ where: { kind: PaymentKind.DEPOSIT, status: PaymentStatus.SUCCESS, completedAt: current } }),
    prisma.payment.count({ where: { requestedAt: current } }),
    prisma.payment.count({ where: { requestedAt: current, status: PaymentStatus.SUCCESS } }),
    prisma.payment.count({ where: { requestedAt: current, status: { in: FAILED_PAYMENT_STATUSES } } }),
    prisma.refundRecord.aggregate({ where: { refundedAt: current }, _sum: { amountKsh: true }, _count: true }),
    prisma.refundRecord.aggregate({ where: { refundedAt: previous }, _sum: { amountKsh: true } }),
    prisma.payment.count({ where: { status: PaymentStatus.MANUAL_REVIEW, reviewDecision: null } }),
    collectInventory(current, previous, now),
    collectWarehouse(current, previous, now),
    readAffiliateTeam(current, previous),
    collectAfterSales(current, previous, now)
  ]);

  const settled = salesNow.orders;
  return {
    period,
    generatedAt: now,
    sales: {
      paidOrders: { current: settled.length, previous: salesBefore.orders.length },
      revenueKsh: { current: sum(settled, (o) => o.totalKsh), previous: sum(salesBefore.orders, (o) => o.totalKsh) },
      itemsSold: { current: sum(settled, (o) => o.items), previous: sum(salesBefore.orders, (o) => o.items) },
      cashInKsh: { current: cashNow, previous: cashBefore },
      newDepositHolds,
      paymentAttempts,
      paymentSuccesses,
      paymentFailures,
      refundsKsh: { current: refundsNow._sum.amountKsh ?? 0, previous: refundsBefore._sum.amountKsh ?? 0 },
      refundCount: refundsNow._count,
      pickupOrders: settled.filter((o) => o.fulfillmentMethod === "PICKUP").length,
      deliveryOrders: settled.filter((o) => o.fulfillmentMethod !== "PICKUP").length,
      paymentsInManualReview
    },
    inventory,
    warehouse,
    affiliates: buildAffiliateTeam({
      ...affiliates,
      period,
      now,
      orders: { current: settled, previous: salesBefore.orders }
    }),
    afterSales
  };
}

/**
 * An order counts as sold in the period its last payment cleared: the FULL
 * payment, or the BALANCE on a deposit order. A deposit alone is a hold, not a
 * sale, so it is reported separately.
 */
async function settledOrders(range: Range) {
  const payments = await prisma.payment.findMany({
    where: { status: PaymentStatus.SUCCESS, kind: { in: [PaymentKind.FULL, PaymentKind.BALANCE] }, completedAt: range },
    select: {
      orderId: true,
      order: {
        select: {
          totalKsh: true,
          itemSubtotalKsh: true,
          fulfillmentMethod: true,
          affiliateId: true,
          _count: { select: { items: true } }
        }
      }
    }
  });
  const byOrder = new Map<
    string,
    { totalKsh: number; itemSubtotalKsh: number; fulfillmentMethod: string; affiliateId: string | null; items: number }
  >();
  for (const payment of payments) {
    byOrder.set(payment.orderId, {
      totalKsh: payment.order.totalKsh,
      itemSubtotalKsh: payment.order.itemSubtotalKsh,
      fulfillmentMethod: payment.order.fulfillmentMethod,
      affiliateId: payment.order.affiliateId,
      items: payment.order._count.items
    });
  }
  return { orders: [...byOrder.values()] };
}

async function cashIn(range: Range) {
  const result = await prisma.payment.aggregate({
    where: { status: PaymentStatus.SUCCESS, completedAt: range },
    _sum: { amountKsh: true }
  });
  return result._sum.amountKsh ?? 0;
}

async function collectInventory(current: Range, previous: Range, now: Date): Promise<BusinessReport["inventory"]> {
  const onSaleWhere = {
    status: ProductStatus.PUBLISHED,
    inventoryItem: { is: { status: InventoryItemStatus.AVAILABLE } }
  };
  const [stockedNow, stockedBefore, publishedNow, publishedBefore, onSale, heldInCarts, heldByDeposit, inDigitisation, slowest] =
    await Promise.all([
      prisma.inventoryItem.count({ where: { checkedInAt: current } }),
      prisma.inventoryItem.count({ where: { checkedInAt: previous } }),
      prisma.product.count({ where: { publishedAt: current } }),
      prisma.product.count({ where: { publishedAt: previous } }),
      prisma.product.aggregate({ where: onSaleWhere, _count: true, _sum: { priceKsh: true } }),
      prisma.inventoryItem.count({ where: { status: InventoryItemStatus.RESERVED } }),
      prisma.inventoryItem.count({ where: { status: InventoryItemStatus.DEPOSIT_HELD } }),
      prisma.product.count({ where: { status: { in: DIGITISATION_STATUSES } } }),
      prisma.product.findMany({
        where: { ...onSaleWhere, publishedAt: { not: null } },
        orderBy: { publishedAt: "asc" },
        take: 5,
        select: { productCode: true, title: true, priceKsh: true, publishedAt: true }
      })
    ]);

  return {
    stockedIn: { current: stockedNow, previous: stockedBefore },
    published: { current: publishedNow, previous: publishedBefore },
    onSale: onSale._count,
    onSaleValueKsh: onSale._sum.priceKsh ?? 0,
    heldInCarts,
    heldByDeposit,
    inDigitisation,
    slowestSellers: slowest.map((product) => ({
      productCode: product.productCode,
      title: product.title ?? product.productCode,
      priceKsh: product.priceKsh,
      daysListed: Math.floor((now.getTime() - (product.publishedAt?.getTime() ?? now.getTime())) / (24 * 60 * 60 * 1000))
    }))
  };
}

export async function collectWarehouse(current: Range, previous: Range, now: Date): Promise<BusinessReport["warehouse"]> {
  const stages = Object.entries(QUEUE_STAGES) as Array<[keyof typeof QUEUE_STAGES, FulfillmentStatus[]]>;
  const [queueCounts, overdue, packedNow, packedBefore, completedNow, completedBefore, deliveryFailures, codelessCompletions, pickers, packers] =
    await Promise.all([
      Promise.all(stages.map(([, statuses]) => prisma.orderFulfillment.count({ where: { status: { in: statuses } } }))),
      prisma.orderFulfillment.count({
        where: {
          status: { notIn: [FulfillmentStatus.COMPLETED, FulfillmentStatus.EXCEPTION] },
          createdAt: { lt: new Date(now.getTime() - OVERDUE_AFTER_MS) }
        }
      }),
      prisma.orderFulfillment.count({ where: { packedAt: current } }),
      prisma.orderFulfillment.count({ where: { packedAt: previous } }),
      prisma.orderFulfillment.count({ where: { completedAt: current } }),
      prisma.orderFulfillment.count({ where: { completedAt: previous } }),
      prisma.orderFulfillment.count({ where: { deliveryFailedAt: current } }),
      // The event the operations API writes for 无码补登 (CODELESS_COMPLETION_ACTION
      // in apps/api/src/operations/operations-fulfillment-state.ts).
      prisma.fulfillmentEvent.count({ where: { action: "CODELESS_COMPLETION", createdAt: current } }),
      prisma.orderFulfillment.groupBy({
        by: ["assignedPickerEmployeeId"],
        where: { pickedAt: current, assignedPickerEmployeeId: { not: null } },
        _count: true
      }),
      prisma.orderFulfillment.groupBy({
        by: ["packedByEmployeeId"],
        where: { packedAt: current, packedByEmployeeId: { not: null } },
        _count: true
      })
    ]);

  const work = new Map<string, { picked: number; packed: number }>();
  for (const row of pickers) {
    if (row.assignedPickerEmployeeId) work.set(row.assignedPickerEmployeeId, { picked: row._count, packed: 0 });
  }
  for (const row of packers) {
    if (!row.packedByEmployeeId) continue;
    const entry = work.get(row.packedByEmployeeId) ?? { picked: 0, packed: 0 };
    entry.packed = row._count;
    work.set(row.packedByEmployeeId, entry);
  }
  const employees = work.size
    ? await prisma.employee.findMany({ where: { id: { in: [...work.keys()] } }, select: { id: true, name: true } })
    : [];
  const names = new Map(employees.map((employee) => [employee.id, employee.name]));

  return {
    queues: Object.fromEntries(stages.map(([key], index) => [key, queueCounts[index]])) as BusinessReport["warehouse"]["queues"],
    overdue,
    packed: { current: packedNow, previous: packedBefore },
    completed: { current: completedNow, previous: completedBefore },
    deliveryFailures,
    codelessCompletions,
    byEmployee: [...work.entries()]
      .map(([id, counts]) => ({ name: names.get(id) ?? "Unknown", ...counts }))
      .sort((a, b) => b.picked + b.packed - (a.picked + a.packed))
  };
}

/**
 * Reads what the 分销团队增长 section needs. The counting, and the rule that
 * tells staff promoters from external ones, live in affiliate-team.ts.
 */
async function readAffiliateTeam(current: Range, previous: Range) {
  const notRejected = { not: CommissionStatus.REJECTED };
  const [affiliates, employees, adminUsers, clicksNow, clicksBefore, lastClicks, commissionNow, commissionBefore, paid] =
    await Promise.all([
      prisma.affiliate.findMany({
        select: {
          id: true,
          displayName: true,
          affiliateCode: true,
          phone: true,
          email: true,
          status: true,
          createdAt: true,
          disabledAt: true,
          customer: { select: { phone: true, email: true } }
        }
      }),
      prisma.employee.findMany({
        where: { status: EmployeeStatus.ACTIVE },
        select: { employeeCode: true, name: true, phone: true }
      }),
      prisma.adminUser.findMany({
        where: { status: AdminUserStatus.ACTIVE },
        select: { loginAccount: true, name: true, phone: true, email: true }
      }),
      prisma.affiliateClick.groupBy({ by: ["affiliateId"], where: { clickedAt: current }, _count: { _all: true } }),
      prisma.affiliateClick.groupBy({ by: ["affiliateId"], where: { clickedAt: previous }, _count: { _all: true } }),
      prisma.affiliateClick.groupBy({ by: ["affiliateId"], _max: { clickedAt: true } }),
      prisma.commission.groupBy({
        by: ["affiliateId"],
        where: { createdAt: current, status: notRejected },
        _sum: { commissionAmountKsh: true }
      }),
      prisma.commission.groupBy({
        by: ["affiliateId"],
        where: { createdAt: previous, status: notRejected },
        _sum: { commissionAmountKsh: true }
      }),
      prisma.commission.aggregate({ where: { paidAt: current }, _sum: { commissionAmountKsh: true } })
    ]);

  const staff: StaffRow[] = [
    ...employees.map((e) => ({ label: e.employeeCode, name: e.name, phones: [e.phone], emails: [] })),
    // The login account is often a phone number or an email address.
    ...adminUsers.map((u) => ({
      label: u.loginAccount,
      name: u.name,
      phones: [u.phone, u.loginAccount],
      emails: [u.email, u.loginAccount]
    }))
  ];
  const counts = (rows: typeof clicksNow) => rows.map((r) => ({ affiliateId: r.affiliateId, count: r._count._all }));
  const amounts = (rows: typeof commissionNow) =>
    rows.map((r) => ({ affiliateId: r.affiliateId, amountKsh: r._sum.commissionAmountKsh ?? 0 }));

  return {
    affiliates,
    staff,
    clicks: { current: counts(clicksNow), previous: counts(clicksBefore) },
    lastClicks: lastClicks.map((r) => ({ affiliateId: r.affiliateId, lastClickAt: r._max.clickedAt })),
    commission: { current: amounts(commissionNow), previous: amounts(commissionBefore) },
    commissionPaidKsh: paid._sum.commissionAmountKsh ?? 0
  };
}

async function collectAfterSales(current: Range, previous: Range, now: Date): Promise<BusinessReport["afterSales"]> {
  const [returnsNow, returnsBefore, returnsReceived, casesNow, casesBefore, openCases, overdueCases, pendingRefunds] =
    await Promise.all([
      prisma.afterSaleReturn.count({ where: { requestedAt: current } }),
      prisma.afterSaleReturn.count({ where: { requestedAt: previous } }),
      prisma.afterSaleReturn.count({
        where: { receivedAt: current, status: { not: AfterSaleReturnStatus.REJECTED } }
      }),
      prisma.customerServiceCase.count({ where: { createdAt: current } }),
      prisma.customerServiceCase.count({ where: { createdAt: previous } }),
      prisma.customerServiceCase.count({ where: { status: { in: OPEN_CASE_STATUSES } } }),
      prisma.customerServiceCase.count({ where: { status: { in: OPEN_CASE_STATUSES }, slaDueAt: { lt: now } } }),
      prisma.refundRequest.aggregate({
        where: { status: RefundRequestStatus.PENDING_APPROVAL },
        _count: true,
        _sum: { amountKsh: true }
      })
    ]);
  return {
    returnsRequested: { current: returnsNow, previous: returnsBefore },
    returnsReceived,
    casesOpened: { current: casesNow, previous: casesBefore },
    openCases,
    overdueCases,
    refundsAwaitingApproval: pendingRefunds._count,
    refundsAwaitingApprovalKsh: pendingRefunds._sum.amountKsh ?? 0
  };
}

function sum<T>(rows: T[], pick: (row: T) => number) {
  return rows.reduce((total, row) => total + pick(row), 0);
}
