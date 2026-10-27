import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import {
  ActorType,
  AffiliateLinkType,
  AffiliateStatus,
  CommissionStatus,
  OrderStatus,
  Prisma,
  SourceApp,
  type Commission,
  prisma
} from "@online-saler/database";
import { LAUNCH_AFFILIATE_COMMISSION_RATE_BPS } from "@online-saler/business-rules";
import { randomBytes } from "node:crypto";
import { OperationsAccessService } from "./operations-access.service";
import { commissionEligibility } from "./operations-commission-policy";

const AFFILIATE_VIEW = "action.affiliate.view";
const AFFILIATE_EDIT = "action.affiliate.edit";
const AFFILIATE_APPROVE = "action.affiliate.approve";
const AFFILIATE_EXPORT = "action.affiliate.export";
const DEFAULT_COMMISSION_SETTING_KEY = "affiliate.defaultCommissionRateBps";
export const commissionOrderInclude = {
  fulfillment: { select: { status: true, completedAt: true } },
  payments: { select: { status: true, amountKsh: true } },
  customerServiceCases: { select: { status: true, issueType: true, requiresReturn: true, requiresRefund: true, affectsAffiliateCommission: true } },
  afterSaleReturns: { select: { status: true } }
} as const;

export type CommissionQueueKey = "pending" | "confirmed" | "paid" | "exceptions";

type AffiliateInput = {
  adminUserId?: string;
  customerId?: string;
  affiliateCode?: string;
  displayName?: string;
  phone?: string;
  email?: string;
  commissionRateBps?: number;
};

type AffiliateUpdateInput = {
  adminUserId?: string;
  status?: AffiliateStatus;
  commissionRateBps?: number | null;
};

type LinkInput = {
  adminUserId?: string;
  affiliateId?: string;
  affiliateCode?: string;
  type?: AffiliateLinkType;
  productId?: string;
  productCode?: string;
  collectionId?: string;
  source?: string;
  placement?: string;
  campaign?: string;
  landingPath?: string;
};

type CommissionActionInput = {
  adminUserId?: string;
  note?: string;
};

@Injectable()
export class OperationsAffiliateService {
  constructor(private readonly access: OperationsAccessService) {}

  async summary(adminUserId?: string) {
    await this.access.requirePermission(adminUserId, AFFILIATE_VIEW);
    const [
      activeAffiliates,
      disabledAffiliates,
      clicks,
      attributedOrders,
      paidOrders,
      pendingCommissions,
      confirmedCommissions,
      paidCommissions,
      sales,
      commissions
    ] = await Promise.all([
      prisma.affiliate.count({ where: { status: AffiliateStatus.ACTIVE } }),
      prisma.affiliate.count({ where: { status: AffiliateStatus.DISABLED } }),
      prisma.affiliateClick.count(),
      prisma.order.count({ where: { affiliateId: { not: null } } }),
      prisma.order.count({ where: { affiliateId: { not: null }, status: { in: [OrderStatus.PAID, OrderStatus.FULFILLING, OrderStatus.COMPLETED] } } }),
      prisma.commission.count({ where: { status: CommissionStatus.PENDING } }),
      prisma.commission.count({ where: { status: CommissionStatus.CONFIRMED } }),
      prisma.commission.count({ where: { status: CommissionStatus.PAID } }),
      prisma.order.aggregate({
        where: { affiliateId: { not: null }, status: { in: [OrderStatus.PAID, OrderStatus.FULFILLING, OrderStatus.COMPLETED] } },
        _sum: { itemSubtotalKsh: true }
      }),
      // Earned commission leaves out rejected ones, same as the storefront Affiliate Center.
      prisma.commission.aggregate({
        where: { status: { not: CommissionStatus.REJECTED } },
        _sum: {
          commissionAmountKsh: true
        }
      })
    ]);

    return {
      activeAffiliates,
      disabledAffiliates,
      clicks,
      attributedOrders,
      paidOrders,
      pendingCommissions,
      confirmedCommissions,
      paidCommissions,
      attributedSalesKsh: sales._sum.itemSubtotalKsh ?? 0,
      earnedCommissionKsh: commissions._sum.commissionAmountKsh ?? 0
    };
  }

  async listAffiliates(adminUserId?: string) {
    await this.access.requirePermission(adminUserId, AFFILIATE_VIEW);
    const affiliates = await prisma.affiliate.findMany({
      include: {
        _count: {
          select: {
            clicks: true,
            orders: true,
            commissions: true
          }
        }
      },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      take: 200
    });
    const ids = affiliates.map((affiliate) => affiliate.id);
    const [commissionSums, paidOrders, lastOrders, lastClicks] = await Promise.all([
      prisma.commission.groupBy({
        by: ["affiliateId", "status"],
        where: { affiliateId: { in: ids } },
        _sum: { commissionAmountKsh: true }
      }),
      prisma.order.groupBy({
        by: ["affiliateId"],
        where: { affiliateId: { in: ids }, status: { in: [OrderStatus.PAID, OrderStatus.FULFILLING, OrderStatus.COMPLETED] } },
        _count: { _all: true },
        _sum: { itemSubtotalKsh: true }
      }),
      prisma.order.groupBy({
        by: ["affiliateId"],
        where: { affiliateId: { in: ids } },
        _max: { createdAt: true }
      }),
      prisma.affiliateClick.groupBy({
        by: ["affiliateId"],
        where: { affiliateId: { in: ids } },
        _max: { clickedAt: true }
      })
    ]);
    const commissionKsh = (affiliateId: string, status: CommissionStatus) =>
      commissionSums.find((row) => row.affiliateId === affiliateId && row.status === status)?._sum.commissionAmountKsh ?? 0;

    return affiliates.map((affiliate) => {
      const paid = paidOrders.find((row) => row.affiliateId === affiliate.id);
      return {
        ...affiliate,
        effectiveCommissionRateBps: LAUNCH_AFFILIATE_COMMISSION_RATE_BPS,
        stats: {
          paidOrders: paid?._count._all ?? 0,
          salesKsh: paid?._sum.itemSubtotalKsh ?? 0,
          pendingCommissionKsh: commissionKsh(affiliate.id, CommissionStatus.PENDING),
          confirmedCommissionKsh: commissionKsh(affiliate.id, CommissionStatus.CONFIRMED),
          paidCommissionKsh: commissionKsh(affiliate.id, CommissionStatus.PAID),
          rejectedCommissionKsh: commissionKsh(affiliate.id, CommissionStatus.REJECTED),
          lastClickAt: lastClicks.find((row) => row.affiliateId === affiliate.id)?._max.clickedAt ?? null,
          lastOrderAt: lastOrders.find((row) => row.affiliateId === affiliate.id)?._max.createdAt ?? null
        },
        storefrontShareUrl: buildShareUrl("/", affiliate.affiliateCode)
      };
    });
  }

  async createAffiliate(input: AffiliateInput) {
    await this.access.requirePermission(input.adminUserId, AFFILIATE_EDIT);
    const linkedCustomer = input.customerId
      ? await prisma.customer.findUnique({ where: { id: input.customerId } })
      : null;
    if (input.customerId && !linkedCustomer) throw new NotFoundException("Customer account was not found.");
    const displayName = input.displayName?.trim() || linkedCustomer?.displayName || linkedCustomer?.email;
    if (!displayName) throw new BadRequestException("Affiliate display name is required.");
    const affiliateCode = normalizeAffiliateCode(input.affiliateCode) ?? await uniqueAffiliateCode(displayName);
    const commissionRateBps = normalizeOptionalRate(input.commissionRateBps);

    return prisma.affiliate.create({
      data: {
        customerId: linkedCustomer?.id ?? null,
        affiliateCode,
        slug: affiliateSlug(displayName, affiliateCode),
        displayName,
        phone: cleanOptional(input.phone) ?? linkedCustomer?.phone ?? null,
        email: cleanOptional(input.email)?.toLowerCase() ?? linkedCustomer?.email?.toLowerCase() ?? null,
        commissionRateBps
      }
    });
  }

  async searchCustomers(adminUserId: string | undefined, query: string | undefined) {
    await this.access.requirePermission(adminUserId, AFFILIATE_VIEW);
    const term = query?.trim();
    if (!term || term.length < 2) return [];
    return prisma.customer.findMany({
      where: {
        OR: [
          { email: { contains: term, mode: "insensitive" } },
          { normalizedEmail: { contains: term.toLowerCase(), mode: "insensitive" } },
          { displayName: { contains: term, mode: "insensitive" } },
          { phone: { contains: term } }
        ]
      },
      include: {
        affiliateProfile: true,
        _count: { select: { orders: true } }
      },
      orderBy: { updatedAt: "desc" },
      take: 20
    });
  }

  async enableCustomerAffiliate(customerId: string, input: AffiliateInput) {
    await this.access.requirePermission(input.adminUserId, AFFILIATE_EDIT);
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      include: { affiliateProfile: true }
    });
    if (!customer) throw new NotFoundException("Customer account was not found.");
    // A guest customer has no email at all, so both the display name and the
    // email-based lookup have to work without one.
    const customerEmail = customer.email?.toLowerCase() ?? null;
    const displayName = input.displayName?.trim() || customer.displayName || customerEmail || customer.phone;
    if (!displayName) throw new BadRequestException("Affiliate display name is required.");
    const commissionRateBps = normalizeOptionalRate(input.commissionRateBps);
    const existing = customer.affiliateProfile ?? (customerEmail
      ? await prisma.affiliate.findFirst({ where: { email: customerEmail } })
      : null);

    if (existing) {
      return prisma.affiliate.update({
        where: { id: existing.id },
        data: {
          customerId: customer.id,
          displayName,
          phone: cleanOptional(input.phone) ?? customer.phone ?? existing.phone,
          email: customerEmail ?? existing.email,
          commissionRateBps: input.commissionRateBps === undefined ? existing.commissionRateBps : commissionRateBps,
          status: AffiliateStatus.ACTIVE,
          disabledAt: null
        }
      });
    }

    const affiliateCode = normalizeAffiliateCode(input.affiliateCode) ?? await uniqueAffiliateCode(displayName);
    return prisma.affiliate.create({
      data: {
        customerId: customer.id,
        affiliateCode,
        slug: affiliateSlug(displayName, affiliateCode),
        displayName,
        phone: cleanOptional(input.phone) ?? customer.phone ?? null,
        email: customerEmail,
        commissionRateBps,
        status: AffiliateStatus.ACTIVE
      }
    });
  }

  async updateAffiliate(affiliateId: string, input: AffiliateUpdateInput) {
    await this.access.requirePermission(input.adminUserId, AFFILIATE_EDIT);
    const data: Record<string, unknown> = {};
    if (input.status) {
      data.status = input.status;
      data.disabledAt = input.status === AffiliateStatus.DISABLED ? new Date() : null;
    }
    if (Object.prototype.hasOwnProperty.call(input, "commissionRateBps")) {
      data.commissionRateBps = normalizeOptionalRate(input.commissionRateBps);
    }
    if (Object.keys(data).length === 0) throw new BadRequestException("No affiliate changes were provided.");
    return prisma.affiliate.update({ where: { id: affiliateId }, data });
  }

  async listLinks(adminUserId?: string) {
    await this.access.requirePermission(adminUserId, AFFILIATE_VIEW);
    const links = await prisma.affiliateLink.findMany({
      include: {
        affiliate: true,
        product: true,
        _count: { select: { clicks: true } }
      },
      orderBy: { createdAt: "desc" },
      take: 200
    });
    return links.map((link) => ({
      ...link,
      shareUrl: buildShareUrl(link.landingPath, link.affiliate.affiliateCode, link.source, link.campaign, link.placement),
      whatsappUrl: `https://wa.me/?text=${encodeURIComponent(buildShareUrl(link.landingPath, link.affiliate.affiliateCode, "whatsapp", link.campaign, link.placement ?? "direct-message"))}`
    }));
  }

  async createLink(input: LinkInput) {
    await this.access.requirePermission(input.adminUserId, AFFILIATE_EDIT);
    const affiliate = await this.findAffiliate(input);
    const type = input.type ?? (
      input.productId || input.productCode
        ? AffiliateLinkType.PRODUCT
        : input.collectionId
          ? AffiliateLinkType.COLLECTION
          : AffiliateLinkType.STORE
    );
    const product = input.productId
      ? await prisma.product.findUnique({ where: { id: input.productId } })
      : input.productCode
        ? await prisma.product.findUnique({ where: { productCode: input.productCode.trim() } })
        : null;
    if (type === AffiliateLinkType.PRODUCT && !product) throw new BadRequestException("Product link requires a valid product.");
    const collection = input.collectionId
      ? await prisma.collection.findFirst({ where: { id: input.collectionId, affiliateId: affiliate.id } })
      : null;
    if (type === AffiliateLinkType.COLLECTION && !collection) {
      throw new BadRequestException("Collection link requires a valid Affiliate Collection.");
    }
    const landingPath = cleanOptional(input.landingPath)
      ?? (product ? `/p/${product.productCode}` : collection ? `/c/${collection.slug}` : "/");
    return prisma.affiliateLink.create({
      data: {
        affiliateId: affiliate.id,
        linkCode: await uniqueLinkCode(affiliate.affiliateCode),
        type,
        productId: product?.id ?? null,
        collectionId: collection?.id ?? null,
        landingPath,
        source: normalizeSource(input.source) ?? "direct",
        placement: normalizeCampaign(input.placement) ?? "share",
        campaign: normalizeCampaign(input.campaign) ?? "organic"
      },
      include: {
        affiliate: true,
        product: true,
        collection: true
      }
    });
  }

  async listClicks(adminUserId?: string) {
    await this.access.requirePermission(adminUserId, AFFILIATE_VIEW);
    return prisma.affiliateClick.findMany({
      include: {
        affiliate: true,
        affiliateLink: true,
        product: true,
        customer: true
      },
      orderBy: { clickedAt: "desc" },
      take: 200
    });
  }

  async listAttributedOrders(adminUserId?: string) {
    await this.access.requirePermission(adminUserId, AFFILIATE_VIEW);
    return prisma.order.findMany({
      where: { affiliateId: { not: null } },
      include: {
        affiliate: true,
        customer: true,
        commission: true,
        items: { include: { snapshot: true } },
        payments: { orderBy: { requestedAt: "desc" }, take: 1 }
      },
      orderBy: { createdAt: "desc" },
      take: 200
    });
  }

  async listCommissions(queue: CommissionQueueKey | undefined, adminUserId?: string) {
    await this.access.requirePermission(adminUserId, AFFILIATE_VIEW);
    const commissions = await prisma.commission.findMany({
      where: commissionWhere(queue),
      include: {
        affiliate: true,
        order: {
          include: {
            ...commissionOrderInclude,
            customer: true,
            items: { include: { snapshot: true } }
          }
        },
        attribution: true
      },
      orderBy: { createdAt: "desc" },
      take: 200
    });
    const now = new Date();
    return commissions.map((commission) => ({ ...commission, eligibility: commissionEligibility(commission, now) }));
  }

  async confirmCommission(commissionId: string, input: CommissionActionInput) {
    return this.transitionCommission(commissionId, input, "CONFIRM");
  }

  async rejectCommission(commissionId: string, input: CommissionActionInput) {
    return this.transitionCommission(commissionId, input, "REJECT");
  }

  async markCommissionPaid(commissionId: string, input: CommissionActionInput) {
    return this.transitionCommission(commissionId, input, "RECORD_PAYMENT");
  }

  private async transitionCommission(commissionId: string, input: CommissionActionInput, action: "CONFIRM" | "REJECT" | "RECORD_PAYMENT") {
    const session = await this.access.requirePermission(input.adminUserId, AFFILIATE_APPROVE);
    const actor = session.adminUser!;
    const note = cleanOptional(input.note);
    if (action !== "CONFIRM" && !note) {
      throw new BadRequestException(action === "REJECT"
        ? "A rejection reason is required."
        : "Enter the verified external payment receipt or reference in the note. This action records payment; it does not transfer money.");
    }
    return prisma.$transaction(async (tx) => {
      const identity = await tx.commission.findUnique({ where: { id: commissionId }, select: { orderId: true } });
      if (!identity) throw new NotFoundException("Commission was not found.");
      // After-sales and commission transitions share this lock; re-read after acquiring it.
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${identity.orderId} FOR UPDATE`;
      const commission = await tx.commission.findUnique({
        where: { id: commissionId },
        include: { order: { include: commissionOrderInclude } }
      });
      if (!commission) throw new NotFoundException("Commission was not found.");
      const expectedStatuses: CommissionStatus[] = action === "CONFIRM" ? [CommissionStatus.PENDING]
        : action === "RECORD_PAYMENT" ? [CommissionStatus.CONFIRMED]
          : [CommissionStatus.PENDING, CommissionStatus.CONFIRMED];
      if (!expectedStatuses.includes(commission.status) || commission.paidAt) {
        throw new ConflictException("Commission state has changed or this action was already recorded. Refresh before continuing.");
      }
      const now = new Date();
      const eligibility = commissionEligibility(commission, now);
      if (action !== "REJECT" && eligibility.blockingReason) throw new BadRequestException(eligibility.blockingReason);
      if (action === "RECORD_PAYMENT" && commission.commissionAmountKsh === 0) {
        throw new BadRequestException("A zero-value commission cannot be recorded as a payment.");
      }
      const data: Prisma.CommissionUpdateManyMutationInput = action === "CONFIRM"
        ? { status: CommissionStatus.CONFIRMED, eligibleAt: eligibility.eligibleAt, confirmedAt: now, note: note ?? commission.note }
        : action === "REJECT"
          ? { status: CommissionStatus.REJECTED, rejectedAt: now, holdReason: "MANUAL_REJECTED", note }
          : { status: CommissionStatus.PAID, paidAt: now, note };
      const changed = await tx.commission.updateMany({
        where: {
          id: commission.id,
          status: commission.status,
          paidAt: null,
          updatedAt: commission.updatedAt,
          holdReason: commission.holdReason
        },
        data
      });
      if (changed.count !== 1) throw new ConflictException("Commission changed during this request. Refresh and review its current state.");
      const updated = await tx.commission.findUniqueOrThrow({ where: { id: commission.id } });
      await tx.auditLog.create({
        data: {
          actorType: ActorType.EMPLOYEE,
          actorId: actor.linkedEmployeeId,
          actorAdminUserId: actor.id,
          sourceApp: SourceApp.OPERATIONS,
          module: "AFFILIATE",
          entityType: "Commission",
          entityId: commission.id,
          action: `COMMISSION_${action}`,
          beforeJson: commissionAuditState(commission),
          afterJson: commissionAuditState(updated),
          reason: note ?? "Completed handover plus 72 hours (the return window); no blocking after-sales case."
        }
      });
      return updated;
    });
  }

  async payoutExport(adminUserId?: string) {
    await this.access.requirePermission(adminUserId, AFFILIATE_EXPORT);
    const commissions = await prisma.commission.findMany({
      where: { status: CommissionStatus.CONFIRMED, holdReason: null },
      include: {
        affiliate: true,
        order: { include: commissionOrderInclude }
      },
      orderBy: { createdAt: "asc" }
    });
    const now = new Date();
    return commissions.filter((commission) => !commission.paidAt && commission.commissionAmountKsh > 0 && !commissionEligibility(commission, now).blockingReason).map((commission) => ({
      commissionId: commission.id,
      affiliateCode: commission.affiliate.affiliateCode,
      affiliateName: commission.affiliate.displayName,
      phone: commission.affiliate.phone,
      orderNumber: commission.order.orderNumber,
      orderSubtotalKsh: commission.orderSubtotalKsh,
      rateBps: commission.rateBps,
      commissionAmountKsh: commission.commissionAmountKsh
    }));
  }

  async commissionSetting(adminUserId?: string) {
    await this.access.requirePermission(adminUserId, AFFILIATE_VIEW);
    return {
      key: DEFAULT_COMMISSION_SETTING_KEY,
      valueBps: LAUNCH_AFFILIATE_COMMISSION_RATE_BPS,
      source: "LAUNCH_POLICY"
    };
  }

  private async findAffiliate(input: LinkInput) {
    const affiliate = input.affiliateId
      ? await prisma.affiliate.findUnique({ where: { id: input.affiliateId } })
      : input.affiliateCode
        ? await prisma.affiliate.findUnique({ where: { affiliateCode: normalizeAffiliateCode(input.affiliateCode) ?? "" } })
        : null;
    if (!affiliate || affiliate.status !== AffiliateStatus.ACTIVE) {
      throw new BadRequestException("Active affiliate is required.");
    }
    return affiliate;
  }
}

function commissionAuditState(commission: Commission): Prisma.InputJsonObject {
  return {
    status: commission.status,
    orderId: commission.orderId,
    affiliateId: commission.affiliateId,
    rateBps: commission.rateBps,
    orderSubtotalKsh: commission.orderSubtotalKsh,
    commissionAmountKsh: commission.commissionAmountKsh,
    holdReason: commission.holdReason,
    eligibleAt: commission.eligibleAt?.toISOString() ?? null,
    confirmedAt: commission.confirmedAt?.toISOString() ?? null,
    rejectedAt: commission.rejectedAt?.toISOString() ?? null,
    paidAt: commission.paidAt?.toISOString() ?? null,
    note: commission.note
  };
}

function commissionWhere(queue?: CommissionQueueKey) {
  if (queue === "pending") return { status: CommissionStatus.PENDING };
  if (queue === "confirmed") return { status: CommissionStatus.CONFIRMED, holdReason: null };
  if (queue === "paid") return { status: CommissionStatus.PAID };
  if (queue === "exceptions") {
    return {
      OR: [
        { status: CommissionStatus.REJECTED },
        { holdReason: { not: null } }
      ]
    };
  }
  return {};
}

function normalizeAffiliateCode(value?: string | null): string | null {
  const normalized = value?.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  return normalized?.slice(0, 40) || null;
}

function cleanOptional(value?: string | null): string | null {
  const cleaned = value?.trim();
  return cleaned ? cleaned.slice(0, 200) : null;
}

function normalizeSource(value?: string | null): string | null {
  return normalizeCampaign(value)?.toLowerCase() ?? null;
}

function normalizeCampaign(value?: string | null): string | null {
  const normalized = value?.trim().replace(/[^a-zA-Z0-9_.:-]/g, "");
  return normalized?.slice(0, 80) || null;
}

function normalizeOptionalRate(value?: number | null): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value) || value < 0 || value > 5000) {
    throw new BadRequestException("Commission rate must be between 0 and 5000 basis points.");
  }
  return Math.round(value);
}

async function uniqueAffiliateCode(displayName: string): Promise<string> {
  const base = normalizeAffiliateCode(displayName.replace(/\s+/g, "-")) ?? "AFF";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = `${base.slice(0, 24)}-${randomBytes(2).toString("hex").toUpperCase()}`;
    const existing = await prisma.affiliate.findUnique({ where: { affiliateCode: code } });
    if (!existing) return code;
  }
  throw new BadRequestException("Could not generate a unique affiliate code.");
}

async function uniqueLinkCode(affiliateCode: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = `${affiliateCode}-${randomBytes(3).toString("hex").toUpperCase()}`;
    const existing = await prisma.affiliateLink.findUnique({ where: { linkCode: code } });
    if (!existing) return code;
  }
  throw new BadRequestException("Could not generate a unique affiliate link code.");
}

function affiliateSlug(displayName: string, affiliateCode: string): string {
  const name = displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "affiliate";
  const code = affiliateCode.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${name}-${code}`;
}

function buildShareUrl(
  path: string,
  affiliateCode: string,
  source?: string | null,
  campaign?: string | null,
  placement?: string | null
): string {
  const base = process.env.STOREFRONT_PUBLIC_URL ?? "http://localhost:3000";
  const url = new URL(path || "/", base);
  url.searchParams.set("ref", affiliateCode);
  url.searchParams.set("source", source || "direct");
  url.searchParams.set("placement", placement || "share");
  url.searchParams.set("campaign", campaign || "organic");
  return url.toString();
}
