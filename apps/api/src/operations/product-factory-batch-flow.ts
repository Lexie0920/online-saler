import { SHOE_REQUIRED_IMAGE_TYPES, isShoeProduct } from "@online-saler/shared-types";

export const PRODUCT_FACTORY_BATCH_STAGES = [
  "UPLOAD",
  "AI_IMAGE",
  "CALIBRATION",
  "BARCODE",
  "LABEL_APPLY",
  "REVIEW",
  "STORAGE",
  "PUBLISH"
] as const;

export type ProductFactoryBatchStage =
  | (typeof PRODUCT_FACTORY_BATCH_STAGES)[number]
  | "EXCEPTION"
  | "COMPLETE";

export type ProductFactoryBatchNextAction =
  | "CONTINUE_UPLOAD"
  | "START_AI_IMAGE"
  | "CONTINUE_CALIBRATION"
  | "GENERATE_BARCODES"
  | "PRINT_AND_APPLY_LABELS"
  | "CONTINUE_REVIEW"
  | "COMPLETE_STORAGE"
  | "PUBLISH_PRODUCTS"
  | "RESOLVE_EXCEPTION"
  | "VIEW_COMPLETED";

export type BatchFlowProduct = {
  status: string;
  batchItemNumber?: number | null;
  category?: string | null;
  subcategory?: string | null;
  detailSourceVersion?: number | null;
  barcode?: string | null;
  labelPrintedAt?: Date | string | null;
  images?: unknown[];
  aiExtractions?: Array<{ status?: string | null }>;
  reviews?: Array<{ result?: string | null }>;
  detailProfiles?: Array<{
    status?: string | null;
    sourceDataVersion?: number | null;
  }>;
  inventoryItem?: {
    locationId?: string | null;
    checkedInAt?: Date | string | null;
    status?: string | null;
  } | null;
};

export type ProductFactoryDetailProgress = {
  eligibleCount: number;
  pendingCount: number;
  generatingCount: number;
  readyCount: number;
  failedCount: number;
  // Which items failed, so staff can find them; rejected (archived) items no longer count.
  failedItemNumbers: number[];
  outdatedCount: number;
  approvedCount: number;
  readyForPublish: boolean;
};

export type ProductFactoryBatchFlow = {
  stage: ProductFactoryBatchStage;
  stageIndex: number;
  stageLabel: string;
  nextAction: ProductFactoryBatchNextAction;
  nextActionLabel: string;
  stageCompletedCount: number;
  exceptionCount: number;
  detailGeneration: ProductFactoryDetailProgress;
};

const STAGE_LABELS: Record<ProductFactoryBatchStage, string> = {
  UPLOAD: "上传图片",
  AI_IMAGE: "商品信息识别",
  CALIBRATION: "人工校准",
  BARCODE: "白底展示图审核",
  LABEL_APPLY: "打印并贴码",
  REVIEW: "商品审核",
  STORAGE: "货架入库",
  PUBLISH: "发布商品",
  EXCEPTION: "处理异常",
  COMPLETE: "批次已完成"
};

const ACTION_LABELS: Record<ProductFactoryBatchNextAction, string> = {
  CONTINUE_UPLOAD: "继续上传",
  START_AI_IMAGE: "开始 商品信息识别",
  CONTINUE_CALIBRATION: "继续人工校准",
  GENERATE_BARCODES: "审核本批白底展示图",
  PRINT_AND_APPLY_LABELS: "打印并贴码",
  CONTINUE_REVIEW: "继续审核",
  COMPLETE_STORAGE: "确认全部入库",
  PUBLISH_PRODUCTS: "发布本批商品",
  RESOLVE_EXCEPTION: "处理异常商品",
  VIEW_COMPLETED: "查看已完成批次"
};

const STATUS_RANK: Record<string, number> = {
  DRAFT: 0,
  PHOTOGRAPHED: 1,
  AI_PROCESSING: 1,
  AI_PROCESSED: 2,
  CALIBRATION_PENDING: 2,
  CALIBRATED: 3,
  BARCODE_ASSIGNED: 4,
  REVIEW_PENDING: 5,
  APPROVED: 6,
  READY_FOR_STORAGE: 6,
  PUBLISHED: 8,
  UNPUBLISHED: 7,
  ARCHIVED: 8
};

export function deriveProductFactoryBatchFlow(products: BatchFlowProduct[]): ProductFactoryBatchFlow {
  const exceptionCount = products.filter(hasOpenException).length;
  if (exceptionCount > 0) {
    return result("EXCEPTION", "RESOLVE_EXCEPTION", 0, exceptionCount, products);
  }

  if (products.length > 0 && products.every(isTerminal)) {
    return result("COMPLETE", "VIEW_COMPLETED", products.length, 0, products);
  }

  const stage = earliestIncompleteStage(products);
  const stageIndex = PRODUCT_FACTORY_BATCH_STAGES.indexOf(stage);
  const stageCompletedCount = products.filter((product) => productStageRank(product) > stageIndex).length;
  const flow = result(stage, nextActionFor(stage), stageCompletedCount, 0, products);
  if (stage === "CALIBRATION") {
    flow.nextActionLabel = stageCompletedCount === 0
      ? "开始人工校准"
      : `继续人工校准（已完成 ${stageCompletedCount}/${products.length}）`;
  }
  return flow;
}

export function summarizeProductFactoryDetailProgress(
  products: BatchFlowProduct[]
): ProductFactoryDetailProgress {
  const eligible = products.filter((product) => DETAIL_ELIGIBLE_STATUSES.has(product.status));
  const currentStatuses = eligible.map((product) => currentDetailProfile(product)?.status ?? null);
  const count = (status: string) => currentStatuses.filter((value) => value === status).length;
  const approvedCount = count("APPROVED");
  const failedItemNumbers = eligible
    .filter((product) => product.status !== "ARCHIVED" && currentDetailProfile(product)?.status === "FAILED")
    .map((product) => product.batchItemNumber ?? 0)
    .sort((left, right) => left - right);
  return {
    eligibleCount: eligible.length,
    pendingCount: currentStatuses.filter((status) => status === null || status === "PENDING").length,
    generatingCount: count("GENERATING"),
    readyCount: count("READY"),
    failedCount: failedItemNumbers.length,
    failedItemNumbers,
    outdatedCount: count("OUTDATED"),
    approvedCount,
    readyForPublish: products.length > 0
  };
}

export function startOfDayAtUtcOffset(now: Date, utcOffsetMinutes: number): Date {
  const shifted = new Date(now.getTime() + utcOffsetMinutes * 60_000);
  return new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - utcOffsetMinutes * 60_000
  );
}

function earliestIncompleteStage(products: BatchFlowProduct[]): (typeof PRODUCT_FACTORY_BATCH_STAGES)[number] {
  if (products.length === 0) return "UPLOAD";
  const rank = Math.min(...products.filter((product) => !isTerminal(product)).map(productStageRank));
  return PRODUCT_FACTORY_BATCH_STAGES[Math.max(0, Math.min(rank, PRODUCT_FACTORY_BATCH_STAGES.length - 1))];
}

function productStageRank(product: BatchFlowProduct): number {
  const baseRank = STATUS_RANK[product.status] ?? 0;
  if (baseRank < 3 && isShoeProduct(product.category, product.subcategory)) {
    const types = new Set((product.images ?? []).map((image) =>
      image && typeof image === "object" && "type" in image ? image.type : null
    ));
    if (SHOE_REQUIRED_IMAGE_TYPES.some((type) => !types.has(type))) return 0;
  }
  if (product.status === "BARCODE_ASSIGNED") return product.labelPrintedAt ? 5 : 4;
  if (product.status === "APPROVED") return 6;
  if (product.status === "READY_FOR_STORAGE") {
    return product.inventoryItem?.checkedInAt && product.inventoryItem.locationId ? 7 : 6;
  }
  return baseRank;
}

function hasOpenException(product: BatchFlowProduct): boolean {
  if (product.status === "REWORK_REQUIRED") return true;
  return product.aiExtractions?.[0]?.status === "FAILED";
}

function isTerminal(product: BatchFlowProduct): boolean {
  return product.status === "PUBLISHED" || product.status === "ARCHIVED";
}

function nextActionFor(
  stage: (typeof PRODUCT_FACTORY_BATCH_STAGES)[number]
): ProductFactoryBatchNextAction {
  const actions: Record<(typeof PRODUCT_FACTORY_BATCH_STAGES)[number], ProductFactoryBatchNextAction> = {
    UPLOAD: "CONTINUE_UPLOAD",
    AI_IMAGE: "START_AI_IMAGE",
    CALIBRATION: "CONTINUE_CALIBRATION",
    BARCODE: "GENERATE_BARCODES",
    LABEL_APPLY: "PRINT_AND_APPLY_LABELS",
    REVIEW: "CONTINUE_REVIEW",
    STORAGE: "COMPLETE_STORAGE",
    PUBLISH: "PUBLISH_PRODUCTS"
  };
  return actions[stage];
}

function result(
  stage: ProductFactoryBatchStage,
  nextAction: ProductFactoryBatchNextAction,
  stageCompletedCount: number,
  exceptionCount: number,
  products: BatchFlowProduct[]
): ProductFactoryBatchFlow {
  return {
    stage,
    stageIndex: stage === "COMPLETE" ? PRODUCT_FACTORY_BATCH_STAGES.length : PRODUCT_FACTORY_BATCH_STAGES.indexOf(stage as (typeof PRODUCT_FACTORY_BATCH_STAGES)[number]),
    stageLabel: STAGE_LABELS[stage],
    nextAction,
    nextActionLabel: ACTION_LABELS[nextAction],
    stageCompletedCount,
    exceptionCount,
    detailGeneration: summarizeProductFactoryDetailProgress(products)
  };
}

const DETAIL_ELIGIBLE_STATUSES = new Set([
  "CALIBRATED",
  "BARCODE_ASSIGNED",
  "REVIEW_PENDING",
  "APPROVED",
  "READY_FOR_STORAGE",
  "PUBLISHED",
  "UNPUBLISHED",
  "ARCHIVED"
]);

function currentDetailProfile(product: BatchFlowProduct) {
  return product.detailProfiles?.find(
    (profile) => profile.sourceDataVersion === product.detailSourceVersion
  ) ?? null;
}
