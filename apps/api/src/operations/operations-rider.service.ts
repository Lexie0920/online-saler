import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import {
  ActorType,
  DeliveryRiderType,
  FulfillmentStatus,
  Prisma,
  SourceApp,
  normalizeNotificationPhone,
  prisma
} from "@online-saler/database";
import { OperationsAccessService } from "./operations-access.service";
import { nairobiDay, payoutWeek } from "./operations-payout-sheet";
import {
  OperationsFulfillmentService,
  type DeliveryCodeInput,
  type DeliveryFailureInput,
  type DropOffInput,
  type RiderActor
} from "./operations-fulfillment.service";

/**
 * The rider side of the loop, and the store's roster of riders.
 *
 * Riders are not a logistics company. They are the people who ride out of one
 * store, so a rider belongs to a node, signs in with their own account, and can
 * only ever see the deliveries that node handed to them. Everything about money
 * — the order total, the commission, what the garment cost — is absent from
 * every response here, not filtered out in the UI.
 */

export type RiderRosterInput = {
  adminUserId?: string;
  nodeId?: string;
};

export type RiderUpsertInput = {
  adminUserId?: string;
  riderId?: string;
  name?: string;
  phone?: string;
  nodeId?: string;
  employeeId?: string;
  loginAccount?: string;
  active?: boolean;
  note?: string;
};

/** Statuses a rider still has work to do on. */
const RIDER_OPEN_STATUSES: FulfillmentStatus[] = [
  FulfillmentStatus.OUT_FOR_DELIVERY,
  FulfillmentStatus.DELIVERY_FAILED,
  FulfillmentStatus.RETURNING_TO_NODE
];

@Injectable()
export class OperationsRiderService {
  constructor(
    private readonly access: OperationsAccessService,
    private readonly fulfillment: OperationsFulfillmentService
  ) {}

  /**
   * Resolves the signed-in account to the rider it belongs to. A rider who has
   * been stood down keeps their login but gets no deliveries, so a store can
   * deactivate someone mid-shift without deleting their history.
   */
  private async requireRider(adminUserId?: string): Promise<RiderActor & { fulfillmentNodeId: string | null }> {
    await this.access.requirePermission(adminUserId, "rider.deliveries");
    const rider = await prisma.deliveryRider.findFirst({
      where: { adminUserId: adminUserId?.trim() || "" },
      include: { employee: { select: { id: true } } }
    });
    if (!rider) throw new ForbiddenException("This account is not linked to a rider.");
    if (!rider.active) throw new ForbiddenException("This rider account is not active. Ask the staff at your store.");
    return {
      id: rider.id,
      name: rider.name,
      employeeId: rider.employee?.id ?? rider.employeeId ?? null,
      fulfillmentNodeId: rider.fulfillmentNodeId
    };
  }

  /** Who the rider is and which store they ride for. */
  async me(adminUserId?: string) {
    const rider = await this.requireRider(adminUserId);
    const node = rider.fulfillmentNodeId
      ? await prisma.fulfillmentNode.findUnique({ where: { id: rider.fulfillmentNodeId }, select: { name: true, phone: true } })
      : null;
    return { riderId: rider.id, name: rider.name, nodeName: node?.name ?? null, nodePhone: node?.phone ?? null };
  }

  /**
   * The rider's own work list. Scoped by `deliveryRiderId` in the query itself,
   * so there is no route by which one rider can read another's deliveries.
   */
  async myDeliveries(adminUserId?: string) {
    const rider = await this.requireRider(adminUserId);
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const thisWeek = payoutWeek(nairobiDay(new Date()), new Date());
    const [open, completedToday, failedToday, earnedThisWeek, unsettled, settledThisWeek, lastPayout] = await Promise.all([
      prisma.order.findMany({
        where: { fulfillment: { is: { deliveryRiderId: rider.id, status: { in: RIDER_OPEN_STATUSES } } } },
        include: RIDER_ORDER_INCLUDE,
        orderBy: { createdAt: "asc" }
      }),
      prisma.orderFulfillment.count({
        where: { deliveryRiderId: rider.id, status: FulfillmentStatus.COMPLETED, completedAt: { gte: startOfToday } }
      }),
      prisma.orderFulfillment.count({
        where: { deliveryRiderId: rider.id, deliveryFailedAt: { gte: startOfToday } }
      }),
      // The rider's own pay only (本周已结算 / 待结算); never an order's money.
      prisma.orderFulfillment.aggregate({
        where: { deliveryRiderId: rider.id, status: FulfillmentStatus.COMPLETED, riderFeeKsh: { gt: 0 }, completedAt: { gte: thisWeek.start, lt: thisWeek.end } },
        _sum: { riderFeeKsh: true },
        _count: { _all: true }
      }),
      prisma.orderFulfillment.aggregate({
        where: { deliveryRiderId: rider.id, status: FulfillmentStatus.COMPLETED, riderFeeKsh: { gt: 0 }, riderFeePayoutId: null },
        _sum: { riderFeeKsh: true },
        _count: { _all: true }
      }),
      prisma.payout.aggregate({
        where: { deliveryRiderId: rider.id, paidAt: { gte: thisWeek.start, lt: thisWeek.end } },
        _sum: { amountKsh: true }
      }),
      prisma.payout.findFirst({
        where: { deliveryRiderId: rider.id },
        orderBy: { paidAt: "desc" },
        select: { amountKsh: true, mpesaCode: true, paidAt: true, itemCount: true }
      })
    ]);

    return {
      rider: { id: rider.id, name: rider.name },
      counts: {
        awaitingDelivery: open.filter((order) => order.fulfillment?.status === FulfillmentStatus.OUT_FOR_DELIVERY).length,
        completedToday,
        failedToday
      },
      pay: {
        earnedThisWeekKsh: earnedThisWeek._sum.riderFeeKsh ?? 0,
        earnedThisWeekCount: earnedThisWeek._count._all,
        unsettledKsh: unsettled._sum.riderFeeKsh ?? 0,
        unsettledCount: unsettled._count._all,
        settledThisWeekKsh: settledThisWeek._sum.amountKsh ?? 0,
        lastPayout: lastPayout ? { ...lastPayout, paidAt: lastPayout.paidAt.toISOString() } : null
      },
      deliveries: open.map((order) => this.fulfillment.riderDeliveryView(order))
    };
  }

  async completeDelivery(orderId: string, input: DeliveryCodeInput) {
    const rider = await this.requireRider(input.adminUserId);
    return this.fulfillment.completeRiderDelivery(orderId, input, rider);
  }

  async authorizedDropOff(orderId: string, input: DropOffInput) {
    const rider = await this.requireRider(input.adminUserId);
    return this.fulfillment.completeAuthorizedDropOff(orderId, input, rider);
  }

  async markFailed(orderId: string, input: DeliveryFailureInput) {
    const rider = await this.requireRider(input.adminUserId);
    await this.fulfillment.markDeliveryFailed(orderId, input, rider);
    return this.myDeliveries(input.adminUserId);
  }

  async startReturn(orderId: string, input: DeliveryFailureInput) {
    const rider = await this.requireRider(input.adminUserId);
    await this.fulfillment.startReturnToNode(orderId, input, rider);
    return this.myDeliveries(input.adminUserId);
  }

  // ---------------------------------------------------------------- roster ---

  /**
   * The riders of one store. A store manager with a home node sees only their
   * own; head office, which has no home node, can look at any of them.
   */
  async roster(input: RiderRosterInput) {
    const session = await this.access.requirePermission(input.adminUserId, "riders.view");
    const homeNodeId = await this.homeNodeId(session.adminUser?.linkedEmployee?.id ?? null);
    const nodeId = homeNodeId ?? input.nodeId?.trim() ?? null;
    if (homeNodeId && input.nodeId?.trim() && input.nodeId.trim() !== homeNodeId) {
      throw new ForbiddenException("You can only manage the riders of your own node.");
    }

    const riders = await prisma.deliveryRider.findMany({
      where: {
        type: DeliveryRiderType.INTERNAL,
        ...(nodeId ? { fulfillmentNodeId: nodeId } : {})
      },
      include: {
        fulfillmentNode: { select: { id: true, name: true } },
        adminUser: { select: { loginAccount: true, status: true } }
      },
      orderBy: [{ active: "desc" }, { name: "asc" }]
    });

    const openByRider = await prisma.orderFulfillment.groupBy({
      by: ["deliveryRiderId"],
      where: { deliveryRiderId: { in: riders.map((rider) => rider.id) }, status: { in: RIDER_OPEN_STATUSES } },
      _count: true
    });
    const open = new Map(openByRider.map((row) => [row.deliveryRiderId, row._count]));

    return riders.map((rider) => ({
      id: rider.id,
      name: rider.name,
      phone: rider.phone,
      active: rider.active,
      nodeId: rider.fulfillmentNode?.id ?? null,
      nodeName: rider.fulfillmentNode?.name ?? null,
      loginAccount: rider.adminUser?.loginAccount ?? null,
      canSignIn: Boolean(rider.adminUserId),
      openDeliveries: open.get(rider.id) ?? 0
    }));
  }

  /** Adds a rider to a node. Their login is created separately, in Accounts. */
  async addRider(input: RiderUpsertInput) {
    const actor = await this.rosterActor(input.adminUserId);
    const name = input.name?.trim();
    if (!name) throw new BadRequestException("A rider needs a name.");
    const phone = input.phone?.trim() ? normalizeNotificationPhone(input.phone) : null;
    if (input.phone?.trim() && !phone) {
      throw new BadRequestException("Enter the rider's phone as a Kenyan mobile number, for example 0712345678.");
    }
    const nodeId = await this.resolveNode(actor.homeNodeId, input.nodeId);
    const adminUserId = await this.resolveLogin(input.loginAccount);

    const rider = await prisma.deliveryRider.create({
      data: {
        type: DeliveryRiderType.INTERNAL,
        name,
        phone,
        fulfillmentNodeId: nodeId,
        active: input.active ?? true,
        employeeId: input.employeeId?.trim() || null,
        adminUserId
      }
    });
    await this.audit(actor, rider.id, "ADD_DELIVERY_RIDER", {}, rider, input.note?.trim() || "New store rider.");
    return rider;
  }

  /** Renames a rider, moves their phone, or stands them down. */
  async updateRider(riderId: string, input: RiderUpsertInput) {
    const actor = await this.rosterActor(input.adminUserId);
    const before = await prisma.deliveryRider.findUnique({ where: { id: riderId } });
    if (!before) throw new NotFoundException("Rider was not found.");
    if (actor.homeNodeId && before.fulfillmentNodeId !== actor.homeNodeId) {
      throw new ForbiddenException("This rider belongs to a different node.");
    }
    if (input.active === false) {
      const open = await prisma.orderFulfillment.count({
        where: { deliveryRiderId: riderId, status: { in: RIDER_OPEN_STATUSES } }
      });
      if (open) throw new ConflictException(`${before.name} still has ${open} delivery(ies) in hand. Close or return them first.`);
    }
    const phone = input.phone === undefined ? undefined : (input.phone.trim() ? normalizeNotificationPhone(input.phone) : null);
    if (input.phone?.trim() && !phone) {
      throw new BadRequestException("Enter the rider's phone as a Kenyan mobile number, for example 0712345678.");
    }

    const rider = await prisma.deliveryRider.update({
      where: { id: riderId },
      data: {
        ...(input.name?.trim() ? { name: input.name.trim() } : {}),
        ...(phone !== undefined ? { phone } : {}),
        ...(typeof input.active === "boolean" ? { active: input.active } : {}),
        ...(input.loginAccount !== undefined ? { adminUserId: await this.resolveLogin(input.loginAccount) } : {})
      }
    });
    await this.audit(actor, riderId, "UPDATE_DELIVERY_RIDER", before, rider, input.note?.trim() || "Rider details changed.");
    return rider;
  }

  private async rosterActor(adminUserId?: string) {
    const session = await this.access.requirePermission(adminUserId, "riders.manage");
    const adminUser = session.adminUser;
    if (!adminUser) throw new ForbiddenException("This action requires an admin account.");
    return {
      actorAdminUserId: adminUser.id,
      actorEmployeeId: adminUser.linkedEmployee?.id ?? null,
      homeNodeId: await this.homeNodeId(adminUser.linkedEmployee?.id ?? null)
    };
  }

  /**
   * The node this person works at, or null for warehouse and head office. The
   * session only carries the employee's name and code, so the home node is read
   * here rather than trusted from the request.
   */
  private async homeNodeId(employeeId: string | null) {
    if (!employeeId) return null;
    const employee = await prisma.employee.findUnique({ where: { id: employeeId }, select: { homeNodeId: true } });
    return employee?.homeNodeId ?? null;
  }

  /** Store staff may only add riders to their own node. */
  private async resolveNode(homeNodeId: string | null, requested?: string) {
    const nodeId = homeNodeId ?? requested?.trim() ?? null;
    if (!nodeId) throw new BadRequestException("Choose the node this rider rides for.");
    if (homeNodeId && requested?.trim() && requested.trim() !== homeNodeId) {
      throw new ForbiddenException("You can only add riders to your own node.");
    }
    const node = await prisma.fulfillmentNode.findUnique({ where: { id: nodeId } });
    if (!node) throw new NotFoundException("Node was not found.");
    return node.id;
  }

  /** Links an existing admin account to this rider so they can sign in. */
  private async resolveLogin(loginAccount?: string) {
    const login = loginAccount?.trim().toLowerCase();
    if (!login) return null;
    const adminUser = await prisma.adminUser.findUnique({ where: { loginAccount: login }, select: { id: true } });
    if (!adminUser) throw new NotFoundException(`No admin account is called ${login}. Create it in Accounts first.`);
    const taken = await prisma.deliveryRider.findFirst({ where: { adminUserId: adminUser.id }, select: { id: true, name: true } });
    if (taken) throw new ConflictException(`That login already belongs to ${taken.name}.`);
    return adminUser.id;
  }

  private async audit(
    actor: { actorAdminUserId: string; actorEmployeeId: string | null },
    entityId: string,
    action: string,
    beforeJson: unknown,
    afterJson: unknown,
    reason: string
  ) {
    await prisma.auditLog.create({
      data: {
        actorType: ActorType.EMPLOYEE,
        actorId: actor.actorEmployeeId,
        actorAdminUserId: actor.actorAdminUserId,
        sourceApp: SourceApp.OPERATIONS,
        module: "ORDERS",
        entityType: "DeliveryRider",
        entityId,
        action,
        beforeJson: json(beforeJson),
        afterJson: json(afterJson),
        reason
      }
    });
  }
}

const RIDER_ORDER_INCLUDE = {
  customer: true,
  items: { include: { snapshot: true }, orderBy: { createdAt: "asc" } },
  fulfillment: { include: { fulfillmentNode: true } }
} as const;

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
}
