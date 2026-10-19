"use client";

import { operationsFetch } from "@/lib/operations-api";

import Link from "next/link";
import { runWithConcurrency } from "./product-batch-processing-concurrency";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ProductImageComparisonResponse, ImageProcessingJobRecord } from "@online-saler/shared-types";
import JsBarcode from "jsbarcode";
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  BarcodeIcon,
  CheckCircle2Icon,
  ImageIcon,
  LoaderCircleIcon,
  MapPinIcon,
  PackageCheckIcon,
  PrinterIcon,
  RefreshCwIcon,
  XCircleIcon
} from "lucide-react";

import { useOperationsSession } from "@/components/admin/operations-access-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";
import { DEFAULT_LABEL_SIZE, MACOS_PRINT_AGENT_DOWNLOAD_URL, PRINT_AGENT_DOWNLOAD_URL } from "../local-label-print";
import { ProductLabelPrinter } from "./product-label-printer";
import { productStatusLabel } from "./product-factory-display";
import { displayMethod, displayMethodLabel, isRejected, latestFailedDisplayJob, stillGenerating } from "./product-display-method";
import { t } from "@/i18n/runtime";

const API_PROXY_URL = "/api-proxy";

type InventoryItem = {
  status?: string | null;
  locationId?: string | null;
  location?: {
    locationCode?: string | null;
    capacity?: number | null;
    _count?: { inventoryItems?: number | null };
  } | null;
};

type ProductRecord = Record<string, unknown> & {
  id: string;
  productCode: string;
  batchItemNumber?: number | null;
  status: string;
  barcode?: string | null;
  title?: string | null;
  category?: string | null;
  color?: string | null;
  finalSizeLabel?: string | null;
  tagSize?: string | null;
  conditionGrade?: string | null;
  labelPrintedAt?: string | null;
  inventoryItem?: InventoryItem | null;
  detailSourceVersion?: number;
  detailProfiles?: Array<{ id: string; status: string; sourceDataVersion: number }>;
};

type Shelf = {
  id: string;
  locationCode: string;
  capacity: number;
  currentItemCount: number;
  remainingCapacity: number;
};

type ProductBatch = {
  id: string;
  batchCode: string;
  targetCount: number;
  stage: string;
  stageLabel: string;
  products: ProductRecord[];
};

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await operationsFetch(`${API_PROXY_URL}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options?.headers ?? {}) }
  });
  const text = await response.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { message: text || `Request failed: ${response.status}` };
  }
  if (!response.ok) {
    const message = body && typeof body === "object" && "message" in body
      ? String((body as { message?: unknown }).message)
      : `Request failed: ${response.status}`;
    throw new Error(translateApiError(message));
  }
  return body as T;
}

function usePageVisible() {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

function useOperationIds() {
  const { session } = useOperationsSession();
  return useMemo(() => ({
    adminUserId: String(session?.adminUser?.id ?? ""),
    employeeId: String(session?.adminUser?.linkedEmployeeId ?? "")
  }), [session]);
}

async function loadBatch(batchId: string, adminUserId: string): Promise<ProductBatch> {
  const query = new URLSearchParams({ adminUserId });
  const batch = await request<ProductBatch>(`/operations/product-batches/${encodeURIComponent(batchId)}?${query.toString()}`);
  return {
    ...batch,
    products: [...batch.products].sort((left, right) => Number(left.batchItemNumber ?? 0) - Number(right.batchItemNumber ?? 0))
  };
}

async function loadComparison(productId: string, adminUserId: string) {
  return request<ProductImageComparisonResponse>(`/products/${productId}/image-comparison`, {
    headers: { "X-Admin-User-Id": adminUserId }
  });
}

export function ProductBatchBarcodePage({ batchId, reviewMode = false }: { batchId: string; reviewMode?: boolean }) {
  const router = useRouter();
  const [printIndex, setPrintIndex] = useState<number | null>(null);
  const [reviewIndex, setReviewIndex] = useState(0);
  const ids = useOperationIds();
  const [batch, setBatch] = useState<ProductBatch | null>(null);
  const [comparisons, setComparisons] = useState<Record<string, ProductImageComparisonResponse>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [shelves, setShelves] = useState<Shelf[]>([]);
  const [shelfId, setShelfId] = useState("");

  const load = useCallback(async () => {
    if (!ids.adminUserId) return;
    const next = await loadBatch(batchId, ids.adminUserId);
    setShelves(await request<Shelf[]>("/operations/product-batches/shelves").catch(() => []));
    const currentShelfId = next.products.find((product) => product.inventoryItem?.locationId)?.inventoryItem?.locationId;
    if (currentShelfId) setShelfId((selected) => selected || currentShelfId);
    const comparisonEntries = await Promise.all(next.products.map(async (product) => {
      try {
        return [product.id, await loadComparison(product.id, ids.adminUserId)] as const;
      } catch {
        return null;
      }
    }));
    setBatch(next);
    setComparisons(Object.fromEntries(
      comparisonEntries.filter((entry): entry is readonly [string, ProductImageComparisonResponse] => Boolean(entry))
    ));
  }, [batchId, ids.adminUserId]);

  useEffect(() => {
    const carriedNotice = sessionStorage.getItem(`product-factory-notice:${batchId}`);
    if (carriedNotice) {
      sessionStorage.removeItem(`product-factory-notice:${batchId}`);
      setNotice(carriedNotice);
    }
    void load().catch((caught) => setError(errorMessage(caught, t("无法读取打印与归位工作台。"))));
  }, [batchId, load]);

  // Items rejected on this page stay listed but take no further part in the batch.
  const activeProducts = useMemo(() => (batch?.products ?? []).filter((product) => !isRejected(product)), [batch]);

  const allAiDisplaysReady = activeProducts.length > 0 && activeProducts.every((product) =>
    Boolean(comparisons[product.id]?.aiDisplayMain)
  );

  const allDisplaysConfirmed = activeProducts.length > 0 && batch!.products.length === batch!.targetCount && activeProducts.every((product) =>
    product.status === "PUBLISHED" || displayConfirmed(comparisons[product.id])
  );
  const allDetailsReady = activeProducts.length > 0 && activeProducts.every((product) =>
    product.status === "PUBLISHED" || detailReady(product)
  );

  // Reload only while something is still generating and the tab is in view;
  // a failed item waits for its retry button instead of a reload every 3 s.
  const pageVisible = usePageVisible();
  const anyStillGenerating = activeProducts.some((product) => stillGenerating(product, comparisons[product.id]));
  useEffect(() => {
    if (!batch || busy || !pageVisible || !anyStillGenerating) return;
    const timer = window.setTimeout(() => {
      void load().catch(() => undefined);
    }, 3_000);
    return () => window.clearTimeout(timer);
  }, [anyStillGenerating, batch, busy, load, pageVisible]);

  async function generateBarcodesAndLocations() {
    if (!batch || !allDisplaysConfirmed || !allDetailsReady) return;
    const shelf = shelves.find((candidate) => candidate.id === shelfId);
    if (!shelf) {
      setError(t("请先选择这一批要放的货架。"));
      return;
    }
    setBusy("generate");
    setError("");
    try {
      // A candidate may be reviewed while sales copy is still rendering.
      // Synchronize the final assets from the confirmed selection before labels.
      await runWithConcurrency(activeProducts.filter((product) => product.status !== "PUBLISHED"), 2, async (product) => {
        await request(`/product-detail-profiles/${product.detailProfiles![0]!.id}/assets/generate`, { method: "POST", body: "{}" });
      });
      await request(`/operations/product-batches/${batch.id}/generate-barcodes`, {
        method: "POST",
        body: JSON.stringify({ ...ids, locationId: shelf.id })
      });
      await load();
      setNotice(t("本批 {targetCount} 个 Barcode 已生成，整批放在货架 {locationCode}。", { targetCount: activeProducts.length, locationCode: shelf.locationCode }));
      router.push(`/product/barcode?batchId=${encodeURIComponent(batch.id)}`);
    } catch (caught) {
      setError(errorMessage(caught, t("无法生成 Barcode 或预留货架位。")));
    } finally {
      setBusy("");
    }
  }

  async function rerunDetails() {
    if (!batch) return;
    setBusy("details");
    setError("");
    try {
      const statuses = batch.products.map((product) => product.detailProfiles?.[0]?.status);
      const action = statuses.includes("FAILED") ? "retry-failed" : statuses.includes("OUTDATED") ? "regenerate-outdated" : "run";
      await request(`/operations/product-batches/${batch.id}/detail-generation/${action}`, {
        method: "POST",
        headers: { "X-Admin-User-Id": ids.adminUserId },
        body: JSON.stringify({})
      });
      setNotice(t("正在补生成 白底展示图与销售详情，完成后本页会自动更新。"));
      await load();
    } catch (caught) {
      setError(errorMessage(caught, t("无法生成 白底展示图与销售详情。")));
    } finally {
      setBusy("");
    }
  }

  async function reviewDisplay(product: ProductRecord, regenerate: boolean) {
    const comparison = comparisons[product.id];
    const profile = product.detailProfiles?.[0];
    if (product.status === "PUBLISHED" || !comparison?.original) return;
    if (!regenerate && !comparison.aiDisplayMain) return;
    setBusy(`${regenerate ? "regenerate" : "confirm"}-${product.id}`);
    setError("");
    setNotice("");
    const select = (imageId: string, humanConfirmed: boolean) => request(
      profile && detailReady(product) ? `/product-detail-profiles/${encodeURIComponent(profile.id)}/main-image` : `/products/${product.id}/display-image-selection`, {
        method: "POST", body: JSON.stringify({ imageId, humanConfirmed })
      }
    );
    try {
      if (regenerate) {
        // Persist invalidation before generation so failures/reloads cannot retain approval.
        if (comparison.aiDisplayMain) await select(comparison.aiDisplayMain.imageId, false);
        const job = await request<ImageProcessingJobRecord>(
          `/products/${product.id}/images/${comparison.original.imageId}/processing-jobs`, {
            method: "POST", body: JSON.stringify({ operation: "GENERATE_AI_DISPLAY_MAIN_IMAGE" })
          });
        const completed = await request<ImageProcessingJobRecord>(`/image-processing-jobs/${job.id}/run`, {
          method: "POST", body: JSON.stringify({})
        });
        if (completed.status !== "SUCCEEDED" || !completed.outputImageId) throw new Error(completed.errorMessage || t("白底展示图生成失败，请重试。"));
        await select(completed.outputImageId, false);
        setNotice(t("已从原图重新生成，请重新核对并确认这张展示图。"));
      } else {
        await select(comparison.aiDisplayMain!.imageId, true);
        setNotice(t("本件展示图已确认。"));
        moveToNextPending(product.id);
      }
      await load();
    } catch (caught) {
      await load().catch(() => undefined);
      setError(errorMessage(caught, t("无法处理展示图，请重试。")));
    } finally {
      setBusy("");
    }
  }

  function moveToNextPending(currentId: string) {
    if (!batch) return;
    const pending = (item: ProductRecord) => item.id !== currentId && item.status !== "PUBLISHED" && !isRejected(item) && !displayConfirmed(comparisons[item.id]);
    const nextIndex = batch.products.findIndex((item, index) => index > reviewIndex && pending(item));
    const firstPending = batch.products.findIndex(pending);
    if (nextIndex >= 0 || firstPending >= 0) setReviewIndex(nextIndex >= 0 ? nextIndex : firstPending);
  }

  // Escape for one item: its own original photo, untouched, becomes the display image.
  async function useOriginalPhoto(product: ProductRecord) {
    const comparison = comparisons[product.id];
    const profile = product.detailProfiles?.[0];
    if (product.status === "PUBLISHED" || !comparison?.original) return;
    if (!window.confirm(t("用第 {number} 件的正面原图（不经过 AI，不抠图）作为白底展示图，并确认本件？", { number: product.batchItemNumber ?? "-" }))) return;
    setBusy(`original-${product.id}`);
    setError("");
    setNotice("");
    try {
      const job = await request<ImageProcessingJobRecord>(
        `/products/${product.id}/images/${comparison.original.imageId}/use-original-display`, { method: "POST", body: "{}" }
      );
      if (job.status !== "SUCCEEDED" || !job.outputImageId) throw new Error(job.errorMessage || t("无法改用原图，请重试。"));
      await request(
        profile && detailReady(product) ? `/product-detail-profiles/${encodeURIComponent(profile.id)}/main-image` : `/products/${product.id}/display-image-selection`, {
          method: "POST", body: JSON.stringify({ imageId: job.outputImageId, humanConfirmed: true })
        }
      );
      // Sales details wait for a display image; one that failed with it is retried now.
      if (profile?.status === "FAILED") {
        await request(`/operations/product-batches/${batch!.id}/detail-generation/retry-failed`, {
          method: "POST", headers: { "X-Admin-User-Id": ids.adminUserId }, body: JSON.stringify({})
        }).catch(() => undefined);
      }
      setNotice(t("已改用原图作为展示图，本件已确认。"));
      moveToNextPending(product.id);
      await load();
    } catch (caught) {
      await load().catch(() => undefined);
      setError(errorMessage(caught, t("无法改用原图，请重试。")));
    } finally {
      setBusy("");
    }
  }

  // Escape for one item: reject only this garment so the rest of the batch can go on.
  async function rejectThisItem(product: ProductRecord) {
    if (product.status !== "CALIBRATED") return;
    const reason = window.prompt(
      t("单独拒绝第 {number} 件？它会移到“已拒绝”列表（以后可恢复），本批其余衣服继续。请填写原因：", { number: product.batchItemNumber ?? "-" }),
      t("白底展示图无法生成")
    );
    if (reason === null) return;
    if (!reason.trim()) {
      setError(t("请填写拒绝原因。"));
      return;
    }
    setBusy(`reject-${product.id}`);
    setError("");
    setNotice("");
    try {
      await request(`/operations/product-batches/products/${product.id}/reject-at-display-review`, {
        method: "POST", body: JSON.stringify({ reason: reason.trim() })
      });
      setNotice(t("第 {number} 件已单独拒绝，本批其余衣服可以继续。", { number: product.batchItemNumber ?? "-" }));
      moveToNextPending(product.id);
      await load();
    } catch (caught) {
      await load().catch(() => undefined);
      setError(errorMessage(caught, t("无法拒绝这件，请重试。")));
    } finally {
      setBusy("");
    }
  }

  async function moveBatchToShelf() {
    if (!batch) return;
    const shelf = shelves.find((candidate) => candidate.id === shelfId);
    if (!shelf) return;
    if (!window.confirm(t("把本批还在仓库里的衣服整批改到货架 {locationCode}？系统改完后，请把实物也搬过去。", { locationCode: shelf.locationCode }))) return;
    setBusy("move-shelf");
    setError("");
    setNotice("");
    try {
      const result = await request<{ moved: number }>(`/operations/product-batches/${batch.id}/shelf`, {
        method: "POST",
        body: JSON.stringify({ ...ids, locationId: shelf.id })
      });
      await load();
      setNotice(t("已把 {count} 件改到货架 {locationCode}。", { count: result.moved, locationCode: shelf.locationCode }));
    } catch (caught) {
      setError(errorMessage(caught, t("无法更换货架。")));
    } finally {
      setBusy("");
    }
  }

  async function markPrinted(products: ProductRecord[]) {
    if (!batch) return;
    if (products.length === activeProducts.length) {
      await request(`/operations/product-batches/${batch.id}/mark-labels-printed`, {
        method: "POST",
        body: JSON.stringify(ids)
      });
    } else {
      await request("/operations/product-control/labels/printed", {
        method: "POST",
        body: JSON.stringify({ ...ids, productIds: products.map((product) => product.id) })
      });
    }
    await load();
  }

  async function confirmPlacedAndPublish() {
    if (!batch) return;
    if (!window.confirm(t("Have all items been placed in their assigned shelf locations?\n\n请确认本批 {targetCount} 件已贴好标签并按货架位放好；继续后将入仓并发布。", { targetCount: activeProducts.length }))) return;
    setBusy("publish");
    setError("");
    setNotice("");
    try {
      await request(`/operations/product-batches/${batch.id}/complete-and-publish`, {
        method: "POST",
        body: JSON.stringify(ids)
      });
      await load();
      setNotice(t("本批 {targetCount} 件已完成入仓并发布。", { targetCount: activeProducts.length }));
    } catch (caught) {
      await load().catch(() => undefined);
      setError(errorMessage(caught, t("无法完成入仓与发布。已完成的动作会保留，可修复后继续。")));
    } finally {
      setBusy("");
    }
  }

  if (!batch) return <StatusMessage tone={error ? "danger" : "neutral"}>{error || t("正在读取打印与归位工作台...")}</StatusMessage>;

  // Rejected items need no barcode, shelf, label or publishing.
  const activeCount = activeProducts.length;
  const rejectedCount = batch.products.length - activeCount;
  const barcodeCount = activeProducts.filter((product) => product.barcode).length;
  const locationCount = activeProducts.filter((product) => product.inventoryItem?.location?.locationCode).length;
  const printedCount = activeProducts.filter((product) => product.labelPrintedAt).length;
  const publishedCount = activeProducts.filter((product) => product.status === "PUBLISHED").length;
  const allCalibrated = activeProducts.every((product) => product.status === "CALIBRATED");
  const allBarcodesReady = activeCount > 0 && barcodeCount === activeCount;
  const allLocationsReady = activeCount > 0 && locationCount === activeCount;
  const allPrinted = activeCount > 0 && printedCount === activeCount;
  const readyToPublish = allBarcodesReady && allLocationsReady && allPrinted && allAiDisplaysReady && allDisplaysConfirmed;
  const shelfGroups = groupProductsByShelf(activeProducts);

  if (publishedCount < activeCount && (reviewMode || !allDisplaysConfirmed || !allDetailsReady)) {
    const product = batch.products[Math.min(reviewIndex, batch.products.length - 1)];
    const comparison = product ? comparisons[product.id] : undefined;
    const confirmedCount = batch.products.filter((item) => item.status === "PUBLISHED" || isRejected(item) || displayConfirmed(comparisons[item.id])).length;
    const method = displayMethod(comparison);
    const failedJob = comparison?.aiDisplayMain ? null : latestFailedDisplayJob(comparison);
    const itemBusy = Boolean(busy);
    return <div className="flex min-w-0 flex-col gap-5">
      <header>
        <Link href={`/product/calibration?batchId=${encodeURIComponent(batch.id)}`} className="text-sm text-muted-foreground">{t("返回商品信息校准")}</Link>
        <h1 className="mt-2 text-2xl font-semibold">{batch.batchCode}  {t("· 第 4 步：白底展示图审核")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("逐件对照原图检查颜色、图案、品牌标、衣服结构和瑕疵。图片不符时重新生成；全部确认后才能打印入仓。")}</p>
      </header>
      {error ? <StatusMessage tone="danger">{error}</StatusMessage> : null}
      {notice ? <StatusMessage tone="neutral">{notice}</StatusMessage> : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Badge variant="outline">{t("已确认")} {confirmedCount}/{batch.targetCount}  {t("件")}</Badge>
        <Button disabled={Boolean(busy)} variant="outline" onClick={() => void load().catch((caught) => setError(errorMessage(caught, t("刷新失败"))))}>{t("刷新进度")}</Button>
      </div>
      <nav className="flex flex-wrap gap-2" aria-label={t("选择待审核商品")}>
        {batch.products.map((item, index) => <Button key={item.id} variant={index === reviewIndex ? "default" : "outline"} disabled={Boolean(busy)} onClick={() => setReviewIndex(index)}>
          
          {t("第")} {item.batchItemNumber ?? index + 1}  {t("件")}{isRejected(item) ? t(" · 已拒绝") : item.status === "PUBLISHED" || displayConfirmed(comparisons[item.id]) ? t(" · 已确认") : t(" · 待审核")}
        </Button>)}
      </nav>
      {product ? <section className="rounded-md border p-4">
        <h2 className="mb-4 font-semibold">{product.title || product.productCode}</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <ReviewImage src={comparisonUrl(comparison?.original?.publicUrl)} label={t("正面原图")} />
          <ReviewImage src={comparisonUrl(comparison?.aiDisplayMain?.publicUrl)} label={t("白底展示图")} tag={method ? displayMethodLabel(method) : undefined} />
        </div>
        {isRejected(product) ? <p className="mt-4 text-sm">{t("本件已单独拒绝，不进入后续步骤；本批其余衣服照常继续。需要时可在“已拒绝”列表里恢复。")}</p> : product.status === "PUBLISHED" ? <p className="mt-4 text-sm">{t("本件已发布，无需重新审核。")}</p> : <>
          <p className="mt-4 text-sm text-muted-foreground">{t("确认展示图没有改变实物的颜色、Logo、图案、口袋、纽扣、拉链、面料、磨损或瑕疵。点击图片可放大检查。")}</p>
          {failedJob ? <div className="mt-4"><StatusMessage tone="danger">
            {t("白底展示图生成失败：{message}", { message: failedJob.errorMessage || failedJob.failureCode || t("未知原因") })}
            <span className="mt-1 block">{t("可以“重新生成”；也可以“用原图”或“单独拒绝这件”，不影响本批其余衣服。")}</span>
          </StatusMessage></div> : null}
          <div className="mt-4 flex flex-wrap gap-3">
            <Button variant="outline" disabled={itemBusy || !comparison?.original} onClick={() => void reviewDisplay(product, true)}>
              {busy === `regenerate-${product.id}` ? <LoaderCircleIcon className="animate-spin" /> : <RefreshCwIcon />}{t("不满意，重新生成")}
            </Button>
            <Button disabled={itemBusy || !comparison?.aiDisplayMain || displayConfirmed(comparison)} onClick={() => void reviewDisplay(product, false)}>
              <CheckCircle2Icon />{displayConfirmed(comparison) ? t("本件已确认") : t("图片正确，确认本件")}
            </Button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3 border-t pt-3">
            <span className="text-xs text-muted-foreground">{t("这一件卡住时：")}</span>
            <Button size="sm" variant="outline" disabled={itemBusy || !comparison?.original || (displayConfirmed(comparison) && method === "ORIGINAL")} onClick={() => void useOriginalPhoto(product)}>
              {busy === `original-${product.id}` ? <LoaderCircleIcon className="animate-spin" /> : <ImageIcon />}{t("用原图")}
            </Button>
            {product.status === "CALIBRATED" ? <Button size="sm" variant="outline" className="text-destructive" disabled={itemBusy} onClick={() => void rejectThisItem(product)}>
              {busy === `reject-${product.id}` ? <LoaderCircleIcon className="animate-spin" /> : <XCircleIcon />}{t("单独拒绝这件")}
            </Button> : null}
          </div>
          {!detailReady(product) || !comparison?.aiDisplayMain ? <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            <span>{t("未完成的展示图或销售详情正在后台处理，完成后自动更新；已有图片可以先审核。")}</span>
            <Button variant="outline" disabled={Boolean(busy)} onClick={() => void rerunDetails()}>{t("重试未完成生成")}</Button>
          </div> : null}
        </>}
      </section> : null}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-4">
        <p className="text-sm">
          {allDisplaysConfirmed ? (allDetailsReady ? t("全部展示图已确认，可以继续。") : t("展示图已全部确认，销售详情仍在后台生成。")) : t("还有 {v0} 件展示图待确认。", { v0: batch.targetCount - confirmedCount })}
          {rejectedCount > 0 ? <span className="ml-1 text-muted-foreground">{t("（{count} 件已单独拒绝，不再处理）", { count: rejectedCount })}</span> : null}
        </p>
        <div className="flex flex-wrap items-end gap-3">
          {!allLocationsReady ? <ShelfPicker shelves={shelves} value={shelfId} needed={activeCount - locationCount} onChange={setShelfId} /> : null}
          <Button disabled={Boolean(busy) || !allDisplaysConfirmed || !allDetailsReady || (!allLocationsReady && !shelfId)} onClick={() => void generateBarcodesAndLocations()}>{t("继续：生成标签、打印入仓")}</Button>
        </div>
      </div>
    </div>;
  }

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Link href={`/product/batches/${encodeURIComponent(batch.id)}`} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><ArrowLeftIcon className="size-3" />{t("返回批次")}</Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-normal">{batch.batchCode}  {t("· 第 5 步：打印、归位并发布")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("展示图已逐件确认。现在打印标签，按货架位归位后确认发布。")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild><a href={PRINT_AGENT_DOWNLOAD_URL} download="direct-loop-print-agent.zip">{t("下载打印代理（Windows）")}</a></Button>
          <Button variant="outline" asChild><a href={MACOS_PRINT_AGENT_DOWNLOAD_URL} download="direct-loop-print-agent-macos.zip">{t("下载打印代理（Mac）")}</a></Button>
          {publishedCount < activeCount ? (
            <Button variant="outline" asChild><Link href={`/product/display-review?batchId=${encodeURIComponent(batch.id)}`}><AlertTriangleIcon data-icon="inline-start" />{t("返回展示图审核")}</Link></Button>
          ) : null}
        </div>
      </header>

      <div className="grid grid-cols-3 gap-2">
        <ProgressMetric label="Barcode" value={barcodeCount} total={activeCount} />
        <ProgressMetric label={t("货架位")} value={locationCount} total={activeCount} />
        <ProgressMetric label={t("已贴标")} value={printedCount} total={activeCount} />
      </div>
      {rejectedCount > 0 ? <p className="text-xs text-muted-foreground">{t("本批有 {count} 件在展示图审核时单独拒绝，不打印、不入仓、不发布。", { count: rejectedCount })}</p> : null}
      {error ? <StatusMessage tone="danger">{error}</StatusMessage> : null}
      {notice ? <StatusMessage tone="neutral">{notice}</StatusMessage> : null}

      {!allBarcodesReady || !allLocationsReady ? (
        <section className="rounded-md border p-4">
          <h2 className="font-semibold">{t("生成 Barcode 并预留货架位")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("先选这一批要放的货架。系统生成 Barcode 后，整批衣服都放在这个货架上。")}</p>
          <div className="mt-4 flex flex-wrap items-end gap-3">
          <ShelfPicker shelves={shelves} value={shelfId} needed={activeCount - locationCount} onChange={setShelfId} />
          <Button disabled={Boolean(busy) || !shelfId || (!allCalibrated && barcodeCount === 0)} onClick={() => void generateBarcodesAndLocations()}>
            {busy === "generate" ? <LoaderCircleIcon className="animate-spin" data-icon="inline-start" /> : <BarcodeIcon data-icon="inline-start" />}
            
            {t("生成 Barcode 与货架位")}
          </Button>
          </div>
        </section>
      ) : null}

      {printIndex !== null && allBarcodesReady && allLocationsReady && allDisplaysConfirmed ? <ProductLabelPrinter products={activeProducts} initialIndex={printIndex} onClose={() => setPrintIndex(null)} onConfirm={products => markPrinted(products as ProductRecord[])} /> : null}

      {allBarcodesReady ? (
        <>
          <section className="flex flex-col gap-3 rounded-md border p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="font-semibold">{t("打印并按大号货架位归位")}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{t("模板")} {DEFAULT_LABEL_SIZE}  {t("mm · Deli DL-720C · Barcode、尺码和货架位同时打印。")}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button disabled={Boolean(busy) || !allLocationsReady || !allDisplaysConfirmed} onClick={() => setPrintIndex(0)}><PrinterIcon data-icon="inline-start" />{t("打印标签 / 贴标确认")}</Button>
            </div>
          </section>

          {allLocationsReady ? (
            <section className="flex flex-col gap-4 rounded-md border p-4">
              <div>
                <h2 className="font-semibold">{t("按货架位分组摆放")}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{t("本批整批放在同一个货架。请按清单完成摆放，然后一次性确认入库。")}</p>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <ShelfPicker label={t("整批换到别的货架")} shelves={shelves} value={shelfId} needed={0} onChange={setShelfId} />
                <Button variant="outline" disabled={Boolean(busy) || !shelfId || shelfGroups.every((group) => shelves.find((shelf) => shelf.id === shelfId)?.locationCode === group.locationCode)} onClick={() => void moveBatchToShelf()}>
                  {busy === "move-shelf" ? <LoaderCircleIcon className="animate-spin" data-icon="inline-start" /> : <MapPinIcon data-icon="inline-start" />}
                  {t("整批换货架")}
                </Button>
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                {shelfGroups.map((group) => (
                  <div key={group.locationCode} className="rounded-md border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="font-semibold">{group.locationCode}</h3>
                      <Badge variant="outline">{group.beforeCount}/{group.capacity}  {t("→ 本批放")} {group.products.length}  {t("件")}</Badge>
                    </div>
                    <div className="mt-3 flex flex-col gap-2">
                      {group.products.map((product) => {
                        const imageUrl = comparisonUrl(comparisons[product.id]?.original?.publicUrl);
                        return <div key={product.id} className="flex items-center gap-3 rounded-md bg-muted/40 p-2">{imageUrl ? <img src={imageUrl} alt={product.title ?? product.productCode} className="size-12 rounded object-contain" /> : <div className="size-12 rounded bg-background" />}<div className="min-w-0"><p className="truncate text-sm font-medium">{product.title ?? product.productCode}</p><p className="truncate font-mono text-xs text-muted-foreground">{product.barcode}</p></div></div>;
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 print:grid-cols-2">
            {activeProducts.map((product) => (
              <LabelPreview
                key={product.id}
                batchCode={batch.batchCode}
                product={product}
                comparison={comparisons[product.id]}
                targetCount={batch.targetCount}
                disabled={Boolean(busy)}
                onPrint={() => setPrintIndex(activeProducts.findIndex(item => item.id === product.id))}
              />
            ))}
          </section>

          {!allAiDisplaysReady ? (
            <StatusMessage tone="neutral">
              <span className="flex flex-wrap items-center justify-between gap-3">
                <span className="flex items-center gap-2"><LoaderCircleIcon className="size-4 animate-spin" />{t("白底展示图与详情仍在生成，完成后本页自动更新。")}</span>
                <Button size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void rerunDetails()}><RefreshCwIcon data-icon="inline-start" />{t("补生成")}</Button>
              </span>
            </StatusMessage>
          ) : null}

          {publishedCount < activeCount ? (
            <section className="rounded-md border p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="font-semibold">{t("最后一次批量确认")}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">{t("确认标签已贴、衣服已按货架号放好；展示图审核已在上一步完成。")}</p>
                </div>
                <Button disabled={Boolean(busy) || !readyToPublish} onClick={() => void confirmPlacedAndPublish()}>
                  {busy === "publish" ? <LoaderCircleIcon className="animate-spin" data-icon="inline-start" /> : <PackageCheckIcon data-icon="inline-start" />}
                  
                  {t("Confirm all items stored · 入仓并发布")}
                </Button>
              </div>
              {!readyToPublish ? <p className="mt-3 text-xs text-muted-foreground">{t("还需完成：")}{pendingLabels({ allLocationsReady, allPrinted, allAiDisplaysReady }).join("、")}。</p> : null}
            </section>
          ) : (
            <StatusMessage tone="neutral"><span className="flex items-center gap-2"><CheckCircle2Icon className="size-4 text-emerald-600" />{t("本批已全部入仓并发布。")}</span></StatusMessage>
          )}
        </>
      ) : null}
    </div>
  );
}

function LabelPreview(props: {
  batchCode: string;
  product: ProductRecord;
  comparison?: ProductImageComparisonResponse;
  targetCount: number;
  disabled: boolean;
  onPrint: () => void;
}) {
  const assignedLocationCode = props.product.inventoryItem?.location?.locationCode;
  const locationCode = assignedLocationCode || t("待分配");
  const whiteUrl = comparisonUrl(props.comparison?.original?.publicUrl);
  const aiUrl = comparisonUrl(props.comparison?.aiDisplayMain?.publicUrl);
  return (
    <article className={cn("overflow-hidden rounded-md border bg-white text-black", props.product.labelPrintedAt && "border-emerald-500")}>
      <div className="grid grid-cols-[112px_1fr] gap-3 p-3">
        <div className="grid grid-rows-2 gap-1 print:hidden">
          <ProductThumb src={whiteUrl} alt={t("{productCode} 正面原图", { productCode: props.product.productCode })} label={t("原图")} />
          <ProductThumb src={aiUrl} alt={t("{productCode} 白底展示图", { productCode: props.product.productCode })} label={t("展示图")} />
        </div>
        <div className="min-w-0">
          <div className="flex items-start justify-between gap-2 text-xs">
            <span className="font-semibold">{props.batchCode}</span>
            <span>{t("第")} {props.product.batchItemNumber ?? "-"}/{props.targetCount}  {t("件")}</span>
          </div>
          <div className="mt-1 truncate text-sm font-semibold">{shortTitle(props.product.title || props.product.productCode)}</div>
          <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><MapPinIcon className="size-4" />{t("货架位")}</div>
          <div className="mt-1 text-3xl font-bold tracking-tight tabular-nums">{locationCode}</div>
          <BarcodeGraphic value={props.product.barcode || ""} />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t px-3 py-2 text-xs print:hidden">
        <Badge variant={props.product.labelPrintedAt ? "default" : "outline"}>
          {props.product.labelPrintedAt ? t("已贴标") : productStatusLabel(props.product.status)}
        </Badge>
        <Button size="sm" variant="ghost" disabled={props.disabled || !assignedLocationCode} onClick={props.onPrint}><PrinterIcon data-icon="inline-start" />{t("单张打印")}</Button>
      </div>
    </article>
  );
}

function ProductThumb({ src, alt, label }: { src: string; alt: string; label: string }) {
  return (
    <div className="relative flex min-h-24 items-center justify-center overflow-hidden rounded border bg-white">
      {src ? <img src={src} alt={alt} className="size-full object-contain" /> : <span className="text-xs text-muted-foreground">{t("生成中")}</span>}
      <span className="absolute bottom-1 left-1 rounded bg-white/90 px-1 text-[10px] text-muted-foreground">{label}</span>
    </div>
  );
}

function BarcodeGraphic({ value }: { value: string }) {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (!ref.current || !value) return;
    JsBarcode(ref.current, value, { format: "CODE128", displayValue: true, fontSize: 12, height: 42, margin: 0, width: 1.5 });
  }, [value]);
  return value ? <svg ref={ref} className="mt-3 h-16 w-full" aria-label={`Barcode ${value}`} /> : <div className="mt-4 text-center text-xs text-red-600">{t("Barcode 未生成")}</div>;
}

function ShelfPicker({ shelves, value, needed, onChange, label }: {
  shelves: Shelf[];
  value: string;
  needed: number;
  onChange: (shelfId: string) => void;
  label?: string;
}) {
  return <label className="flex flex-col gap-1 text-sm">
    <span className="text-muted-foreground">{label ?? t("放到哪个货架")}</span>
    <NativeSelect value={value} onChange={(event) => onChange(event.target.value)}>
      <NativeSelectOption value="">{t("请选择货架")}</NativeSelectOption>
      {shelves.map((shelf) => (
        <NativeSelectOption key={shelf.id} value={shelf.id} disabled={shelf.remainingCapacity < needed}>
          {t("{locationCode}（已放 {count}/{capacity} 件）", { locationCode: shelf.locationCode, count: shelf.currentItemCount, capacity: shelf.capacity })}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  </label>;
}

function ProgressMetric({ label, value, total }: { label: string; value: number; total: number }) {
  return <div className="rounded-md border p-3 text-center"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 text-xl font-semibold tabular-nums">{value}/{total}</div></div>;
}

function StatusMessage({ tone, children }: { tone: "danger" | "neutral"; children: ReactNode }) {
  return <div className={cn("rounded-md border px-4 py-3 text-sm", tone === "danger" ? "border-destructive/40 bg-destructive/5 text-destructive" : "bg-muted/40 text-muted-foreground")}>{children}</div>;
}

function pendingLabels(input: { allLocationsReady: boolean; allPrinted: boolean; allAiDisplaysReady: boolean }) {
  const pending = [];
  if (!input.allLocationsReady) pending.push(t("货架位分配"));
  if (!input.allPrinted) pending.push(t("标签打印"));
  if (!input.allAiDisplaysReady) pending.push(t("白底展示图生成"));
  return pending;
}

function groupProductsByShelf(products: ProductRecord[]) {
  const groups = new Map<string, { locationCode: string; capacity: number; currentCount: number; products: ProductRecord[] }>();
  for (const product of products) {
    const location = product.inventoryItem?.location;
    const locationCode = location?.locationCode;
    if (!locationCode) continue;
    const group = groups.get(locationCode) ?? {
      locationCode,
      capacity: Number(location.capacity ?? 0),
      currentCount: Number(location._count?.inventoryItems ?? 0),
      products: []
    };
    group.products.push(product);
    groups.set(locationCode, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    beforeCount: Math.max(0, group.currentCount - group.products.length)
  }));
}

function comparisonUrl(value?: string | null) {
  return value ? `${API_PROXY_URL}${value}` : "";
}

function shortTitle(value: string) {
  const clean = value.trim();
  return clean.length > 36 ? `${clean.slice(0, 33)}...` : clean;
}

function translateApiError(value: string) {
  const translations: Array<[RegExp, string]> = [
    [/Print the label/i, t("请先完成标签打印。")],
    [/must be approved/i, t("本批商品必须全部确认通过。")],
    [/complete storage/i, t("请先按货架号完成归位。")]
  ];
  return translations.find(([pattern]) => pattern.test(value))?.[1] ?? value;
}

function errorMessage(value: unknown, fallback: string) {
  return value instanceof Error ? value.message : fallback;
}

function displayConfirmed(comparison?: ProductImageComparisonResponse) {
  return Boolean(comparison?.aiDisplayMain && comparison.selectedMainImageId === comparison.aiDisplayMain.imageId && comparison.selectedMainImageConfirmedAt);
}

function detailReady(product: ProductRecord) {
  const profile = product.detailProfiles?.[0];
  return Boolean(profile && profile.sourceDataVersion === product.detailSourceVersion && ["READY", "APPROVED"].includes(profile.status));
}

function ReviewImage({ src, label, tag }: { src: string; label: string; tag?: string }) {
  return <figure className="min-w-0 rounded-md border bg-white p-2">
    <figcaption className="mb-2 flex flex-wrap items-center justify-center gap-2 text-center text-sm font-medium text-black">
      {label}
      {tag ? <span className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-xs font-normal text-amber-800">{tag}</span> : null}
    </figcaption>
    {src ? <a href={src} target="_blank" rel="noreferrer" aria-label={t("放大{label}", { label: label })}><img src={src} alt={label} className="h-[min(55vh,520px)] w-full object-contain" /></a> : <div className="flex h-80 items-center justify-center text-sm text-gray-500">{t("图片尚未生成或加载失败，请刷新或重试")}</div>}
  </figure>;
}
