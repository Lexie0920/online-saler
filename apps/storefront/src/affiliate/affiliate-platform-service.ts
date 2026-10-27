import { randomUUID } from "node:crypto";
import {
  AffiliateLevel,
  AffiliateStatus,
  CampaignChannel,
  CampaignStatus,
  CollectionStatus,
  CommissionStatus,
  InventoryItemStatus,
  OrderStatus,
  Prisma,
  ProductStatus,
  prisma,
} from "@online-saler/database";
import type { CustomerSession } from "../auth/customer-auth";
import {
  COLLECTION_MAX_ITEMS,
  affiliateDailySeries,
  clicksByChannel,
  affiliateEarningTotals,
  affiliateOrderCounts,
  buildAffiliatePath,
  collectionPublicationIssue,
  normalizeTrackingSource,
  normalizeTrackingValue,
  slugifyAffiliateValue,
} from "./affiliate-platform";

export class AffiliatePlatformError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export type CollectionInput = {
  title?: string | null;
  description?: string | null;
  coverImage?: string | null;
};

export type CampaignInput = {
  title?: string | null;
  collectionId?: string | null;
  channel?: string | null;
  source?: string | null;
  placement?: string | null;
};

const affiliatePublicSelect = Prisma.validator<Prisma.AffiliateSelect>()({
  id: true,
  affiliateCode: true,
  slug: true,
  displayName: true,
  bio: true,
  status: true,
  level: true,
  customer: { select: { avatarUrl: true } },
});

const collectionInclude = Prisma.validator<Prisma.CollectionInclude>()({
  items: {
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    include: {
      product: {
        include: {
          inventoryItem: true,
          images: { orderBy: { sortOrder: "asc" }, take: 1 },
        },
      },
    },
  },
});

export async function getActiveAffiliateForCustomer(session: CustomerSession | null) {
  if (!session) return null;
  const direct = await prisma.affiliate.findFirst({
    where: { customerId: session.customerId, status: AffiliateStatus.ACTIVE },
    select: affiliatePublicSelect,
  });
  if (direct) return direct;

  const byEmail = await prisma.affiliate.findFirst({
    where: { email: session.email.toLowerCase(), status: AffiliateStatus.ACTIVE },
  });
  if (!byEmail || (byEmail.customerId && byEmail.customerId !== session.customerId)) return null;
  return prisma.affiliate.update({
    where: { id: byEmail.id },
    data: { customerId: session.customerId },
    select: affiliatePublicSelect,
  });
}

export async function becomeAffiliate(session: CustomerSession | null) {
  if (!session) throw new AffiliatePlatformError("Sign in before becoming an Affiliate.", 401);
  const existing = await getActiveAffiliateForCustomer(session);
  if (existing) return existing;

  const disabled = await prisma.affiliate.findUnique({ where: { customerId: session.customerId } });
  if (disabled) throw new AffiliatePlatformError("This Affiliate profile is disabled. Contact Direct Loop support.", 403);

  const customer = await prisma.customer.findUnique({ where: { id: session.customerId } });
  if (!customer) throw new AffiliatePlatformError("Customer account was not found.", 404);

  const suffix = customer.id.replace(/-/g, "").slice(0, 10).toUpperCase();
  const displayName = customer.displayName?.trim() || customer.email?.split("@")[0] || "Direct Loop Affiliate";
  return prisma.affiliate.create({
    data: {
      customerId: customer.id,
      affiliateCode: `DL-AFF-${suffix}`,
      slug: `${slugifyAffiliateValue(displayName)}-${suffix.toLowerCase().slice(0, 6)}`,
      displayName,
      bio: "Curated one-of-one finds from Direct Loop.",
      email: customer.normalizedEmail,
      status: AffiliateStatus.ACTIVE,
      level: AffiliateLevel.LEVEL_1,
    },
    select: affiliatePublicSelect,
  });
}

export async function requireActiveAffiliate(session: CustomerSession | null) {
  if (!session) throw new AffiliatePlatformError("Sign in to continue.", 401);
  const affiliate = await getActiveAffiliateForCustomer(session);
  if (!affiliate) throw new AffiliatePlatformError("Become an Affiliate to use this feature.", 403);
  return affiliate;
}

export async function listAffiliateCollections(session: CustomerSession | null) {
  const affiliate = await requireActiveAffiliate(session);
  const collections = await prisma.collection.findMany({
    where: { affiliateId: affiliate.id },
    include: collectionInclude,
    orderBy: { updatedAt: "desc" },
  });
  return collections.map(serializeCollection);
}

export async function createAffiliateCollection(session: CustomerSession | null, input: CollectionInput) {
  const affiliate = await requireActiveAffiliate(session);
  const title = validateTitle(input.title, "Collection title");
  const id = randomUUID();
  const collection = await prisma.collection.create({
    data: {
      id,
      affiliateId: affiliate.id,
      title,
      slug: `${slugifyAffiliateValue(title, "collection")}-${id.slice(0, 8)}`,
      description: optionalText(input.description, 500),
      coverImage: optionalUrl(input.coverImage),
    },
    include: collectionInclude,
  });
  return serializeCollection(collection);
}

export async function updateAffiliateCollection(
  session: CustomerSession | null,
  collectionId: string,
  input: CollectionInput & { action?: string | null },
) {
  const affiliate = await requireActiveAffiliate(session);
  const existing = await prisma.collection.findFirst({
    where: { id: collectionId, affiliateId: affiliate.id },
    include: { _count: { select: { items: true } } },
  });
  if (!existing) throw new AffiliatePlatformError("Collection was not found.", 404);

  const action = input.action?.trim().toUpperCase();
  let status: CollectionStatus | undefined;
  if (action === "PUBLISH") {
    const issue = collectionPublicationIssue(existing._count.items);
    if (issue) throw new AffiliatePlatformError(issue, 409);
    status = CollectionStatus.PUBLISHED;
  } else if (action === "ARCHIVE") {
    status = CollectionStatus.ARCHIVED;
  } else if (action === "RESTORE") {
    status = CollectionStatus.DRAFT;
  }

  const collection = await prisma.collection.update({
    where: { id: existing.id },
    data: {
      ...(input.title !== undefined ? { title: validateTitle(input.title, "Collection title") } : {}),
      ...(input.description !== undefined ? { description: optionalText(input.description, 500) } : {}),
      ...(input.coverImage !== undefined ? { coverImage: optionalUrl(input.coverImage) } : {}),
      ...(status ? { status } : {}),
    },
    include: collectionInclude,
  });
  return serializeCollection(collection);
}

export async function deleteAffiliateCollection(session: CustomerSession | null, collectionId: string) {
  const affiliate = await requireActiveAffiliate(session);
  const result = await prisma.collection.deleteMany({ where: { id: collectionId, affiliateId: affiliate.id } });
  if (result.count !== 1) throw new AffiliatePlatformError("Collection was not found.", 404);
  return { deleted: true };
}

export async function setProductCollections(
  session: CustomerSession | null,
  productCode: string,
  selectedCollectionIds: string[],
) {
  const affiliate = await requireActiveAffiliate(session);
  const product = await prisma.product.findFirst({
    where: { productCode: productCode.trim(), status: ProductStatus.PUBLISHED },
  });
  if (!product) throw new AffiliatePlatformError("Published product was not found.", 404);

  const uniqueIds = [...new Set(selectedCollectionIds.map((value) => value.trim()).filter(Boolean))];
  const collections = await prisma.collection.findMany({
    where: { affiliateId: affiliate.id },
    include: { _count: { select: { items: true } }, items: { where: { productId: product.id } } },
  });
  if (uniqueIds.some((id) => !collections.some((collection) => collection.id === id))) {
    throw new AffiliatePlatformError("One or more Collections were not found.", 404);
  }

  await prisma.$transaction(async (tx) => {
    for (const collection of collections) {
      const selected = uniqueIds.includes(collection.id);
      const exists = collection.items.length > 0;
      if (selected && !exists) {
        if (collection._count.items >= COLLECTION_MAX_ITEMS) {
          throw new AffiliatePlatformError(`${collection.title} already contains ${COLLECTION_MAX_ITEMS} products.`, 409);
        }
        const last = await tx.collectionItem.aggregate({
          where: { collectionId: collection.id },
          _max: { sortOrder: true },
        });
        await tx.collectionItem.create({
          data: { collectionId: collection.id, productId: product.id, sortOrder: (last._max.sortOrder ?? -1) + 1 },
        });
      } else if (!selected && exists) {
        await tx.collectionItem.delete({ where: { collectionId_productId: { collectionId: collection.id, productId: product.id } } });
      }
    }
  });

  return listAffiliateCollections(session);
}

export async function listAffiliateCampaigns(session: CustomerSession | null) {
  const affiliate = await requireActiveAffiliate(session);
  const campaigns = await prisma.campaign.findMany({
    where: { affiliateId: affiliate.id },
    include: { collection: { select: { title: true, slug: true } } },
    orderBy: { createdAt: "desc" },
  });
  return campaigns.map((campaign) => ({
    ...campaign,
    link: buildCampaignLink(
      campaign.collection?.slug,
      affiliate.affiliateCode,
      campaign.source,
      campaign.placement,
      campaign.slug,
    ),
  }));
}

export async function createAffiliateCampaign(session: CustomerSession | null, input: CampaignInput) {
  const affiliate = await requireActiveAffiliate(session);
  const title = validateTitle(input.title, "Campaign title");
  const channel = String(input.channel ?? "").trim().toUpperCase() as CampaignChannel;
  if (!Object.values(CampaignChannel).includes(channel)) {
    throw new AffiliatePlatformError("Choose WhatsApp, Status, TikTok, or Facebook.");
  }
  const collectionId = input.collectionId?.trim() || null;
  if (collectionId) {
    const owned = await prisma.collection.count({ where: { id: collectionId, affiliateId: affiliate.id } });
    if (!owned) throw new AffiliatePlatformError("Collection was not found.", 404);
  }
  const id = randomUUID();
  const source = normalizeTrackingSource(input.source) ?? channel.toLowerCase();
  const placement = normalizeTrackingValue(input.placement) ?? defaultPlacement(channel);
  const slug = `${slugifyAffiliateValue(title, "campaign")}-${id.slice(0, 6)}`;
  const campaign = await prisma.campaign.create({
    data: {
      id,
      affiliateId: affiliate.id,
      collectionId,
      title,
      slug,
      channel,
      source,
      placement,
      status: CampaignStatus.ACTIVE,
    },
    include: { collection: { select: { title: true, slug: true } } },
  });
  return {
    ...campaign,
    link: buildCampaignLink(campaign.collection?.slug, affiliate.affiliateCode, source, placement, slug),
  };
}

export async function updateAffiliateCampaignStatus(
  session: CustomerSession | null,
  campaignId: string,
  statusValue: string,
) {
  const affiliate = await requireActiveAffiliate(session);
  const status = statusValue.trim().toUpperCase() as CampaignStatus;
  if (!Object.values(CampaignStatus).includes(status)) throw new AffiliatePlatformError("Invalid Campaign status.");
  const result = await prisma.campaign.updateMany({
    where: { id: campaignId, affiliateId: affiliate.id },
    data: { status },
  });
  if (result.count !== 1) throw new AffiliatePlatformError("Campaign was not found.", 404);
  return { updated: true, status };
}

export async function getAffiliateDashboard(session: CustomerSession | null) {
  const affiliate = await requireActiveAffiliate(session);
  const paidOrderStatuses = [OrderStatus.PAID, OrderStatus.FULFILLING, OrderStatus.COMPLETED];
  const [clicks, clickTotal, clickSources, orderTotal, orderPaid, commissions, collections, campaigns, payouts] = await Promise.all([
    // A sample, only to find the top collection and product. The totals below are counted in the database.
    prisma.affiliateClick.findMany({
      where: { affiliateId: affiliate.id },
      select: {
        productId: true,
        collectionId: true,
        collection: { select: { title: true, slug: true } },
        product: { select: { productCode: true, title: true } },
      },
      take: 1000,
      orderBy: { clickedAt: "desc" },
    }),
    prisma.affiliateClick.count({ where: { affiliateId: affiliate.id } }),
    // Where the clicks came from (WhatsApp, Status, TikTok...), counted in the database.
    prisma.affiliateClick.groupBy({ by: ["source"], where: { affiliateId: affiliate.id }, _count: { _all: true } }),
    // The same counts the back office shows for this promoter.
    prisma.order.count({ where: { affiliateId: affiliate.id } }),
    prisma.order.count({ where: { affiliateId: affiliate.id, status: { in: paidOrderStatuses } } }),
    prisma.commission.findMany({
      where: { affiliateId: affiliate.id },
      select: { status: true, orderSubtotalKsh: true, commissionAmountKsh: true, createdAt: true },
    }),
    prisma.collection.count({ where: { affiliateId: affiliate.id } }),
    prisma.campaign.count({ where: { affiliateId: affiliate.id } }),
    // Weekly M-Pesa payouts recorded by finance (2026-10-14): what reached this promoter.
    prisma.payout.findMany({
      where: { affiliateId: affiliate.id, payeeType: "AFFILIATE" },
      select: { id: true, amountKsh: true, itemCount: true, mpesaCode: true, paidAt: true, periodStart: true, periodEnd: true },
      orderBy: { paidAt: "desc" },
      take: 52,
    }),
  ]);
  const topCollection = topByKey(clicks.filter((click) => click.collection).map((click) => ({
    key: click.collection!.slug,
    label: click.collection!.title,
  })));
  const topProduct = topByKey(clicks.filter((click) => click.product).map((click) => ({
    key: click.product!.productCode,
    label: click.product!.title || click.product!.productCode,
  })));
  const commissionTotals = Object.fromEntries(Object.values(CommissionStatus).map((status) => [
    status,
    commissions.filter((row) => row.status === status).reduce((total, row) => total + row.commissionAmountKsh, 0),
  ]));
  const earned = affiliateEarningTotals(commissions);
  const orderCounts = affiliateOrderCounts(orderTotal, orderPaid);
  return {
    affiliate,
    metrics: {
      // Every recorded click, counted in the database: the same number the back office shows.
      clicks: clickTotal,
      orders: earned.orders,
      ordersTotal: orderCounts.total,
      ordersPaid: orderCounts.paid,
      ordersUnpaid: orderCounts.unpaid,
      sales: earned.sales,
      commission: earned.commission,
      topCollection: topCollection?.label ?? null,
      topProduct: topProduct?.label ?? null,
      collections,
      campaigns,
    },
    commission: commissionTotals,
    // One point per Nairobi day, for the order and earnings charts.
    daily: affiliateDailySeries(commissions, 30),
    clickChannels: clicksByChannel(clickSources.map((row) => ({ source: row.source, count: row._count._all }))),
    payouts: payouts.map((payout) => ({
      id: payout.id,
      amountKsh: payout.amountKsh,
      itemCount: payout.itemCount,
      mpesaCode: payout.mpesaCode,
      paidAt: payout.paidAt.toISOString(),
      periodStart: payout.periodStart.toISOString(),
      // The stored end is the next Monday 00:00; the week's last day is the Sunday before it.
      periodEnd: payout.periodEnd.toISOString(),
    })),
  };
}

export async function getPublicAffiliateProfile(slug: string) {
  const affiliate = await prisma.affiliate.findFirst({
    where: { slug, status: AffiliateStatus.ACTIVE },
    select: {
      ...affiliatePublicSelect,
      collections: {
        where: { status: CollectionStatus.PUBLISHED },
        include: collectionInclude,
        orderBy: { updatedAt: "desc" },
      },
    },
  });
  if (!affiliate) return null;
  const collections = affiliate.collections.map(serializeCollection);
  const productMap = new Map<string, ReturnType<typeof serializeProduct>>();
  for (const collection of affiliate.collections) {
    for (const item of collection.items) productMap.set(item.product.id, serializeProduct(item.product));
  }
  return { ...affiliate, collections, products: [...productMap.values()] };
}

export async function getPublicCollection(slug: string) {
  const collection = await prisma.collection.findFirst({
    where: { slug, status: CollectionStatus.PUBLISHED, affiliate: { status: AffiliateStatus.ACTIVE } },
    include: { ...collectionInclude, affiliate: { select: affiliatePublicSelect } },
  });
  if (!collection) return null;
  return { ...serializeCollection(collection), affiliate: collection.affiliate };
}

function serializeCollection(collection: {
  id: string;
  title: string;
  slug: string;
  description: string | null;
  coverImage: string | null;
  status: CollectionStatus;
  createdAt: Date;
  updatedAt: Date;
  items: Array<{ sortOrder: number; product: Parameters<typeof serializeProduct>[0] }>;
}) {
  const products = collection.items.map((item) => ({ ...serializeProduct(item.product), sortOrder: item.sortOrder }));
  return {
    id: collection.id,
    title: collection.title,
    slug: collection.slug,
    description: collection.description,
    coverImage: collection.coverImage || products[0]?.image || null,
    status: collection.status,
    itemCount: products.length,
    products,
    createdAt: collection.createdAt.toISOString(),
    updatedAt: collection.updatedAt.toISOString(),
  };
}

function serializeProduct(product: {
  id: string;
  productCode: string;
  title: string | null;
  finalSizeLabel: string | null;
  tagSize: string | null;
  priceKsh: number | null;
  inventoryItem: { status: InventoryItemStatus } | null;
  images: Array<{ publicUrl: string | null; originalUrl: string }>;
}) {
  return {
    id: product.id,
    code: product.productCode,
    title: product.title || "Direct Loop item",
    size: product.finalSizeLabel || product.tagSize || "Size not listed",
    price: product.priceKsh ?? 0,
    image: product.images[0]?.publicUrl || product.images[0]?.originalUrl || "/og.png",
    status: product.inventoryItem?.status === InventoryItemStatus.AVAILABLE ? "Available" as const : "Sold" as const,
  };
}

function validateTitle(value: string | null | undefined, label: string): string {
  const title = value?.trim();
  if (!title || title.length < 3 || title.length > 80) {
    throw new AffiliatePlatformError(`${label} must contain 3 to 80 characters.`);
  }
  return title;
}

function optionalText(value: string | null | undefined, maxLength: number): string | null {
  const next = value?.trim() || null;
  if (next && next.length > maxLength) throw new AffiliatePlatformError(`Text must contain at most ${maxLength} characters.`);
  return next;
}

function optionalUrl(value: string | null | undefined): string | null {
  const next = value?.trim() || null;
  if (!next) return null;
  if (next.startsWith("/") || /^https:\/\//i.test(next)) return next.slice(0, 1000);
  throw new AffiliatePlatformError("Cover image must use an HTTPS URL or Storefront path.");
}

function defaultPlacement(channel: CampaignChannel): string {
  if (channel === CampaignChannel.STATUS) return "status";
  if (channel === CampaignChannel.TIKTOK) return "link-in-bio";
  if (channel === CampaignChannel.FACEBOOK) return "post";
  return "direct-message";
}

function buildCampaignLink(
  collectionSlug: string | undefined,
  affiliateCode: string,
  source: string,
  placement: string,
  campaign: string,
): string {
  return buildAffiliatePath(collectionSlug ? `/c/${collectionSlug}` : "/", affiliateCode, { source, placement, campaign });
}

function topByKey(rows: Array<{ key: string; label: string }>) {
  const counts = new Map<string, { label: string; count: number }>();
  for (const row of rows) {
    const current = counts.get(row.key) ?? { label: row.label, count: 0 };
    current.count += 1;
    counts.set(row.key, current);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count)[0] ?? null;
}

// Use only the active affiliate's public name, never customer identity fields.
export async function getPublicRecommenderName(affiliateCode: string): Promise<string | null> {
  try {
    const affiliate = await prisma.affiliate.findFirst({
      where: { affiliateCode, status: AffiliateStatus.ACTIVE },
      select: { displayName: true },
    });
    return affiliate?.displayName ?? null;
  } catch {
    return null;
  }
}
