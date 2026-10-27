"use client";

import { useState } from "react";
import { nextPayoutDate } from "../../affiliate/affiliate-platform";
import type { AffiliateRecentOrder, AffiliateSessionPayload } from "../../affiliate/affiliate-client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Button } from "../../components/ui/button";
import { LineChart, runningTotal } from "./affiliate-charts";
import { money, payoutDay, payoutDayLabel, SectionHeading, type Translate } from "./center-ui";

const dot = { waiting: "bg-yellow-400", ready: "bg-blue-500", paid: "bg-green-600", notCounted: "bg-red-500" } as const;

/** Earnings: how much, where the money is, and when it arrives. */
export function Earnings({ payload, t }: { payload: AffiliateSessionPayload; t: Translate }) {
  const dashboard = payload.dashboard;
  const totals = dashboard?.commission ?? {};
  const payouts = dashboard?.payouts ?? [];
  const daily = dashboard?.daily ?? [];
  const allTime = dashboard?.allTime ?? [];
  const orders = dashboard?.recentOrders ?? [];
  const [range, setRange] = useState<"30" | "all">("30");
  const hasEarnings = Object.values(totals).some((value) => value > 0) || payouts.length > 0;
  const running = runningTotal(daily.map((day) => day.commission));
  const points = range === "30"
    ? daily.map((day, index) => ({ label: day.date.slice(5), value: running[index] }))
    : allTime.map((week) => ({ label: week.date.slice(5), value: week.total }));
  const ready = totals.CONFIRMED ?? 0;
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
          <CardContent className="text-sm text-primary-foreground/80">{t("affiliate.earnings.fromPaidOrders", { count: dashboard?.metrics.ordersPaid ?? 0 })}</CardContent>
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
          <LineChart markBest={false} points={points} ariaLabel={t("affiliate.earnings.chartAria")} formatValue={(value) => money(value)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t("affiliate.earnings.howPaidTitle")}</CardTitle><CardDescription>{t("affiliate.earnings.howPaidBody")}</CardDescription></CardHeader>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t("affiliate.earnings.yourOrders")}</CardTitle></CardHeader>
        <CardContent>
          {orders.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-xs text-muted-foreground">
                  <th className="py-1 pr-3 font-normal">{t("affiliate.earnings.colOrder")}</th>
                  <th className="py-1 pr-3 font-normal">{t("affiliate.earnings.colDate")}</th>
                  <th className="py-1 pr-3 font-normal">{t("affiliate.earnings.colEarn")}</th>
                  <th className="py-1 font-normal">{t("affiliate.earnings.colWhat")}</th>
                </tr></thead>
                <tbody>
                  {orders.map((order) => (
                    <tr key={order.orderNumber} className="border-t">
                      <td className="py-2 pr-3">#{order.orderNumber}</td>
                      <td className="py-2 pr-3">{shortDate(order.date)}</td>
                      <td className="py-2 pr-3">{money(order.amountKsh)}</td>
                      <td className="py-2"><span className="flex items-center gap-2"><i className={`size-2.5 shrink-0 rounded-full ${dot[order.state]}`} />{whatHappens(order)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
