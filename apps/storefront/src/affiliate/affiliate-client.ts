"use client";

import { useCallback, useEffect, useState } from "react";

export type AffiliateIdentity = {
  id: string;
  affiliateCode: string;
  slug: string;
  displayName: string;
  bio: string | null;
  status: string;
  level: "LEVEL_1" | "LEVEL_2" | "LEVEL_3";
  customer?: { avatarUrl: string | null } | null;
};

export type AffiliateProduct = {
  id: string;
  code: string;
  title: string;
  size: string;
  price: number;
  image: string;
  status: "Available" | "Sold";
  sortOrder?: number;
};

export type AffiliateCollection = {
  id: string;
  title: string;
  slug: string;
  description: string | null;
  coverImage: string | null;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  itemCount: number;
  products: AffiliateProduct[];
  createdAt: string;
  updatedAt: string;
};

export type AffiliateCampaign = {
  id: string;
  title: string;
  slug: string;
  channel: "WHATSAPP" | "STATUS" | "TIKTOK" | "FACEBOOK";
  source: string;
  placement: string;
  status: "DRAFT" | "ACTIVE" | "ARCHIVED";
  collectionId: string | null;
  collection?: { title: string; slug: string } | null;
  link?: string;
};

export type AffiliateDashboard = {
  metrics: {
    clicks: number;
    views: number;
    orders: number;
    /** Every order credited to this promoter, how many are paid, how many are not (same as the back office). */
    ordersTotal: number;
    ordersPaid: number;
    ordersUnpaid: number;
    sales: number;
    commission: number;
    conversionRate: number;
    topCollection: string | null;
    topProduct: string | null;
    collections: number;
    campaigns: number;
  };
  commission: Record<string, number>;
  /** Weekly M-Pesa payouts already sent, newest first. */
  payouts?: AffiliatePayout[];
};

export type AffiliatePayout = {
  id: string;
  amountKsh: number;
  itemCount: number;
  mpesaCode: string;
  paidAt: string;
  periodStart: string;
  periodEnd: string;
};

export type AffiliateSessionPayload = {
  authenticated: boolean;
  affiliate: AffiliateIdentity | null;
  collections?: AffiliateCollection[];
  campaigns?: AffiliateCampaign[];
  dashboard?: AffiliateDashboard;
};

let cachedPayload: AffiliateSessionPayload | null = null;
let pendingRequest: Promise<AffiliateSessionPayload> | null = null;

export async function loadAffiliateSession(force = false): Promise<AffiliateSessionPayload> {
  if (!force && cachedPayload) return cachedPayload;
  if (!force && pendingRequest) return pendingRequest;
  pendingRequest = fetch("/api/affiliate/me", { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) throw new Error("Affiliate session could not be loaded.");
      return response.json() as Promise<AffiliateSessionPayload>;
    })
    .then((payload) => {
      cachedPayload = payload;
      return payload;
    })
    .finally(() => {
      pendingRequest = null;
    });
  return pendingRequest;
}

export function clearAffiliateSessionCache() {
  cachedPayload = null;
}

export function useAffiliateSession() {
  const [payload, setPayload] = useState<AffiliateSessionPayload | null>(cachedPayload);
  const [loading, setLoading] = useState(!cachedPayload);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadAffiliateSession(true);
      setPayload(next);
      return next;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Affiliate session could not be loaded.");
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    loadAffiliateSession()
      .then((next) => {
        if (active) setPayload(next);
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : "Affiliate session could not be loaded.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return { payload, loading, error, refresh };
}

export async function affiliateJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw new Error(payload.error || "Affiliate action failed.");
  clearAffiliateSessionCache();
  return payload;
}
