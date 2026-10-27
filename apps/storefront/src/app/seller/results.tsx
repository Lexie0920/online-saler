"use client";

import { ChevronDown, Share2 } from "lucide-react";
import { useState } from "react";
import { topRows } from "../../affiliate/affiliate-platform";
import type { AffiliateSessionPayload } from "../../affiliate/affiliate-client";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { bestPoint, dayLabel, EXAMPLE_ORDERS_PER_DAY, LineChart } from "./affiliate-charts";
import { money, SectionHeading, type Translate } from "./center-ui";
import { RangeToggle } from "./home";

type Row = { label: string; value: string };

/** One headline number, with a short "top 3" list that opens under it. */
function DrillCard({ value, label, note, rows, open, onToggle, toggleText, t }: {
  value: string; label: string; note?: string; rows: Row[]; open: boolean; onToggle: () => void; toggleText: string; t: Translate;
}) {
  return (
    <Card className={open ? "border-foreground" : undefined}>
      <CardHeader className="pb-2">
        <CardTitle className="text-2xl font-semibold">{value}</CardTitle>
        <CardDescription>{label}{note ? ` · ${note}` : ""}</CardDescription>
      </CardHeader>
      <CardContent>
        <button type="button" className="flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-4" aria-expanded={open} onClick={onToggle}>
          {toggleText}
          <ChevronDown className={`size-3 transition ${open ? "rotate-180" : ""}`} />
        </button>
        {open ? (
          rows.length ? (
            <ul className="mt-2 divide-y text-sm">
              {rows.map((row) => (
                <li key={row.label} className="flex justify-between gap-2 py-1.5"><span>{row.label}</span><strong>{row.value}</strong></li>
              ))}
            </ul>
          ) : <p className="mt-2 text-sm text-muted-foreground">{t("affiliate.noData")}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Results: how it is going and where it works. Every number opens a short "top 3". */
export function Results({ payload, setTab, t }: { payload: AffiliateSessionPayload; setTab: (tab: "tiktok-video") => void; t: Translate }) {
  const dashboard = payload.dashboard;
  const metrics = dashboard?.metrics;
  const daily = dashboard?.daily ?? [];
  const [range, setRange] = useState<7 | 30>(7);
  const [open, setOpen] = useState<"clicks" | "orders" | "sales" | "earned" | null>("clicks");
  const isNew = !(metrics?.clicks) && !(metrics?.ordersTotal);
  const points = daily.slice(-range).map((day) => ({ label: dayLabel(day.date, range), value: day.orders }));
  const best = bestPoint(daily.slice(-range).map((day) => ({ label: day.date, value: day.orders })));
  const bestDay = best >= 0 ? daily.slice(-range)[best] : null;
  const toggle = (key: NonNullable<typeof open>) => setOpen(open === key ? null : key);

  if (isNew) {
    return (
      <div className="space-y-5">
        <SectionHeading title={t("affiliate.analytics.title")} body={t("affiliate.analytics.body")} />
        <Card>
          <CardHeader>
            <span className="w-fit rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">{t("affiliate.results.example")}</span>
            <CardTitle>{t("affiliate.results.exampleTitle")}</CardTitle>
            <CardDescription>{t("affiliate.results.exampleBody")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <LineChart muted dashed markBest={false} ariaLabel={t("affiliate.results.exampleAria")} formatValue={(value) => String(value)}
              points={EXAMPLE_ORDERS_PER_DAY.map((value, index) => ({ label: t("affiliate.results.exampleDay", { day: index + 1 }), value }))} />
            <Button onClick={() => setTab("tiktok-video")}><Share2 /> {t("affiliate.results.goShare")}</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const totalClicks = metrics?.clicks ?? 0;
  const channelRows: Row[] = (dashboard?.clickChannels ?? []).slice(0, 3).map((row) => ({
    label: t("affiliate.results.fromChannel", { name: row.label }),
    value: totalClicks > 0 ? `${Math.round((row.count / totalClicks) * 100)}%` : String(row.count),
  }));
  const whereRows: Row[] = topRows([
    ...(dashboard?.topCollections ?? []).map((row) => ({ label: t("affiliate.results.collectionTag", { name: row.label }), count: row.count })),
    ...(dashboard?.topProducts ?? []).map((row) => ({ label: row.label, count: row.count })),
  ]).map((row) => ({ label: row.label, value: String(row.count) }));
  const orderRows: Row[] = (dashboard?.orderChannels ?? []).map((row) => ({ label: t("affiliate.results.fromChannel", { name: row.label }), value: t("affiliate.results.ordersCount", { count: row.count }) }));
  const bestDays = (key: "sales" | "commission"): Row[] =>
    [...daily].filter((day) => day[key] > 0).sort((a, b) => b[key] - a[key]).slice(0, 3)
      .map((day) => ({ label: dayName(day.date), value: money(day[key]) }));

  return (
    <div className="space-y-5">
      <SectionHeading title={t("affiliate.analytics.title")} body={bestDay ? t("affiliate.results.bestSentence", { count: bestDay.orders, day: dayName(bestDay.date) }) : t("affiliate.results.noOrdersYet")} />
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>{t("affiliate.results.chartTitle")}</CardTitle>
            <RangeToggle range={range} setRange={setRange} t={t} />
          </div>
        </CardHeader>
        <CardContent>
          <LineChart points={points} ariaLabel={t("affiliate.results.chartAria", { days: range })} formatValue={(value) => t("affiliate.results.bestDayLabel", { count: value })} />
        </CardContent>
      </Card>
      <div className="grid items-start gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <DrillCard t={t} value={String(totalClicks)} label={t("affiliate.metric.clicks")} note={t("affiliate.home.clicksNote")}
          rows={[...channelRows, ...whereRows]} open={open === "clicks"} onToggle={() => toggle("clicks")} toggleText={t("affiliate.results.seeTop3")} />
        <DrillCard t={t} value={String(metrics?.orders ?? 0)} label={t("affiliate.metric.orders")} note={t("affiliate.home.ordersNote", { paid: metrics?.ordersPaid ?? 0, unpaid: metrics?.ordersUnpaid ?? 0 })}
          rows={orderRows.slice(0, 3)} open={open === "orders"} onToggle={() => toggle("orders")} toggleText={t("affiliate.results.seeTop3")} />
        <DrillCard t={t} value={money(metrics?.sales ?? 0)} label={t("affiliate.metric.sales")}
          rows={bestDays("sales")} open={open === "sales"} onToggle={() => toggle("sales")} toggleText={t("affiliate.results.seeBestDays")} />
        <DrillCard t={t} value={money(metrics?.commission ?? 0)} label={t("affiliate.home.youEarned")}
          rows={bestDays("commission")} open={open === "earned"} onToggle={() => toggle("earned")} toggleText={t("affiliate.results.seeBestDays")} />
      </div>
    </div>
  );
}

/** "Saturday" for a Nairobi date (YYYY-MM-DD). */
function dayName(date: string) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });
}
