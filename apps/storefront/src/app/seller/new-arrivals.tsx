"use client";

import { LoaderCircle, Share2 } from "lucide-react";
import { useEffect, useState } from "react";
import { affiliateJson, type AffiliateCollection } from "../../affiliate/affiliate-client";
import type { NewArrival } from "../../affiliate/new-arrivals-service";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../../components/ui/card";
import { useStorefrontI18n } from "../../i18n/use-storefront-i18n";
import { ShareDialog } from "./share-dialog";

/** The newest pieces, newest first, each with what the promoter earns if it sells. */
export function NewArrivals({ affiliateCode, collections, refresh }: { affiliateCode: string; collections: AffiliateCollection[]; refresh: () => Promise<unknown> }) {
  const { t } = useStorefrontI18n();
  const [items, setItems] = useState<NewArrival[] | null>(null);
  const [error, setError] = useState("");
  const [sharing, setSharing] = useState<NewArrival | null>(null);
  const [message, setMessage] = useState("");

  /** Puts the piece in one more collection, keeping the ones it is already in. */
  async function addToCollection(item: NewArrival, collectionId: string) {
    if (!collectionId) return;
    const already = collections.filter((collection) => collection.products.some((product) => product.code === item.code)).map((collection) => collection.id);
    if (already.includes(collectionId)) { setMessage(t("affiliate.newArrivals.alreadyIn")); return; }
    try {
      await affiliateJson("/api/affiliate/collections/product", { method: "PUT", body: JSON.stringify({ productCode: item.code, collectionIds: [...already, collectionId] }) });
      setMessage(t("affiliate.newArrivals.added", { title: item.title }));
      await refresh();
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : t("affiliate.actionFailed")); }
  }

  useEffect(() => {
    let cancelled = false;
    fetch("/api/affiliate/new-arrivals", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as { items?: NewArrival[]; error?: string };
        if (!response.ok) throw new Error(body.error || t("affiliate.newArrivals.failed"));
        if (!cancelled) setItems(body.items ?? []);
      })
      .catch((caught) => { if (!cancelled) setError(caught instanceof Error ? caught.message : t("affiliate.newArrivals.failed")); });
    return () => { cancelled = true; };
  }, [t]);

  return (
    <div className="space-y-5">
      <header>
        <h2 className="text-xl font-semibold tracking-tight">{t("affiliate.newArrivals.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("affiliate.newArrivals.body")}</p>
      </header>
      {message ? <p className="rounded-md border bg-card px-3 py-2 text-sm" role="status">{message}</p> : null}
      {error ? <p className="rounded-md border bg-card px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
      {!items && !error ? <div className="flex h-32 items-center justify-center"><LoaderCircle className="animate-spin" /></div> : null}
      {items && !items.length ? <p className="text-sm text-muted-foreground">{t("affiliate.newArrivals.empty")}</p> : null}
      {items?.length ? (
        <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-3">
          {items.map((item) => {
            const pickable = collections.filter((collection) => collection.status !== "ARCHIVED");
            const picker = (className: string) => (
              <select
                className={className}
                aria-label={t("affiliate.newArrivals.addTo")}
                value=""
                onChange={(event) => void addToCollection(item, event.target.value)}
              >
                <option value="">{t("affiliate.newArrivals.addTo")}</option>
                {pickable.map((collection) => <option key={collection.id} value={collection.id}>{collection.title}</option>)}
              </select>
            );
            return (
              <Card key={item.code} className="overflow-hidden pt-0 max-sm:gap-2">
                <div className="relative">
                  <img src={item.image} alt="" loading="lazy" className="aspect-[3/4] w-full object-cover sm:aspect-square" />
                  {/* Phone: a small round "+" on the picture. The select sits on top of it, invisible, so a tap opens the list of collections. */}
                  {collections.length ? (
                    <span className="absolute bottom-2 right-2 flex size-8 items-center justify-center rounded-full bg-background text-lg leading-none shadow sm:hidden">
                      <span aria-hidden="true">+</span>
                      {picker("absolute inset-0 size-full cursor-pointer opacity-0")}
                    </span>
                  ) : null}
                </div>
                <CardHeader className="max-sm:px-2.5">
                  <CardTitle className="truncate max-sm:text-sm">{item.title}</CardTitle>
                  <CardDescription className="max-sm:text-xs">KSh {item.price.toLocaleString("en-KE")} · {item.size}</CardDescription>
                </CardHeader>
                <CardContent className="flex items-center justify-between gap-2 max-sm:flex-col max-sm:items-stretch max-sm:px-2.5">
                  <strong className="text-sm font-medium max-sm:text-xs max-sm:text-green-700">{t("affiliate.newArrivals.earn", { amount: item.earnKsh.toLocaleString("en-KE") })}</strong>
                  <Button size="sm" className="max-sm:h-10 max-sm:w-full" onClick={() => setSharing(item)}><Share2 /> {t("affiliate.shareDialog.button")}</Button>
                </CardContent>
                {collections.length ? (
                  <CardFooter className="hidden sm:flex">
                    {picker("w-full rounded-md border bg-background px-2 py-1.5 text-sm")}
                  </CardFooter>
                ) : null}
              </Card>
            );
          })}
        </div>
      ) : null}
      <ShareDialog
        open={Boolean(sharing)}
        onOpenChange={(open) => { if (!open) setSharing(null); }}
        title={sharing?.title ?? ""}
        path={sharing ? `/p/${sharing.code}` : "/"}
        affiliateCode={affiliateCode}
      />
    </div>
  );
}
