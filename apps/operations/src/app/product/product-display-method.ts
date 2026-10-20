import type { ImageProcessingJobRecord, ProductImageComparisonResponse } from "@online-saler/shared-types";

import { t } from "@/i18n/runtime";

/**
 * How the white-background display image under review was made, read from the
 * processing job that produced it:
 * - AI: OpenAI edited the photo (the normal path)
 * - CUTOUT_AI_REJECTED / CUTOUT_AI_FAILED: OpenAI refused, our own background
 *   removal made it instead, so prints and logos are exactly as photographed
 * - ORIGINAL: staff chose the untouched original photo
 */
export type DisplayMethod = "AI" | "CUTOUT_AI_REJECTED" | "CUTOUT_AI_FAILED" | "ORIGINAL";

const CUTOUT_PROVIDER = "local-cutout";
const ORIGINAL_PROVIDER = "original-photo";
const SAFETY_REJECTED = "OPENAI_SAFETY_REJECTED";

export function displayMethod(comparison?: Pick<ProductImageComparisonResponse, "aiDisplayMain" | "jobs"> | null): DisplayMethod | null {
  const imageId = comparison?.aiDisplayMain?.imageId;
  if (!imageId) return null;
  const job = comparison.jobs?.find((candidate) => candidate.outputImageId === imageId);
  if (!job) return "AI";
  if (job.provider === ORIGINAL_PROVIDER) return "ORIGINAL";
  if (job.provider === CUTOUT_PROVIDER) return job.fallbackReason === SAFETY_REJECTED ? "CUTOUT_AI_REJECTED" : "CUTOUT_AI_FAILED";
  return "AI";
}

/** Rendered at call time so the label follows the language the page is in. */
export function displayMethodLabel(method: DisplayMethod): string {
  if (method === "CUTOUT_AI_REJECTED") return t("本地抠图（AI 拒绝）");
  if (method === "CUTOUT_AI_FAILED") return t("本地抠图（AI 失败）");
  if (method === "ORIGINAL") return t("原图（员工选择）");
  return t("AI 生成");
}

/** The display job that failed most recently, when no display image exists yet. */
export function latestFailedDisplayJob(
  comparison?: Pick<ProductImageComparisonResponse, "jobs" | "original"> | null
): ImageProcessingJobRecord | null {
  const sourceImageId = comparison?.original?.imageId;
  const latest = (comparison?.jobs ?? [])
    .filter((job) => job.operation === "GENERATE_AI_DISPLAY_MAIN_IMAGE" && (!sourceImageId || job.sourceImageId === sourceImageId))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  return latest?.status === "FAILED" ? latest : null;
}

/**
 * Whether the review page should keep reloading for this item: its display
 * image or sales details are still on their way. A failed generation only
 * comes back on an employee retry, so polling for it just loads the API.
 */
export function stillGenerating(
  product: { status: string; detailSourceVersion?: number; detailProfiles?: Array<{ status: string; sourceDataVersion: number }> },
  comparison?: Pick<ProductImageComparisonResponse, "aiDisplayMain" | "jobs" | "original"> | null
): boolean {
  if (product.status === "PUBLISHED" || isRejected(product)) return false;
  const displayWaiting = !comparison || (!comparison.aiDisplayMain && !latestFailedDisplayJob(comparison));
  const profile = product.detailProfiles?.[0];
  const detailReady = Boolean(profile && profile.sourceDataVersion === product.detailSourceVersion && ["READY", "APPROVED"].includes(profile.status));
  const detailWaiting = !detailReady && profile?.status !== "FAILED";
  return displayWaiting || detailWaiting;
}

/** Rejected on the review page (archived): listed, but out of the rest of the batch. */
export function isRejected(product: { status: string }): boolean {
  return product.status === "ARCHIVED";
}

/** The current sales details for this item failed and wait for a retry or a reject. */
export function detailFailed(product: { status: string; detailSourceVersion?: number; detailProfiles?: Array<{ status: string; sourceDataVersion: number }> }): boolean {
  if (isRejected(product)) return false;
  const profile = product.detailProfiles?.[0];
  return Boolean(profile && profile.sourceDataVersion === product.detailSourceVersion && profile.status === "FAILED");
}
