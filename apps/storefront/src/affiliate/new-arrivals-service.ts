import { listPublishedProducts } from "../db/catalog";
import type { CustomerSession } from "../auth/customer-auth";
import { calculateCommissionKsh } from "./affiliate-service";
import { requireActiveAffiliate } from "./affiliate-platform-service";
import { LAUNCH_AFFILIATE_COMMISSION_RATE_BPS } from "@online-saler/business-rules";

export const NEW_ARRIVALS_LIMIT = 24;

export type NewArrival = {
  code: string;
  title: string;
  price: number;
  size: string;
  image: string;
  /** What the promoter earns if this piece sells, at the launch rate. */
  earnKsh: number;
};

/**
 * The newest pieces on the shop, for promoters who come back each day to find
 * something to post. The shop list is already newest first, so this only takes
 * the top of it. Only pieces that are on sale with a price are shown.
 */
export async function listNewArrivalsForAffiliate(session: CustomerSession | null): Promise<NewArrival[]> {
  await requireActiveAffiliate(session);
  const products = await listPublishedProducts();
  return products
    .filter((product) => product.price > 0 && (!product.status || product.status === "Available"))
    .slice(0, NEW_ARRIVALS_LIMIT)
    .map((product) => ({
      code: product.code,
      title: product.title,
      price: product.price,
      size: product.size,
      image: product.image,
      earnKsh: calculateCommissionKsh(product.price, LAUNCH_AFFILIATE_COMMISSION_RATE_BPS),
    }));
}
