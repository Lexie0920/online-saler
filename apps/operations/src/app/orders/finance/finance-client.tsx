"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { RefreshCwIcon } from "lucide-react";

import { useOperationsSession } from "@/components/admin/operations-access-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatKsh, formatMoment, operationsRequester } from "@/lib/operations-request";
import { t } from "@/i18n/runtime";

/**
 * What finance reconciles against the M-Pesa statement: money in, money back
 * out, what the affiliates are owed, and how much of each KSh 200 delivery fee
 * the company ended up covering itself.
 */

type FinanceSummary = {
  sales: {
    paidOrders: number;
    completedOrders: number;
    gmvKsh: number;
    deliveryRevenueKsh: number;
    collectedKsh: number;
    averageOrderValueKsh: number;
  };
  refunds: {
    count: number;
    refundedKsh: number;
    outstanding: Array<{
      orderId: string;
      orderNumber: string;
      customerName: string | null;
      customerPhone: string | null;
      paidKsh: number;
      refundedKsh: number;
      outstandingKsh: number;
      createdAt: string;
    }>;
  };
  commission: {
    pendingKsh: number;
    availableKsh: number;
    paidKsh: number;
    reversedKsh: number;
    pendingCount: number;
    availableCount: number;
    paidCount: number;
    reversedCount: number;
    owedKsh: number;
  };
  delivery: {
    deliveryRevenueKsh: number;
    actualDeliveryCostKsh: number;
    subsidyKsh: number;
    ordersWithRecordedCost: number;
    ordersMissingCost: number;
    averageCostPerOrderKsh: number | null;
  };
  deposits: {
    heldOrders: number;
    depositHeldKsh: number;
    balanceOutstandingKsh: number;
    lapsedOrders: number;
    forfeitKsh: number;
    refundOwedKsh: number;
    refundPaidKsh: number;
  };
  net: { netRevenueKsh: number; formula: string };
  attention: { paymentsInReview: number; callbacksInReview: number; fulfillmentExceptions: number };
};

export function FinancePage() {
  const { session } = useOperationsSession();
  const accessToken = session?.accessToken ?? "";
  const [summary, setSummary] = useState<FinanceSummary | null>(null);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError("");
    try {
      setSummary(await operationsRequester(accessToken)<FinanceSummary>("/operations/finance/summary", {
        query: { dateFrom: dateFrom || undefined, dateTo: dateTo || undefined }
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("无法读取财务汇总。"));
    } finally {
      setLoading(false);
    }
  }, [accessToken, dateFrom, dateTo]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>{t("财务汇总")}</CardTitle>
            <CardDescription>{t("按订单创建时间统计。所有金额都可以与 M-Pesa 商户账单逐笔对账。")}</CardDescription>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
            <Input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCwIcon className={loading ? "animate-spin" : ""} /> {t("刷新")}
            </Button>
          </div>
        </CardHeader>
        {error ? <CardContent><p className="text-destructive text-sm">{error}</p></CardContent> : null}
      </Card>

      {summary ? (
        <>
          {summary.attention.paymentsInReview || summary.attention.callbacksInReview || summary.attention.fulfillmentExceptions ? (
            <Card>
              <CardHeader>
                <CardTitle>{t("需要处理")}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {summary.attention.paymentsInReview ? (
                  <Link href="/orders/payment-review">
                    <Badge variant="destructive">{t("待复核支付")} {summary.attention.paymentsInReview}</Badge>
                  </Link>
                ) : null}
                {summary.attention.callbacksInReview ? (
                  <Link href="/orders/payment-review">
                    <Badge variant="destructive">{t("无主回调")} {summary.attention.callbacksInReview}</Badge>
                  </Link>
                ) : null}
                {summary.attention.fulfillmentExceptions ? (
                  <Link href="/orders/exceptions">
                    <Badge variant="secondary">{t("履约异常")} {summary.attention.fulfillmentExceptions}</Badge>
                  </Link>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Metric label={t("GMV（商品销售额）")} value={formatKsh(summary.sales.gmvKsh)} note={`${summary.sales.paidOrders} ${t("笔已付款订单")}`} />
            <Metric label={t("实际收款")} value={formatKsh(summary.sales.collectedKsh)} note={t("含配送费")} />
            <Metric label={t("客单价")} value={formatKsh(summary.sales.averageOrderValueKsh)} note={`${summary.sales.completedOrders} ${t("笔已完成")}`} />
            <Metric label={t("净收入")} value={formatKsh(summary.net.netRevenueKsh)} note={summary.net.formula} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>{t("定金计划")}</CardTitle>
              <CardDescription>
                {t("「定金在途」是已收但还没赚到的钱——尾款付清会变成销售额，逾期则大部分要退回，所以不计入净收入。「违约金收入」是逾期后留下的那部分，已经赚到，计入净收入。")}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              <Metric
                label={t("定金在途")}
                value={formatKsh(summary.deposits.depositHeldKsh)}
                note={`${summary.deposits.heldOrders} ${t("笔持有中，不计入净收入")}`}
              />
              <Metric
                label={t("待收尾款")}
                value={formatKsh(summary.deposits.balanceOutstandingKsh)}
                note={t("这些单还要收到的钱")}
              />
              <Metric
                label={t("违约金收入")}
                value={formatKsh(summary.deposits.forfeitKsh)}
                note={`${summary.deposits.lapsedOrders} ${t("笔逾期，已计入净收入")}`}
              />
              <Metric
                label={t("待退顾客")}
                value={formatKsh(summary.deposits.refundOwedKsh)}
                note={summary.deposits.refundPaidKsh
                  ? `${t("已退")} ${formatKsh(summary.deposits.refundPaidKsh)}`
                  : t("逾期应退但还没在 M-Pesa 执行")}
              />
            </CardContent>
          </Card>

          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>{t("推广佣金")}</CardTitle>
                <CardDescription>{t("统一按销售额 25% 计提，完成交付满 3 天（72 小时，退货期结束）后可确认。")}</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-2 sm:grid-cols-2">
                <Metric label={t("待确认")} value={formatKsh(summary.commission.pendingKsh)} note={`${summary.commission.pendingCount} ${t("笔")}`} />
                <Metric label={t("可发放")} value={formatKsh(summary.commission.availableKsh)} note={`${summary.commission.availableCount} ${t("笔")}`} />
                <Metric label={t("已发放")} value={formatKsh(summary.commission.paidKsh)} note={`${summary.commission.paidCount} ${t("笔")}`} />
                <Metric label={t("已冲回")} value={formatKsh(summary.commission.reversedKsh)} note={`${summary.commission.reversedCount} ${t("笔")}`} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t("配送经济")}</CardTitle>
                <CardDescription>
                  {t("顾客统一付 KSh 200，门店付的是真实 Bolt 车费。差额是公司补贴。")}
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-2 sm:grid-cols-2">
                <Metric label={t("配送收入")} value={formatKsh(summary.delivery.deliveryRevenueKsh)} />
                <Metric label={t("实际车费")} value={formatKsh(summary.delivery.actualDeliveryCostKsh)} />
                <Metric label={t("公司补贴")} value={formatKsh(summary.delivery.subsidyKsh)} />
                <Metric
                  label={t("单均车费")}
                  value={formatKsh(summary.delivery.averageCostPerOrderKsh)}
                  note={summary.delivery.ordersMissingCost
                    ? `${summary.delivery.ordersMissingCost} ${t("笔还没登记车费")}`
                    : t("全部已登记")}
                />
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>{t("待退款")} ({summary.refunds.outstanding.length})</CardTitle>
              <CardDescription>
                {t("已收款但订单被作废的订单。在 M-Pesa 里退完钱后，回到订单页登记退款凭证。")}
                {t("本期已登记退款")} {formatKsh(summary.refunds.refundedKsh)}（{summary.refunds.count} {t("笔")}）。
              </CardDescription>
            </CardHeader>
            <CardContent>
              {summary.refunds.outstanding.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("没有欠顾客的退款。")}</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("订单")}</TableHead>
                      <TableHead>{t("顾客")}</TableHead>
                      <TableHead>{t("已付")}</TableHead>
                      <TableHead>{t("已退")}</TableHead>
                      <TableHead>{t("待退")}</TableHead>
                      <TableHead>{t("下单时间")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {summary.refunds.outstanding.map((row) => (
                      <TableRow key={row.orderId}>
                        <TableCell>
                          <Link className="underline" href={`/orders/${row.orderId}`}>{row.orderNumber}</Link>
                        </TableCell>
                        <TableCell>{row.customerName ?? t("访客")} · {row.customerPhone ?? "—"}</TableCell>
                        <TableCell>{formatKsh(row.paidKsh)}</TableCell>
                        <TableCell>{formatKsh(row.refundedKsh)}</TableCell>
                        <TableCell className="font-semibold text-destructive">{formatKsh(row.outstandingKsh)}</TableCell>
                        <TableCell>{formatMoment(row.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}

function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-muted-foreground text-xs">{label}</p>
        <p className="text-2xl font-semibold">{value}</p>
        {note ? <p className="text-muted-foreground mt-1 text-xs">{note}</p> : null}
      </CardContent>
    </Card>
  );
}
