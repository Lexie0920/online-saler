import { Injectable, NotFoundException } from "@nestjs/common";
import {
  CustomerServiceCaseStatus,
  CustomerServiceIssueType,
  FulfillmentStatus,
  OrderStatus,
  PaymentStatus,
  Prisma,
  RefundRequestStatus,
  prisma
} from "@online-saler/database";
import { isCustomerServiceCaseOverdue, whatsAppLinkForPhone } from "@online-saler/business-rules";
import { OperationsAccessService } from "./operations-access.service";

/**
 * The customer service desk: find the person, then answer the one question they
 * actually asked, which is almost always "where is my order?".
 *
 * Everything here is read-only. An agent on the phone needs the whole picture
 * in one place -- payment, fulfillment, who is holding the package right now,
 * which promoter sent the customer, and what support has already done about it
 * -- without being able to change any of it. Every write lives behind its own
 * permission in a different service.
 */

const CUSTOMER_SERVICE_VIEW = "action.customer-service.view";

/** A garment is one of one, so an item is only ever identified by its barcode. */
const ORDER_360_INCLUDE = {
  customer: true,
  affiliate: { select: { id: true, code: true, displayName: true, phone: true, status: true } },
  fulfillmentNode: { select: { id: true, code: true, name: true, address: true, phone: true, mapsUrl: true } },
  items: { include: { snapshot: true }, orderBy: { createdAt: "asc" as const } },
  payments: { orderBy: { requestedAt: "desc" as const } },
  fulfillment: {
    include: {
      fulfillmentNode: { select: { id: true, code: true, name: true, phone: true } },
      deliveryRider: { select: { id: true, name: true, phone: true, type: true } }
    }
  },
  fulfillmentEvents: {
    include: {
      actorEmployee: { select: { name: true } },
      actorAdminUser: { select: { name: true } },
      deliveryRider: { select: { name: true } }
    },
    orderBy: { createdAt: "asc" as const }
  },
  customerServiceCases: {
    include: {
      assignedAdminUser: { select: { id: true, name: true } },
      createdByAdminUser: { select: { id: true, name: true } },
      notes: { include: { authorAdminUser: { select: { name: true } } }, orderBy: { createdAt: "desc" as const } }
    },
    orderBy: { createdAt: "desc" as const }
  },
  customerServiceNotes: {
    include: { authorAdminUser: { select: { name: true } } },
    orderBy: { createdAt: "desc" as const }
  },
  afterSaleReturns: {
    include: {
      orderItem: { include: { snapshot: { select: { title: true, barcode: true } } } },
      returnNode: { select: { id: true, code: true, name: true } }
    },
    orderBy: { requestedAt: "asc" as const }
  },
  refundRequests: {
    include: {
      requestedByAdminUser: { select: { name: true } },
      reviewedByAdminUser: { select: { name: true } },
      refundRecord: { select: { externalReference: true, refundedAt: true, amountKsh: true } }
    },
    orderBy: { requestedAt: "asc" as const }
  },
  refunds: { orderBy: { recordedAt: "asc" as const } }
} as const;

type Order360Row = Prisma.OrderGetPayload<{ include: typeof ORDER_360_INCLUDE }>;

export type GlobalSearchInput = {
  adminUserId?: string;
  search?: string;
};

type TimelineEntry = {
  at: Date;
  channel: "PAYMENT" | "FULFILLMENT" | "CUSTOMER_SERVICE";
  action: string;
  detail: string | null;
  actor: string | null;
};

@Injectable()
export class OperationsCustomerServiceDeskService {
  constructor(private readonly access: OperationsAccessService) {}

  /**
   * One box, three ways in: phone, order number, or name.
   *
   * The phone is the important one. Most customers here check out as guests, so
   * they have no account and no email -- the number they paid from is the only
   * thing that identifies them, and it is the thing they can read out over a
   * bad line.
   */
  async search(input: GlobalSearchInput) {
    await this.access.requirePermission(input.adminUserId, CUSTOMER_SERVICE_VIEW);
    const search = input.search?.trim();
    if (!search) return { search: "", customers: [], orders: [] };

    const [customers, orders] = await Promise.all([
      prisma.customer.findMany({
        where: customerSearchWhere(search),
        select: {
          id: true,
          displayName: true,
          email: true,
          phone: true,
          normalizedPhone: true,
          defaultAddress: true,
          status: true,
          createdAt: true,
          _count: { select: { orders: true, customerServiceCases: true } },
          orders: {
            select: {
              id: true,
              orderNumber: true,
              status: true,
              totalKsh: true,
              createdAt: true,
              fulfillmentMethod: true,
              whatsappPhone: true,
              fulfillment: { select: { status: true, currentHolderLabel: true } }
            },
            orderBy: { createdAt: "desc" },
            take: 10
          }
        },
        orderBy: { updatedAt: "desc" },
        take: 25
      }),
      prisma.order.findMany({
        where: orderSearchWhere(search),
        select: {
          id: true,
          orderNumber: true,
          status: true,
          totalKsh: true,
          createdAt: true,
          fulfillmentMethod: true,
          customer: { select: { id: true, displayName: true, phone: true, email: true } },
          fulfillment: { select: { status: true, currentHolderLabel: true } },
          _count: { select: { customerServiceCases: true } }
        },
        orderBy: { createdAt: "desc" },
        take: 40
      })
    ]);

    return {
      search,
      customers: customers.map((customer) => ({
        ...customer,
        whatsAppUrl: whatsAppLinkForPhone(customer.phone ?? customer.normalizedPhone)
      })),
      orders
    };
  }

  /**
   * Everything about one order on one screen, so nobody has to ring the
   * warehouse, the store manager or the rider to answer the customer.
   *
   * Neither the pickup code nor the delivery code is in here, and neither is
   * the delivery code's hash. Four digits is ten thousand guesses, so a hash in
   * a JSON response is the code. Customer service resends a code; it never
   * reads one.
   */
  async order360(orderId: string, adminUserId?: string) {
    await this.access.requirePermission(adminUserId, CUSTOMER_SERVICE_VIEW);
    const order = await prisma.order.findUnique({ where: { id: orderId }, include: ORDER_360_INCLUDE });
    if (!order) throw new NotFoundException("Order was not found.");
    return this.presentOrder360(order);
  }

  /** The same view, reached the way a customer reads their number out. */
  async order360ByNumber(orderNumber: string, adminUserId?: string) {
    await this.access.requirePermission(adminUserId, CUSTOMER_SERVICE_VIEW);
    const order = await prisma.order.findUnique({
      where: { orderNumber: orderNumber.trim().toUpperCase() },
      include: ORDER_360_INCLUDE
    });
    if (!order) throw new NotFoundException("Order was not found.");
    return this.presentOrder360(order);
  }

  private presentOrder360(order: Order360Row) {
    // An exchange top-up is extra money on the same order; the desk shows the order's own payment.
    const orderPayments = order.payments.filter((payment) => payment.kind !== "EXCHANGE_TOPUP");
    const latestPayment = orderPayments[0] ?? order.payments[0] ?? null;
    const successfulPayment = orderPayments.find((payment) => payment.status === PaymentStatus.SUCCESS) ?? null;
    const fulfillment = order.fulfillment;
    const now = new Date();

    return {
      customer: {
        id: order.customer.id,
        name: order.customer.displayName,
        email: order.customer.email,
        phone: order.customer.phone,
        whatsappPhone: order.whatsappPhone ?? order.customer.phone,
        whatsAppUrl: whatsAppLinkForPhone(order.whatsappPhone ?? order.customer.phone, `Direct Loop, order ${order.orderNumber}`),
        defaultAddress: order.customer.defaultAddress,
        status: order.customer.status
      },
      order: {
        id: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        fulfillmentMethod: order.fulfillmentMethod,
        deliveryAddress: order.deliveryAddress,
        deliveryNote: order.deliveryNote,
        itemSubtotalKsh: order.itemSubtotalKsh,
        deliveryFeeKsh: order.deliveryFeeKsh,
        totalKsh: order.totalKsh,
        currency: order.currency,
        createdAt: order.createdAt,
        node: order.fulfillmentNode,
        items: order.items.map((item) => ({
          id: item.id,
          productId: item.productId,
          quantity: item.quantity,
          unitPriceKsh: item.unitPriceKsh,
          lineTotalKsh: item.lineTotalKsh,
          title: item.snapshot?.title ?? null,
          barcode: item.snapshot?.barcode ?? null,
          sizeLabel: item.snapshot?.sizeLabel ?? null,
          imageUrl: item.snapshot?.imageUrl ?? null
        }))
      },
      payment: {
        status: latestPayment?.status ?? null,
        paidAt: successfulPayment?.completedAt ?? null,
        // The M-Pesa receipt is what the customer reads off their own SMS, so
        // it is the one reference that lets an agent match their story to ours.
        transactionReference: successfulPayment?.providerReceiptNumber ?? null,
        amountKsh: successfulPayment?.amountKsh ?? latestPayment?.amountKsh ?? null,
        phone: latestPayment?.phone ?? null,
        resultDescription: latestPayment?.providerResultDescription ?? null,
        attempts: order.payments.map((payment) => ({
          status: payment.status,
          amountKsh: payment.amountKsh,
          phone: payment.phone,
          requestedAt: payment.requestedAt,
          completedAt: payment.completedAt,
          transactionReference: payment.providerReceiptNumber,
          resultDescription: payment.providerResultDescription
        }))
      },
      fulfillment: fulfillment
        ? {
            status: fulfillment.status,
            node: fulfillment.fulfillmentNode,
            rider: fulfillment.deliveryRider
              ? { ...fulfillment.deliveryRider }
              : fulfillment.deliveryRiderName
                ? { id: null, name: fulfillment.deliveryRiderName, phone: fulfillment.deliveryRiderPhone, type: null }
                : null,
            holder: { type: fulfillment.currentHolderType, label: fulfillment.currentHolderLabel },
            exceptionReason: fulfillment.exceptionReason,
            exceptionNote: fulfillment.exceptionNote,
            deliveryAttemptCount: fulfillment.deliveryAttemptCount,
            deliveryFailureReason: fulfillment.deliveryFailureReason,
            // How many times a code went out, never the code itself.
            deliveryCodeSentCount: fulfillment.deliveryCodeSentCount,
            deliveryCodeIssuedAt: fulfillment.deliveryCodeIssuedAt,
            customerCodeLockedAt: fulfillment.customerCodeLockedAt,
            completedAt: fulfillment.completedAt,
            latestUpdateAt: fulfillment.updatedAt
          }
        : null,
      promoter: order.affiliate
        ? {
            ...order.affiliate,
            source: order.affiliateSource,
            placement: order.affiliatePlacement,
            campaign: order.affiliateCampaign
          }
        : null,
      cases: order.customerServiceCases.map((serviceCase) => ({
        ...serviceCase,
        overdue: isCustomerServiceCaseOverdue(serviceCase, now)
      })),
      notes: order.customerServiceNotes,
      returns: order.afterSaleReturns,
      refundRequests: order.refundRequests,
      refunds: order.refunds,
      timeline: buildTimeline(order)
    };
  }

  /**
   * The numbers a supervisor looks at to decide who to chase, not a report.
   * Every count is work that is still outstanding or happened today.
   */
  async dashboard(adminUserId?: string) {
    await this.access.requirePermission(adminUserId, CUSTOMER_SERVICE_VIEW);
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const unfinished = { in: [CustomerServiceCaseStatus.OPEN, CustomerServiceCaseStatus.IN_PROGRESS] };

    const [
      openCases,
      newToday,
      inProgress,
      resolvedToday,
      overdue,
      escalated,
      unassigned,
      paymentIssues,
      deliveryIssues,
      afterSales,
      pendingRefundRequests,
      byPriority
    ] = await Promise.all([
      prisma.customerServiceCase.count({ where: { status: unfinished } }),
      prisma.customerServiceCase.count({ where: { createdAt: { gte: startOfDay } } }),
      prisma.customerServiceCase.count({ where: { status: CustomerServiceCaseStatus.IN_PROGRESS } }),
      prisma.customerServiceCase.count({ where: { resolvedAt: { gte: startOfDay } } }),
      // Overdue is defined once, in business rules; this is the same test
      // expressed as a query so the dashboard does not load every open case.
      prisma.customerServiceCase.count({ where: { status: unfinished, slaDueAt: { not: null, lte: now } } }),
      prisma.customerServiceCase.count({ where: { status: unfinished, escalated: true } }),
      prisma.customerServiceCase.count({ where: { status: unfinished, assignedAdminUserId: null } }),
      prisma.customerServiceCase.count({ where: { status: unfinished, issueType: CustomerServiceIssueType.PAYMENT } }),
      prisma.customerServiceCase.count({ where: { status: unfinished, issueType: CustomerServiceIssueType.DELIVERY } }),
      prisma.customerServiceCase.count({ where: { status: unfinished, issueType: CustomerServiceIssueType.AFTER_SALE } }),
      prisma.refundRequest.count({ where: { status: RefundRequestStatus.PENDING_APPROVAL } }),
      prisma.customerServiceCase.groupBy({ by: ["priority"], where: { status: unfinished }, _count: true })
    ]);

    return {
      openCases,
      newToday,
      inProgress,
      resolvedToday,
      overdue,
      escalated,
      unassigned,
      paymentIssues,
      deliveryIssues,
      afterSales,
      pendingRefundRequests,
      byPriority: Object.fromEntries(byPriority.map((row) => [row.priority, row._count]))
    };
  }
}

/**
 * Guests have no email and often no name, so the phone is the search. Shoppers
 * read it out as "0712..." while M-Pesa stores it as "254712...", so the last
 * nine digits are matched too -- that is the part both forms share.
 */
function customerSearchWhere(search: string): Prisma.CustomerWhereInput {
  const digits = search.replace(/\D/g, "");
  const phoneTail = digits.length >= 9 ? digits.slice(-9) : "";
  return {
    OR: [
      { displayName: { contains: search, mode: "insensitive" } },
      { email: { contains: search, mode: "insensitive" } },
      { phone: { contains: search, mode: "insensitive" } },
      ...(phoneTail ? [{ phone: { contains: phoneTail } }, { normalizedPhone: { contains: phoneTail } }] : []),
      // A customer found by their order number: the agent has the number in
      // front of them and does not yet know whose it is.
      { orders: { some: { orderNumber: { contains: search, mode: "insensitive" } } } }
    ]
  };
}

function orderSearchWhere(search: string): Prisma.OrderWhereInput {
  const digits = search.replace(/\D/g, "");
  const phoneTail = digits.length >= 9 ? digits.slice(-9) : "";
  return {
    OR: [
      { orderNumber: { contains: search, mode: "insensitive" } },
      { customer: { displayName: { contains: search, mode: "insensitive" } } },
      { customer: { phone: { contains: search, mode: "insensitive" } } },
      ...(phoneTail
        ? [
            { customer: { phone: { contains: phoneTail } } },
            { customer: { normalizedPhone: { contains: phoneTail } } },
            // The number that actually paid, which is not always the number on
            // the account: someone else can pay for you on M-Pesa.
            { payments: { some: { phone: { contains: phoneTail } } } }
          ]
        : []),
      { items: { some: { snapshot: { is: { barcode: { contains: search, mode: "insensitive" } } } } } }
    ]
  };
}

/**
 * One chronology out of three separate histories: what the money did, what the
 * package did, and what support did about it. Sorted oldest first, because an
 * agent reads it out as a story.
 */
function buildTimeline(order: Order360Row): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  for (const payment of order.payments) {
    entries.push({
      at: payment.requestedAt,
      channel: "PAYMENT",
      action: "PAYMENT_REQUESTED",
      detail: `KSh ${payment.amountKsh} requested on ${payment.phone}.`,
      actor: null
    });
    if (payment.completedAt) {
      entries.push({
        at: payment.completedAt,
        channel: "PAYMENT",
        action: `PAYMENT_${payment.status}`,
        detail: payment.providerReceiptNumber
          ? `M-Pesa ${payment.providerReceiptNumber}.`
          : payment.providerResultDescription,
        actor: null
      });
    }
    if (payment.reviewedAt) {
      entries.push({
        at: payment.reviewedAt,
        channel: "PAYMENT",
        action: `PAYMENT_REVIEW_${payment.reviewDecision ?? "RECORDED"}`,
        detail: payment.reviewNote,
        actor: null
      });
    }
  }

  for (const event of order.fulfillmentEvents) {
    entries.push({
      at: event.createdAt,
      channel: "FULFILLMENT",
      action: event.action,
      detail: event.note,
      actor: event.actorEmployee?.name ?? event.actorAdminUser?.name ?? event.deliveryRider?.name ?? null
    });
  }

  for (const serviceCase of order.customerServiceCases) {
    entries.push({
      at: serviceCase.createdAt,
      channel: "CUSTOMER_SERVICE",
      action: `CASE_OPENED_${serviceCase.caseType}`,
      detail: serviceCase.title,
      actor: serviceCase.createdByAdminUser?.name ?? null
    });
    if (serviceCase.escalatedAt) {
      entries.push({
        at: serviceCase.escalatedAt,
        channel: "CUSTOMER_SERVICE",
        action: `CASE_ESCALATED_${serviceCase.escalatedTo ?? "ADMIN"}`,
        detail: serviceCase.escalationNote,
        actor: null
      });
    }
    if (serviceCase.resolvedAt) {
      entries.push({
        at: serviceCase.resolvedAt,
        channel: "CUSTOMER_SERVICE",
        action: `CASE_${serviceCase.status}`,
        detail: serviceCase.title,
        actor: serviceCase.assignedAdminUser?.name ?? null
      });
    }
    for (const note of serviceCase.notes) {
      entries.push({
        at: note.createdAt,
        channel: "CUSTOMER_SERVICE",
        action: "INTERNAL_NOTE",
        detail: note.body,
        actor: note.authorAdminUser?.name ?? null
      });
    }
  }

  // Notes written straight onto the order or customer, with no case yet.
  for (const note of order.customerServiceNotes.filter((row) => !row.caseId)) {
    entries.push({
      at: note.createdAt,
      channel: "CUSTOMER_SERVICE",
      action: "INTERNAL_NOTE",
      detail: note.body,
      actor: note.authorAdminUser?.name ?? null
    });
  }

  for (const request of order.refundRequests) {
    entries.push({
      at: request.requestedAt,
      channel: "CUSTOMER_SERVICE",
      action: "REFUND_REQUESTED",
      detail: `KSh ${request.amountKsh}: ${request.reason}`,
      actor: request.requestedByAdminUser?.name ?? null
    });
    if (request.reviewedAt) {
      entries.push({
        at: request.reviewedAt,
        channel: "CUSTOMER_SERVICE",
        action: `REFUND_${request.status}`,
        detail: request.reviewNote,
        actor: request.reviewedByAdminUser?.name ?? null
      });
    }
  }

  for (const refund of order.refunds) {
    entries.push({
      at: refund.refundedAt,
      channel: "PAYMENT",
      action: "REFUND_PAID",
      detail: `KSh ${refund.amountKsh} sent, reference ${refund.externalReference}.`,
      actor: null
    });
  }

  return entries.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Order states an agent should read as "this order is still in progress". */
export const OPEN_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.PAYMENT_PROCESSING,
  // Half paid and waiting on the balance. The shopper has money with us and
  // will call about it, so an agent has to find the order.
  OrderStatus.DEPOSIT_PAID,
  OrderStatus.PAID,
  OrderStatus.FULFILLING
];

/** Fulfillment states where the package has not reached the customer yet. */
export const IN_FLIGHT_FULFILLMENT_STATUSES: FulfillmentStatus[] = [
  FulfillmentStatus.PAID,
  FulfillmentStatus.PICKING,
  FulfillmentStatus.READY_TO_PACK,
  FulfillmentStatus.PACKED,
  FulfillmentStatus.IN_TRANSIT_TO_NODE,
  FulfillmentStatus.ARRIVED_AT_NODE,
  FulfillmentStatus.READY_FOR_PICKUP,
  FulfillmentStatus.READY_FOR_DISPATCH,
  FulfillmentStatus.OUT_FOR_DELIVERY,
  FulfillmentStatus.EXCEPTION
];
