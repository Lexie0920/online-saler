"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon, DownloadIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { downloadCsv } from "@/lib/csv-download";
import { formatKsh, operationsRequester } from "@/lib/operations-request";
import { t } from "@/i18n/runtime";

/**
 * The 导出 button on the weekly payouts page, the only place the payment list is exported.
 *
 * Two big buttons cover the usual runs (this week's unpaid, everything unpaid). 更多选项
 * opens, in the same panel, the choices behind them: the week, a date range or everything;
 * unpaid, paid or both; promoters and/or riders; one line per person or per order. The
 * panel shows how many people and how much will be exported before anything downloads.
 * Read-only: nothing here records a payment.
 */

export type ExportSummary = {
  people: number;
  affiliatePeople: number;
  riderPeople: number;
  amountKsh: number;
  itemCount: number;
  missingPhonePeople: number;
  truncated: boolean;
};

type ExportResult = { fileName: string; summary: ExportSummary; lineCount: number; csv: string };

export type ExportParams = {
  scope: "week" | "range" | "all" | "earlier";
  week?: string;
  from?: string;
  to?: string;
  status: "pending" | "paid" | "all";
  includeAffiliate: boolean;
  includeRider: boolean;
  format: "summary" | "detail";
};

function toQuery(params: ExportParams): Record<string, string | undefined> {
  return {
    scope: params.scope,
    week: params.scope === "week" || params.scope === "earlier" ? params.week : undefined,
    from: params.scope === "range" ? params.from : undefined,
    to: params.scope === "range" ? params.to : undefined,
    status: params.status,
    include: [params.includeAffiliate ? "affiliate" : "", params.includeRider ? "rider" : ""].filter(Boolean).join(",") || "none",
    format: params.format
  };
}

function fetchExport(accessToken: string, params: ExportParams) {
  return operationsRequester(accessToken)<ExportResult>("/operations/payouts/export", { query: toQuery(params) });
}

/** Fetches one export and saves it as a file. Returns what was exported, or null when there was nothing. */
export async function downloadPayoutExport(accessToken: string, params: ExportParams): Promise<ExportResult | null> {
  const result = await fetchExport(accessToken, params);
  if (result.lineCount === 0) return null;
  downloadCsv(result.fileName, result.csv);
  return result;
}

function Choice<T extends string>(props: { value: T; options: Array<[T, string]>; onChange: (value: T) => void }) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border">
      {props.options.map(([option, label]) => (
        <Button
          key={option}
          type="button"
          size="sm"
          variant={props.value === option ? "default" : "ghost"}
          className="rounded-none"
          onClick={() => props.onChange(option)}
        >
          {label}
        </Button>
      ))}
    </div>
  );
}

function describe(summary: ExportSummary) {
  return t("{people} 人 · {amount}", { people: summary.people, amount: formatKsh(summary.amountKsh) });
}

export function PayoutExportPanel(props: { accessToken: string; week: string | undefined; disabled?: boolean }) {
  const { accessToken, week, disabled } = props;
  const [open, setOpen] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [weekSummary, setWeekSummary] = useState<ExportSummary | null>(null);
  const [allSummary, setAllSummary] = useState<ExportSummary | null>(null);
  const [scope, setScope] = useState<"week" | "range" | "all">("week");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [status, setStatus] = useState<"pending" | "paid" | "all">("pending");
  const [includeAffiliate, setIncludeAffiliate] = useState(true);
  const [includeRider, setIncludeRider] = useState(true);
  const [format, setFormat] = useState<"summary" | "detail">("summary");
  const [custom, setCustom] = useState<ExportResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const box = useRef<HTMLDivElement | null>(null);

  // Close when the click lands outside the panel.
  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // The two quick buttons show how many people and how much, read fresh each time the panel opens.
  useEffect(() => {
    if (!open || !accessToken) return;
    let cancelled = false;
    setError("");
    const base = { status: "pending", includeAffiliate: true, includeRider: true, format: "summary" } as const;
    void fetchExport(accessToken, { ...base, scope: "week", week })
      .then((result) => { if (!cancelled) setWeekSummary(result.summary); })
      .catch((caught) => { if (!cancelled) setError(caught instanceof Error ? caught.message : t("无法读取导出内容。")); });
    void fetchExport(accessToken, { ...base, scope: "all" })
      .then((result) => { if (!cancelled) setAllSummary(result.summary); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [open, accessToken, week]);

  const customParams: ExportParams = { scope, week, from, to, status, includeAffiliate, includeRider, format };
  const rangeReady = scope !== "range" || (Boolean(from) && Boolean(to) && from <= to);
  const customReady = rangeReady && (includeAffiliate || includeRider);

  // The "more options" choice is previewed as it changes, so the count is never stale at download time.
  useEffect(() => {
    if (!open || !advanced || !accessToken) return;
    if (!customReady) { setCustom(null); return; }
    let cancelled = false;
    setLoading(true);
    setError("");
    const timer = window.setTimeout(() => {
      fetchExport(accessToken, { scope, week, from, to, status, includeAffiliate, includeRider, format })
        .then((result) => { if (!cancelled) setCustom(result); })
        .catch((caught) => { if (!cancelled) { setCustom(null); setError(caught instanceof Error ? caught.message : t("无法读取导出内容。")); } })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [open, advanced, accessToken, customReady, scope, week, from, to, status, includeAffiliate, includeRider, format]);

  async function quick(params: ExportParams) {
    setBusy(true);
    setError("");
    try {
      const result = await downloadPayoutExport(accessToken, params);
      if (!result) setError(t("所选范围没有可导出的内容。"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("导出失败，请刷新后再试。"));
    } finally {
      setBusy(false);
    }
  }

  function downloadCustom() {
    if (custom && custom.lineCount > 0) downloadCsv(custom.fileName, custom.csv);
  }

  const quickBase = { status: "pending", includeAffiliate: true, includeRider: true, format: "summary" } as const;

  return (
    <div ref={box} className="relative">
      <Button variant="outline" size="sm" disabled={disabled || !accessToken} onClick={() => setOpen((state) => !state)} aria-expanded={open}>
        <DownloadIcon className="size-4" /> {t("导出")} <ChevronDownIcon className={`size-4 transition ${open ? "rotate-180" : ""}`} />
      </Button>
      {open ? (
        <div className="bg-card absolute right-0 top-full z-30 mt-2 flex w-[26rem] max-w-[90vw] flex-col gap-3 rounded-lg border p-4 shadow-lg" role="dialog" aria-label={t("导出付款清单")}>
          <div className="font-medium">{t("导出付款清单")}</div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button disabled={busy || !week} className="h-auto flex-col py-2" onClick={() => void quick({ ...quickBase, scope: "week", week })}>
              <span>{t("本周待付")}</span>
              <span className="text-xs font-normal opacity-80">{weekSummary ? describe(weekSummary) : "…"}</span>
            </Button>
            <Button disabled={busy} className="h-auto flex-col py-2" onClick={() => void quick({ ...quickBase, scope: "all" })}>
              <span>{t("全部待付（含更早）")}</span>
              <span className="text-xs font-normal opacity-80">{allSummary ? describe(allSummary) : "…"}</span>
            </Button>
          </div>

          <button type="button" className="text-muted-foreground flex items-center gap-1 text-left text-sm" onClick={() => setAdvanced((state) => !state)}>
            <ChevronDownIcon className={`size-4 transition ${advanced ? "" : "-rotate-90"}`} /> {t("更多选项")}
          </button>

          {advanced ? (
            <div className="flex flex-col gap-3 text-sm">
              <div className="flex flex-col gap-1">
                <span className="text-muted-foreground text-xs">{t("范围")}</span>
                <Choice<"week" | "range" | "all"> value={scope} onChange={setScope} options={[["week", t("本周")], ["range", t("日期范围")], ["all", t("全部")]]} />
                {scope === "range" ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Input type="date" className="w-40" value={from} aria-label={t("开始日期")} onChange={(event) => setFrom(event.target.value)} />
                    <span>—</span>
                    <Input type="date" className="w-40" value={to} aria-label={t("结束日期")} onChange={(event) => setTo(event.target.value)} />
                  </div>
                ) : null}
                {scope === "week" && week ? <span className="text-muted-foreground text-xs">{t("页面上选中的这一周：{week} 起", { week })}</span> : null}
                <span className="text-muted-foreground rounded-md bg-amber-50 px-2 py-1 text-xs dark:bg-amber-950/30">
                  {t("按“归属日期”：佣金是确认日期，骑手费是完成配送日期。")}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-muted-foreground text-xs">{t("状态")}</span>
                <Choice<"pending" | "paid" | "all"> value={status} onChange={setStatus} options={[["pending", t("待付")], ["paid", t("已付")], ["all", t("全部")]]} />
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-muted-foreground text-xs">{t("包含")}</span>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2"><input type="checkbox" checked={includeAffiliate} onChange={(event) => setIncludeAffiliate(event.target.checked)} /> {t("推广员佣金")}</label>
                  <label className="flex items-center gap-2"><input type="checkbox" checked={includeRider} onChange={(event) => setIncludeRider(event.target.checked)} /> {t("骑手费")}</label>
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-muted-foreground text-xs">{t("格式")}</span>
                <Choice<"summary" | "detail"> value={format} onChange={setFormat} options={[["summary", t("按人汇总")], ["detail", t("逐笔明细")]]} />
              </div>
              <div className="flex flex-col gap-2">
                <p>
                  {!customReady
                    ? (!(includeAffiliate || includeRider) ? t("请至少选一项：推广员佣金或骑手费。") : t("请选好开始和结束日期。"))
                    : loading || !custom
                      ? t("读取中…")
                      : custom.lineCount === 0
                        ? t("所选范围没有内容。")
                        : t("所选范围：{summary}，共 {count} 笔", { summary: describe(custom.summary), count: custom.summary.itemCount })}
                </p>
                {custom && custom.summary.missingPhonePeople > 0 ? (
                  <p className="text-destructive text-xs">{t("其中 {count} 人没有手机号，文件的备注列会标出。", { count: custom.summary.missingPhonePeople })}</p>
                ) : null}
                {custom?.summary.truncated ? <p className="text-destructive text-xs">{t("数据太多，只导出了前 20000 条。请缩小范围再导出。")}</p> : null}
                <div>
                  <Button size="sm" disabled={!customReady || loading || !custom || custom.lineCount === 0} onClick={downloadCustom}>
                    <DownloadIcon className="size-4" /> {t("下载 CSV")}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}

          {error ? <p className="text-destructive text-xs" role="alert">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
