import assert from "node:assert/strict";
import test from "node:test";
import {
  PRODUCT_FACTORY_BATCH_STAGES,
  deriveProductFactoryBatchFlow,
  summarizeProductFactoryDetailProgress,
  startOfDayAtUtcOffset,
  type BatchFlowProduct
} from "./product-factory-batch-flow";

function products(status: string, count = 10, extra: Partial<BatchFlowProduct> = {}): BatchFlowProduct[] {
  return Array.from({ length: count }, () => ({ status, ...extra }));
}

test("shoe batches leave capture once every pair has its pair photo; side, soles and label are optional", () => {
  const pairs = products("PHOTOGRAPHED", 10, { category: "SHOES", images: [{ type: "FRONT" }] });
  assert.equal(deriveProductFactoryBatchFlow(pairs).stage, "AI_IMAGE");
  pairs[9].images = [{ type: "BACK" }, { type: "LABEL" }];
  const incomplete = deriveProductFactoryBatchFlow(pairs);
  assert.equal(incomplete.stage, "UPLOAD");
  assert.equal(incomplete.stageCompletedCount, 9);
  pairs[9] = { status: "CALIBRATION_PENDING", category: "KIDS", subcategory: "KIDS_SHOES", images: [{ type: "DETAIL" }] };
  assert.equal(deriveProductFactoryBatchFlow(pairs).stage, "UPLOAD");
});

test("derives the eight legal stages in order", () => {
  const fixtures: Array<[BatchFlowProduct[], string, string]> = [
    [products("DRAFT"), "UPLOAD", "CONTINUE_UPLOAD"],
    [products("PHOTOGRAPHED"), "AI_IMAGE", "START_AI_IMAGE"],
    [products("AI_PROCESSED"), "CALIBRATION", "CONTINUE_CALIBRATION"],
    [products("CALIBRATED"), "BARCODE", "GENERATE_BARCODES"],
    [products("BARCODE_ASSIGNED"), "LABEL_APPLY", "PRINT_AND_APPLY_LABELS"],
    [products("BARCODE_ASSIGNED", 10, { labelPrintedAt: new Date() }), "REVIEW", "CONTINUE_REVIEW"],
    [products("READY_FOR_STORAGE"), "STORAGE", "COMPLETE_STORAGE"],
    [products("READY_FOR_STORAGE", 10, {
      inventoryItem: { locationId: "loc", checkedInAt: new Date() }
    }), "PUBLISH", "PUBLISH_PRODUCTS"]
  ];

  for (const [input, stage, action] of fixtures) {
    const flow = deriveProductFactoryBatchFlow(input);
    assert.equal(flow.stage, stage);
    assert.equal(flow.nextAction, action);
  }
  assert.equal(PRODUCT_FACTORY_BATCH_STAGES.length, 8);
});

test("keeps detail generation optional at the publish step", () => {
  const calibrated = deriveProductFactoryBatchFlow(products("CALIBRATED"));
  assert.equal(calibrated.stage, "BARCODE");
  assert.equal(calibrated.nextAction, "GENERATE_BARCODES");

  const publishableWithoutDetails = deriveProductFactoryBatchFlow(products("READY_FOR_STORAGE", 10, {
    detailSourceVersion: 3,
    detailProfiles: [{ status: "READY", sourceDataVersion: 3 }],
    inventoryItem: { locationId: "loc", checkedInAt: new Date() }
  }));
  assert.equal(publishableWithoutDetails.stage, "PUBLISH");
  assert.equal(publishableWithoutDetails.nextAction, "PUBLISH_PRODUCTS");
  assert.equal(publishableWithoutDetails.detailGeneration.readyForPublish, true);
});

test("counts only current detail versions as publish-ready", () => {
  const progress = summarizeProductFactoryDetailProgress([
    {
      status: "CALIBRATED",
      detailSourceVersion: 2,
      detailProfiles: [{ status: "APPROVED", sourceDataVersion: 1 }]
    },
    {
      status: "CALIBRATED",
      detailSourceVersion: 4,
      detailProfiles: [{ status: "APPROVED", sourceDataVersion: 4 }]
    }
  ]);
  assert.equal(progress.pendingCount, 1);
  assert.equal(progress.approvedCount, 1);
  assert.equal(progress.readyForPublish, true);
});

test("keeps a mixed batch at its earliest incomplete stage", () => {
  const flow = deriveProductFactoryBatchFlow([
    ...products("CALIBRATED", 9),
    { status: "AI_PROCESSED" }
  ]);
  assert.equal(flow.stage, "CALIBRATION");
  assert.equal(flow.stageCompletedCount, 9);
  assert.equal(flow.nextActionLabel, "继续人工校准（已完成 9/10）");
});

test("uses an explicit start action before the first product is calibrated", () => {
  const flow = deriveProductFactoryBatchFlow(products("AI_PROCESSED"));
  assert.equal(flow.nextActionLabel, "开始人工校准");
});

test("prioritizes open exceptions and recognizes terminal batches", () => {
  assert.equal(deriveProductFactoryBatchFlow(products("REWORK_REQUIRED", 1)).stage, "EXCEPTION");
  assert.equal(
    deriveProductFactoryBatchFlow(products("PHOTOGRAPHED", 1, { aiExtractions: [{ status: "FAILED" }] })).stage,
    "EXCEPTION"
  );
  assert.equal(deriveProductFactoryBatchFlow([...products("PUBLISHED", 9), { status: "ARCHIVED" }]).stage, "COMPLETE");
});

test("calculates the Nairobi business day independently of server timezone", () => {
  const now = new Date("2026-08-01T22:30:00.000Z");
  assert.equal(startOfDayAtUtcOffset(now, 180).toISOString(), "2026-08-01T21:00:00.000Z");
});

test("names the items whose sales details failed, leaving rejected items out", () => {
  const progress = summarizeProductFactoryDetailProgress([
    { status: "CALIBRATED", batchItemNumber: 7, detailSourceVersion: 1, detailProfiles: [{ status: "FAILED", sourceDataVersion: 1 }] },
    { status: "CALIBRATED", batchItemNumber: 2, detailSourceVersion: 1, detailProfiles: [{ status: "READY", sourceDataVersion: 1 }] },
    { status: "ARCHIVED", batchItemNumber: 3, detailSourceVersion: 1, detailProfiles: [{ status: "FAILED", sourceDataVersion: 1 }] },
    { status: "CALIBRATED", batchItemNumber: 4, detailSourceVersion: 2, detailProfiles: [{ status: "FAILED", sourceDataVersion: 1 }] }
  ]);
  assert.equal(progress.failedCount, 1);
  assert.deepEqual(progress.failedItemNumbers, [7]);
});
