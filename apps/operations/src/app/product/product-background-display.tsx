"use client";

import { useEffect, useState } from "react";
import { operationsFetch } from "@/lib/operations-api";
import type { ImageProcessingJobRecord, ProductImageComparisonResponse } from "@online-saler/shared-types";
import { completedCaptureCount } from "./product-factory-upload-flow";
import { t } from "@/i18n/runtime";

type Item = { id: string; status: string; category?: string | null; subcategory?: string | null; images?: Array<{ id: string; type: string; createdAt?: string }> };
type Batch = { id: string; targetCount: number; products: Item[] };
const running = new Map<string, Promise<void>>();
const waiting: Array<() => Promise<void>> = [];
let active = 0;
const LIMIT = 2;

async function request<T>(path: string): Promise<T> {
  const response = await operationsFetch(`/api-proxy${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || t("白底图生成请求失败"));
  return body as T;
}

function drain() {
  while (active < LIMIT && waiting.length) {
    active++;
    const next = waiting.shift()!;
    void next().finally(() => { active--; drain(); });
  }
}

// Module lifetime spans Next.js client navigation. Work is executed by the API;
// persisted job status prevents refreshes/other tabs from generating duplicates.
export function startBatchDisplayWork(batch: Batch) {
  if (batch.products.length !== batch.targetCount || completedCaptureCount(batch.products) !== batch.targetCount) return;
  for (const product of batch.products) {
    if (!["PHOTOGRAPHED", "AI_PROCESSING", "AI_PROCESSED", "CALIBRATION_PENDING", "CALIBRATED"].includes(product.status)) continue;
    const source = product.images?.find((image) => image.type === "FRONT");
    if (!source) continue;
    const key = `${product.id}:${source.id}`;
    if (running.has(key)) continue;
    let resolve!: () => void;
    const pending = new Promise<void>((done) => { resolve = done; });
    running.set(key, pending);
    waiting.push(async () => {
      try {
        const response = await operationsFetch(`/api-proxy/products/${product.id}/image-comparison`);
        if (!response.ok) throw new Error(t("读取白底图进度失败"));
        const comparison = await response.json() as ProductImageComparisonResponse;
        if (comparison.aiDisplayMain) return;
        let job = await request<ImageProcessingJobRecord>(`/products/${product.id}/images/${source.id}/ensure-display`);
        const deadline = Date.now() + 240_000;
        while (["PENDING", "RUNNING"].includes(job.status) && Date.now() < deadline) {
          await new Promise((done) => setTimeout(done, 4_000));
          job = await request<ImageProcessingJobRecord>(`/products/${product.id}/images/${source.id}/ensure-display`);
        }
      } catch {
        // The progress panel reads server state; a navigation/network failure
        // must never mark an image as generated or automatically retry billing.
      } finally {
        running.delete(key);
        resolve();
      }
    });
  }
  drain();
}

export function BatchDisplayProgress({ batch }: { batch: Batch }) {
  const [progress, setProgress] = useState<{ ready: number; failed: number } | null>(null);
  useEffect(() => {
    startBatchDisplayWork(batch);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const comparisons = await Promise.all(batch.products.map(async (product) => {
          const response = await operationsFetch(`/api-proxy/products/${product.id}/image-comparison`);
          if (!response.ok) throw new Error(t("进度暂不可用"));
          return response.json() as Promise<ProductImageComparisonResponse>;
        }));
        const ready = comparisons.filter((comparison) => comparison.aiDisplayMain).length;
        const failed = comparisons.filter((comparison) => !comparison.aiDisplayMain && comparison.jobs.find((job) => job.sourceImageId === comparison.original?.imageId && job.operation === "GENERATE_AI_DISPLAY_MAIN_IMAGE")?.status === "FAILED").length;
        if (!stopped) setProgress({ ready, failed });
        // Every item has an image or a failure that waits for a manual retry.
        if (ready + failed >= batch.products.length) return;
      } catch { if (!stopped) setProgress(null); }
      if (!stopped) timer = setTimeout(poll, 5_000);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [batch]);
  return <div className="rounded-md border bg-muted/30 px-4 py-3 text-sm" role="status">
    
    {t("白底展示图后台生成：")}{progress ? t("已完成 {ready}/{targetCount} 件{v2}", { ready: progress.ready, targetCount: batch.targetCount, v2: progress.failed ? t("，{failed} 件失败，可在审核页重试", { failed: progress.failed }) : "" }) : t("正在读取进度")}{t("。你可以继续填写商品信息，切换商品不会中断生成。")}
  </div>;
}
