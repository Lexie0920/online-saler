"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon, DownloadIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { downloadCsv } from "@/lib/csv-download";
import { operationsRequester } from "@/lib/operations-request";
import { t } from "@/i18n/runtime";

/**
 * The 导出退货记录 button on the after-sales orders page.
 *
 * One line per returned garment, for finance to find the refunds still to be sent
 * by hand in M-Pesa and for the team to look back at what is returned and why.
 * Leave the dates empty for the last 30 days. Read-only; the download is written to
 * the audit log because the file carries customer names and phone numbers.
 */

type ExportResult = {
  fileName: string;
  lineCount: number;
  summary: { lines: number; toRefundKsh: number; truncated: boolean };
  csv: string;
};

export function ReturnsExportButton(props: { accessToken: string; disabled?: boolean }) {
  const { accessToken, disabled } = props;
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [toRefundOnly, setToRefundOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const datesReady = (from === "") === (to === "") && (from === "" || from <= to);

  async function download() {
    setBusy(true);
    setMessage("");
    try {
      const result = await operationsRequester(accessToken)<ExportResult>("/operations/after-sales/export", {
        query: { from: from || undefined, to: to || undefined, filter: toRefundOnly ? "to-refund" : "all" }
      });
      if (result.lineCount === 0) {
        setMessage(t("所选日期范围内没有退货记录。"));
        return;
      }
      downloadCsv(result.fileName, result.csv);
      setMessage(result.summary.truncated ? t("文件只包含前 5000 行，请缩小日期范围后再导出。") : t("已导出 {count} 行。", { count: result.lineCount }));
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : t("退货记录导出失败，请刷新后再试。"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={box} className="relative">
      <Button variant="outline" disabled={disabled || !accessToken} onClick={() => setOpen((state) => !state)} aria-expanded={open}>
        <DownloadIcon className="size-4" /> {t("导出退货记录")} <ChevronDownIcon className={`size-4 transition ${open ? "rotate-180" : ""}`} />
      </Button>
      {open ? (
        <div className="bg-card absolute right-0 top-full z-30 mt-2 flex w-[22rem] max-w-[90vw] flex-col gap-3 rounded-lg border p-4 text-sm shadow-lg" role="dialog" aria-label={t("导出退货记录")}>
          <div className="font-medium">{t("导出退货记录")}</div>
          <p className="text-muted-foreground">{t("每件退回的衣服一行：原因、经手人、退款进度。日期留空为最近 30 天。文件含顾客姓名和电话，请勿外传。")}</p>
          <div className="flex items-center gap-2">
            <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} aria-label={t("退货记录的开始日期")} />
            <span>–</span>
            <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} aria-label={t("退货记录的结束日期")} />
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={toRefundOnly} onChange={(event) => setToRefundOnly(event.target.checked)} />
            {t("只看已批准、还没退款的")}
          </label>
          <Button disabled={busy || !datesReady} onClick={() => void download()}>
            <DownloadIcon className="size-4" /> {t("下载 Excel 可打开的文件")}
          </Button>
          {!datesReady ? <p className="text-destructive">{t("请同时填写开始和结束日期，且开始不晚于结束。")}</p> : null}
          {message ? <p role="status">{message}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
