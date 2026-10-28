"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, RefreshCwIcon, WalletCardsIcon } from "lucide-react";

import { useOperationsSession } from "@/components/admin/operations-access-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatKsh, formatMoment, operationsRequester } from "@/lib/operations-request";
import { t } from "@/i18n/runtime";
import { MpesaBulkPanel, type PayoutBatch } from "./mpesa-bulk-panel";
import { PayoutExportButton } from "./payout-export-button";

/**
 * 周结付款 — the Monday M-Pesa run (owner, 2026-10-14, "做法一").
 *
 * One row per person for the chosen Monday–Sunday week: promoters' confirmed
 * commissions and riders' delivery pay. Finance sends each amount by hand with
 * M-Pesa Send Money, then types the transaction code from the M-Pesa SMS here.
 * That marks everything in the row paid at once. This page never moves money.
 *
 * Since 2026-10-14 the usual way is the M-Pesa bulk file (MpesaBulkPanel):
 * export once, upload to the M-Pesa for Business portal, upload the results
 * back. Typing a code per row stays as the fallback.
 */

type PayoutItem = { kind: "COMMISSION" | "RIDER_FEE"; id: string; orderNumber: string; amountKsh: number; at: string | null };

type SheetRow = {
  payeeKey: string;
  payeeType: "AFFILIATE" | "RIDER";
  name: string;
  phone: string | null;
  affiliateCode: string | null;
  riderType: string | null;
  amountKsh: number;
  count: number;
  items: PayoutItem[];
  selfPayment: { by: string; message: string } | null;
  bulkPhone: string | null;
  exported: { batchId: string; batchReference: string; lineReference: string } | null;
};

type PaidRow = {
  id: string;
  payeeType: "AFFILIATE" | "RIDER";
  payeeName: string;
  payeePhone: string | null;
  amountKsh: number;
  itemCount: number;
  mpesaCode: string;
  paidAt: string;
  note: string | null;
  paidByName: string | null;
};

type Sheet = {
  week: { start: string; end: string; firstDay: string; lastDay: string };
  totals: {
    people: number;
    amountKsh: number;
    affiliateKsh: number;
    affiliatePeople: number;
    riderKsh: number;
    riderPeople: number;
    paidKsh: number;
    paidPeople: number;
  };
  rows: SheetRow[];
  batches: PayoutBatch[];
  paid: PaidRow[];
  earlierUnpaid: { commissionKsh: number; commissionCount: number; riderFeeKsh: number; riderFeeCount: number };
  awaitingConfirmation: { count: number; amountKsh: number };
  csv: string;
};

const MPESA_CODE = /^[A-Z0-9]{10}$/;

function shiftDay(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function cleanCode(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase().slice(0, 10);
}

export function WeeklyPayoutsPage() {
  const { session } = useOperationsSession();
  const accessToken = session?.accessToken ?? "";
  const [week, setWeek] = useState<string | undefined>(undefined);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [paying, setPaying] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (target?: string) => {
    if (!accessToken) return;
    setLoading(true);
    setError("");
    try {
      const result = await operationsRequester(accessToken)<Sheet>("/operations/payouts/sheet", { query: { week: target } });
      setSheet(result);
      setWeek(result.week.firstDay);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("无法读取周结付款表。"));
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => { void load(undefined); }, [load]);

  function goTo(target: string) {
    setPaying(null);
    setNotice("");
    void load(target);
  }

  function startPaying(row: SheetRow) {
    setPaying(row.payeeKey);
    setCode("");
    setNote("");
    setNotice("");
    setError("");
  }

  async function confirmPaid(row: SheetRow) {
    if (!sheet || !MPESA_CODE.test(code) || !/[A-Z]/.test(code)) return;
    setBusy(true);
    setError("");
    try {
      const result = await operationsRequester(accessToken)<{ alreadyRecorded: boolean }>("/operations/payouts/mark-paid", {
        method: "POST",
        body: JSON.stringify({ week: sheet.week.firstDay, payeeKey: row.payeeKey, mpesaCode: code, note: note.trim() || undefined, expectedAmountKsh: row.amountKsh })
      });
      setNotice(result.alreadyRecorded
        ? t("这笔付款之前已经登记过（交易号 {code}），没有重复登记。", { code })
        : t("已登记：{name} {amount}，M-Pesa 交易号 {code}。", { name: row.name, amount: formatKsh(row.amountKsh), code }));
      setPaying(null);
      await load(sheet.week.firstDay);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("登记失败，请刷新后再试。"));
    } finally {
      setBusy(false);
    }
  }

  const codeReady = MPESA_CODE.test(code) && /[A-Z]/.test(code);
  const metrics: Array<[string, string, string?]> = sheet ? [
    [t("本周应付合计"), formatKsh(sheet.totals.amountKsh), t("{count} 人待付", { count: sheet.totals.people })],
    [t("推广员佣金"), formatKsh(sheet.totals.affiliateKsh), t("{count} 人", { count: sheet.totals.affiliatePeople })],
    [t("骑手费"), formatKsh(sheet.totals.riderKsh), t("{count} 人", { count: sheet.totals.riderPeople })],
    [t("本周已付"), formatKsh(sheet.totals.paidKsh), t("{count} 笔", { count: sheet.totals.paidPeople })]
  ] : [];

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>{t("周结付款")}</CardTitle>
            <CardDescription>
              {t("每周一给上周（周一到周日，内罗毕时间）的推广员佣金和骑手费付款。先用 M-Pesa「Send Money」手动转账，再把短信里的交易号填到这里，系统会把这个人这周的所有款项标为已付。这里不会自动转账。")}
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-start gap-2">
            <Button variant="outline" size="sm" disabled={loading || !week} onClick={() => week && goTo(shiftDay(week, -7))}>
              <ChevronLeftIcon className="size-4" /> {t("上一周")}
            </Button>
            <Input
              type="date"
              className="w-40"
              value={week ?? ""}
              aria-label={t("选择周")}
              onChange={(event) => { if (event.target.value) goTo(event.target.value); }}
            />
            <Button variant="outline" size="sm" disabled={loading || !week} onClick={() => week && goTo(shiftDay(week, 7))}>
              {t("下一周")} <ChevronRightIcon className="size-4" />
            </Button>
            <Button variant="outline" size="sm" disabled={loading} onClick={() => void load(week)}>
              <RefreshCwIcon className="size-4" /> {loading ? t("读取中…") : t("刷新")}
            </Button>
            <PayoutExportButton accessToken={accessToken} refreshKey={sheet} disabled={loading} />
          </div>
        </CardHeader>
        {sheet ? (
          <CardContent className="flex flex-col gap-3">
            {sheet.awaitingConfirmation.count ? (
              <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                {t("先处理：另有 {count} 笔佣金（{amount}）已过 3 天退货期但还没确认，确认后才会出现在付款表和导出的付款清单里。", {
                  count: sheet.awaitingConfirmation.count,
                  amount: formatKsh(sheet.awaitingConfirmation.amountKsh)
                })}{" "}
                <Link href="/affiliate/commissions/pending" className="underline">{t("去确认佣金")}</Link>
              </p>
            ) : null}
            <div className="text-sm font-medium">
              {t("{from} 至 {to}", { from: sheet.week.firstDay, to: sheet.week.lastDay })}
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {metrics.map(([label, value, hint]) => (
                <div key={label} className={`rounded-md border p-3 ${label === t("骑手费") && sheet.totals.riderKsh === 0 ? "opacity-60" : ""}`}>
                  <div className="text-muted-foreground text-xs">{label}</div>
                  <div className="text-lg font-semibold">{value}</div>
                  {hint ? <div className="text-muted-foreground text-xs">{hint}</div> : null}
                </div>
              ))}
            </div>
            {sheet.earlierUnpaid.commissionCount || sheet.earlierUnpaid.riderFeeCount ? (
              <p className="text-sm text-amber-700 dark:text-amber-400">
                {t("更早的周还有未付款项：佣金 {commission}（{commissionCount} 笔），骑手费 {rider}（{riderCount} 单）。点「上一周」查看并付款。", {
                  commission: formatKsh(sheet.earlierUnpaid.commissionKsh),
                  commissionCount: sheet.earlierUnpaid.commissionCount,
                  rider: formatKsh(sheet.earlierUnpaid.riderFeeKsh),
                  riderCount: sheet.earlierUnpaid.riderFeeCount
                })}
              </p>
            ) : null}
          </CardContent>
        ) : null}
      </Card>

      {error ? <p className="text-destructive text-sm" role="alert">{error}</p> : null}
      {notice ? <p className="rounded-md border bg-card px-3 py-2 text-sm" role="status">{notice}</p> : null}

      {sheet ? (
        <MpesaBulkPanel
          accessToken={accessToken}
          week={sheet.week.firstDay}
          rows={sheet.rows}
          batches={sheet.batches ?? []}
          onChanged={() => load(sheet.week.firstDay)}
        />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("待付款项")}</CardTitle>
          <CardDescription>{t("每人一行。点「展开」看包含哪些订单。平时用上面的 M-Pesa 批量付款；单独手动转账的，转账后点「登记已付」。")}</CardDescription>
        </CardHeader>
        <CardContent>
          {sheet?.rows.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("姓名")}</TableHead>
                  <TableHead>{t("类型")}</TableHead>
                  <TableHead>{t("M-Pesa 手机号")}</TableHead>
                  <TableHead>{t("金额")}</TableHead>
                  <TableHead>{t("订单数")}</TableHead>
                  <TableHead>{t("操作")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sheet.rows.map((row) => (
                  <Fragment key={row.payeeKey}>
                    <TableRow>
                      <TableCell>
                        <div className="font-medium">{row.name}</div>
                        {row.affiliateCode ? <div className="text-muted-foreground font-mono text-xs">{row.affiliateCode}</div> : null}
                        {row.riderType === "EXTERNAL" ? <div className="text-muted-foreground text-xs">{t("外部骑手（按姓名和手机号合并）")}</div> : null}
                      </TableCell>
                      <TableCell>
                        <Badge variant={row.payeeType === "AFFILIATE" ? "secondary" : "outline"}>
                          {row.payeeType === "AFFILIATE" ? t("推广员") : t("骑手")}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {row.phone ?? <span className="text-destructive">{t("没有手机号")}</span>}
                        {row.phone && !row.bulkPhone ? <div className="text-destructive font-sans">{t("不是有效的 M-Pesa 手机号，不能放进批量文件")}</div> : null}
                      </TableCell>
                      <TableCell className="font-semibold">{formatKsh(row.amountKsh)}</TableCell>
                      <TableCell>
                        <Button variant="ghost" size="sm" onClick={() => setOpen((state) => ({ ...state, [row.payeeKey]: !state[row.payeeKey] }))}>
                          {row.count} <ChevronDownIcon className={`size-4 transition ${open[row.payeeKey] ? "rotate-180" : ""}`} /> {t("展开")}
                        </Button>
                      </TableCell>
                      <TableCell>
                        {row.exported ? (
                          <div className="flex max-w-56 flex-col gap-1">
                            <Badge variant="outline">{t("已导出，等待 M-Pesa 结果")}</Badge>
                            <span className="text-muted-foreground font-mono text-xs">{row.exported.lineReference}</span>
                          </div>
                        ) : row.selfPayment ? (
                          <p className="text-destructive max-w-56 text-xs">{t("这是你自己的款项，不能由你本人登记。请让另一位财务或超级管理员登记。")}</p>
                        ) : paying === row.payeeKey ? null : (
                          <Button size="sm" onClick={() => startPaying(row)}>{t("登记已付")}</Button>
                        )}
                      </TableCell>
                    </TableRow>
                    {open[row.payeeKey] ? (
                      <TableRow>
                        <TableCell colSpan={6} className="bg-muted/40">
                          <ul className="grid gap-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
                            {row.items.map((item) => (
                              <li key={item.id} className="flex justify-between gap-3 rounded border bg-card px-2 py-1">
                                <span className="font-mono">{item.orderNumber}</span>
                                <span className="text-muted-foreground">{item.kind === "COMMISSION" ? t("确认于 {at}", { at: formatMoment(item.at) }) : t("送达于 {at}", { at: formatMoment(item.at) })}</span>
                                <span className="font-medium">{formatKsh(item.amountKsh)}</span>
                              </li>
                            ))}
                          </ul>
                        </TableCell>
                      </TableRow>
                    ) : null}
                    {paying === row.payeeKey ? (
                      <TableRow>
                        <TableCell colSpan={6} className="bg-muted/40">
                          <div className="flex flex-col gap-3">
                            <p className="text-sm">
                              {t("先用 M-Pesa 给 {phone} 转 {amount}，再填写 M-Pesa 短信里的交易号（10 位字母和数字，例如 SJK3ABC12X）。", {
                                phone: row.phone ?? t("（没有手机号）"),
                                amount: formatKsh(row.amountKsh)
                              })}
                            </p>
                            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                              <Input
                                className="font-mono sm:w-48"
                                placeholder={t("M-Pesa 交易号")}
                                value={code}
                                autoFocus
                                maxLength={14}
                                aria-label={t("M-Pesa 交易号")}
                                onChange={(event) => setCode(cleanCode(event.target.value))}
                              />
                              <Input
                                className="sm:w-72"
                                placeholder={t("备注（可选）")}
                                value={note}
                                maxLength={300}
                                aria-label={t("备注（可选）")}
                                onChange={(event) => setNote(event.target.value)}
                              />
                              <Button disabled={busy || !codeReady} onClick={() => void confirmPaid(row)}>
                                {busy ? t("登记中…") : t("确认已付 {amount}", { amount: formatKsh(row.amountKsh) })}
                              </Button>
                              <Button variant="ghost" disabled={busy} onClick={() => setPaying(null)}>{t("取消")}</Button>
                            </div>
                            {code && !codeReady ? <p className="text-destructive text-xs">{t("交易号应为 10 位字母和数字。")}</p> : null}
                            <p className="text-muted-foreground text-xs">{t("确认后，这一行的 {count} 笔款项会一起标为已付，同一个交易号不能再用。", { count: row.count })}</p>
                          </div>
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon"><WalletCardsIcon /></EmptyMedia>
                <EmptyTitle>{loading ? t("读取中…") : t("这周没有待付款项")}</EmptyTitle>
                <EmptyDescription>{t("已确认的佣金（按确认日期）和已完成配送的骑手费（按送达日期）会出现在所属那一周。")}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </CardContent>
      </Card>

      {sheet?.paid.length ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("本周已付")}</CardTitle>
            <CardDescription>{t("已经登记过 M-Pesa 交易号的付款。")}</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("姓名")}</TableHead>
                  <TableHead>{t("类型")}</TableHead>
                  <TableHead>{t("金额")}</TableHead>
                  <TableHead>{t("M-Pesa 交易号")}</TableHead>
                  <TableHead>{t("登记时间")}</TableHead>
                  <TableHead>{t("登记人")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sheet.paid.map((payout) => (
                  <TableRow key={payout.id}>
                    <TableCell>
                      <div className="font-medium">{payout.payeeName}</div>
                      <div className="text-muted-foreground font-mono text-xs">{payout.payeePhone ?? "—"}</div>
                    </TableCell>
                    <TableCell>{payout.payeeType === "AFFILIATE" ? t("推广员") : t("骑手")}</TableCell>
                    <TableCell>
                      {formatKsh(payout.amountKsh)}
                      <div className="text-muted-foreground text-xs">{t("{count} 单", { count: payout.itemCount })}</div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{payout.mpesaCode}</TableCell>
                    <TableCell className="text-xs">
                      {formatMoment(payout.paidAt)}
                      {payout.note ? <div className="text-muted-foreground">{payout.note}</div> : null}
                    </TableCell>
                    <TableCell className="text-xs">{payout.paidByName ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
