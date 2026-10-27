"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Archive,
  BarChart3,
  BookImage,
  CheckCircle2,
  CircleDollarSign,
  Copy,
  Download,
  Eye,
  FolderHeart,
  LayoutDashboard,
  LoaderCircle,
  PackageCheck,
  PauseCircle,
  Plus,
  Share2,
  Trash2,
  Users,
} from "lucide-react";
import { LAUNCH_AFFILIATE_COMMISSION_RATE_BPS } from "@online-saler/business-rules";
import { FormEvent, useEffect, useState } from "react";
import {
  affiliateJson,
  type AffiliateCollection,
  type AffiliateSessionPayload,
  useAffiliateSession,
} from "../../affiliate/affiliate-client";
import { affiliateNextGoal, affiliateWeekComparison, nextPayoutDate, type AffiliateNextGoal } from "../../affiliate/affiliate-platform";
import { generateStatusPack } from "../../affiliate/status-pack-generator";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../../components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../../components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Textarea } from "../../components/ui/textarea";
import { useStorefrontI18n } from "../../i18n/use-storefront-i18n";
import { SiteHeader } from "../components/site-header";
import { bestPoint, EXAMPLE_ORDERS_PER_DAY, LineChart, runningTotal } from "./affiliate-charts";
import { RunThroughVideos } from "./run-through-videos";
import { NewArrivals } from "./new-arrivals";
import { ShareDialog } from "./share-dialog";

/** The five sidebar sections. */
type CenterSection = "home" | "share" | "results" | "earnings" | "community";
/** The tabs inside Share. */
type ShareTab = "packs" | "videos" | "collections" | "new";
/**
 * Where a button or an old link wants to go. The old section names keep working
 * (for example /seller?tab=share-assets), they are mapped onto the five sections below.
 */
type CenterTab = "dashboard" | "tiktok-video" | "collections" | "campaigns" | "share-assets" | "analytics" | "commission" | CenterSection;
type Translate = ReturnType<typeof useStorefrontI18n>["t"];

const sections: Array<{ id: CenterSection; label: "affiliate.nav.home" | "affiliate.nav.share" | "affiliate.nav.results" | "affiliate.nav.earnings" | "affiliate.nav.community"; icon: React.ReactNode }> = [
  { id: "home", label: "affiliate.nav.home", icon: <LayoutDashboard /> },
  { id: "share", label: "affiliate.nav.share", icon: <Share2 /> },
  { id: "results", label: "affiliate.nav.results", icon: <BarChart3 /> },
  { id: "earnings", label: "affiliate.nav.earnings", icon: <CircleDollarSign /> },
  { id: "community", label: "affiliate.nav.community", icon: <Users /> },
];

const shareTabs: Array<{ id: ShareTab; label: "affiliate.share.packs" | "affiliate.share.videos" | "affiliate.share.collections" | "affiliate.share.new" }> = [
  { id: "packs", label: "affiliate.share.packs" },
  { id: "videos", label: "affiliate.share.videos" },
  { id: "collections", label: "affiliate.share.collections" },
  { id: "new", label: "affiliate.share.new" },
];

const destinations: Record<CenterTab, { section: CenterSection; share?: ShareTab }> = {
  home: { section: "home" }, dashboard: { section: "home" },
  share: { section: "share" }, "share-assets": { section: "share", share: "packs" },
  "tiktok-video": { section: "share", share: "videos" }, collections: { section: "share", share: "collections" },
  campaigns: { section: "share", share: "collections" },
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
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const next = destinationFor(requestedTab);
    if (!next) return;
    setSection(next.section);
    if (next.share) setShareTab(next.share);
  }, [requestedTab]);

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
          <nav className="flex gap-1 overflow-x-auto rounded-lg border bg-card p-1.5 lg:flex-col lg:self-start" aria-label={t("affiliate.nav.label")}>
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
            {tab === "home" ? <Dashboard payload={payload} setTab={setTab} t={t} /> : null}
            {tab === "share" ? (
              <div className="space-y-5">
                <div className="flex gap-1 overflow-x-auto rounded-lg border bg-card p-1" role="tablist" aria-label={t("affiliate.share.label")}>
                  {shareTabs.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      role="tab"
                      aria-selected={shareTab === item.id}
                      className={`shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition ${shareTab === item.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
                      onClick={() => setShareTab(item.id)}
                    >
                      {t(item.label)}
                    </button>
                  ))}
                </div>
                {shareTab === "packs" ? <ShareAssets payload={payload} t={t} /> : null}
                {shareTab === "videos" ? <RunThroughVideos /> : null}
                {shareTab === "new" ? <NewArrivals affiliateCode={payload.affiliate.affiliateCode} /> : null}
                {shareTab === "collections" ? <Collections collections={payload.collections ?? []} affiliateCode={payload.affiliate.affiliateCode} refresh={refresh} t={t} /> : null}
              </div>
            ) : null}
            {tab === "results" ? <Analytics payload={payload} setTab={setTab} t={t} /> : null}
            {tab === "earnings" ? <Commission payload={payload} t={t} /> : null}
            {tab === "community" ? (
              <Empty className="border bg-card">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><Users /></EmptyMedia>
                  <EmptyTitle>{t("affiliate.community.title")}</EmptyTitle>
                  <EmptyDescription>{t("affiliate.community.soon")}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : null}
          </section>
        </div>
      </div>
    </main>
  );
}

function Dashboard({ payload, setTab, t }: { payload: AffiliateSessionPayload; setTab: (tab: CenterTab) => void; t: Translate }) {
  const metrics = payload.dashboard?.metrics;
  const daily = payload.dashboard?.daily ?? [];
  const collections = payload.collections ?? [];
  const [range, setRange] = useState<7 | 30>(7);
  const isNew = !(metrics?.clicks) && !(metrics?.ordersTotal);
  const { thisWeek, lastWeek } = affiliateWeekComparison(daily);
  const points = daily.slice(-range).map((day) => ({ label: day.date.slice(5), value: day.orders }));
  const goal = affiliateNextGoal({
    collections: collections.length,
    largestCollectionItems: Math.max(0, ...collections.map((item) => item.itemCount)),
    ordersTotal: metrics?.ordersTotal ?? 0,
    thisWeek,
    lastWeek,
  });
  const readyToPay = payload.dashboard?.commission?.CONFIRMED ?? 0;
  const exampleSale = 800;
  const exampleEarn = Math.round((exampleSale * LAUNCH_AFFILIATE_COMMISSION_RATE_BPS) / 10_000);
  const stats = [
    [t("affiliate.metric.commission"), money(metrics?.commission ?? 0), null],
    [t("affiliate.metric.orders"), String(metrics?.ordersPaid ?? 0), (metrics?.ordersUnpaid ?? 0) > 0 ? t("affiliate.home.unpaidNote", { count: metrics?.ordersUnpaid ?? 0 }) : null],
    [t("affiliate.metric.clicks"), String(metrics?.clicks ?? 0), null],
    [t("affiliate.home.nextPayout"), money(readyToPay), nextPayoutDate()],
  ] as const;
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle>{homeHeadline(t, isNew, thisWeek, lastWeek)}</CardTitle>
          <CardDescription>{t("affiliate.dashboard.todayBody")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button onClick={() => setTab(isNew ? "tiktok-video" : "share-assets")}><Share2 /> {t("affiliate.home.postStatus")}</Button>
          <Button variant="outline" onClick={() => setTab("collections")}><Plus /> {t("affiliate.dashboard.newCollection")}</Button>
        </CardContent>
      </Card>

      {isNew ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("affiliate.home.stepsTitle")}</CardTitle>
            <CardDescription>{t("affiliate.home.exampleEarn", { sale: exampleSale.toLocaleString("en-KE"), earn: exampleEarn.toLocaleString("en-KE") })}</CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="space-y-2 text-sm">
              {(["affiliate.home.step1", "affiliate.home.step2", "affiliate.home.step3"] as const).map((key, index) => (
                <li key={key} className="flex items-start gap-3 rounded-md border bg-muted/40 px-3 py-2">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">{index + 1}</span>
                  <span>{t(key)}</span>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {stats.map(([label, value, note]) => <MetricCard key={label} label={label} value={value} note={note} />)}
          </div>
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle>{t("affiliate.results.chartTitle")}</CardTitle>
                <div className="flex gap-1" role="group" aria-label={t("affiliate.results.range")}>
                  {([7, 30] as const).map((value) => (
                    <Button key={value} size="sm" variant={range === value ? "default" : "outline"} aria-pressed={range === value} onClick={() => setRange(value)}>
                      {t(value === 7 ? "affiliate.results.range7" : "affiliate.results.range30")}
                    </Button>
                  ))}
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <LineChart points={points} ariaLabel={t("affiliate.results.chartAria", { days: range })} formatValue={(value) => t("affiliate.results.ordersCount", { count: value })} />
            </CardContent>
          </Card>
        </>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t("affiliate.home.goalTitle")}</CardTitle>
          <CardDescription>{goalText(t, goal)}</CardDescription>
        </CardHeader>
        <CardFooter>
          <Button variant="outline" onClick={() => setTab(goal.kind === "createCollection" || goal.kind === "addProducts" ? "collections" : "share-assets")}>
            {goal.kind === "createCollection" || goal.kind === "addProducts" ? t("affiliate.dashboard.newCollection") : t("affiliate.home.postStatus")}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}

function homeHeadline(t: Translate, isNew: boolean, thisWeek: number, lastWeek: number) {
  if (isNew) return t("affiliate.home.headlineNew");
  if (thisWeek > lastWeek && thisWeek > 0) return t("affiliate.home.headlineUp", { count: thisWeek });
  if (thisWeek > 0) return t("affiliate.home.headlineSome", { count: thisWeek });
  return t("affiliate.home.headlineQuiet");
}

function goalText(t: Translate, goal: AffiliateNextGoal) {
  if (goal.kind === "createCollection") return t("affiliate.home.goalCreate");
  if (goal.kind === "addProducts") return t("affiliate.home.goalAdd", { count: goal.count });
  if (goal.kind === "firstOrder") return t("affiliate.home.goalFirst");
  return t("affiliate.home.goalBeat", { count: goal.target });
}

function Collections({ collections, affiliateCode, refresh, t }: { collections: AffiliateCollection[]; affiliateCode: string; refresh: () => Promise<unknown>; t: Translate }) {
  const [sharing, setSharing] = useState<AffiliateCollection | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusyId("create");
    try {
      await affiliateJson("/api/affiliate/collections", { method: "POST", body: JSON.stringify({ title, description }) });
      setTitle(""); setDescription(""); setMessage(t("affiliate.collections.created")); await refresh();
    } catch (caught) { setMessage(errorMessage(caught, t)); } finally { setBusyId(null); }
  }

  async function action(collection: AffiliateCollection, nextAction: "PUBLISH" | "ARCHIVE" | "RESTORE" | "DELETE") {
    setBusyId(collection.id); setMessage(null);
    try {
      await affiliateJson(`/api/affiliate/collections/${collection.id}`, nextAction === "DELETE"
        ? { method: "DELETE" }
        : { method: "PATCH", body: JSON.stringify({ action: nextAction }) });
      setMessage(t("affiliate.collections.updated", { title: collection.title })); await refresh();
    } catch (caught) { setMessage(errorMessage(caught, t)); } finally { setBusyId(null); }
  }

  async function rename(collection: AffiliateCollection) {
    const nextTitle = window.prompt(t("affiliate.collections.renamePrompt"), collection.title)?.trim();
    if (!nextTitle || nextTitle === collection.title) return;
    setBusyId(collection.id);
    try { await affiliateJson(`/api/affiliate/collections/${collection.id}`, { method: "PATCH", body: JSON.stringify({ title: nextTitle }) }); await refresh(); }
    catch (caught) { setMessage(errorMessage(caught, t)); } finally { setBusyId(null); }
  }

  return (
    <div className="space-y-5">
      <SectionHeading title={t("affiliate.collections.title")} body={t("affiliate.collections.body")} />
      <Card>
        <CardHeader><CardTitle>{t("affiliate.collections.new")}</CardTitle><CardDescription>{t("affiliate.collections.newBody")}</CardDescription></CardHeader>
        <CardContent>
          <form onSubmit={create}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="collection-title">{t("affiliate.collections.titleField")}</FieldLabel>
                <Input id="collection-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t("affiliate.collections.titlePlaceholder")} />
              </Field>
              <Field>
                <FieldLabel htmlFor="collection-description">{t("affiliate.collections.descriptionField")}</FieldLabel>
                <Textarea id="collection-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t("affiliate.collections.descriptionPlaceholder")} />
              </Field>
              <Button type="submit" disabled={busyId === "create" || title.trim().length < 3}>
                {busyId === "create" ? <LoaderCircle className="animate-spin" /> : <Plus />} {t("affiliate.collections.create")}
              </Button>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
      {message ? <Notice>{message}</Notice> : null}
      <ShareDialog
        open={Boolean(sharing)}
        onOpenChange={(open) => { if (!open) setSharing(null); }}
        title={sharing?.title ?? ""}
        path={sharing ? `/c/${sharing.slug}` : "/"}
        affiliateCode={affiliateCode}
      />
      {collections.length ? (
        <div className="grid gap-4 xl:grid-cols-2">
          {collections.map((collection) => (
            <Card key={collection.id} className="overflow-hidden">
              {collection.coverImage ? <img src={collection.coverImage} alt="" className="h-40 w-full object-cover" /> : null}
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle>{collection.title}</CardTitle>
                    <CardDescription>{collection.description || t("affiliate.collections.noDescription")}</CardDescription>
                  </div>
                  <Badge variant={collection.status === "PUBLISHED" ? "default" : "outline"}>{collection.status}</Badge>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <span>{t("affiliate.collections.count", { count: collection.itemCount })}</span>
                  <span>·</span>
                  <Link className="underline underline-offset-4" href={`/c/${collection.slug}`} target="_blank">{t("affiliate.collections.publicPage")}</Link>
                </div>
                {collection.itemCount < 5 ? <p className="mt-2 text-xs text-muted-foreground">{t("affiliate.collections.needMore", { count: 5 - collection.itemCount })}</p> : null}
              </CardContent>
              <CardFooter className="flex flex-wrap gap-2">
                {collection.status === "PUBLISHED" ? (
                  <Button size="sm" onClick={() => setSharing(collection)}><Share2 /> {t("affiliate.shareDialog.button")}</Button>
                ) : null}
                <Button size="sm" variant="outline" onClick={() => void rename(collection)}>{t("affiliate.collections.rename")}</Button>
                {collection.status === "PUBLISHED" ? (
                  <Button size="sm" variant="outline" onClick={() => void action(collection, "ARCHIVE")}><Archive /> {t("affiliate.collections.archive")}</Button>
                ) : (
                  <Button size="sm" onClick={() => void action(collection, collection.status === "ARCHIVED" ? "RESTORE" : "PUBLISH")} disabled={collection.status !== "ARCHIVED" && collection.itemCount < 5}>
                    {collection.status === "ARCHIVED" ? t("affiliate.collections.restore") : t("affiliate.collections.publish")}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busyId === collection.id}
                  onClick={() => window.confirm(t("affiliate.collections.deleteConfirm", { title: collection.title })) && void action(collection, "DELETE")}
                >
                  <Trash2 /> {t("affiliate.collections.delete")}
                </Button>
              </CardFooter>
            </Card>
          ))}
        </div>
      ) : (
        <EmptyState icon={<FolderHeart />} title={t("affiliate.collections.emptyTitle")} body={t("affiliate.collections.emptyBody")} action={t("affiliate.collections.browse")} />
      )}
    </div>
  );
}

function ShareAssets({ payload, t }: { payload: AffiliateSessionPayload; t: Translate }) {
  const collections = payload.collections ?? [];
  const [collectionId, setCollectionId] = useState(collections[0]?.id ?? "");
  const [count, setCount] = useState<"4" | "6" | "8">("4");
  const [busy, setBusy] = useState<"status" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const collection = collections.find((item) => item.id === collectionId) ?? null;

  async function statusPack() {
    if (!collection || !payload.affiliate) return;
    setBusy("status"); setMessage(null);
    try {
      const blob = await generateStatusPack(collection, payload.affiliate, Number(count) as 4 | 6 | 8, window.location.origin);
      downloadBlob(blob, `direct-loop-${collection.slug}-${count}-status-pack.zip`);
      const form = new FormData();
      form.set("file", blob, `status-pack-${collection.slug}-${count}.zip`);
      form.set("collectionId", collection.id);
      form.set("itemCount", count);
      void fetch("/api/affiliate/assets/status-pack", { method: "POST", body: form }).catch(() => undefined);
      setMessage(t("affiliate.assets.statusDone", { count }));
    } catch (caught) { setMessage(errorMessage(caught, t)); } finally { setBusy(null); }
  }

  return (
    <div className="space-y-5">
      <SectionHeading title={t("affiliate.assets.title")} body={t("affiliate.assets.body")} />
      {collections.length ? (
        <>
          <Card>
            <CardHeader><CardTitle>{t("affiliate.assets.choose")}</CardTitle><CardDescription>{t("affiliate.assets.chooseBody")}</CardDescription></CardHeader>
            <CardContent>
              <Select value={collectionId} onValueChange={setCollectionId}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {collections.map((item) => <SelectItem key={item.id} value={item.id}>{item.title} · {t("affiliate.assets.products", { count: item.itemCount })}</SelectItem>)}
                </SelectContent>
              </Select>
            </CardContent>
          </Card>
          <div className="grid gap-4">
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2"><PackageCheck /> {t("affiliate.assets.statusPack")}</CardTitle><CardDescription>{t("affiliate.assets.statusPackBody")}</CardDescription></CardHeader>
              <CardContent className="space-y-3">
                <Select value={count} onValueChange={(value) => setCount(value as "4" | "6" | "8")}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{[4, 6, 8].map((value) => <SelectItem key={value} value={String(value)}>{t("affiliate.assets.statusPages", { count: value })}</SelectItem>)}</SelectContent>
                </Select>
                <Button className="w-full" onClick={() => void statusPack()} disabled={Boolean(busy) || !collection || collection.itemCount < Number(count)}>
                  {busy === "status" ? <LoaderCircle className="animate-spin" /> : <Download />} {t("affiliate.assets.downloadZip")}
                </Button>
                {collection && collection.itemCount < Number(count) ? <p className="text-xs text-destructive">{t("affiliate.assets.addMore", { count: Number(count) - collection.itemCount })}</p> : null}
              </CardContent>
            </Card>
          </div>
        </>
      ) : (
        <EmptyState icon={<BookImage />} title={t("affiliate.assets.emptyTitle")} body={t("affiliate.assets.emptyBody")} action={t("affiliate.collections.browse")} />
      )}
      {message ? <Notice>{message}</Notice> : null}
    </div>
  );
}

function Analytics({ payload, setTab, t }: { payload: AffiliateSessionPayload; setTab: (tab: CenterTab) => void; t: Translate }) {
  const metrics = payload.dashboard?.metrics;
  const daily = payload.dashboard?.daily ?? [];
  const [range, setRange] = useState<7 | 30>(7);
  const isNew = !(metrics?.clicks) && !(metrics?.ordersTotal);
  const shown = daily.slice(-range);
  const points = shown.map((day) => ({ label: day.date.slice(5), value: day.orders }));
  const best = bestPoint(points);
  const rows = [
    [t("affiliate.metric.clicks"), String(metrics?.clicks ?? 0)],
    [t("affiliate.metric.orders"), String(metrics?.orders ?? 0)],
    [t("affiliate.metric.sales"), money(metrics?.sales ?? 0)],
    [t("affiliate.metric.commission"), money(metrics?.commission ?? 0)],
  ];
  const unpaid = metrics?.ordersUnpaid ?? 0;
  return (
    <div className="space-y-5">
      <SectionHeading title={t("affiliate.analytics.title")} body={t("affiliate.analytics.body")} />
      {isNew ? (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2"><Badge variant="outline">{t("affiliate.results.example")}</Badge></div>
            <CardTitle>{t("affiliate.results.exampleTitle")}</CardTitle>
            <CardDescription>{t("affiliate.results.exampleBody")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <LineChart
              muted
              markBest={false}
              ariaLabel={t("affiliate.results.exampleAria")}
              formatValue={(value) => String(value)}
              points={EXAMPLE_ORDERS_PER_DAY.map((value, index) => ({ label: t("affiliate.results.exampleDay", { day: index + 1 }), value }))}
            />
            <Button onClick={() => setTab("tiktok-video")}><Share2 /> {t("affiliate.results.goShare")}</Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>{t("affiliate.results.chartTitle")}</CardTitle>
              <div className="flex gap-1" role="group" aria-label={t("affiliate.results.range")}>
                {([7, 30] as const).map((value) => (
                  <Button key={value} size="sm" variant={range === value ? "default" : "outline"} aria-pressed={range === value} onClick={() => setRange(value)}>
                    {t(value === 7 ? "affiliate.results.range7" : "affiliate.results.range30")}
                  </Button>
                ))}
              </div>
            </div>
            <CardDescription>
              {best >= 0 ? t("affiliate.results.bestDay", { date: points[best].label, count: points[best].value }) : t("affiliate.results.noOrdersYet")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LineChart points={points} ariaLabel={t("affiliate.results.chartAria", { days: range })} formatValue={(value) => t("affiliate.results.ordersCount", { count: value })} />
            {unpaid > 0 ? <p className="mt-3 text-sm text-muted-foreground">{t("affiliate.results.unpaid", { count: unpaid })}</p> : null}
          </CardContent>
        </Card>
      )}
      {isNew ? null : <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{rows.map(([label, value]) => <MetricCard key={label} label={label} value={value} />)}</div>}
      {isNew || !(payload.dashboard?.clickChannels?.length) ? null : (
        <Card>
          <CardHeader><CardTitle>{t("affiliate.results.channelsTitle")}</CardTitle><CardDescription>{t("affiliate.results.channelsBody")}</CardDescription></CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-3">
            {payload.dashboard.clickChannels.slice(0, 3).map((channel) => <MetricLine key={channel.label} label={channel.label} value={t("affiliate.results.clicksCount", { count: channel.count })} />)}
          </CardContent>
        </Card>
      )}
      {isNew ? null : (
        <Card>
          <CardHeader><CardTitle>{t("affiliate.analytics.top")}</CardTitle></CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <MetricLine label={t("affiliate.analytics.topCollection")} value={metrics?.topCollection || t("affiliate.noData")} />
            <MetricLine label={t("affiliate.analytics.topProduct")} value={metrics?.topProduct || t("affiliate.noData")} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Commission({ payload, t }: { payload: AffiliateSessionPayload; t: Translate }) {
  const totals = payload.dashboard?.commission ?? {};
  const payouts = payload.dashboard?.payouts ?? [];
  const daily = payload.dashboard?.daily ?? [];
  const hasEarnings = Object.values(totals).some((value) => value > 0) || payouts.length > 0;
  const running = runningTotal(daily.map((day) => day.commission));
  const cumulative = daily.map((day, index) => ({ label: day.date.slice(5), value: running[index] }));
  const states = [
    ["PENDING", t("affiliate.commission.pending"), <CircleDollarSign key="pending" />],
    ["CONFIRMED", t("affiliate.commission.confirmed"), <CircleDollarSign key="confirmed" />],
    ["PAID", t("affiliate.commission.paid"), <CheckCircle2 key="paid" />],
    ["REJECTED", t("affiliate.commission.rejected"), <PauseCircle key="rejected" />],
  ] as const;
  return (
    <div className="space-y-5">
      <SectionHeading title={t("affiliate.commission.title")} body={t("affiliate.commission.body")} />
      {hasEarnings ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("affiliate.earnings.chartTitle")}</CardTitle>
            <CardDescription>{t("affiliate.earnings.chartBody", { amount: (running[running.length - 1] ?? 0).toLocaleString("en-KE") })}</CardDescription>
          </CardHeader>
          <CardContent>
            <LineChart
              markBest={false}
              points={cumulative}
              ariaLabel={t("affiliate.earnings.chartAria")}
              formatValue={(value) => money(value)}
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{t("affiliate.earnings.newTitle")}</CardTitle>
            <CardDescription>{t("affiliate.earnings.newBody")}</CardDescription>
          </CardHeader>
        </Card>
      )}
      {hasEarnings ? <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {states.filter(([status]) => status !== "REJECTED" || (totals.REJECTED ?? 0) > 0).map(([status, label, icon]) => (
          <Card key={status}>
            <CardHeader className="pb-2"><CardDescription className="flex items-center gap-2">{icon}{label}</CardDescription></CardHeader>
            <CardContent><strong className="text-xl font-semibold">{money(totals[status] ?? 0)}</strong></CardContent>
          </Card>
        ))}
      </div> : null}
      <Card>
        <CardHeader>
          <CardTitle>{t("affiliate.commission.historyTitle")}</CardTitle>
          <CardDescription>{t("affiliate.commission.historyBody")}</CardDescription>
        </CardHeader>
        <CardContent>
          {payouts.length ? (
            <ul className="space-y-2">
              {payouts.map((payout) => (
                <li key={payout.id} className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                  <strong className="font-medium">
                    {t("affiliate.commission.historyLine", { amount: payout.amountKsh.toLocaleString("en-KE"), code: payout.mpesaCode, date: payoutDay(payout.paidAt) })}
                  </strong>
                  <span className="block text-xs text-muted-foreground">
                    {t("affiliate.commission.historyWeek", { from: payoutDay(payout.periodStart), to: payoutDay(new Date(new Date(payout.periodEnd).getTime() - 1).toISOString()), count: payout.itemCount })}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t("affiliate.commission.historyEmpty")}</p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t("affiliate.commission.howTitle")}</CardTitle><CardDescription>{t("affiliate.commission.howBody")}</CardDescription></CardHeader>
      </Card>
    </div>
  );
}

/** A Nairobi calendar date (UTC+3), e.g. 2026-10-12. */
function payoutDay(iso: string) {
  return new Date(new Date(iso).getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function MetricCard({ label, value, note }: { label: string; value: string; note?: string | null }) {
  return <Card><CardHeader className="pb-2"><CardDescription>{label}</CardDescription><CardTitle className="text-2xl font-semibold">{value}</CardTitle>{note ? <p className="text-xs text-muted-foreground">{note}</p> : null}</CardHeader></Card>;
}
function MetricLine({ label, value }: { label: string; value: string }) {
  return <div className="rounded-md border bg-muted/60 p-3"><small className="text-muted-foreground">{label}</small><strong className="mt-1 block text-sm font-medium">{value}</strong></div>;
}
function SectionHeading({ title, body }: { title: string; body: string }) {
  return <header><h2 className="text-xl font-semibold tracking-tight">{title}</h2><p className="mt-1 text-sm text-muted-foreground">{body}</p></header>;
}
function Notice({ children }: { children: React.ReactNode }) {
  return <p className="rounded-md border bg-card px-3 py-2 text-sm" role="status">{children}</p>;
}
function EmptyState({ icon, title, body, action }: { icon: React.ReactNode; title: string; body: string; action: string }) {
  return (
    <Empty className="border bg-card">
      <EmptyHeader><EmptyMedia variant="icon">{icon}</EmptyMedia><EmptyTitle>{title}</EmptyTitle><EmptyDescription>{body}</EmptyDescription></EmptyHeader>
      <EmptyContent><Button asChild variant="outline"><Link href="/">{action}</Link></Button></EmptyContent>
    </Empty>
  );
}
function CenterMessage({ icon, title, body, action }: { icon: React.ReactNode; title: string; body: string; action?: React.ReactNode }) {
  return (
    <main className="affiliateConsole min-h-screen bg-muted/50">
      <SiteHeader />
      <div className="mx-auto max-w-xl px-5 py-24">
        <Empty className="border bg-card">
          <EmptyHeader><EmptyMedia variant="icon">{icon}</EmptyMedia><EmptyTitle>{title}</EmptyTitle><EmptyDescription>{body}</EmptyDescription></EmptyHeader>
          {action ? <EmptyContent>{action}</EmptyContent> : null}
        </Empty>
      </div>
    </main>
  );
}
function money(value: number) { return `KSh ${value.toLocaleString("en-KE")}`; }
function errorMessage(caught: unknown, t: Translate) { return caught instanceof Error ? caught.message : t("affiliate.actionFailed"); }
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function copyText(value: string) { await navigator.clipboard.writeText(value); }
function publicProfileUrl(payload: AffiliateSessionPayload) {
  const path = `/seller/${payload.affiliate?.slug}`;
  return typeof window === "undefined" ? path : new URL(path, window.location.origin).toString();
}
