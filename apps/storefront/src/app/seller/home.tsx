"use client";

import { Check, Plus, Share2, Video } from "lucide-react";
import { useState } from "react";
import {
  affiliateNextGoal,
  affiliateWeekComparison,
  nextPayoutDate,
  type AffiliateNextGoal,
} from "../../affiliate/affiliate-platform";
import type { AffiliateSessionPayload } from "../../affiliate/affiliate-client";
import { LAUNCH_AFFILIATE_COMMISSION_RATE_BPS } from "@online-saler/business-rules";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { dayLabel, EXAMPLE_ORDERS_PER_DAY, LineChart } from "./affiliate-charts";
import { MetricCard, money, payoutDayLabel, type Translate } from "./center-ui";

/** Where a Home button can send the promoter (resolved by the Affiliate Center). */
export type HomeTarget = "tiktok-video" | "share-assets" | "collections" | "new-arrivals" | "community";

/**
 * Home: what to do today, and what it earned. Promoters with no clicks and no
 * orders yet see a welcome with three steps instead of a row of zeros.
 */
export function Home({ payload, setTab, t }: { payload: AffiliateSessionPayload; setTab: (tab: HomeTarget) => void; t: Translate }) {
  const metrics = payload.dashboard?.metrics;
  const daily = payload.dashboard?.daily ?? [];
  const collections = payload.collections ?? [];
  const community = payload.dashboard?.community;
  const [range, setRange] = useState<7 | 30>(7);
  const isNew = !(metrics?.clicks) && !(metrics?.ordersTotal);
  const { thisWeek, lastWeek } = affiliateWeekComparison(daily);
  const points = daily.slice(-range).map((day) => ({ label: dayLabel(day.date, range), value: day.orders }));
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
  const name = payload.affiliate?.displayName ?? "";
  const unpaid = metrics?.ordersUnpaid ?? 0;

  const others = (
    <Card>
      <CardHeader>
        <CardTitle>{t("affiliate.home.othersTitle")}</CardTitle>
        <CardDescription>{community ? t("affiliate.home.othersBody", { shared: community.shared, orders: community.gotOrders }) : t("affiliate.community.soon")}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="link" className="h-auto p-0" onClick={() => setTab("community")}>{t("affiliate.home.seeBoard")}</Button>
      </CardContent>
    </Card>
  );

  if (isNew) {
    const steps: Array<{ done?: boolean; title: string; note?: string }> = [
      { done: true, title: t("affiliate.home.newStep1") },
      { title: t("affiliate.home.newStep2"), note: t("affiliate.home.newStep2Note") },
      { title: t("affiliate.home.newStep3"), note: t("affiliate.home.newStep3Note") },
    ];
    return (
      <div className="space-y-5">
        <div className="rounded-lg border bg-muted/40 p-5">
          <h2 className="text-xl font-semibold tracking-tight">{t("affiliate.home.welcomeName", { name })}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("affiliate.home.welcomeBody")}</p>
          <ol className="mt-4 grid gap-3 sm:grid-cols-3">
            {steps.map((step, index) => (
              <li key={step.title} className="rounded-md border bg-card px-3 py-2 text-sm">
                <span className="flex items-center gap-2 font-medium">
                  <span className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${step.done ? "bg-green-600 text-white" : "bg-primary text-primary-foreground"}`}>
                    {step.done ? <Check className="size-3.5" /> : index + 1}
                  </span>
                  {step.title}
                </span>
                {step.note ? <span className="mt-1 block text-xs text-muted-foreground">{step.note}</span> : null}
              </li>
            ))}
          </ol>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={() => setTab("tiktok-video")}><Share2 /> {t("affiliate.home.postStatus")}</Button>
            <Button variant="outline" onClick={() => setTab("new-arrivals")}>{t("affiliate.home.seeNew")}</Button>
          </div>
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-2">
                <CardTitle>{t("affiliate.home.dayByDay")}</CardTitle>
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">{t("affiliate.results.example")}</span>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              <LineChart
                muted
                dashed
                markBest={false}
                ariaLabel={t("affiliate.results.exampleAria")}
                formatValue={(value) => String(value)}
                points={EXAMPLE_ORDERS_PER_DAY.map((value, index) => ({ label: String(index + 1), value }))}
              />
              <p className="text-xs text-muted-foreground">{t("affiliate.home.exampleNote")}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>{t("affiliate.home.howYouEarn")}</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p className="rounded-md bg-green-50 px-3 py-2 font-semibold text-green-900 dark:bg-green-950/40 dark:text-green-100">
                {t("affiliate.home.exampleEarnShort", { sale: exampleSale.toLocaleString("en-KE"), earn: exampleEarn.toLocaleString("en-KE") })}
              </p>
              <p>{t("affiliate.home.paidMonday")}</p>
            </CardContent>
          </Card>
          {others}
        </div>
      </div>
    );
  }

  const stats = [
    [t("affiliate.home.youEarned"), money(metrics?.commission ?? 0), t("affiliate.home.youEarnedNote")],
    [t("affiliate.metric.orders"), String(metrics?.ordersPaid ?? 0), t("affiliate.home.ordersNote", { paid: metrics?.ordersPaid ?? 0, unpaid })],
    [t("affiliate.metric.clicks"), String(metrics?.clicks ?? 0), t("affiliate.home.clicksNote")],
    [t("affiliate.home.nextPayout"), payoutDayLabel(nextPayoutDate()), t("affiliate.home.payoutNote", { amount: readyToPay.toLocaleString("en-KE") })],
  ] as const;
  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-green-950 dark:border-green-900 dark:bg-green-950/40 dark:text-green-100">
        <p className="text-base font-semibold">{thisWeek > lastWeek ? "🎉 " : ""}{homeHeadline(t, thisWeek, lastWeek)}</p>
        <p className="mt-0.5 text-sm opacity-80">{t("affiliate.home.keepGoing")}</p>
      </div>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>{t("affiliate.results.chartTitle")}</CardTitle>
            <RangeToggle range={range} setRange={setRange} t={t} />
          </div>
        </CardHeader>
        <CardContent>
          <LineChart swipeHint={t("affiliate.chart.swipe")} points={points} ariaLabel={t("affiliate.results.chartAria", { days: range })} formatValue={(value) => t("affiliate.results.bestDayLabel", { count: value })} />
        </CardContent>
      </Card>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map(([label, value, note]) => <MetricCard key={label} label={label} value={value} note={note} />)}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader><CardTitle>{t("affiliate.dashboard.today")}</CardTitle><CardDescription>{t("affiliate.dashboard.todayBody")}</CardDescription></CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button onClick={() => setTab("tiktok-video")}><Video /> {t("affiliate.dashboard.openVideos")}</Button>
            <Button variant="outline" onClick={() => setTab("collections")}><Plus /> {t("affiliate.dashboard.newCollection")}</Button>
          </CardContent>
        </Card>
        {others}
        <Card>
          <CardHeader>
            <CardTitle>{t("affiliate.home.goalTitle")}</CardTitle>
            <CardDescription>{goalText(t, goal)}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {goal.kind === "beatLastWeek" ? (
              <div>
                <div className="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={goal.target} aria-valuenow={Math.min(thisWeek, goal.target)}>
                  <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, Math.round((thisWeek / goal.target) * 100))}%` }} />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{t("affiliate.home.goalProgress", { done: thisWeek, target: goal.target })}</p>
              </div>
            ) : null}
            <Button variant="outline" onClick={() => setTab(goal.kind === "createCollection" || goal.kind === "addProducts" ? "collections" : "share-assets")}>
              {goal.kind === "createCollection" || goal.kind === "addProducts" ? t("affiliate.dashboard.newCollection") : t("affiliate.home.postStatus")}
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export function RangeToggle({ range, setRange, t }: { range: 7 | 30; setRange: (range: 7 | 30) => void; t: Translate }) {
  return (
    <div className="flex gap-1" role="group" aria-label={t("affiliate.results.range")}>
      {([7, 30] as const).map((value) => (
        <Button key={value} size="sm" variant={range === value ? "default" : "outline"} aria-pressed={range === value} onClick={() => setRange(value)}>
          {t(value === 7 ? "affiliate.results.range7" : "affiliate.results.range30")}
        </Button>
      ))}
    </div>
  );
}

function homeHeadline(t: Translate, thisWeek: number, lastWeek: number) {
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
