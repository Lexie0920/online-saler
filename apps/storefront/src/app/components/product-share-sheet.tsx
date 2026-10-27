"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import {
  BarChart3,
  Check,
  Copy,
  Download,
  FolderPlus,
  Image as ImageIcon,
  Link2,
  LoaderCircle,
  MessageCircle,
  Plus,
  Radio,
  Share2,
  Smartphone,
  Video,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { affiliateJson, type AffiliateCollection, useAffiliateSession } from "../../affiliate/affiliate-client";
import type { Product } from "../data/products";
import { productPath, productShareText } from "../data/products";
import { recordClientEvent } from "../lib/client-events";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Checkbox } from "../../components/ui/checkbox";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { ScrollArea } from "../../components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "../../components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { useStorefrontI18n } from "../../i18n/use-storefront-i18n";

const ShareCardStudio = dynamic(
  () => import("../../affiliate/share-card-studio").then((module) => module.ShareCardStudio),
  { ssr: false, loading: () => <div className="flex h-40 items-center justify-center"><LoaderCircle className="animate-spin" /></div> },
);

type ProductShareSheetProps = {
  product: Product;
  className?: string;
  compact?: boolean;
};

export function ProductShareSheet({ product, className, compact = false }: ProductShareSheetProps) {
  const shareLabel = useStorefrontI18n().t("pd.share");
  const { payload, loading, refresh } = useAffiliateSession();
  const affiliate = payload?.affiliate ?? null;
  const [copied, setCopied] = useState(false);
  const [cardOpen, setCardOpen] = useState(false);
  const affiliateLink = useShareUrl(product, affiliate?.affiliateCode, "direct", "product-share", "organic");
  const regularLink = useShareUrl(product, undefined, "direct", "product-share", "organic");
  const shareUrl = affiliate ? affiliateLink : regularLink;

  async function copyLink(source = "copy-link", placement = "product-share") {
    const url = currentShareUrl(product, affiliate?.affiliateCode, source, placement, "organic");
    await copyText(url);
    recordShare(product, affiliate?.affiliateCode, source);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  async function nativeShare(source: string, placement: string) {
    const url = currentShareUrl(product, affiliate?.affiliateCode, source, placement, "organic");
    if (navigator.share) {
      await navigator.share({ title: product.title, text: productShareText(product, affiliate?.displayName), url });
    } else {
      await copyText(url);
      setCopied(true);
    }
    recordShare(product, affiliate?.affiliateCode, source);
  }

  const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(`${productShareText(product, affiliate?.displayName)}\n${currentShareUrl(
    product,
    affiliate?.affiliateCode,
    "whatsapp",
    "direct-message",
    "organic",
  )}`)}`;

  return (
    <Sheet>
      <SheetTrigger asChild>
        <button
          type="button"
          className={className || (compact ? "whatsappIconButton depopShareButton" : "copyLinkButton")}
          aria-label={compact ? `Share ${product.title}` : undefined}
          title={compact ? "Share" : undefined}
        >
          <Share2 size={compact ? 19 : 18} />
          {compact ? null : shareLabel}
        </button>
      </SheetTrigger>
      <SheetContent className="w-full sm:max-w-xl">
        <SheetHeader className="border-b">
          <div className="flex items-center gap-2">
            <SheetTitle>Share {product.title}</SheetTitle>
            {affiliate ? <Badge>Affiliate · Level 1</Badge> : null}
          </div>
          <SheetDescription>
            {affiliate ? "Tracked links, Collections, reusable assets, and live performance." : "Send this item with a clickable Direct Loop link."}
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-5 p-4">
            {affiliate ? (
              <Tabs defaultValue="quick">
                <TabsList className="grid h-auto w-full grid-cols-4">
                  <TabsTrigger value="quick">Quick</TabsTrigger>
                  <TabsTrigger value="marketing">Content</TabsTrigger>
                  <TabsTrigger value="collections">Collections</TabsTrigger>
                  <TabsTrigger value="analytics">Analytics</TabsTrigger>
                </TabsList>
                <TabsContent value="quick" className="pt-3">
                  <QuickShareActions
                    whatsappUrl={whatsappUrl}
                    copied={copied}
                    onCopy={() => void copyLink()}
                    onNearby={() => void nativeShare("nearby-share", "mobile")}
                    onNative={() => void nativeShare("native-share", "system-share")}
                  />
                  <TrackedLink value={shareUrl} />
                </TabsContent>
                <TabsContent value="marketing" className="space-y-3 pt-3">
                  <AssetCard icon={<ImageIcon />} title="Share Card" description="Branded 1200×630 PNG with product details and a tracked QR code.">
                    <Button variant="outline" type="button" onClick={() => setCardOpen((open) => !open)}>
                      <Download /> {cardOpen ? "Hide preview" : "Create share card"}
                    </Button>
                  </AssetCard>
                  {cardOpen ? (
                    <ShareCardStudio
                      product={product}
                      shareUrl={currentShareUrl(product, affiliate.affiliateCode, "share-card", "download", "organic")}
                      affiliateName={affiliate.displayName}
                      onDownloaded={(blob) => storeShareCard(blob, product.code)}
                    />
                  ) : null}
                  <AssetCard icon={<Smartphone />} title="WhatsApp Status Pack" description="Build 4, 6, or 8-item vertical packs from an Affiliate Collection.">
                    <Button asChild variant="outline"><Link href="/seller?tab=share-assets">Open Share Assets</Link></Button>
                  </AssetCard>
                  <AssetCard icon={<Video />} title="TikTok video" description="Render a 12-second vertical MP4 from an Affiliate Collection.">
                    <Button asChild variant="outline"><Link href="/seller?tab=share-assets">Open Share Assets</Link></Button>
                  </AssetCard>
                </TabsContent>
                <TabsContent value="collections" className="pt-3">
                  <CollectionPicker product={product} collections={payload?.collections ?? []} onChanged={refresh} />
                </TabsContent>
                <TabsContent value="analytics" className="pt-3">
                  <AnalyticsPreview payload={payload} />
                </TabsContent>
              </Tabs>
            ) : (
              <div className="space-y-5">
                <QuickShareActions
                  whatsappUrl={whatsappUrl}
                  copied={copied}
                  onCopy={() => void copyLink()}
                  onNearby={() => void nativeShare("nearby-share", "mobile")}
                  onNative={() => void nativeShare("native-share", "system-share")}
                />
                {loading ? <p className="text-sm text-muted-foreground">Checking Affiliate access…</p> : (
                  <Card>
                    <CardHeader>
                      <CardTitle>Want tracked campaigns and share assets?</CardTitle>
                      <CardDescription>Become an Affiliate instantly. Every new Affiliate starts at Level 1.</CardDescription>
                    </CardHeader>
                    <CardContent><Button asChild><Link href="/become-affiliate">Become an Affiliate</Link></Button></CardContent>
                  </Card>
                )}
              </div>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

export function ProductCollectionButton({ product, className }: { product: Product; className?: string }) {
  const { payload, refresh } = useAffiliateSession();
  if (!payload?.affiliate) return null;
  return (
    <Sheet>
      <SheetTrigger asChild>
        <button className={className || "absolute right-3 top-3 hidden rounded-full bg-white p-2 shadow-md group-hover:block"} type="button" aria-label={`Add ${product.title} to Collections`}>
          <Plus size={18} />
        </button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Add to Collections</SheetTitle>
          <SheetDescription>Choose one or several Collections for {product.title}.</SheetDescription>
        </SheetHeader>
        <div className="p-4"><CollectionPicker product={product} collections={payload.collections ?? []} onChanged={refresh} /></div>
      </SheetContent>
    </Sheet>
  );
}

function QuickShareActions({
  whatsappUrl,
  copied,
  onCopy,
  onNearby,
  onNative,
}: {
  whatsappUrl: string;
  copied: boolean;
  onCopy: () => void;
  onNearby: () => void;
  onNative: () => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <Button asChild><a href={whatsappUrl} target="_blank" rel="noreferrer"><MessageCircle /> WhatsApp</a></Button>
      <Button variant="outline" type="button" onClick={onCopy}>{copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy link"}</Button>
      <Button variant="outline" type="button" onClick={onNearby}><Radio /> Nearby · mobile</Button>
      <Button variant="outline" type="button" onClick={onNative}><Share2 /> System share</Button>
    </div>
  );
}

function CollectionPicker({
  product,
  collections,
  onChanged,
}: {
  product: Product;
  collections: AffiliateCollection[];
  onChanged: () => Promise<unknown>;
}) {
  const initial = useMemo(
    () => collections.filter((collection) => collection.products.some((item) => item.code === product.code)).map((collection) => collection.id),
    [collections, product.code],
  );
  const [selected, setSelected] = useState<string[]>(initial);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => setSelected(initial), [initial]);

  async function save(next = selected) {
    setBusy(true);
    setMessage(null);
    try {
      await affiliateJson("/api/affiliate/collections/product", {
        method: "PUT",
        body: JSON.stringify({ productCode: product.code, collectionIds: next }),
      });
      await onChanged();
      setMessage("Collection membership saved.");
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Collection membership could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    if (!title.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await affiliateJson<{ collection: AffiliateCollection }>("/api/affiliate/collections", {
        method: "POST",
        body: JSON.stringify({ title }),
      });
      const next = [...selected, result.collection.id];
      setSelected(next);
      setTitle("");
      await save(next);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Collection could not be created.");
      setBusy(false);
    }
  }

  return (
    <FieldGroup>
      <div className="space-y-2">
        {collections.length ? collections.map((collection) => (
          <Field key={collection.id} orientation="horizontal" className="rounded-lg border p-3">
            <Checkbox
              id={`collection-${collection.id}-${product.code}`}
              checked={selected.includes(collection.id)}
              onCheckedChange={(checked) => setSelected((current) => checked ? [...current, collection.id] : current.filter((id) => id !== collection.id))}
            />
            <FieldLabel htmlFor={`collection-${collection.id}-${product.code}`} className="flex-1">
              <span>{collection.title}</span>
              <Badge variant="outline">{collection.itemCount}/30</Badge>
            </FieldLabel>
          </Field>
        )) : <p className="text-sm text-muted-foreground">Create your first Collection below.</p>}
      </div>
      <Field>
        <FieldLabel htmlFor={`new-collection-${product.code}`}><FolderPlus /> New Collection</FieldLabel>
        <div className="flex gap-2">
          <Input id={`new-collection-${product.code}`} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Weekend favourites" />
          <Button type="button" variant="outline" onClick={() => void create()} disabled={busy || title.trim().length < 3}>Create</Button>
        </div>
        <FieldDescription>Collections publish when they contain 5–30 products.</FieldDescription>
      </Field>
      <Button type="button" onClick={() => void save()} disabled={busy}>{busy ? <LoaderCircle className="animate-spin" /> : <Check />} Save selections</Button>
      {message ? <p className="text-sm" role="status">{message}</p> : null}
    </FieldGroup>
  );
}

function AnalyticsPreview({ payload }: { payload: ReturnType<typeof useAffiliateSession>["payload"] }) {
  const metrics = payload?.dashboard?.metrics;
  if (!metrics) return <p className="text-sm text-muted-foreground">Analytics become available after your first tracked share.</p>;
  const rows = [
    ["Clicks", metrics.clicks.toLocaleString()],
    ["Total orders", metrics.ordersTotal.toLocaleString()],
    ["Paid orders", metrics.ordersPaid.toLocaleString()],
    ["Unpaid orders", metrics.ordersUnpaid.toLocaleString()],
    ["Sales", `KSh ${metrics.sales.toLocaleString("en-KE")}`],
    ["Commission", `KSh ${metrics.commission.toLocaleString("en-KE")}`],
  ];
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">{rows.map(([label, value]) => <Card key={label} size="sm"><CardContent><small className="text-muted-foreground">{label}</small><strong className="mt-1 block text-lg">{value}</strong></CardContent></Card>)}</div>
      <Card><CardHeader><CardTitle className="flex items-center gap-2"><BarChart3 /> Top performers</CardTitle><CardDescription>Collection: {metrics.topCollection || "Not enough data"}<br />Product: {metrics.topProduct || "Not enough data"}</CardDescription></CardHeader><CardContent><Button asChild variant="outline"><Link href="/seller?tab=analytics">Full analytics</Link></Button></CardContent></Card>
    </div>
  );
}

function AssetCard({ icon, title, description, children }: { icon: React.ReactNode; title: string; description: string; children: React.ReactNode }) {
  return <Card><CardHeader><CardTitle className="flex items-center gap-2">{icon}{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader><CardContent>{children}</CardContent></Card>;
}

function TrackedLink({ value }: { value: string }) {
  return <div className="mt-3 flex items-center gap-2 rounded-lg bg-muted p-3 text-xs text-muted-foreground"><Link2 className="shrink-0" /><span className="truncate">{value}</span></div>;
}

function useShareUrl(product: Product, ref: string | undefined, source: string, placement: string, campaign: string) {
  const [url, setUrl] = useState(() => currentShareUrl(product, ref, source, placement, campaign));
  useEffect(() => setUrl(currentShareUrl(product, ref, source, placement, campaign)), [campaign, placement, product, ref, source]);
  return url;
}

function currentShareUrl(product: Product, ref: string | undefined, source: string, placement: string, campaign: string) {
  const path = productPath(product.code, ref, { source, placement, campaign });
  return typeof window === "undefined" ? path : new URL(path, window.location.origin).toString();
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const field = document.createElement("textarea");
  field.value = value;
  document.body.append(field);
  field.select();
  document.execCommand("copy");
  field.remove();
}

function recordShare(product: Product, sellerRef: string | undefined, source: string) {
  recordClientEvent({ eventType: "share_action", productCode: product.code, sellerRef });
  void source;
}

async function storeShareCard(blob: Blob, productCode: string) {
  const form = new FormData();
  form.set("file", blob, `share-card-${productCode}.png`);
  form.set("productCode", productCode);
  await fetch("/api/affiliate/assets/share-card", { method: "POST", body: form });
}
