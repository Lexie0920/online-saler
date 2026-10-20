"use client";

import { operationsFetch } from "@/lib/operations-api";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowRightIcon,
  CheckCircle2Icon,
  CircleDotIcon,
  Clock3Icon,
  ExternalLinkIcon,
  ImageIcon,
  ListChecksIcon,
  PackageCheckIcon,
  PlusIcon,
  RefreshCwIcon,
  XCircleIcon
} from "lucide-react";

import { useOperationsSession } from "@/components/admin/operations-access-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { productStatusLabel } from "./product-factory-display";
import {
  PRODUCT_FACTORY_WORKFLOW_STAGE_LABELS,
  PRODUCT_FACTORY_WORKFLOW_STAGE_ORDER,
  batchNextActionHref,
  batchProductCalibrationHref,
  productFactoryWorkflowStage,
  productFactoryWorkflowStageIndex
} from "./product-factory-batch-display";
import {
  DEFAULT_PRODUCT_BATCH_SIZE,
  isAllowedProductBatchSize
} from "./product-factory-batch-size";
import { operationsFormatLocale, t } from "@/i18n/runtime";

const API_PROXY_URL = "/api-proxy";

type ProductBatchImagePreview = {
  imageId: string;
  variant: string;
  publicUrl: string;
  selectedAsMain: boolean;
};

type ProductRecord = Record<string, unknown> & {
  id: string;
  productCode: string;
  batchItemNumber?: number | null;
  status: string;
  barcode?: string | null;
  labelPrintedAt?: string | null;
  images?: Array<Record<string, unknown>>;
  imagePreviews?: ProductBatchImagePreview[];
  aiExtractions?: Array<Record<string, unknown>>;
  inventoryItem?: Record<string, unknown> | null;
};

type ProductBatch = {
  id: string;
  batchCode: string;
  status: string;
  targetCount: number;
  intakeCategory?: string | null;
  completedCount: number;
  createdByEmployeeId?: string | null;
  createdAt: string;
  updatedAt: string;
  stage: string;
  stageIndex: number;
  stageLabel: string;
  stageCompletedCount: number;
  nextAction: string;
  nextActionLabel: string;
  exceptionCount: number;
  detailGeneration: {
    eligibleCount: number;
    pendingCount: number;
    generatingCount: number;
    readyCount: number;
    failedCount: number;
    failedItemNumbers?: number[];
    outdatedCount: number;
    approvedCount: number;
    readyForPublish: boolean;
  };
  counts: Record<string, number>;
  products: ProductRecord[];
};

type BatchCancellationResult = {
  batchId: string;
  deletedCount: number;
  archivedCount: number;
  archivedProductCodes: string[];
  keptCount: number;
  releasedShelves: Array<{ productCode: string; locationCode: string | null; physicallyShelved: boolean }>;
};

type ProductSummary = {
  employeeId: string;
  metrics: {
    todayNewBatches: number;
    todayCompletedProducts: number;
    activeBatchCount: number;
    exceptionCount: number;
  };
  continueBatch: ProductBatch | null;
  activeBatches: ProductBatch[];
  tasks: {
    upload: number;
    aiImage: number;
    calibration: number;
    labelApply: number;
    review: number;
    storage: number;
  };
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
    throw new Error(message);
  }
  return body as T;
}

function useOperationIds() {
  const { session } = useOperationsSession();
  return useMemo(() => ({
    adminUserId: String(session?.adminUser?.id ?? ""),
    employeeId: String(session?.adminUser?.linkedEmployeeId ?? "")
  }), [session]);
}

async function loadSummary(ids: ReturnType<typeof useOperationIds>): Promise<ProductSummary> {
  const query = new URLSearchParams(ids);
  return request<ProductSummary>(`/operations/product-batches/summary?${query.toString()}`);
}

export function ProductWorkbenchPage() {
  const ids = useOperationIds();
  const { hasPermission } = useOperationsSession();
  const [summary, setSummary] = useState<ProductSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!ids.adminUserId) return;
    setBusy(true);
    setError("");
    try {
      setSummary(await loadSummary(ids));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("无法读取今日工作。 "));
    } finally {
      setBusy(false);
    }
  }, [ids]);

  useEffect(() => {
    void load();
  }, [load]);

  const metrics = summary?.metrics;
  const tasks = summary?.tasks;
  const continueBatch = summary?.continueBatch;
  const continueWorkflowIndex = continueBatch ? productFactoryWorkflowStageIndex(continueBatch.stage) : 0;
  const continueWorkflowStage = continueBatch ? productFactoryWorkflowStage(continueBatch.stage) : "CAPTURE";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={t("商品工厂")}
        title={t("今日工作")}
        description={t("三段完成上品：批量采集、商品信息识别、异常确认并发布。")}
        action={
          <Button asChild disabled={!hasPermission("action.product.create")}>
            <Link href="/product/new-batch"><PlusIcon data-icon="inline-start" />{t("新建批次")}</Link>
          </Button>
        }
      />
      {error ? <StatusMessage tone="danger">{error}</StatusMessage> : null}
      <section className="grid grid-cols-2 gap-3 xl:grid-cols-4" aria-label={t("今日指标")}>
        <Metric title={t("今日新建批次")} value={metrics?.todayNewBatches ?? 0} />
        <Metric title={t("今日完成商品")} value={metrics?.todayCompletedProducts ?? 0} />
        <Metric title={t("进行中批次")} value={metrics?.activeBatchCount ?? 0} />
        <Metric title={t("待处理异常")} value={metrics?.exceptionCount ?? 0} tone={metrics?.exceptionCount ? "danger" : "default"} />
      </section>

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,.6fr)]">
        <Card>
          <CardHeader>
            <CardTitle>{t("继续工作")}</CardTitle>
            <CardDescription>{t("系统只显示当前批次此刻允许执行的下一步。")}</CardDescription>
          </CardHeader>
          <CardContent>
            {continueBatch ? (
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-semibold">{continueBatch.batchCode}</span>
                    <StageBadge stage={continueBatch.stage} label={t(PRODUCT_FACTORY_WORKFLOW_STAGE_LABELS[continueWorkflowStage])} />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    
                    {t("当前阶段")} {Math.min(continueWorkflowIndex + 1, 3)}{t("/3，当前任务：")}{continueBatch.nextActionLabel}
                  </p>
                  <ProgressBar value={Math.min(continueWorkflowIndex + 1, 3)} max={3} />
                </div>
                <Button asChild className="w-full shrink-0 sm:w-auto">
                  <Link href={`/product/batches/${continueBatch.id}`}>{t("继续本批次")}<ArrowRightIcon data-icon="inline-end" /></Link>
                </Button>
              </div>
            ) : (
              <EmptyState title={t("没有进行中的批次")} description={t("新建批次后，下一步会出现在这里。")} action={<Button asChild><Link href="/product/new-batch">{t("新建批次")}</Link></Button>} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("待处理异常")}</CardTitle>
            <CardDescription>{t("退回返工和处理失败的商品集中在这里。")}</CardDescription>
          </CardHeader>
          <CardContent className="flex items-center justify-between gap-4">
            <div>
              <div className="text-3xl font-semibold tabular-nums">{metrics?.exceptionCount ?? 0}</div>
              <p className="text-sm text-muted-foreground">{t("件需要处理")}</p>
            </div>
            <Button asChild variant="outline"><Link href="/product/exceptions">{t("查看异常")}</Link></Button>
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>{t("今日任务")}</CardTitle>
          <CardDescription>{t("员工只需要跟随 3 个阶段；内部子步骤由系统自动衔接。")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-3">
          <TaskRow label={t("1. 批量采集")} value={tasks?.upload ?? 0} href="/product/waiting-upload" />
          <TaskRow label={t("2. 商品信息识别")} value={tasks?.aiImage ?? 0} href="/product/waiting-ai" />
          <TaskRow
            label={t("3. 异常确认并发布")}
            value={(tasks?.calibration ?? 0) + (tasks?.labelApply ?? 0) + (tasks?.review ?? 0) + (tasks?.storage ?? 0)}
            href="/product/batches"
          />
        </CardContent>
      </Card>
    </div>
  );
}

export function NewBatchPage() {
  const ids = useOperationIds();
  const router = useRouter();
  const { hasPermission } = useOperationsSession();
  const [note, setNote] = useState("");
  const [intakeCategory, setIntakeCategory] = useState<"" | "SHOES">("");
  const unit = intakeCategory === "SHOES" ? t("双") : t("件");
  const [quantity, setQuantity] = useState(String(DEFAULT_PRODUCT_BATCH_SIZE));
  const targetCount = Number(quantity);
  const validCount = /^\d+$/.test(quantity) && isAllowedProductBatchSize(targetCount);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function createBatch() {
    if (!validCount) {
      setError(t("请输入大于 0 的整数数量。"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const batch = await request<ProductBatch>("/operations/product-batches", {
        method: "POST",
        body: JSON.stringify({ ...ids, targetCount, note: note.trim() || undefined, intakeCategory: intakeCategory || null })
      });
      router.push(`/product/batches/${batch.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("无法创建批次。 "));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <PageHeader
        eyebrow={t("商品工厂")}
        title={t("新建批次")}
        description={t("输入本批商品数量。先集中拍照，再坐下批量上传。")}
      />
      {error ? <StatusMessage tone="danger">{error}</StatusMessage> : null}
      <Card>
        <CardHeader>
          <CardTitle>{validCount ? `${targetCount} ${unit}` : ""}{intakeCategory === "SHOES" ? t("鞋类") : t("商品")}{t("批次")}</CardTitle>
          <CardDescription>{t("系统会按填写的数量生成有顺序的商品位置，正式 Barcode 在全部校准完成后生成。")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="batch-intake-category">{t("本批录入类型")}</FieldLabel>
              <NativeSelect id="batch-intake-category" value={intakeCategory} disabled={busy} onChange={(event) => setIntakeCategory(event.target.value === "SHOES" ? "SHOES" : "")}>
                <NativeSelectOption value="">{t("服装 / 其他商品")}</NativeSelectOption>
                <NativeSelectOption value="SHOES">{t("鞋类 · 一双一个商品")}</NativeSelectOption>
              </NativeSelect>
              <FieldDescription>{intakeCategory === "SHOES" ? t("保持左右鞋配对，按顺序编号。每双拍整双、侧面、鞋底和尺码标签，瑕疵另补图。") : t("按顺序编号摆放，在干净背景上拍清楚整件服装即可，无需测量板；尺码稍后人工填写。")}</FieldDescription>
            </Field>
          </FieldGroup>
          <Field>
            <FieldLabel htmlFor="batch-quantity">{t("批次数量（")}{unit}）</FieldLabel>
            <Input
              id="batch-quantity"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={quantity}
              disabled={busy}
              aria-invalid={!validCount}
              aria-describedby="batch-quantity-help"
              onChange={(event) => setQuantity(event.target.value)}
            />
            <FieldDescription id="batch-quantity-help">
              {validCount ? t("输入本批实际上传的商品数量，至少 1 件；鞋类一双计一个商品。") : t("请输入大于 0 的整数数量。")}
            </FieldDescription>
          </Field>
          <label className="block space-y-2 text-sm font-medium">
            
            {t("批次备注（可选）")}
            <textarea
              className="mt-2 min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={note}
              maxLength={200}
              placeholder={intakeCategory === "SHOES" ? t("例如：上午成人鞋选货") : t("例如：上午女装选货")}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button asChild variant="outline"><Link href="/">{t("取消")}</Link></Button>
            <Button disabled={busy || !validCount || !hasPermission("action.product.create")} onClick={() => void createBatch()}>
              <PlusIcon data-icon="inline-start" />{busy ? t("创建中") : t("创建并开始上传")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function ProductBatchListPage({ completed = false }: { completed?: boolean }) {
  const ids = useOperationIds();
  const { hasPermission } = useOperationsSession();
  const [batches, setBatches] = useState<ProductBatch[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cancelTarget, setCancelTarget] = useState<ProductBatch | null>(null);
  const [notice, setNotice] = useState<BatchCancellationResult & { batchCode: string } | null>(null);
  const canCancel = !completed && hasPermission("action.product.approve");

  const load = useCallback(async () => {
    if (!ids.adminUserId) return;
    setBusy(true);
    setError("");
    try {
      const query = new URLSearchParams({ ...ids, status: completed ? "COMPLETED" : "OPEN" });
      setBatches(await request<ProductBatch[]>(`/operations/product-batches?${query.toString()}`));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("无法读取批次。 "));
    } finally {
      setBusy(false);
    }
  }, [completed, ids]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={t("商品工厂")}
        title={completed ? t("已完成") : t("进行中批次")}
        description={completed ? t("查询已完成的商品批次。") : t("从批次进入当前合法步骤，不在列表页暴露跨阶段操作。")}
        action={completed ? undefined : <Button asChild><Link href="/product/new-batch"><PlusIcon data-icon="inline-start" />{t("新建批次")}</Link></Button>}
      />
      {error ? <StatusMessage tone="danger">{error}</StatusMessage> : null}
      {notice ? <BatchCancelledNotice result={notice} onDismiss={() => setNotice(null)} /> : null}
      {busy && batches.length === 0 ? <StatusMessage tone="neutral">{t("正在读取批次...")}</StatusMessage> : null}
      <div className="space-y-3">
        {batches.map((batch) => <BatchRow key={batch.id} batch={batch} onCancel={canCancel ? () => setCancelTarget(batch) : undefined} />)}
        {!busy && batches.length === 0 ? <EmptyState title={completed ? t("还没有已完成批次") : t("没有进行中的批次")} description={completed ? t("完整发布或归档的批次会显示在这里。") : t("新建批次后会显示在这里。")} /> : null}
      </div>
      <CancelBatchDialog
        batch={cancelTarget}
        ids={ids}
        onOpenChange={(open) => { if (!open) setCancelTarget(null); }}
        onCancelled={(result, batch) => {
          setCancelTarget(null);
          setNotice({ ...result, batchCode: batch.batchCode });
          void load();
        }}
      />
    </div>
  );
}

function CancelBatchDialog({
  batch,
  ids,
  onOpenChange,
  onCancelled
}: {
  batch: ProductBatch | null;
  ids: ReturnType<typeof useOperationIds>;
  onOpenChange: (open: boolean) => void;
  onCancelled: (result: BatchCancellationResult, batch: ProductBatch) => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The API decides what is deleted and what is kept (it knows which items are on an order).
  const [preview, setPreview] = useState<BatchCancellationResult | null>(null);

  useEffect(() => {
    setReason("");
    setError("");
    setPreview(null);
    if (!batch) return;
    let cancelled = false;
    request<BatchCancellationResult>(`/operations/product-batches/${batch.id}/cancel`, {
      method: "POST",
      body: JSON.stringify({ ...ids, dryRun: true })
    }).then((result) => { if (!cancelled) setPreview(result); })
      .catch((caught) => { if (!cancelled) setError(caught instanceof Error ? caught.message : t("取消批次失败。")); });
    return () => { cancelled = true; };
  }, [batch, ids]);

  async function confirm() {
    if (!batch) return;
    if (!reason.trim()) {
      setError(t("请填写取消原因。"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await request<BatchCancellationResult>(`/operations/product-batches/${batch.id}/cancel`, {
        method: "POST",
        body: JSON.stringify({ ...ids, reason: reason.trim() })
      });
      onCancelled(result, batch);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("取消批次失败。"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={Boolean(batch)} onOpenChange={(open) => { if (!busy) onOpenChange(open); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("取消批次 {batchCode}", { batchCode: batch?.batchCode ?? "" })}</DialogTitle>
          <DialogDescription>{t("取消后这批就当没录过，此操作不能撤销。")}</DialogDescription>
        </DialogHeader>
        {preview ? <ul className="space-y-1.5 rounded-md border bg-muted/30 p-3 text-sm">
          <li className="font-medium text-destructive">{t("这批里 {count} 件未上架商品会被永久删除，就当没录过", { count: preview.deletedCount })}</li>
          {preview.archivedCount ? <li>
            {t("{count} 件关联过顾客订单，不删除，改为已拒绝：", { count: preview.archivedCount })}
            <span className="font-mono text-xs"> {preview.archivedProductCodes.join(", ")}</span>
          </li> : null}
          {preview.keptCount ? <li>{t("{count} 件已上架或已拒绝的商品保持不变", { count: preview.keptCount })}</li> : null}
          {preview.releasedShelves.length ? <li>{t("{count} 个已预留的货架位将被释放", { count: preview.releasedShelves.length })}</li> : null}
        </ul> : !error ? <p className="text-muted-foreground text-sm">{t("正在读取…")}</p> : null}
        <Field>
          <FieldLabel htmlFor="cancel-batch-reason">{t("取消原因")}</FieldLabel>
          <Textarea
            id="cancel-batch-reason"
            rows={3}
            value={reason}
            placeholder={t("例如：测试批次 / 录错数量 / 货品退回供应商")}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
        {error ? <StatusMessage tone="danger">{error}</StatusMessage> : null}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>{t("返回")}</Button>
          <Button variant="destructive" disabled={busy || !preview || !reason.trim()} onClick={() => void confirm()}>
            {busy ? t("正在取消…") : t("取消批次并删除 {count} 件", { count: preview?.deletedCount ?? 0 })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BatchCancelledNotice({ result, onDismiss }: { result: BatchCancellationResult & { batchCode: string }; onDismiss: () => void }) {
  const toTakeDown = result.releasedShelves.filter((shelf) => shelf.physicallyShelved);
  return (
    <div className="rounded-md border bg-muted/40 px-4 py-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <p>{t("已取消批次 {batchCode}：永久删除 {deleted} 件，{archived} 件因关联订单改为已拒绝，释放 {released} 个货架位。", {
          batchCode: result.batchCode,
          deleted: result.deletedCount,
          archived: result.archivedCount,
          released: result.releasedShelves.length
        })}</p>
        <Button size="sm" variant="ghost" onClick={onDismiss}>{t("关闭")}</Button>
      </div>
      {toTakeDown.length ? (
        <div className="mt-2 text-destructive">
          <p className="font-medium">{t("以下商品已经放上货架，请把实物取下：")}</p>
          <ul className="mt-1 list-disc pl-5">
            {toTakeDown.map((shelf) => <li key={shelf.productCode}>{shelf.locationCode ?? "-"} · {shelf.productCode}</li>)}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function ProductBatchDetailPage({ batchId }: { batchId: string }) {
  const ids = useOperationIds();
  const { hasPermission } = useOperationsSession();
  const [batch, setBatch] = useState<ProductBatch | null>(null);
  const [previewProduct, setPreviewProduct] = useState<ProductRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!ids.adminUserId || !batchId) return;
    setBusy(true);
    setError("");
    try {
      const query = new URLSearchParams({ adminUserId: ids.adminUserId });
      setBatch(await request<ProductBatch>(`/operations/product-batches/${encodeURIComponent(batchId)}?${query.toString()}`));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("无法读取批次详情。 "));
    } finally {
      setBusy(false);
    }
  }, [batchId, ids.adminUserId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!batch) {
    return <div className="flex flex-col gap-4">{error ? <StatusMessage tone="danger">{error}</StatusMessage> : <StatusMessage tone="neutral">{t("正在读取批次...")}</StatusMessage>}</div>;
  }

  const nextHref = batchNextActionHref(batch.id, batch.nextAction);
  const workflowStage = productFactoryWorkflowStage(batch.stage);
  const workflowStageIndex = productFactoryWorkflowStageIndex(batch.stage);
  const workflowStageLabel = t(PRODUCT_FACTORY_WORKFLOW_STAGE_LABELS[workflowStage]);
  const canReviewDetails = hasPermission("page.product.details");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={t("商品工厂 / 批次详情")}
        title={batch.batchCode}
        description={t("{v0}创建于 {v1} · 操作员工 {v2}", { v0: batch.intakeCategory === "SHOES" ? t("鞋类 · 一双一个商品 · ") : "", v1: formatDateTime(batch.createdAt), v2: batch.createdByEmployeeId || t("未记录") })}
        action={<Button variant="outline" size="icon" title={t("刷新")} disabled={busy} onClick={() => void load()}><RefreshCwIcon /></Button>}
      />
      {error ? <StatusMessage tone="danger">{error}</StatusMessage> : null}

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric title={t("批次商品")} value={batch.targetCount} />
        <Metric title={t("当前阶段")} value={Math.min(workflowStageIndex + 1, 3)} suffix="/ 3" />
        <Metric title={t("已发布/归档")} value={batch.completedCount} suffix={`/ ${batch.targetCount}`} />
        <Metric title={t("异常")} value={batch.exceptionCount} tone={batch.exceptionCount ? "danger" : "default"} />
      </section>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle>{t("第")} {Math.min(workflowStageIndex + 1, 3)}{t("/3 阶段：")}{workflowStageLabel}</CardTitle>
              <CardDescription className="mt-1 space-y-1">
                <span className="block">{t("当前系统任务：")}{batch.stageLabel}</span>
                <span className="block">{t("正常商品自动前进；只有异常和最终实物确认需要员工处理。")}</span>
              </CardDescription>
            </div>
            <Button asChild className="w-full sm:w-auto"><Link href={nextHref}>{batch.nextActionLabel}<ArrowRightIcon data-icon="inline-end" /></Link></Button>
          </div>
        </CardHeader>
        <CardContent>
          <BatchStageStepper batch={batch} />
        </CardContent>
      </Card>

      {batch.detailGeneration.eligibleCount > 0 ? (
        <Card>
          <CardHeader>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <CardTitle>{t("AI 销售素材")}</CardTitle>
                <CardDescription className="mt-1">
                  
                  {t("最后一件完成确认后自动生成 AI 陈列主图、销售文案和尺码模板；旧商品与旧资产不会回填或重生成。")}
                </CardDescription>
              </div>
              {canReviewDetails ? (
                <Button asChild variant="outline" size="sm">
                  <Link href={`/product/details?batchId=${encodeURIComponent(batch.id)}`}>{t("检查生成异常")}<ArrowRightIcon data-icon="inline-end" /></Link>
                </Button>
              ) : null}
            </div>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
            <Metric title={t("待生成")} value={batch.detailGeneration.pendingCount} />
            <Metric title={t("生成中")} value={batch.detailGeneration.generatingCount} />
            <Metric title={t("待批准")} value={batch.detailGeneration.readyCount} />
            <Metric title={t("生成失败")} value={batch.detailGeneration.failedCount} tone={batch.detailGeneration.failedCount ? "danger" : "default"} />
            <Metric title={t("已过期")} value={batch.detailGeneration.outdatedCount} tone={batch.detailGeneration.outdatedCount ? "danger" : "default"} />
            <Metric title={t("已批准")} value={batch.detailGeneration.approvedCount} suffix={`/ ${batch.targetCount}`} />
            <Metric title={t("已进入详情")} value={batch.detailGeneration.eligibleCount} suffix={`/ ${batch.targetCount}`} />
            {batch.detailGeneration.failedItemNumbers?.length ? (
              <div className="col-span-full flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                <span className="text-destructive">
                  {t("生成失败的是：第 {numbers} 件。可以重试，或单独拒绝这件，本批其余衣服照常继续。", { numbers: batch.detailGeneration.failedItemNumbers.join("、") })}
                </span>
                <Button asChild size="sm" variant="outline">
                  <Link href={`/product/display-review?batchId=${encodeURIComponent(batch.id)}`}>{t("去处理")}<ArrowRightIcon data-icon="inline-end" /></Link>
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{batch.targetCount}  {t("件商品")}</CardTitle>
          <CardDescription>{t("点击商品图片可查看原图和系统生成的各个图片版本。")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
          {batch.products.map((product) => (
            <BatchProductItem
              key={product.id}
              batchId={batch.id}
              product={product}
              onPreview={() => setPreviewProduct(product)}
            />
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t("状态分布")}</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {Object.entries(batch.counts).map(([status, count]) => <Badge key={status} variant="secondary">{productStatusLabel(status)} {count}</Badge>)}
        </CardContent>
      </Card>
      <BatchProductPreviewDialog
        batchId={batch.id}
        product={previewProduct}
        onOpenChange={(open) => {
          if (!open) setPreviewProduct(null);
        }}
      />
    </div>
  );
}

function BatchStageStepper({ batch }: { batch: ProductBatch }) {
  const activeStage = productFactoryWorkflowStage(batch.stage);
  const activeIndex = productFactoryWorkflowStageIndex(batch.stage);
  return (
    <ol className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
      {PRODUCT_FACTORY_WORKFLOW_STAGE_ORDER.map((stage, index) => {
        const complete = batch.stage === "COMPLETE" || index < activeIndex;
        const current = stage === activeStage;
        return (
          <li key={stage} className={cn("min-w-0 rounded-md border px-4 py-4", current && "border-primary bg-primary/5", complete && "bg-muted/50")}>
            <div className="flex items-center gap-2">
              {complete ? <CheckCircle2Icon className="size-4 shrink-0 text-emerald-600" /> : current ? <CircleDotIcon className="size-4 shrink-0 text-primary" /> : <Clock3Icon className="size-4 shrink-0 text-muted-foreground" />}
              <span className="text-xs text-muted-foreground">{index + 1}</span>
            </div>
            <div className="mt-2 text-sm font-medium leading-snug">{t(PRODUCT_FACTORY_WORKFLOW_STAGE_LABELS[stage])}</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {stage === "CAPTURE" ? t("按顺序上传正面图，可补充背面与瑕疵图。") : stage === "AUTOMATION" ? t("直接用原图识别商品信息。") : stage === "CALIBRATION" ? t("核对商品信息，人工填写尺码。") : stage === "DISPLAY_REVIEW" ? t("原图生成白底图，逐件核对；不满意可重新生成。") : t("图片全部确认后，打印贴码、归位并发布。")}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function BatchProductItem({
  batchId,
  product,
  onPreview
}: {
  batchId: string;
  product: ProductRecord;
  onPreview: () => void;
}) {
  const missing: string[] = [];
  if (!product.images?.length) missing.push(t("缺正面图"));
  if (["PHOTOGRAPHED", "AI_PROCESSING"].includes(product.status) && product.aiExtractions?.[0]?.status === "FAILED") missing.push(t("AI 失败"));
  if (product.status === "REWORK_REQUIRED") missing.push(t("需返工"));
  const preview = product.imagePreviews?.[0] ?? null;
  return (
    <div className="grid min-w-0 grid-cols-[3.5rem_minmax(0,1fr)] gap-3 rounded-md border p-2 transition-colors hover:border-foreground/30 hover:bg-muted/40">
      <button
        type="button"
        className="flex h-[4.5rem] w-14 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t("查看第 {v0} 件商品图片", { v0: product.batchItemNumber ?? "-" })}
        title={t("查看原图和处理后的图片")}
        onClick={onPreview}
      >
        {preview ? (
          <img
            src={productImagePreviewUrl(preview.publicUrl)}
            alt={t("第 {v0} 件商品缩略图", { v0: product.batchItemNumber ?? "-" })}
            className="size-full object-contain"
            loading="lazy"
          />
        ) : (
          <ImageIcon className="size-5 text-muted-foreground" aria-hidden="true" />
        )}
      </button>
      <Link
        href={batchProductCalibrationHref(batchId, product.id)}
        className="min-w-0 rounded-sm py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t("校准第 {v0} 件商品", { v0: product.batchItemNumber ?? "-" })}
      >
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="shrink-0 text-sm font-semibold tabular-nums">{t("第")} {product.batchItemNumber ?? "-"}  {t("件")}</span>
          <span className="flex min-w-0 items-center gap-1">
            <Badge variant="secondary" className="max-w-24 truncate">{productStatusLabel(product.status)}</Badge>
            <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          </span>
        </div>
        <div className="mt-1 truncate text-xs text-muted-foreground">{product.productCode}</div>
        <div className="mt-2 min-h-5 text-xs">
          {missing.length ? <span className="text-destructive">{missing.join(" · ")}</span> : <span className="text-emerald-700">{t("资料正常")}</span>}
        </div>
      </Link>
    </div>
  );
}

function BatchProductPreviewDialog({
  batchId,
  product,
  onOpenChange
}: {
  batchId: string;
  product: ProductRecord | null;
  onOpenChange: (open: boolean) => void;
}) {
  const previews = product?.imagePreviews ?? [];
  const [activeImageId, setActiveImageId] = useState("");

  useEffect(() => {
    setActiveImageId(previews[0]?.imageId ?? "");
  }, [product?.id, previews]);

  const activePreview = previews.find((preview) => preview.imageId === activeImageId) ?? previews[0] ?? null;
  const activeUrl = activePreview ? productImagePreviewUrl(activePreview.publicUrl) : "";

  return (
    <Dialog open={Boolean(product)} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t("第")} {product?.batchItemNumber ?? "-"}  {t("件商品图片")}</DialogTitle>
          <DialogDescription>{product?.productCode}  {t("· 选择下方小图查看系统生成的不同版本。")}</DialogDescription>
        </DialogHeader>

        {activePreview ? (
          <a
            href={activeUrl}
            target="_blank"
            rel="noreferrer"
            className="flex min-h-72 items-center justify-center overflow-hidden rounded-md border bg-white p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-[32rem]"
            title={t("点击打开大图")}
          >
            <img
              src={activeUrl}
              alt={t("{v0} {v1}", { v0: product?.productCode ?? t("商品"), v1: productImageVariantLabel(activePreview.variant) })}
              className="max-h-full max-w-full object-contain"
            />
          </a>
        ) : (
          <div className="flex min-h-72 flex-col items-center justify-center gap-3 rounded-md border bg-muted/30 text-muted-foreground">
            <ImageIcon className="size-8" aria-hidden="true" />
            <span>{t("这件商品还没有可查看的正面图片")}</span>
          </div>
        )}

        {previews.length ? (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {previews.map((preview) => (
              <button
                key={preview.imageId}
                type="button"
                className={cn(
                  "min-w-0 rounded-md border p-1.5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  preview.imageId === activePreview?.imageId && "border-primary bg-primary/5"
                )}
                onClick={() => setActiveImageId(preview.imageId)}
              >
                <span className="flex h-20 items-center justify-center overflow-hidden rounded bg-white">
                  <img
                    src={productImagePreviewUrl(preview.publicUrl)}
                    alt={productImageVariantLabel(preview.variant)}
                    className="size-full object-contain"
                    loading="lazy"
                  />
                </span>
                <span className="mt-1.5 flex min-w-0 items-center gap-1">
                  <span className="truncate text-xs font-medium">{productImageVariantLabel(preview.variant)}</span>
                  {preview.selectedAsMain ? <Badge className="shrink-0 px-1 py-0 text-[10px]">{t("主图")}</Badge> : null}
                </span>
              </button>
            ))}
          </div>
        ) : null}

        <DialogFooter>
          {activePreview ? (
            <Button asChild variant="outline">
              <a href={activeUrl} target="_blank" rel="noreferrer">
                <ExternalLinkIcon data-icon="inline-start" />{t("打开大图")}
              </a>
            </Button>
          ) : null}
          <Button asChild>
            <Link href={product ? batchProductCalibrationHref(batchId, product.id) : `/product/calibration?batchId=${encodeURIComponent(batchId)}`}>
              
              {t("进入本件校准")}<ArrowRightIcon data-icon="inline-end" />
            </Link>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function productImagePreviewUrl(publicUrl: string) {
  if (/^(https?:|data:|blob:)/.test(publicUrl) || publicUrl.startsWith(API_PROXY_URL)) return publicUrl;
  return `${API_PROXY_URL}${publicUrl.startsWith("/") ? "" : "/"}${publicUrl}`;
}

function productImageVariantLabel(variant: string) {
  const labels: Record<string, string> = {
    ORIGINAL: t("原图"),
    CUTOUT_TRANSPARENT: t("透明抠图"),
    CUTOUT_WHITE: t("白底图"),
    OPTIMIZED_MAIN: t("优化主图"),
    OPTIMIZED_BALANCED_MAIN: t("均整版"),
    AI_DISPLAY_MAIN: t("AI 陈列图")
  };
  return labels[variant] ?? variant;
}

function BatchRow({ batch, onCancel }: { batch: ProductBatch; onCancel?: () => void }) {
  return (
    <div className="grid gap-3 rounded-md border bg-background p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-semibold">{batch.batchCode}</span>
          <StageBadge stage={batch.stage} label={batch.stageLabel} />
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>{t("当前步骤")} {batch.stageCompletedCount}/{batch.targetCount}</span>
          <span>{t("更新于")} {formatDateTime(batch.updatedAt)}</span>
          {batch.exceptionCount ? <span className="text-destructive">{t("异常")} {batch.exceptionCount}</span> : null}
        </div>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        {onCancel ? (
          <Button variant="ghost" className="w-full text-muted-foreground hover:text-destructive sm:w-auto" onClick={onCancel}>
            <XCircleIcon data-icon="inline-start" />{t("取消批次")}
          </Button>
        ) : null}
        <Button asChild variant="outline" className="w-full sm:w-auto"><Link href={`/product/batches/${batch.id}`}>{t("打开批次")}<ArrowRightIcon data-icon="inline-end" /></Link></Button>
      </div>
    </div>
  );
}

function TaskRow({ label, value, href }: { label: string; value: number; href: string }) {
  return (
    <Link href={href} className="flex min-h-14 items-center justify-between rounded-md border px-3 py-2 transition-colors hover:bg-muted/50">
      <span className="flex min-w-0 items-center gap-2 text-sm font-medium"><ListChecksIcon className="size-4 shrink-0 text-muted-foreground" />{label}</span>
      <span className="tabular-nums text-lg font-semibold">{value}</span>
    </Link>
  );
}

function StageBadge({ stage, label }: { stage: string; label: string }) {
  return <Badge variant={stage === "EXCEPTION" ? "destructive" : stage === "COMPLETE" ? "default" : "secondary"}>{label}</Badge>;
}

function Metric({ title, value, suffix = "", tone = "default" }: { title: string; value: number; suffix?: string; tone?: "default" | "danger" }) {
  return (
    <div className={cn("rounded-md border bg-background p-4", tone === "danger" && "border-destructive/40")}>
      <div className="text-xs text-muted-foreground sm:text-sm">{title}</div>
      <div className={cn("mt-2 text-2xl font-semibold tabular-nums", tone === "danger" && "text-destructive")}>{value}<span className="ml-1 text-sm font-normal text-muted-foreground">{suffix}</span></div>
    </div>
  );
}

function ProgressBar({ value, max }: { value: number; max: number }) {
  const percentage = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return <div className="h-2 w-full max-w-md overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary transition-[width]" style={{ width: `${percentage}%` }} /></div>;
}

function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <div className="text-xs font-medium text-muted-foreground">{eyebrow}</div>
        <h1 className="mt-1 text-2xl font-semibold tracking-normal">{title}</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}

function StatusMessage({ tone, children }: { tone: "danger" | "neutral"; children: ReactNode }) {
  return <div className={cn("rounded-md border px-4 py-3 text-sm", tone === "danger" ? "border-destructive/40 bg-destructive/5 text-destructive" : "bg-muted/40 text-muted-foreground")}>{children}</div>;
}

function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="flex min-h-32 flex-col items-center justify-center gap-2 rounded-md border border-dashed p-5 text-center">
      <PackageCheckIcon className="size-5 text-muted-foreground" />
      <div className="font-medium">{title}</div>
      <p className="text-sm text-muted-foreground">{description}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat(operationsFormatLocale(), {
    timeZone: "Africa/Nairobi",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}
