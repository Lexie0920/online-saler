-- Exchanges on delivered orders (owner request, 2026-11-03).
--
-- An exchange on a delivered order has steps: the new garment is held, the old
-- one comes back and is photographed, a second person reviews it. Adds the
-- exchange status and the fields for those steps, and a table of photos.
--
-- Additive only. Existing exchange rows are already finished, so they take the
-- default status COMPLETED.

DO $$ BEGIN
  CREATE TYPE "OrderExchangeStatus" AS ENUM ('COMPLETED', 'AWAITING_RETURN', 'PENDING_REVIEW', 'REJECTED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "OrderExchange" ADD COLUMN IF NOT EXISTS "status" "OrderExchangeStatus" NOT NULL DEFAULT 'COMPLETED';
ALTER TABLE "OrderExchange" ADD COLUMN IF NOT EXISTS "discountReason" TEXT;
ALTER TABLE "OrderExchange" ADD COLUMN IF NOT EXISTS "receivedByAdminUserId" TEXT;
ALTER TABLE "OrderExchange" ADD COLUMN IF NOT EXISTS "receivedAt" TIMESTAMP(3);
ALTER TABLE "OrderExchange" ADD COLUMN IF NOT EXISTS "receivedBarcode" TEXT;
ALTER TABLE "OrderExchange" ADD COLUMN IF NOT EXISTS "inspectionNote" TEXT;
ALTER TABLE "OrderExchange" ADD COLUMN IF NOT EXISTS "reviewedByAdminUserId" TEXT;
ALTER TABLE "OrderExchange" ADD COLUMN IF NOT EXISTS "reviewedAt" TIMESTAMP(3);
ALTER TABLE "OrderExchange" ADD COLUMN IF NOT EXISTS "reviewNote" TEXT;
ALTER TABLE "OrderExchange" ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "OrderExchange_status_createdAt_idx" ON "OrderExchange"("status", "createdAt");

CREATE TABLE IF NOT EXISTS "OrderExchangePhoto" (
  "id" TEXT NOT NULL,
  "orderExchangeId" TEXT NOT NULL,
  "storageUrl" TEXT NOT NULL,
  "contentType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "uploadedByAdminUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderExchangePhoto_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "OrderExchangePhoto_orderExchangeId_createdAt_idx" ON "OrderExchangePhoto"("orderExchangeId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "OrderExchangePhoto" ADD CONSTRAINT "OrderExchangePhoto_orderExchangeId_fkey"
    FOREIGN KEY ("orderExchangeId") REFERENCES "OrderExchange"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
