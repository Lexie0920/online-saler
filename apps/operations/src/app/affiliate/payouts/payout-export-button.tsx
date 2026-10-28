"use client";

import { useEffect, useState } from "react";
import { DownloadIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { XLSX_MIME, buildPayoutListXlsx, downloadBytes, type PayoutListLine } from "@/lib/payout-list-xlsx";
import { formatKsh, operationsRequester } from "@/lib/operations-request";
import { t } from "@/i18n/runtime";

/**
 * 导出付款清单: one button, the only place the payment list is exported.
 *
 * It downloads an Excel file with every promoter commission that is confirmed and not yet
 * paid, from every week: one row per promoter and week, a colour block and a subtotal for a
 * promoter owed for several weeks, and a total. There is nothing to choose. Once a payment is
 * recorded on this page that commission is no longer in the list. Rider fees are not in it.
 * Read-only: nothing here records a payment.
 */

type ListSummary = {
  people: number;
  rows: number;
  orders: number;
  amountKsh: number;
  phoneProblems: number;
  truncated: boolean;
};

type PayoutListResult = { fileName: string; summary: ListSummary; lines: PayoutListLine[] };

export function PayoutExportButton(props: { accessToken: string; /** Changes whenever the page reloads, so the numbers stay current. */ refreshKey: unknown; disabled?: boolean }) {
  const { accessToken, refreshKey, disabled } = props;
  const [summary, setSummary] = useState<ListSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  // The button shows how many people and how much before anything is downloaded.
  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    operationsRequester(accessToken)<PayoutListResult>("/operations/payouts/export", { query: { summary: "true" } })
      .then((result) => { if (!cancelled) setSummary(result.summary); })
      .catch(() => { if (!cancelled) setSummary(null); });
    return () => { cancelled = true; };
  }, [accessToken, refreshKey]);

  async function download() {
    setBusy(true);
    setError("");
    setDone("");
    try {
      // Read the list again now, so the file always matches what is owed at this moment.
      const list = await operationsRequester(accessToken)<PayoutListResult>("/operations/payouts/export");
      setSummary(list.summary);
      if (list.summary.people === 0 || list.lines.length === 0) return;
      const saved = downloadBytes(list.fileName, await buildPayoutListXlsx(list.lines), XLSX_MIME);
      if (!saved) throw new Error("empty file");
      setDone(t("已下载 {file}：{people} 人，合计 {amount}。", { file: list.fileName, people: list.summary.people, amount: formatKsh(list.summary.amountKsh) }));
    } catch {
      setError(t("导出失败，没有保存文件。请刷新页面后再试。"));
    } finally {
      setBusy(false);
    }
  }

  const nothing = summary !== null && summary.people === 0;
  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="outline" size="sm" disabled={disabled || busy || !accessToken || nothing} onClick={() => void download()}>
        <DownloadIcon className="size-4" /> {busy ? t("正在生成文件…") : t("导出付款清单")}
      </Button>
      <p className="text-muted-foreground max-w-80 text-right text-xs">
        {summary === null
          ? t("读取中…")
          : nothing
            ? t("现在没有要付的款项。")
            : t("待付 {people} 人 · {amount}。登记付款后，这些人才会从清单里消失。", { people: summary.people, amount: formatKsh(summary.amountKsh) })}
      </p>
      {summary && summary.phoneProblems > 0 ? (
        <p className="text-destructive max-w-80 text-right text-xs">{t("有 {count} 人没有可用的 M-Pesa 手机号，文件的备注列会标出。", { count: summary.phoneProblems })}</p>
      ) : null}
      {summary?.truncated ? (
        <p className="text-destructive max-w-80 text-right text-xs">{t("数据太多，清单只列出了前 20000 笔。付完这些再导出一次，就能看到其余的。")}</p>
      ) : null}
      {done ? <p className="max-w-80 text-right text-xs text-green-700 dark:text-green-400" role="status">{done}</p> : null}
      {error ? <p className="text-destructive max-w-80 text-right text-xs" role="alert">{error}</p> : null}
    </div>
  );
}
