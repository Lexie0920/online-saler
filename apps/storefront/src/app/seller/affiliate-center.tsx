"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { BarChart3, CircleDollarSign, Copy, Eye, Home as HomeIcon, LoaderCircle, Share2, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { type AffiliateSessionPayload, useAffiliateSession } from "../../affiliate/affiliate-client";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { useStorefrontI18n } from "../../i18n/use-storefront-i18n";
import { SiteHeader } from "../components/site-header";
import { BadgeShield } from "./badge-art";
import { CenterMessage, copyText, Notice, type Translate } from "./center-ui";
import { Collections } from "./collections";
import { Earnings } from "./earnings";
import { Home, type HomeTarget } from "./home";
import { NewArrivals } from "./new-arrivals";
import { Results } from "./results";
import { RunThroughVideos } from "./run-through-videos";
import { StatusPacks } from "./status-packs";

/** The five sidebar sections. */
type CenterSection = "home" | "share" | "results" | "earnings" | "community";
/** The tabs inside Share. */
type ShareTab = "packs" | "videos" | "collections" | "new";
/**
 * Where a button or an old link wants to go. The old section names keep working
 * (for example /seller?tab=share-assets); they are mapped onto the five sections below.
 */
type CenterTab = "dashboard" | "tiktok-video" | "collections" | "campaigns" | "share-assets" | "analytics" | "commission" | "new-arrivals" | CenterSection;

const sections: Array<{ id: CenterSection; label: "affiliate.nav.home" | "affiliate.nav.share" | "affiliate.nav.results" | "affiliate.nav.earnings" | "affiliate.nav.community"; icon: React.ReactNode }> = [
  { id: "home", label: "affiliate.nav.home", icon: <HomeIcon /> },
  { id: "share", label: "affiliate.nav.share", icon: <Share2 /> },
  { id: "results", label: "affiliate.nav.results", icon: <BarChart3 /> },
  { id: "earnings", label: "affiliate.nav.earnings", icon: <CircleDollarSign /> },
  { id: "community", label: "affiliate.nav.community", icon: <Users /> },
];

const shareTabs: Array<{ id: ShareTab; label: "affiliate.share.packs" | "affiliate.share.videos" | "affiliate.share.collections" | "affiliate.share.new"; sub: "affiliate.share.packsSub" | "affiliate.share.videosSub" | "affiliate.share.collectionsSub" | "affiliate.share.newSub" }> = [
  { id: "packs", label: "affiliate.share.packs", sub: "affiliate.share.packsSub" },
  { id: "videos", label: "affiliate.share.videos", sub: "affiliate.share.videosSub" },
  { id: "collections", label: "affiliate.share.collections", sub: "affiliate.share.collectionsSub" },
  { id: "new", label: "affiliate.share.new", sub: "affiliate.share.newSub" },
];

const destinations: Record<CenterTab, { section: CenterSection; share?: ShareTab }> = {
  home: { section: "home" }, dashboard: { section: "home" },
  share: { section: "share" }, "share-assets": { section: "share", share: "packs" },
  "tiktok-video": { section: "share", share: "videos" }, collections: { section: "share", share: "collections" },
  campaigns: { section: "share", share: "collections" }, "new-arrivals": { section: "share", share: "new" },
  results: { section: "results" }, analytics: { section: "results" },
  earnings: { section: "earnings" }, commission: { section: "earnings" },
  community: { section: "community" },
};

function destinationFor(value: string | null) {
  return value && Object.prototype.hasOwnProperty.call(destinations, value) ? destinations[value as CenterTab] : null;
}

export function AffiliateCenter() {
  const { t } = useStorefrontI18n();
  const searchParams = useSearchParams();
  const { payload, loading, error, refresh } = useAffiliateSession();
  const requestedTab = searchParams.get("tab");
  const requested = destinationFor(requestedTab);
  const [tab, setSection] = useState<CenterSection>(requested?.section ?? "home");
  const [shareTab, setShareTab] = useState<ShareTab>(requested?.share ?? "packs");
  const [packCollectionId, setPackCollectionId] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const next = destinationFor(requestedTab);
    if (!next) return;
    setSection(next.section);
    if (next.share) setShareTab(next.share);
  }, [requestedTab]);

  // On a phone the section bar scrolls sideways: keep the open section in view.
  useEffect(() => {
    document.querySelector('nav[data-affiliate-nav] [aria-current="page"]')?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [tab, payload]);

  function setTab(target: CenterTab) {
    const next = destinations[target];
    setSection(next.section);
    if (next.share) setShareTab(next.share);
  }

  if (loading && !payload) {
    return <CenterMessage icon={<LoaderCircle className="animate-spin" />} title={t("affiliate.loading.title")} body={t("affiliate.loading.body")} />;
  }
  if (error || !payload?.affiliate) {
    return (
      <CenterMessage
        icon={<Share2 />}
        title={t("affiliate.denied.title")}
        body={error || t("affiliate.denied.body")}
        action={<Button asChild><Link href="/become-affiliate">{t("affiliate.denied.action")}</Link></Button>}
      />
    );
  }

  const level = payload.affiliate.level.replace("LEVEL_", "");
  const activeShare = shareTabs.find((item) => item.id === shareTab) ?? shareTabs[0];
  return (
    <main className="affiliateConsole min-h-screen bg-muted/50">
      <SiteHeader />
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        <header className="mb-6 flex flex-col justify-between gap-4 border-b pb-6 sm:flex-row sm:items-end">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">{t("affiliate.badge.level", { level })}</Badge>
              <Badge variant="outline">{t("affiliate.badge.active")}</Badge>
            </div>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">{t("affiliate.title")}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t("affiliate.welcome", { name: payload.affiliate.displayName })}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm"><Link href={`/seller/${payload.affiliate.slug}`} target="_blank"><Eye /> {t("affiliate.publicProfile")}</Link></Button>
            <Button type="button" size="sm" onClick={() => void copyText(publicProfileUrl(payload)).then(() => setNotice(t("affiliate.copied")))}>
              <Copy /> {t("affiliate.copyProfile")}
            </Button>
          </div>
        </header>

        {notice ? <p className="mb-4 rounded-md border bg-card px-3 py-2 text-sm" role="status">{notice}</p> : null}

        <div className="grid gap-6 lg:grid-cols-[13rem_1fr]">
          <nav data-affiliate-nav className="flex gap-1 overflow-x-auto rounded-lg border bg-card p-1.5 lg:flex-col lg:self-start" aria-label={t("affiliate.nav.label")}>
            {sections.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-current={tab === item.id ? "page" : undefined}
                className={`flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium transition ${tab === item.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
                onClick={() => setTab(item.id)}
              >
                {item.icon}{t(item.label)}
              </button>
            ))}
          </nav>
          <section className="min-w-0">
            {tab === "home" ? <Home payload={payload} setTab={(target: HomeTarget) => setTab(target)} t={t} /> : null}
            {tab === "share" ? (
              <div className="space-y-5">
                <header>
                  <h2 className="text-xl font-semibold tracking-tight">{t("affiliate.nav.share")}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">{t(activeShare.sub)}</p>
                </header>
                <div className="flex flex-wrap gap-2" role="tablist" aria-label={t("affiliate.share.label")}>
                  {shareTabs.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      role="tab"
                      aria-selected={shareTab === item.id}
                      className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-medium transition ${shareTab === item.id ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"}`}
                      onClick={() => setShareTab(item.id)}
                    >
                      {t(item.label)}
                    </button>
                  ))}
                </div>
                {shareTab === "packs" ? <StatusPacks payload={payload} initialCollectionId={packCollectionId} t={t} /> : null}
                {shareTab === "videos" ? <RunThroughVideos /> : null}
                {shareTab === "collections" ? (
                  <Collections
                    collections={payload.collections ?? []}
                    affiliateCode={payload.affiliate.affiliateCode}
                    refresh={refresh}
                    openStatusPack={(collectionId) => { setPackCollectionId(collectionId); setShareTab("packs"); }}
                    t={t}
                  />
                ) : null}
                {shareTab === "new" ? <NewArrivals affiliateCode={payload.affiliate.affiliateCode} collections={payload.collections ?? []} refresh={refresh} /> : null}
              </div>
            ) : null}
            {tab === "results" ? <Results payload={payload} setTab={(target) => setTab(target)} t={t} /> : null}
            {tab === "earnings" ? <Earnings payload={payload} t={t} /> : null}
            {tab === "community" ? <CommunityPlaceholder payload={payload} t={t} /> : null}
          </section>
        </div>
      </div>
    </main>
  );
}

/** Community for now: this week in two numbers. The board, wins and tips come later. */
function CommunityPlaceholder({ payload, t }: { payload: AffiliateSessionPayload; t: Translate }) {
  const community = payload.dashboard?.community;
  return (
    <div className="space-y-5">
      {community ? (
        <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-green-950 dark:border-green-900 dark:bg-green-950/40 dark:text-green-100">
          <p className="text-base font-semibold">{t("affiliate.community.banner", { shared: community.shared, orders: community.gotOrders })} 👏</p>
          <p className="mt-0.5 text-sm opacity-80">{t("affiliate.community.notAlone")}</p>
        </div>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>{t("affiliate.community.title")}</CardTitle>
          <CardDescription>{t("affiliate.community.soon")}</CardDescription>
        </CardHeader>
        <CardContent><Notice>{t("affiliate.community.later")}</Notice></CardContent>
      </Card>
      <CommunityExample t={t} />
    </div>
  );
}

/** A made-up board and two made-up posts, so promoters can see what is coming. Always labelled as an example. */
function CommunityExample({ t }: { t: Translate }) {
  const board = [
    { id: "a", orders: 41, badge: "mkali", name: t("affiliate.community.promoter", { letter: "A" }) },
    { id: "b", orders: 33, badge: "moto", name: t("affiliate.community.promoter", { letter: "B" }) },
    { id: "c", orders: 29, badge: "poa", name: t("affiliate.community.promoter", { letter: "C" }) },
    { id: "you", orders: 12, badge: "moto", name: t("affiliate.community.you") },
  ];
  const posts = [
    { id: "p1", who: t("affiliate.community.promoter", { letter: "A" }), text: t("affiliate.community.post1"), orders: 3 },
    { id: "p2", who: t("affiliate.community.promoter", { letter: "B" }), text: t("affiliate.community.post2"), orders: 2 },
  ];
  return (
    <section className="space-y-3 opacity-90" aria-label={t("affiliate.community.example")}>
      <p className="inline-block rounded-md bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">{t("affiliate.community.example")}</p>
      <div className="grid gap-4 lg:grid-cols-[1fr_1.3fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("affiliate.community.boardTitle")}</CardTitle>
            <CardDescription>{t("affiliate.community.boardBody")}</CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="text-sm">
              {board.map((row, index) => (
                <li key={row.id} className={`flex items-center gap-2 border-t py-2 ${row.id === "you" ? "bg-green-50 dark:bg-green-950/30" : ""}`}>
                  <span className="w-5 text-muted-foreground">{index + 1}</span>
                  <BadgeShield id={row.badge} size={22} />
                  <span className="flex-1">{row.name}</span>
                  <strong>{t("affiliate.community.orders", { count: row.orders })}</strong>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">{t("affiliate.community.postsTitle")}</h3>
          {posts.map((post) => (
            <Card key={post.id}>
              <CardContent className="space-y-2 pt-4">
                <p className="text-sm font-semibold">{post.who}</p>
                <div className="flex h-24 items-center justify-center rounded-md bg-muted text-xs text-muted-foreground">{t("affiliate.community.postPicture")}</div>
                <p className="text-sm">{post.text}</p>
                <p className="text-sm font-semibold text-green-700">{t("affiliate.community.postFromOrders", { count: post.orders })}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

function publicProfileUrl(payload: AffiliateSessionPayload) {
  const path = `/seller/${payload.affiliate?.slug}`;
  return typeof window === "undefined" ? path : new URL(path, window.location.origin).toString();
}
