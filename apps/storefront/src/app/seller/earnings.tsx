"use client";

import { useState } from "react";
import { AFFILIATE_ORDERS_PAGE_SIZE, badgeMarkIndex, filterAffiliateOrders, nextPayoutDate, type AffiliateOrderFilter } from "../../affiliate/affiliate-platform";
import type { AffiliateRecentOrder, AffiliateSessionPayload } from "../../affiliate/affiliate-client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Button } from "../../components/ui/button";
import { BadgeShield } from "./badge-art";
import { CommissionChart } from "./commission-chart";
import { money, payoutDay, payoutDayLabel, SectionHeading, type Translate } from "./center-ui";

const dot = { waiting: "bg-yellow-400", ready: "bg-blue-500", paid: "bg-green-600", notCounted: "bg-red-500" } as const;

/** Earnings: how much, where the money is, and when it arrives. */
export function Earnings({ payload, t }: { payload: AffiliateSessionPayload; t: Translate }) {
  const dashboard = payload.dashboard;
  const totals = dashboard?.commission ?? {};
  const payouts = dashboard?.payouts ?? [];
  const orders = dashboard?.recentOrders ?? [];
  const [range, setRange] = useState<"30" | "all">("30");
  const [filter, setFilter] = useState<AffiliateOrderFilter>("all");
  const [visible, setVisible] = useState(AFFILIATE_ORDERS_PAGE_SIZE);
  const hasEarnings = Object.values(totals).some((value) => value > 0) || payouts.length > 0;
  // One line of commission that counts (ready or paid), with the badges where they were unlocked.
  const counted = dashboard?.counted;
  const badgeState = dashboard?.badges;
  const series = (range === "30" ? counted?.daily : counted?.weekly) ?? [];
  const points = series.map((point) => ({ label: point.date.slice(5), total: point.total, added: point.added }));
  const marks = (badgeState?.badges ?? [])
    .filter((badge) => badge.state === "unlocked")
    .map((badge) => ({ id: badge.id, name: badge.name, index: badgeMarkIndex(series, badge, counted?.firstCommissionDay ?? null, { clampToStart: range === "all" }) }))
    .filter((mark) => mark.index >= 0);
  const nextBadge = badgeState?.badges.find((badge) => badge.state === "next") ?? null;
  const ready = totals.CONFIRMED ?? 0;
  const stateCounts = dashboard?.orderStateCounts ?? {
    all: orders.filter((order) => order.state !== "notCounted").length,
    waiting: orders.filter((order) => order.state === "waiting").length,
    ready: orders.filter((order) => order.state === "ready").length,
    paid: orders.filter((order) => order.state === "paid").length,
  };
  const matching = filterAffiliateOrders(orders, filter);
  const shownOrders = matching.slice(0, visible);
  const moreOrders = Math.min(AFFILIATE_ORDERS_PAGE_SIZE, matching.length - shownOrders.length);
  const filters = [
    ["all", "affiliate.earnings.filterAll"],
    ["waiting", "affiliate.earnings.filterWaiting"],
    ["ready", "affiliate.earnings.filterReady"],
    ["paid", "affiliate.earnings.filterPaid"],
  ] as const;
  const phone = dashboard?.payoutPhone;
  const shortDate = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Africa/Nairobi" });

  const whatHappens = (order: AffiliateRecentOrder) => {
    if (order.state === "waiting") return t("affiliate.earnings.stateWaiting", { date: order.readyOn ? shortDate(order.readyOn) : "—" });
    if (order.state === "ready") return t("affiliate.earnings.stateReady", { date: payoutDayLabel(nextPayoutDate()) });
    if (order.state === "paid") return t("affiliate.earnings.statePaid");
    return t(order.reason === "returned" ? "affiliate.earnings.notCountedReturned" : order.reason === "cancelled" ? "affiliate.earnings.notCountedCancelled" : "affiliate.earnings.notCountedOther");
  };

  if (!hasEarnings && !orders.length) {
    return (
      <div className="space-y-5">
        <SectionHeading title={t("affiliate.commission.title")} body={t("affiliate.commission.body")} />
        <Card>
          <CardHeader>
            <CardTitle>{t("affiliate.earnings.newTitle")}</CardTitle>
            <CardDescription>{t("affiliate.earnings.newBody")}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-3 lg:grid-cols-[1.4fr_1fr_1fr]">
        <Card className="bg-primary text-primary-foreground">
          <CardHeader className="pb-2">
            <CardDescription className="text-primary-foreground/80">{t("affiliate.home.youEarned")}</CardDescription>
            <CardTitle className="text-3xl font-semibold">{money(dashboard?.metrics.commission ?? 0)}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-primary-foreground/80">{t("affiliate.earnings.totalSinceDay1")}</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>{t("affiliate.home.nextPayout")}</CardDescription>
            <CardTitle className="text-2xl font-semibold">{payoutDayLabel(nextPayoutDate())}</CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {phone ? t("affiliate.earnings.payoutTo", { amount: ready.toLocaleString("en-KE"), phone }) : t("affiliate.home.payoutNote", { amount: ready.toLocaleString("en-KE") })}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">{t("affiliate.earnings.whereMoney")}</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p className="flex items-center gap-2"><i className={`size-2.5 rounded-full ${dot.waiting}`} />{t("affiliate.earnings.waiting")} <strong>{(totals.PENDING ?? 0).toLocaleString("en-KE")}</strong></p>
            <p className="flex items-center gap-2"><i className={`size-2.5 rounded-full ${dot.ready}`} />{t("affiliate.earnings.readyToPay")} <strong>{ready.toLocaleString("en-KE")}</strong></p>
            <p className="flex items-center gap-2"><i className={`size-2.5 rounded-full ${dot.paid}`} />{t("affiliate.earnings.alreadyPaid")} <strong>{(totals.PAID ?? 0).toLocaleString("en-KE")}</strong></p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle>{t("affiliate.earnings.chartHeading")}</CardTitle>
              <CardDescription>{t("affiliate.earnings.onlyGoesUp")}</CardDescription>
            </div>
            <div className="flex gap-1" role="group" aria-label={t("affiliate.results.range")}>
              <Button size="sm" variant={range === "30" ? "default" : "outline"} aria-pressed={range === "30"} onClick={() => setRange("30")}>{t("affiliate.results.range30")}</Button>
              <Button size="sm" variant={range === "all" ? "default" : "outline"} aria-pressed={range === "all"} onClick={() => setRange("all")}>{t("affiliate.earnings.allTime")}</Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <CommissionChart
            points={points}
            marks={marks}
            next={nextBadge}
            ariaLabel={t("affiliate.badges.chartAria")}
            nextLabel={nextBadge ? t("affiliate.badges.chartNext", { name: nextBadge.name, amount: nextBadge.thresholdKsh.toLocaleString("en-KE"), remaining: nextBadge.remainingKsh.toLocaleString("en-KE") }) : ""}
            formatMoney={(value) => money(value)}
            swipeHint={t("affiliate.chart.swipe")}
          />
        </CardContent>
      </Card>

      {badgeState ? (
        <Card className="border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/20">
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <CardTitle>{t("affiliate.badges.title")}</CardTitle>
                <CardDescription>{t("affiliate.badges.body")}</CardDescription>
              </div>
              <p className="text-2xl font-semibold text-amber-700 dark:text-amber-400">{t("affiliate.badges.count", { unlocked: badgeState.unlocked, total: badgeState.badges.length })}</p>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-7">
              {badgeState.badges.map((badge) => (
                <li key={badge.id} className="flex flex-col items-center text-center">
                  <BadgeShield id={badge.id} locked={badge.state === "locked"} size={88} />
                  <span className="mt-1 text-sm font-extrabold tracking-wide">{badge.name}</span>
                  <span className={`text-xs ${badge.state === "next" ? "font-semibold text-amber-700 dark:text-amber-400" : "text-muted-foreground"}`}>
                    {badge.id === "chipukizi" ? t("affiliate.badges.firstOrder") : `KSh ${badge.thresholdKsh.toLocaleString("en-KE")}`}
                    {badge.state === "next" && badge.thresholdKsh > 0 ? ` · ${Math.round(badge.progress * 100)}%` : ""}
                  </span>
                  {badge.state === "next" && badge.thresholdKsh > 0 ? (
                    <span className="mt-1 block h-1.5 w-20 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                      <span className="block h-full rounded-full bg-amber-500" style={{ width: `${Math.round(badge.progress * 100)}%` }} />
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className="rounded-md border border-amber-200 bg-card px-3 py-2 text-sm text-amber-950 dark:border-amber-900 dark:text-amber-100">
              {nextBadge
                ? <><strong>{t("affiliate.badges.nextLine", { name: nextBadge.name, remaining: nextBadge.remainingKsh.toLocaleString("en-KE") })}</strong>{(totals.PENDING ?? 0) > 0 ? ` ${t("affiliate.badges.waitingLine", { amount: (totals.PENDING ?? 0).toLocaleString("en-KE") })}` : ""}</>
                : t("affiliate.badges.allDone")}
            </p>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader><CardTitle>{t("affiliate.earnings.howPaidTitle")}</CardTitle><CardDescription>{t("affiliate.earnings.howPaidBody")}</CardDescription></CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("affiliate.earnings.yourOrders")}</CardTitle>
          <div className="flex flex-wrap gap-1 pt-1" role="group" aria-label={t("affiliate.earnings.filterLabel")}>
            {filters.map(([id, key]) => (
              <Button key={id} size="sm" variant={filter === id ? "default" : "outline"} aria-pressed={filter === id} onClick={() => { setFilter(id); setVisible(AFFILIATE_ORDERS_PAGE_SIZE); }}>
                {t(key, { count: stateCounts[id] })}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {shownOrders.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[34rem] text-sm">
                <thead><tr className="text-left text-xs text-muted-foreground">
                  <th className="py-1 pr-3 font-normal">{t("affiliate.earnings.colOrder")}</th>
                  <th className="py-1 pr-3 font-normal">{t("affiliate.earnings.colDate")}</th>
                  <th className="py-1 pr-3 font-normal">{t("affiliate.earnings.colEarn")}</th>
                  <th className="py-1 font-normal">{t("affiliate.earnings.colWhat")}</th>
                </tr></thead>
                <tbody>
                  {shownOrders.map((order) => (
                    <tr key={order.orderNumber} className="border-t">
                      <td className="py-2 pr-3">#{order.orderNumber}</td>
                      <td className="py-2 pr-3">{shortDate(order.date)}</td>
                      <td className="py-2 pr-3">{money(order.amountKsh)}</td>
                      <td className="py-2"><span className="flex items-center gap-2"><i className={`size-2.5 shrink-0 rounded-full ${dot[order.state]}`} />{whatHappens(order)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {moreOrders > 0 ? (
                <div className="pt-3 text-center">
                  <Button variant="outline" size="sm" onClick={() => setVisible((count) => count + AFFILIATE_ORDERS_PAGE_SIZE)}>{t("affiliate.earnings.showMore", { count: moreOrders })}</Button>
                </div>
              ) : null}
            </div>
          ) : <p className="text-sm text-muted-foreground">{t("affiliate.earnings.noOrders")}</p>}
        </CardContent>
      </Card>

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
    </div>
  );
}
