"use client";

import { CheckCircle2, Copy, Download, LoaderCircle, RotateCcw, Share2, Video } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { affiliateJson, useAffiliateSession } from "../../affiliate/affiliate-client";
import { buildShareLink } from "../../affiliate/affiliate-platform";
import { captionWithLink } from "../../affiliate/run-through";
import type { RunThroughPlan } from "../../affiliate/run-through-service";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import { useStorefrontI18n } from "../../i18n/use-storefront-i18n";

type CategoryOption = { value: string; label: string; count: number };
type Listing = { videos: RunThroughPlan[]; categories: CategoryOption[] };
type Translate = ReturnType<typeof useStorefrontI18n>["t"];

// While any of today's videos is still being made, check back this often.
const REFRESH_MS = 30_000;
// Cover and end card, in frames, for the length shown on each card.
const FIXED_FRAMES = 75;

/**
 * Today's TikTok videos, made overnight: three a day, each a different
 * category and a different look. The affiliate downloads each, posts it with
 * a trending sound, and pastes the caption. An extra video of any category can
 * be made on the spot. Music is added in TikTok.
 */
export function RunThroughVideos() {
  const { t } = useStorefrontI18n();
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/affiliate/run-through-video", { cache: "no-store" });
      const payload = await response.json() as Listing & { error?: string };
      if (!response.ok) throw new Error(payload.error || t("affiliate.videos.loadFailed"));
      setListing(payload);
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("affiliate.videos.loadFailed"));
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  const waiting = listing?.videos.some((video) => !video.stored && video.status === "PROCESSING");
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [waiting, load]);

  const videos = listing?.videos ?? [];
  const downloaded = videos.filter((video) => video.downloaded).length;
  return (
    <div className="space-y-5">
      <header>
        <h2 className="text-xl font-semibold tracking-tight">{t("affiliate.videos.title")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t("affiliate.videos.intro", { count: videos.length || 3 })}</p>
      </header>

      {error ? <p className="rounded-md border bg-card px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
      {!listing && !error ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" /> {t("affiliate.videos.loading")}</p>
      ) : null}

      {videos.length ? (
        <>
          <Badge variant={downloaded >= videos.length ? "default" : "outline"}>{t("affiliate.videos.progress", { done: downloaded, total: videos.length })}</Badge>
          <div className="grid gap-4 xl:grid-cols-3">
            {videos.map((video) => (
              <VideoCard key={video.id} plan={video} title={t("affiliate.videos.card", { slot: video.slot ?? 1 })} onChanged={load} t={t} />
            ))}
          </div>
        </>
      ) : listing ? (
        <p className="rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">{t("affiliate.videos.none")}</p>
      ) : null}

      {listing?.categories.length ? <ExtraVideo categories={listing.categories} t={t} /> : null}
    </div>
  );
}

function VideoCard({ plan, title, onChanged, t }: { plan: RunThroughPlan; title: string; onChanged?: () => Promise<void> | void; t: Translate }) {
  // The caption ends with the promoter's own tracked link, tagged as a WhatsApp Status post.
  const { payload: session } = useAffiliateSession();
  const affiliateCode = session?.affiliate?.affiliateCode;
  const caption = affiliateCode && typeof window !== "undefined"
    ? captionWithLink(plan.caption, new URL(buildShareLink("/", affiliateCode, "STATUS"), window.location.origin).toString())
    : plan.caption;
  const [making, setMaking] = useState(false);
  const [blobUrl, setBlobUrl] = useState("");
  const [message, setMessage] = useState("");
  const [stored, setStored] = useState(plan.stored);
  const fileUrl = `/api/affiliate/run-through-video/${plan.id}/file`;
  const source = stored ? fileUrl : blobUrl;
  const seconds = Math.round((FIXED_FRAMES + plan.items.length * plan.variant.itemFrames) / 30);

  useEffect(() => setStored(plan.stored), [plan.stored]);

  async function makeNow() {
    setMaking(true);
    setMessage("");
    try {
      const response = await fetch(`/api/affiliate/run-through-video/${plan.id}`, { method: "POST" });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error || t("affiliate.videos.makeFailed"));
      }
      if (response.headers.get("content-type")?.includes("video/mp4")) {
        setBlobUrl(URL.createObjectURL(await response.blob()));
      } else {
        setStored(true);
      }
      await onChanged?.();
    } catch (makeError) {
      setMessage(makeError instanceof Error ? makeError.message : t("affiliate.videos.makeFailed"));
    } finally {
      setMaking(false);
    }
  }

  async function share() {
    try {
      const blob = await (await fetch(stored ? `${fileUrl}?download=1` : blobUrl)).blob();
      const file = new File([blob], `direct-loop-${plan.id.slice(0, 8)}.mp4`, { type: "video/mp4" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file] });
        await onChanged?.();
      } else {
        setMessage(t("affiliate.videos.shareUnsupported"));
      }
    } catch {
      // The share sheet was closed.
    }
  }

  async function copy(value: string, done: string) {
    await navigator.clipboard.writeText(value).then(() => setMessage(done), () => setMessage(t("affiliate.videos.copyFailed")));
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span>{title} · {plan.categoryLabel}</span>
          {plan.downloaded ? <Badge variant="outline" className="gap-1 font-normal"><CheckCircle2 className="size-3" /> {t("affiliate.videos.downloaded")}</Badge> : null}
        </CardTitle>
        <CardDescription>{t("affiliate.videos.pieces", { count: plan.items.length, seconds })}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {source ? (
          <>
            <video src={source} controls playsInline preload="metadata" className="aspect-[9/16] w-full rounded-md border bg-black" />
            <div className="grid grid-cols-2 gap-2">
              <Button asChild variant="outline">
                <a
                  href={stored ? `${fileUrl}?download=1` : blobUrl}
                  download={`direct-loop-${plan.id.slice(0, 8)}.mp4`}
                  onClick={() => window.setTimeout(() => void onChanged?.(), 1500)}
                >
                  <Download /> {t("affiliate.videos.download")}
                </a>
              </Button>
              <Button onClick={() => void share()}><Share2 /> {t("affiliate.videos.share")}</Button>
            </div>
          </>
        ) : (
          <div className="flex aspect-[9/16] w-full flex-col items-center justify-center gap-3 rounded-md border border-dashed bg-muted/50 p-6 text-center text-sm text-muted-foreground">
            {making ? <LoaderCircle className="size-6 animate-spin" /> : <Video className="size-6" />}
            <p>{making ? t("affiliate.videos.making") : plan.status === "FAILED" ? t("affiliate.videos.failed") : t("affiliate.videos.waiting")}</p>
            <Button size="sm" variant="outline" disabled={making} onClick={() => void makeNow()}>
              {plan.status === "FAILED" ? <RotateCcw /> : <Video />} {plan.status === "FAILED" ? t("affiliate.videos.retry") : t("affiliate.videos.makeNow")}
            </Button>
          </div>
        )}

        <Textarea value={caption} readOnly rows={4} className="resize-none text-xs" />
        <Button variant="outline" className="w-full" onClick={() => void copy(caption, t("affiliate.videos.captionCopied"))}>
          <Copy /> {t("affiliate.videos.copyCaption")}
        </Button>

        <details className="rounded-md border">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium">{t("affiliate.videos.pieceLinks")}</summary>
          <div className="divide-y border-t">
            {plan.items.map((item) => (
              <div key={item.productId} className="flex items-center gap-3 px-3 py-2">
                <span className="w-9 shrink-0 font-mono text-xs text-muted-foreground">{String(item.number).padStart(2, "0")}</span>
                <img src={item.image} alt="" className="size-10 shrink-0 rounded border bg-white object-contain" />
                <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{item.size ? `${item.size} · ` : ""}KSh {item.price.toLocaleString("en-KE")}</p>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t("affiliate.videos.pieceLinks")}
                  onClick={() => void copy(new URL(item.link, window.location.origin).toString(), t("affiliate.videos.linkCopied", { number: item.number }))}
                >
                  <Copy />
                </Button>
              </div>
            ))}
          </div>
        </details>

        <p className="text-xs text-muted-foreground">{t("affiliate.videos.stepsBody")}</p>
        {message ? <p className="text-sm" role="status">{message}</p> : null}
      </CardContent>
    </Card>
  );
}

function ExtraVideo({ categories, t }: { categories: CategoryOption[]; t: Translate }) {
  const [category, setCategory] = useState(categories[0]?.value ?? "");
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<RunThroughPlan | null>(null);
  const [message, setMessage] = useState("");

  async function make() {
    setBusy(true);
    setMessage("");
    setPlan(null);
    try {
      const { plan: next } = await affiliateJson<{ plan: RunThroughPlan }>("/api/affiliate/run-through-video", { method: "POST", body: JSON.stringify({ category }) });
      setPlan(next);
    } catch (makeError) {
      setMessage(makeError instanceof Error ? makeError.message : t("affiliate.videos.makeFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("affiliate.videos.extraTitle")}</CardTitle>
        <CardDescription>{t("affiliate.videos.extraBody")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Select value={category} onValueChange={setCategory} disabled={busy}>
          <SelectTrigger className="w-full"><SelectValue placeholder={t("affiliate.videos.chooseCategory")} /></SelectTrigger>
          <SelectContent>
            {categories.map((option) => (
              <SelectItem key={option.value} value={option.value}>{option.label} · {t("affiliate.videos.inStock", { count: option.count })}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button className="w-full" onClick={() => void make()} disabled={busy || !category}>
          {busy ? <LoaderCircle className="animate-spin" /> : <Video />} {busy ? t("affiliate.videos.picking") : t("affiliate.videos.makeExtra")}
        </Button>
        {message ? <p className="text-sm text-destructive" role="alert">{message}</p> : null}
        {plan ? <div className="max-w-sm"><VideoCard plan={plan} title={t("affiliate.videos.extraCard")} t={t} /></div> : null}
      </CardContent>
    </Card>
  );
}
