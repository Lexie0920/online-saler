"use client";

import { useRef, useState } from "react";
import { DownloadIcon, FileSpreadsheetIcon, UploadIcon, XCircleIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatKsh, formatMoment, operationsRequester } from "@/lib/operations-request";
import { t } from "@/i18n/runtime";

/**
 * M-Pesa for Business bulk payouts (owner, 2026-10-14). Export one file for
 * the week, upload it to the portal and approve it there, then upload the
 * portal's results report here: each successful person is marked paid with
 * their M-Pesa receipt. The manual "登记已付" stays as the fallback.
 */

export type BatchLine = {
  id: string;
  reference: string;
  status: "PENDING" | "PAID" | "FAILED" | "CANCELLED";
  payeeType: "AFFILIATE" | "RIDER";
  payeeName: string;
  phone: string;
  amountKsh: number;
  mpesaCode: string | null;
  resultStatus: string | null;
  resultReason: string | null;
  resultAt: string | null;
};

export type PayoutBatch = {
  id: string;
  reference: string;
  status: "OPEN" | "RECONCILED" | "CANCELLED";
  lineCount: number;
  totalKsh: number;
  exportedAt: string;
  exportedByName: string | null;
  cancelledAt: string | null;
  reconciledAt: string | null;
  counts: { pending: number; paid: number; paidKsh: number; failed: number; cancelled: number };
  lines: BatchLine[];
};

export type BulkRow = {
  payeeKey: string;
  name: string;
  amountKsh: number;
  bulkPhone: string | null;
  selfPayment: unknown;
  exported: { batchReference: string } | null;
};

type FilePayload = { fileName: string; contentType: string; base64: string };

type Exclusion = { payeeKey: string; name: string; amountKsh: number; reason: "SELF_PAYMENT" | "NO_PHONE" | "ALREADY_EXPORTED" | "NOTHING_TO_PAY"; batchReference?: string };

type ExportResult = {
  batch: { id: string; reference: string; lineCount: number; totalKsh: number } | null;
  excluded: Exclusion[];
  file: FilePayload | null;
};

type ReconcileRow = {
  fileRow: number;
  outcome: "PAY" | "ALREADY_PAID" | "FAILED" | "DUPLICATE" | "UNMATCHED";
  reason: string | null;
  detail: string | null;
  lineReference: string | null;
  payeeName: string | null;
  receipt: string | null;
  phone: string;
  amountKsh: number | null;
  statusText: string;
  itemsNoLongerPayable: string[];
};

type ReconcileResult = {
  batch: { reference: string };
  changed: number;
  summary: { paidPeople: number; paidKsh: number; newlyPaid: number; alreadyPaid: number; failed: number; unmatched: number; duplicates: number; stillPending: number };
  rows: ReconcileRow[];
};

function download(file: FilePayload) {
  const bytes = Uint8Array.from(atob(file.base64), (char) => char.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: file.contentType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

function exclusionText(row: Exclusion): string {
  switch (row.reason) {
    case "SELF_PAYMENT": return t("这是你自己的款项，不能由你导出，请让另一位财务导出或登记。");
    case "NO_PHONE": return t("没有有效的 M-Pesa 手机号，请先补手机号，或手动转账后点「登记已付」。");
    case "ALREADY_EXPORTED": return t("已在批次 {reference} 里，等待 M-Pesa 结果。", { reference: row.batchReference ?? "" });
    default: return t("没有要付的金额。");
  }
}

function reasonText(row: ReconcileRow): string {
  const detail = row.detail ?? "";
  switch (row.reason) {
    case "NO_MATCH": return t("找不到对应的人：参考号、手机号加金额都对不上。");
    case "OTHER_BATCH": return t("参考号 {detail} 属于另一批导出。", { detail });
    case "AMOUNT_MISMATCH": return t("金额对不上（文件里 / 导出时：{detail}）。", { detail });
    case "AMBIGUOUS": return t("有多人手机号和金额相同，无法确定是谁。");
    case "NO_RECEIPT": return t("成功行没有有效的 M-Pesa 交易号。");
    case "UNKNOWN_STATUS": return t("看不懂的状态「{detail}」，没有处理。", { detail });
    case "DUPLICATE_SUCCESS": return t("同一人有两笔不同的成功付款（{detail}），请到 M-Pesa 核对是否重复付款。", { detail });
    case "RECEIPT_REUSED": return t("这个交易号已经登记给别人了（{detail}）。", { detail });
    case "LINE_CANCELLED": return t("这个人所在的导出已作废。");
    case "PAID_WITH_OTHER_CODE": return t("此人已用另一个交易号登记过（{detail}），请到 M-Pesa 核对是否重复付款。", { detail });
    case "SELF_PAYMENT": return t("这是你自己的款项，不能由你本人登记。请让另一位财务上传结果。");
    default: return "";
  }
}

const OUTCOME_LABELS: Record<ReconcileRow["outcome"], string> = {
  PAY: "已标为已付",
  ALREADY_PAID: "之前已登记",
  FAILED: "付款失败",
  DUPLICATE: "重复行，已忽略",
  UNMATCHED: "未匹配"
};

const LINE_STATUS_LABELS: Record<BatchLine["status"], string> = {
  PENDING: "等待结果",
  PAID: "已付",
  FAILED: "失败",
  CANCELLED: "已作废"
};

const BATCH_STATUS_LABELS: Record<PayoutBatch["status"], string> = {
  OPEN: "已导出，等待 M-Pesa 结果",
  RECONCILED: "已对账",
  CANCELLED: "已作废"
};

export function MpesaBulkPanel(props: {
  accessToken: string;
  week: string;
  rows: BulkRow[];
  batches: PayoutBatch[];
  onChanged: () => Promise<void>;
}) {
  const { accessToken, week, rows, batches, onChanged } = props;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [reconcile, setReconcile] = useState<ReconcileResult | null>(null);
  const [openBatch, setOpenBatch] = useState<string | null>(null);
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});

  const ready = rows.filter((row) => !row.selfPayment && row.bulkPhone && !row.exported);
  const readyKsh = ready.reduce((sum, row) => sum + row.amountKsh, 0);
  // Left out of the file because they have no usable M-Pesa number (not because they were already exported or are the payer).
  const noPhone = rows.filter((row) => !row.bulkPhone && !row.exported && !row.selfPayment);
  const noPhoneKsh = noPhone.reduce((sum, row) => sum + row.amountKsh, 0);
  const request = operationsRequester(accessToken);

  async function run(key: string, action: () => Promise<void>) {
    setBusy(key);
    setError("");
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("操作失败，请刷新后再试。"));
    } finally {
      setBusy(null);
    }
  }

  function exportFile() {
    void run("export", async () => {
      setReconcile(null);
      const result = await request<ExportResult>("/operations/payouts/batches", { method: "POST", body: JSON.stringify({ week, format: "xlsx" }) });
      setExportResult(result);
      if (result.file) download(result.file);
      await onChanged();
    });
  }

  function downloadAgain(batch: PayoutBatch, format: "xlsx" | "csv") {
    void run(`file:${batch.id}`, async () => {
      download(await request<FilePayload>(`/operations/payouts/batches/${batch.id}/file`, { query: { format } }));
    });
  }

  function cancel(batch: PayoutBatch, pendingOnly: boolean) {
    const question = pendingOnly
      ? t("先到 M-Pesa for Business 门户确认这 {count} 人确实没有收到钱。释放后他们会回到待付列表，可以重新导出或手动登记。继续吗？", { count: batch.counts.pending })
      : t("作废批次 {reference}？作废后这个文件不能再上传到 M-Pesa；如果已经上传，请不要在门户里批准。", { reference: batch.reference });
    if (!window.confirm(question)) return;
    void run(`cancel:${batch.id}`, async () => {
      await request(`/operations/payouts/batches/${batch.id}/cancel`, { method: "POST", body: JSON.stringify({ pendingOnly }) });
      await onChanged();
    });
  }

  function upload(batch: PayoutBatch, file: File | undefined) {
    if (!file) return;
    void run(`upload:${batch.id}`, async () => {
      setExportResult(null);
      const contentBase64 = await readAsBase64(file);
      const result = await request<ReconcileResult>(`/operations/payouts/batches/${batch.id}/results`, {
        method: "POST",
        body: JSON.stringify({ fileName: file.name, contentBase64 })
      });
      setReconcile(result);
      await onChanged();
    });
    const input = fileInputs.current[batch.id];
    if (input) input.value = "";
  }

  const problems = reconcile?.rows.filter((row) => row.outcome === "FAILED" || row.outcome === "UNMATCHED" || row.itemsNoLongerPayable.length) ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("M-Pesa 批量付款")}</CardTitle>
        <CardDescription>
          {t("① 点「导出 M-Pesa 批量付款文件」下载本周文件 ② 登录 M-Pesa for Business 门户，用批量付款（Bulk / B2C）上传这个文件并批准 ③ 付款完成后，在门户下载结果报告 ④ 在下面对应批次点「上传 M-Pesa 结果文件」，系统会按交易号把成功的人标为已付。")}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm">
            {ready.length
              ? t("可放进批量文件：{count} 人，合计 {amount}。", { count: ready.length, amount: formatKsh(readyKsh) })
              : t("没有可放进批量文件的人。")}
            {noPhone.length ? (
              <span className="text-destructive"> {t("{count} 人没有可用的手机号，没放进文件（{amount}）。", { count: noPhone.length, amount: formatKsh(noPhoneKsh) })}</span>
            ) : null}
          </p>
          <Button disabled={!ready.length || busy !== null} onClick={exportFile}>
            <FileSpreadsheetIcon className="size-4" /> {busy === "export" ? t("导出中…") : t("导出 M-Pesa 批量付款文件")}
          </Button>
        </div>

        {error ? <p className="text-destructive text-sm" role="alert">{error}</p> : null}

        {exportResult ? (
          <div className="rounded-md border p-3 text-sm" role="status">
            {exportResult.batch ? (
              <p className="font-medium">
                {t("已导出批次 {reference}：{count} 人，合计 {amount}。文件已下载，请上传到 M-Pesa for Business 门户。", {
                  reference: exportResult.batch.reference,
                  count: exportResult.batch.lineCount,
                  amount: formatKsh(exportResult.batch.totalKsh)
                })}
              </p>
            ) : (
              <p className="font-medium">{t("没有导出任何人。")}</p>
            )}
            {exportResult.excluded.length ? (
              <div className="mt-2">
                <p className="text-amber-700 dark:text-amber-400">{t("以下 {count} 人没有放进文件：", { count: exportResult.excluded.length })}</p>
                <ul className="mt-1 grid gap-1 text-xs">
                  {exportResult.excluded.map((row) => (
                    <li key={row.payeeKey}><span className="font-medium">{row.name}</span> {formatKsh(row.amountKsh)} — {exclusionText(row)}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}

        {reconcile ? (
          <div className="rounded-md border p-3 text-sm" role="status">
            <p className="font-medium">
              {t("批次 {reference} 对账结果：成功 {paid} 人 {amount} · 失败 {failed} · 未匹配 {unmatched}", {
                reference: reconcile.batch.reference,
                paid: reconcile.summary.paidPeople,
                amount: formatKsh(reconcile.summary.paidKsh),
                failed: reconcile.summary.failed,
                unmatched: reconcile.summary.unmatched
              })}
            </p>
            <p className="text-muted-foreground text-xs">
              {reconcile.changed
                ? t("本次新标为已付 {count} 人；之前已登记 {already} 人；还在等待结果 {pending} 人。", { count: reconcile.summary.newlyPaid, already: reconcile.summary.alreadyPaid, pending: reconcile.summary.stillPending })
                : t("这个文件之前已经处理过，没有任何改动。")}
            </p>
            {problems.length ? (
              <Table className="mt-2">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("文件行")}</TableHead>
                    <TableHead>{t("结果")}</TableHead>
                    <TableHead>{t("姓名")}</TableHead>
                    <TableHead>{t("手机号")}</TableHead>
                    <TableHead>{t("金额")}</TableHead>
                    <TableHead>{t("原因")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {problems.map((row) => (
                    <TableRow key={`${row.fileRow}-${row.outcome}`}>
                      <TableCell>{row.fileRow}</TableCell>
                      <TableCell>
                        <Badge variant={row.outcome === "PAY" ? "secondary" : "destructive"}>{t(OUTCOME_LABELS[row.outcome])}</Badge>
                      </TableCell>
                      <TableCell>{row.payeeName ?? "—"}</TableCell>
                      <TableCell className="font-mono text-xs">{row.phone || "—"}</TableCell>
                      <TableCell>{row.amountKsh === null ? "—" : formatKsh(row.amountKsh)}</TableCell>
                      <TableCell className="text-xs">
                        {row.outcome === "FAILED" ? t("M-Pesa 显示付款失败（{detail}）。此人回到待付列表，可以重新导出或手动登记。", { detail: row.detail || row.statusText }) : reasonText(row)}
                        {row.itemsNoLongerPayable.length ? (
                          <div className="text-amber-700 dark:text-amber-400">
                            {t("钱已付出，但这些订单已不能结算（例如有退货），没有标为已付，请人工处理：{orders}", { orders: row.itemsNoLongerPayable.join(" ") })}
                          </div>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : null}
          </div>
        ) : null}

        {batches.length ? (
          <div className="flex flex-col gap-3">
            {batches.map((batch) => {
              const settled = batch.counts.paid + batch.counts.failed;
              return (
                <div key={batch.id} className="rounded-md border p-3">
                  <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                    <div className="text-sm">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-semibold">{batch.reference}</span>
                        <Badge variant={batch.status === "OPEN" ? "default" : batch.status === "CANCELLED" ? "outline" : "secondary"}>{t(BATCH_STATUS_LABELS[batch.status])}</Badge>
                      </div>
                      <div className="text-muted-foreground text-xs">
                        {t("{at} 由 {name} 导出 · {count} 人 · {amount}", { at: formatMoment(batch.exportedAt), name: batch.exportedByName ?? "—", count: batch.lineCount, amount: formatKsh(batch.totalKsh) })}
                      </div>
                      <div className="text-xs">
                        {t("已付 {paid} 人（{paidKsh}）· 失败 {failed} · 等待结果 {pending} · 作废 {cancelled}", {
                          paid: batch.counts.paid,
                          paidKsh: formatKsh(batch.counts.paidKsh),
                          failed: batch.counts.failed,
                          pending: batch.counts.pending,
                          cancelled: batch.counts.cancelled
                        })}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="ghost" size="sm" onClick={() => setOpenBatch(openBatch === batch.id ? null : batch.id)}>
                        {openBatch === batch.id ? t("收起") : t("查看名单")}
                      </Button>
                      {batch.status !== "CANCELLED" ? (
                        <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => downloadAgain(batch, "xlsx")}>
                          <DownloadIcon className="size-4" /> {t("再次下载文件")}
                        </Button>
                      ) : null}
                      {batch.status !== "CANCELLED" ? (
                        <>
                          <input
                            ref={(element) => { fileInputs.current[batch.id] = element; }}
                            type="file"
                            accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                            className="hidden"
                            aria-label={t("上传 M-Pesa 结果文件")}
                            onChange={(event) => upload(batch, event.target.files?.[0])}
                          />
                          <Button size="sm" disabled={busy !== null} onClick={() => fileInputs.current[batch.id]?.click()}>
                            <UploadIcon className="size-4" /> {busy === `upload:${batch.id}` ? t("对账中…") : t("上传 M-Pesa 结果文件")}
                          </Button>
                        </>
                      ) : null}
                      {batch.status === "OPEN" && !settled ? (
                        <Button variant="destructive" size="sm" disabled={busy !== null} onClick={() => cancel(batch, false)}>
                          <XCircleIcon className="size-4" /> {t("作废这批导出")}
                        </Button>
                      ) : null}
                      {batch.status === "OPEN" && settled && batch.counts.pending ? (
                        <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => cancel(batch, true)}>
                          {t("释放还没有结果的 {count} 人", { count: batch.counts.pending })}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  {openBatch === batch.id ? (
                    <Table className="mt-2">
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t("参考号")}</TableHead>
                          <TableHead>{t("姓名")}</TableHead>
                          <TableHead>{t("手机号")}</TableHead>
                          <TableHead>{t("金额")}</TableHead>
                          <TableHead>{t("状态")}</TableHead>
                          <TableHead>{t("M-Pesa 交易号")}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {batch.lines.map((line) => (
                          <TableRow key={line.id}>
                            <TableCell className="font-mono text-xs">{line.reference}</TableCell>
                            <TableCell>{line.payeeName}</TableCell>
                            <TableCell className="font-mono text-xs">{line.phone}</TableCell>
                            <TableCell>{formatKsh(line.amountKsh)}</TableCell>
                            <TableCell>
                              {t(LINE_STATUS_LABELS[line.status])}
                              {line.status === "FAILED" && line.resultReason ? <div className="text-muted-foreground text-xs">{line.resultReason}</div> : null}
                            </TableCell>
                            <TableCell className="font-mono text-xs">{line.mpesaCode ?? "—"}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
