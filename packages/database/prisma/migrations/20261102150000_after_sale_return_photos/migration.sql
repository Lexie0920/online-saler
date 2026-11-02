-- Return photos (owner request, 2026-11-02).
--
-- When the warehouse accepts a returned item it must photograph it. One row is
-- one photo; the file itself is in the private product-image bucket and only
-- its gs:// path is stored here.
--
-- Additive only: one table and one index. No existing row or column changes and
-- no state machine changes.

CREATE TABLE IF NOT EXISTS "AfterSaleReturnPhoto" (
  "id" TEXT NOT NULL,
  "afterSaleReturnId" TEXT NOT NULL,
  "storageUrl" TEXT NOT NULL,
  "contentType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "uploadedByAdminUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AfterSaleReturnPhoto_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AfterSaleReturnPhoto_afterSaleReturnId_createdAt_idx" ON "AfterSaleReturnPhoto"("afterSaleReturnId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "AfterSaleReturnPhoto" ADD CONSTRAINT "AfterSaleReturnPhoto_afterSaleReturnId_fkey"
    FOREIGN KEY ("afterSaleReturnId") REFERENCES "AfterSaleReturn"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
