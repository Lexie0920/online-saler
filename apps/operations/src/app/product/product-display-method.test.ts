import assert from "node:assert/strict";

import { setOperationsRuntimeLocale } from "@/i18n/runtime";
import { detailFailed, displayMethod, displayMethodLabel, isRejected, latestFailedDisplayJob, stillGenerating } from "./product-display-method";

const job = (overrides: Record<string, unknown>) => ({
  id: "job",
  productId: "p",
  sourceImageId: "front",
  operation: "GENERATE_AI_DISPLAY_MAIN_IMAGE",
  targetVariant: "AI_DISPLAY_MAIN",
  status: "SUCCEEDED",
  provider: "openai-image-edit",
  processorVersion: "v",
  qualityScore: null,
  qualityIssues: [],
  fallbackFrom: null,
  fallbackReason: null,
  outputImageId: null,
  retryCount: 0,
  failureCode: null,
  errorMessage: null,
  startedAt: null,
  completedAt: null,
  createdAt: "2026-10-01T08:00:00.000Z",
  updatedAt: "2026-10-01T08:00:00.000Z",
  ...overrides
}) as never;

const comparison = (imageId: string | null, jobs: unknown[]) => ({
  aiDisplayMain: imageId ? { imageId } : null,
  original: { imageId: "front" },
  jobs
}) as never;

// No display image: nothing to tag.
assert.equal(displayMethod(comparison(null, [])), null);
// The image the AI made.
assert.equal(displayMethod(comparison("img-ai", [job({ outputImageId: "img-ai" })])), "AI");
// OpenAI's safety system refused; the local cutout made it.
assert.equal(displayMethod(comparison("img-cut", [
  job({ outputImageId: "img-cut", provider: "local-cutout", fallbackFrom: "openai-image-edit", fallbackReason: "OPENAI_SAFETY_REJECTED" })
])), "CUTOUT_AI_REJECTED");
assert.equal(displayMethod(comparison("img-cut", [
  job({ outputImageId: "img-cut", provider: "local-cutout", fallbackReason: "OPENAI_REJECTED_400" })
])), "CUTOUT_AI_FAILED");
// Staff chose the original photo.
assert.equal(displayMethod(comparison("img-orig", [
  job({ outputImageId: "img-orig", provider: "original-photo", fallbackReason: "STAFF_USE_ORIGINAL" })
])), "ORIGINAL");

setOperationsRuntimeLocale("zh-CN");
assert.equal(displayMethodLabel("CUTOUT_AI_REJECTED"), "本地抠图（AI 拒绝）");
setOperationsRuntimeLocale("en");
assert.match(displayMethodLabel("CUTOUT_AI_REJECTED"), /cutout/i);
setOperationsRuntimeLocale("zh-CN");

// The newest display job decides: a failure followed by a success is not a failure.
const failed = job({ id: "failed", status: "FAILED", errorMessage: "rejected by the safety system", createdAt: "2026-10-01T08:00:00.000Z" });
assert.equal(latestFailedDisplayJob(comparison(null, [failed]))?.id, "failed");
assert.equal(latestFailedDisplayJob(comparison(null, [
  failed,
  job({ id: "later", status: "RUNNING", createdAt: "2026-10-01T09:00:00.000Z" })
])), null);
// A job for an older original photo does not count.
assert.equal(latestFailedDisplayJob(comparison(null, [job({ id: "old", status: "FAILED", sourceImageId: "older-front" })])), null);

assert.equal(isRejected({ status: "ARCHIVED" }), true);
assert.equal(isRejected({ status: "CALIBRATED" }), false);

// The review page stops reloading once nothing is left to wait for.
const readyDetails = { status: "CALIBRATED", detailSourceVersion: 2, detailProfiles: [{ status: "READY", sourceDataVersion: 2 }] };
assert.equal(stillGenerating(readyDetails, comparison("img", [])), false);
assert.equal(stillGenerating(readyDetails, comparison(null, [job({ status: "RUNNING" })])), true);
assert.equal(stillGenerating(readyDetails, comparison(null, [job({ status: "FAILED" })])), false);
assert.equal(stillGenerating(readyDetails, undefined), true);
assert.equal(stillGenerating({ ...readyDetails, detailProfiles: [{ status: "GENERATING", sourceDataVersion: 2 }] }, comparison("img", [])), true);
assert.equal(stillGenerating({ ...readyDetails, detailProfiles: [{ status: "FAILED", sourceDataVersion: 2 }] }, comparison("img", [])), false);
assert.equal(stillGenerating({ ...readyDetails, status: "ARCHIVED" }, comparison(null, [job({ status: "RUNNING" })])), false);

// A failed sales detail is named on the review page until it is retried or the item rejected.
assert.equal(detailFailed({ ...readyDetails, detailProfiles: [{ status: "FAILED", sourceDataVersion: 2 }] }), true);
assert.equal(detailFailed({ ...readyDetails, detailProfiles: [{ status: "FAILED", sourceDataVersion: 1 }] }), false);
assert.equal(detailFailed({ ...readyDetails, status: "ARCHIVED", detailProfiles: [{ status: "FAILED", sourceDataVersion: 2 }] }), false);
assert.equal(detailFailed(readyDetails), false);

console.log("product display method ok");
