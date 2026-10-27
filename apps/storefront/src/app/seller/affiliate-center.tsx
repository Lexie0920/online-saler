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
  Megaphone,
  PackageCheck,
  PauseCircle,
  Plus,
  Share2,
  Trash2,
  Video,
} from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import {
  affiliateJson,
  type AffiliateCampaign,
  type AffiliateCollection,
  type AffiliateSessionPayload,
  useAffiliateSession,
} from "../../affiliate/affiliate-client";
import { generateStatusPack } from "../../affiliate/status-pack-generator";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../../components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../../components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { Textarea } from "../../components/ui/textarea";
import { useStorefrontI18n } from "../../i18n/use-storefront-i18n";
import { SiteHeader } from "../components/site-header";
import { RunThroughVideos } from "./run-through-videos";

type CenterTab = "dashboard" | "tiktok-video" | "collections" | "campaigns" | "share-assets" | "analytics" | "commission";
type Translate = ReturnType<typeof useStorefrontI18n>["t"];

const tabs: Array<{ id: CenterTab; label: "affiliate.nav.dashboard" | "affiliate.nav.videos" | "affiliate.nav.collections" | "affiliate.nav.campaigns" | "affiliate.nav.assets" | "affiliate.nav.analytics" | "affiliate.nav.commission"; icon: React.ReactNode }> = [
  { id: "dashboard", label: "affiliate.nav.dashboard", icon: <LayoutDashboard /> },
  { id: "tiktok-video", label: "affiliate.nav.videos", icon: <Video /> },
  { id: "collections", label: "affiliate.nav.collections", icon: <FolderHeart /> },
  { id: "campaigns", label: "affiliate.nav.campaigns", icon: <Megaphone /> },
  { id: "share-assets", label: "affiliate.nav.assets", icon: <BookImage /> },
  { id: "analytics", label: "affiliate.nav.analytics", icon: <BarChart3 /> },
  { id: "commission", label: "affiliate.nav.commission", icon: <CircleDollarSign /> },
];

export function AffiliateCenter() {
  const { t } = useStorefrontI18n();
  const searchParams = useSearchParams();
  const { payload, loading, error, refresh } = useAffiliateSession();
  const requestedTab = searchParams.get("tab") as CenterTab | null;
  const [tab, setTab] = useState<CenterTab>(tabs.some((item) => item.id === requestedTab) ? requestedTab! : "dashboard");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (requestedTab && tabs.some((item) => item.id === requestedTab)) setTab(requestedTab);
  }, [requestedTab]);

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
            {tabs.map((item) => (
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
            {tab === "dashboard" ? <Dashboard payload={payload} setTab={setTab} t={t} /> : null}
            {tab === "tiktok-video" ? <RunThroughVideos /> : null}
            {tab === "collections" ? <Collections collections={payload.collections ?? []} refresh={refresh} t={t} /> : null}
            {tab === "campaigns" ? <Campaigns campaigns={payload.campaigns ?? []} collections={payload.collections ?? []} refresh={refresh} t={t} /> : null}
            {tab === "share-assets" ? <ShareAssets payload={payload} t={t} /> : null}
            {tab === "analytics" ? <Analytics payload={payload} t={t} /> : null}
            {tab === "commission" ? <Commission payload={payload} t={t} /> : null}
          </section>
        </div>
      </div>
    </main>
  );
}

function Dashboard({ payload, setTab, t }: { payload: AffiliateSessionPayload; setTab: (tab: CenterTab) => void; t: Translate }) {
  const metrics = payload.dashboard?.metrics;
  const stats = [
    [t("affiliate.metric.clicks"), String(metrics?.clicks ?? 0)],
    [t("affiliate.metric.orders"), String(metrics?.ordersTotal ?? 0)],
    [t("affiliate.metric.sales"), money(metrics?.sales ?? 0)],
    [t("affiliate.metric.commission"), money(metrics?.commission ?? 0)],
  ];
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{stats.map(([label, value]) => <MetricCard key={label} label={label} value={value} />)}</div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>{t("affiliate.dashboard.today")}</CardTitle><CardDescription>{t("affiliate.dashboard.todayBody")}</CardDescription></CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button onClick={() => setTab("tiktok-video")}><Video /> {t("affiliate.dashboard.openVideos")}</Button>
            <Button variant="outline" onClick={() => setTab("collections")}><Plus /> {t("affiliate.dashboard.newCollection")}</Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>{t("affiliate.dashboard.top")}</CardTitle><CardDescription>{t("affiliate.dashboard.topBody")}</CardDescription></CardHeader>
          <CardContent className="grid gap-2 sm:grid-cols-2">
            <MetricLine label={t("affiliate.dashboard.topCollection")} value={metrics?.topCollection || t("affiliate.noData")} />
            <MetricLine label={t("affiliate.dashboard.topProduct")} value={metrics?.topProduct || t("affiliate.noData")} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Collections({ collections, refresh, t }: { collections: AffiliateCollection[]; refresh: () => Promise<unknown>; t: Translate }) {
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

function Campaigns({ campaigns, collections, refresh, t }: { campaigns: AffiliateCampaign[]; collections: AffiliateCollection[]; refresh: () => Promise<unknown>; t: Translate }) {
  const [title, setTitle] = useState("");
  const [collectionId, setCollectionId] = useState("none");
  const [channel, setChannel] = useState("WHATSAPP");
  const [source, setSource] = useState("whatsapp");
  const [placement, setPlacement] = useState("direct-message");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage(null);
    try {
      await affiliateJson("/api/affiliate/campaigns", { method: "POST", body: JSON.stringify({ title, collectionId: collectionId === "none" ? null : collectionId, channel, source, placement }) });
      setTitle(""); setMessage(t("affiliate.campaigns.created")); await refresh();
    } catch (caught) { setMessage(errorMessage(caught, t)); } finally { setBusy(false); }
  }

  return (
    <div className="space-y-5">
      <SectionHeading title={t("affiliate.campaigns.title")} body={t("affiliate.campaigns.body")} />
      <Card>
        <CardHeader><CardTitle>{t("affiliate.campaigns.new")}</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={create}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="campaign-title">{t("affiliate.campaigns.titleField")}</FieldLabel>
                <Input id="campaign-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t("affiliate.campaigns.titlePlaceholder")} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel>{t("affiliate.campaigns.collection")}</FieldLabel>
                  <Select value={collectionId} onValueChange={setCollectionId}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">{t("affiliate.campaigns.storefront")}</SelectItem>
                      {collections.map((collection) => <SelectItem key={collection.id} value={collection.id}>{collection.title}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel>{t("affiliate.campaigns.channel")}</FieldLabel>
                  <Select value={channel} onValueChange={(value) => { setChannel(value); const defaults = campaignDefaults(value); setSource(defaults.source); setPlacement(defaults.placement); }}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>{["WHATSAPP", "STATUS", "TIKTOK", "FACEBOOK"].map((value) => <SelectItem key={value} value={value}>{titleCase(value)}</SelectItem>)}</SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="campaign-source">{t("affiliate.campaigns.source")}</FieldLabel>
                  <Input id="campaign-source" value={source} onChange={(event) => setSource(event.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="campaign-placement">{t("affiliate.campaigns.placement")}</FieldLabel>
                  <Input id="campaign-placement" value={placement} onChange={(event) => setPlacement(event.target.value)} />
                </Field>
              </div>
              <Button type="submit" disabled={busy || title.trim().length < 3}>
                {busy ? <LoaderCircle className="animate-spin" /> : <Megaphone />} {t("affiliate.campaigns.create")}
              </Button>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
      {message ? <Notice>{message}</Notice> : null}
      {campaigns.length ? (
        <Card>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("affiliate.campaigns.titleField")}</TableHead>
                  <TableHead>{t("affiliate.campaigns.collection")}</TableHead>
                  <TableHead>{t("affiliate.campaigns.channel")}</TableHead>
                  <TableHead>{t("affiliate.campaigns.tracking")}</TableHead>
                  <TableHead>{t("affiliate.campaigns.status")}</TableHead>
                  <TableHead>{t("affiliate.campaigns.link")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {campaigns.map((campaign) => (
                  <TableRow key={campaign.id}>
                    <TableCell className="font-medium">{campaign.title}</TableCell>
                    <TableCell>{campaign.collection?.title || t("affiliate.campaigns.storefront")}</TableCell>
                    <TableCell>{titleCase(campaign.channel)}</TableCell>
                    <TableCell className="text-muted-foreground">{campaign.source} / {campaign.placement}</TableCell>
                    <TableCell><Badge variant={campaign.status === "ACTIVE" ? "default" : "outline"}>{campaign.status}</Badge></TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!campaign.link}
                        onClick={() => campaign.link && void copyText(new URL(campaign.link, window.location.origin).toString()).then(() => setMessage(t("affiliate.campaigns.linkCopied", { title: campaign.title })))}
                      >
                        <Copy /> {t("affiliate.campaigns.copy")}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : (
        <EmptyState icon={<Megaphone />} title={t("affiliate.campaigns.emptyTitle")} body={t("affiliate.campaigns.emptyBody")} action={t("affiliate.collections.browse")} />
      )}
    </div>
  );
}

function ShareAssets({ payload, t }: { payload: AffiliateSessionPayload; t: Translate }) {
  const collections = payload.collections ?? [];
  const [collectionId, setCollectionId] = useState(collections[0]?.id ?? "");
  const [count, setCount] = useState<"4" | "6" | "8">("4");
  const [busy, setBusy] = useState<"status" | "video" | null>(null);
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

  async function video() {
    if (!collection) return;
    setBusy("video"); setMessage(t("affiliate.assets.videoRendering"));
    try {
      const response = await fetch("/api/affiliate/assets/tiktok-video", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ collectionId: collection.id }) });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || t("affiliate.actionFailed"));
      }
      downloadBlob(await response.blob(), `direct-loop-${collection.slug}-tiktok.mp4`);
      setMessage(t("affiliate.assets.videoDone"));
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
          <div className="grid gap-4 xl:grid-cols-2">
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
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2"><Video /> {t("affiliate.assets.video")}</CardTitle><CardDescription>{t("affiliate.assets.videoBody")}</CardDescription></CardHeader>
              <CardContent>
                <Button className="w-full" onClick={() => void video()} disabled={Boolean(busy) || !collection || collection.itemCount < 5}>
                  {busy === "video" ? <LoaderCircle className="animate-spin" /> : <Video />} {t("affiliate.assets.renderVideo")}
                </Button>
                {collection && collection.itemCount < 5 ? <p className="mt-2 text-xs text-destructive">{t("affiliate.assets.videoNeeds")}</p> : null}
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

function Analytics({ payload, t }: { payload: AffiliateSessionPayload; t: Translate }) {
  const metrics = payload.dashboard?.metrics;
  const rows = [
    [t("affiliate.metric.clicks"), String(metrics?.clicks ?? 0)],
    [t("affiliate.metric.ordersTotal"), String(metrics?.ordersTotal ?? 0)],
    [t("affiliate.metric.ordersPaid"), String(metrics?.ordersPaid ?? 0)],
    [t("affiliate.metric.ordersUnpaid"), String(metrics?.ordersUnpaid ?? 0)],
    [t("affiliate.metric.sales"), money(metrics?.sales ?? 0)],
    [t("affiliate.metric.commission"), money(metrics?.commission ?? 0)],
  ];
  return (
    <div className="space-y-5">
      <SectionHeading title={t("affiliate.analytics.title")} body={t("affiliate.analytics.body")} />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{rows.map(([label, value]) => <MetricCard key={label} label={label} value={value} />)}</div>
      <Card>
        <CardHeader><CardTitle>{t("affiliate.analytics.top")}</CardTitle></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <MetricLine label={t("affiliate.analytics.topCollection")} value={metrics?.topCollection || t("affiliate.noData")} />
          <MetricLine label={t("affiliate.analytics.topProduct")} value={metrics?.topProduct || t("affiliate.noData")} />
        </CardContent>
      </Card>
    </div>
  );
}

function Commission({ payload, t }: { payload: AffiliateSessionPayload; t: Translate }) {
  const totals = payload.dashboard?.commission ?? {};
  const payouts = payload.dashboard?.payouts ?? [];
  const states = [
    ["PENDING", t("affiliate.commission.pending"), <CircleDollarSign key="pending" />],
    ["CONFIRMED", t("affiliate.commission.confirmed"), <CircleDollarSign key="confirmed" />],
    ["PAID", t("affiliate.commission.paid"), <CheckCircle2 key="paid" />],
    ["REJECTED", t("affiliate.commission.rejected"), <PauseCircle key="rejected" />],
  ] as const;
  return (
    <div className="space-y-5">
      <SectionHeading title={t("affiliate.commission.title")} body={t("affiliate.commission.body")} />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {states.map(([status, label, icon]) => (
          <Card key={status}>
            <CardHeader className="pb-2"><CardDescription className="flex items-center gap-2">{icon}{label}</CardDescription></CardHeader>
            <CardContent><strong className="text-xl font-semibold">{money(totals[status] ?? 0)}</strong></CardContent>
          </Card>
        ))}
      </div>
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

function MetricCard({ label, value }: { label: string; value: string }) {
  return <Card><CardHeader className="pb-2"><CardDescription>{label}</CardDescription><CardTitle className="text-2xl font-semibold">{value}</CardTitle></CardHeader></Card>;
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
function campaignDefaults(channel: string) {
  if (channel === "STATUS") return { source: "whatsapp-status", placement: "status-pack" };
  if (channel === "TIKTOK") return { source: "tiktok", placement: "link-in-bio" };
  if (channel === "FACEBOOK") return { source: "facebook", placement: "post" };
  return { source: "whatsapp", placement: "direct-message" };
}
function money(value: number) { return `KSh ${value.toLocaleString("en-KE")}`; }
function titleCase(value: string) { return value.toLowerCase().replace(/(^|[_-])\w/g, (match) => match.replace(/[_-]/, " ").toUpperCase()); }
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
