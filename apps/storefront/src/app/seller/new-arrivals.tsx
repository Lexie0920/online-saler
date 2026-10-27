"use client";

import { LoaderCircle, Share2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { NewArrival } from "../../affiliate/new-arrivals-service";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { useStorefrontI18n } from "../../i18n/use-storefront-i18n";
import { ShareDialog } from "./share-dialog";

/** The newest pieces, newest first, each with what the promoter earns if it sells. */
export function NewArrivals({ affiliateCode }: { affiliateCode: string }) {
  const { t } = useStorefrontI18n();
  const [items, setItems] = useState<NewArrival[] | null>(null);
  const [error, setError] = useState("");
  const [sharing, setSharing] = useState<NewArrival | null>(null);

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
      {error ? <p className="rounded-md border bg-card px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
      {!items && !error ? <div className="flex h-32 items-center justify-center"><LoaderCircle className="animate-spin" /></div> : null}
      {items && !items.length ? <p className="text-sm text-muted-foreground">{t("affiliate.newArrivals.empty")}</p> : null}
      {items?.length ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => (
            <Card key={item.code} className="overflow-hidden">
              <img src={item.image} alt="" loading="lazy" className="aspect-[4/5] w-full object-cover" />
              <CardHeader>
                <CardTitle className="text-base">{item.title}</CardTitle>
                <CardDescription>KSh {item.price.toLocaleString("en-KE")} · {item.size}</CardDescription>
              </CardHeader>
              <CardContent className="flex items-center justify-between gap-2">
                <strong className="text-sm font-medium">{t("affiliate.newArrivals.earn", { amount: item.earnKsh.toLocaleString("en-KE") })}</strong>
                <Button size="sm" onClick={() => setSharing(item)}><Share2 /> {t("affiliate.shareDialog.button")}</Button>
              </CardContent>
            </Card>
          ))}
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
