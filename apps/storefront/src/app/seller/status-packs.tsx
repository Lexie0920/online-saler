"use client";

import { BookImage, Copy, Download, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { buildShareLink } from "../../affiliate/affiliate-platform";
import { generateStatusPack } from "../../affiliate/status-pack-generator";
import type { AffiliateSessionPayload } from "../../affiliate/affiliate-client";
import { Button } from "../../components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import { copyText, downloadBlob, EmptyState, errorMessage, Notice, type Translate } from "./center-ui";

type Count = 4 | 6 | 8;

/** Status packs: ready-to-post pictures for a WhatsApp Status, each picture with the piece's own link. */
export function StatusPacks({ payload, initialCollectionId, t }: { payload: AffiliateSessionPayload; initialCollectionId?: string; t: Translate }) {
  // Only live collections can be shared, so only those can make a pack.
  const collections = (payload.collections ?? []).filter((item) => item.status === "PUBLISHED");
  const [collectionId, setCollectionId] = useState(initialCollectionId ?? collections[0]?.id ?? "");
  const [count, setCount] = useState<Count>(6);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => { if (initialCollectionId) setCollectionId(initialCollectionId); }, [initialCollectionId]);
  const collection = collections.find((item) => item.id === collectionId) ?? collections[0] ?? null;
  const affiliateCode = payload.affiliate?.affiliateCode;
  const link = collection && affiliateCode && typeof window !== "undefined"
    ? new URL(buildShareLink(`/c/${collection.slug}`, affiliateCode, "STATUS"), window.location.origin).toString()
    : "";
  const textToPaste = collection ? `${t("affiliate.packs.defaultText", { title: collection.title })}\n${link}` : "";
  const preview = collection?.products.slice(0, count) ?? [];

  async function download() {
    if (!collection || !payload.affiliate) return;
    setBusy(true); setMessage(null);
    try {
      const blob = await generateStatusPack(collection, payload.affiliate, count, window.location.origin);
      downloadBlob(blob, `direct-loop-${collection.slug}-${count}-status-pack.zip`);
      const form = new FormData();
      form.set("file", blob, `status-pack-${collection.slug}-${count}.zip`);
      form.set("collectionId", collection.id);
      form.set("itemCount", String(count));
      void fetch("/api/affiliate/assets/status-pack", { method: "POST", body: form }).catch(() => undefined);
      setMessage(t("affiliate.assets.statusDone", { count }));
    } catch (caught) { setMessage(errorMessage(caught, t)); } finally { setBusy(false); }
  }

  if (!collections.length) {
    return <EmptyState icon={<BookImage />} title={t("affiliate.packs.emptyTitle")} body={t("affiliate.packs.emptyBody")} action={t("affiliate.collections.browse")} />;
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
        <div className="space-y-4">
          <div>
            <p className="mb-1 text-sm font-medium">{t("affiliate.packs.from")}</p>
            <Select value={collection?.id ?? ""} onValueChange={setCollectionId}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{collections.map((item) => <SelectItem key={item.id} value={item.id}>{item.title}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div>
            <p className="mb-1 text-sm font-medium">{t("affiliate.packs.howMany")}</p>
            <div className="flex gap-2" role="group" aria-label={t("affiliate.packs.howMany")}>
              {([4, 6, 8] as const).map((value) => (
                <Button key={value} size="sm" className="rounded-full" variant={count === value ? "default" : "outline"} aria-pressed={count === value} onClick={() => setCount(value)}>{value}</Button>
              ))}
            </div>
            {collection && collection.itemCount < count ? <p className="mt-1 text-xs text-destructive">{t("affiliate.assets.addMore", { count: count - collection.itemCount })}</p> : null}
          </div>
          <div>
            <p className="mb-1 text-sm font-medium">{t("affiliate.packs.textOn")}</p>
            <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm">{t("affiliate.packs.textOnValue")}</p>
          </div>
          <div>
            <p className="mb-1 text-sm font-medium">{t("affiliate.packs.textToPaste")}</p>
            <Textarea value={textToPaste} readOnly rows={5} className="resize-none text-xs" />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void download()} disabled={busy || !collection || collection.itemCount < count}>
              {busy ? <LoaderCircle className="animate-spin" /> : <Download />} {t("affiliate.packs.downloadAll", { count })}
            </Button>
            <Button variant="outline" onClick={() => void copyText(textToPaste).then(() => setMessage(t("affiliate.videos.captionCopied")))}><Copy /> {t("affiliate.videos.copyCaption")}</Button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
          {preview.map((product) => (
            <div key={product.id} className="relative aspect-[9/16] overflow-hidden rounded-md bg-muted">
              <img src={product.image} alt="" loading="lazy" className="size-full object-cover" />
              <span className="absolute bottom-2 left-2 rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-white">Size {product.size} · KSh {product.price.toLocaleString("en-KE")}</span>
              <span className="absolute right-2 top-2 rounded bg-black/40 px-1 text-[10px] text-white">dloop</span>
            </div>
          ))}
        </div>
      </div>
      {message ? <Notice>{message}</Notice> : null}
    </div>
  );
}
