-- M-Pesa for Business bulk payouts (owner, 2026-10-14).
--
-- Finance exports one bulk payment file per week from the weekly payout page,
-- uploads it to the M-Pesa for Business portal, then uploads the portal's
-- results report back. A PayoutBatch is one exported file; a PayoutBatchLine
-- is one person in it. A successful line points at the Payout it created.
--
-- Additive only: two enums, two tables and indexes. No existing row or column
-- changes, no state machine changes.

DO $$ BEGIN
  CREATE TYPE "PayoutBatchStatus" AS ENUM ('OPEN', 'RECONCILED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "PayoutBatchLineStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "PayoutBatch" (
  "id" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "status" "PayoutBatchStatus" NOT NULL DEFAULT 'OPEN',
  "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL,
  "lineCount" INTEGER NOT NULL,
  "totalKsh" INTEGER NOT NULL,
  "exportedByAdminUserId" TEXT NOT NULL,
  "exportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cancelledByAdminUserId" TEXT,
  "cancelledAt" TIMESTAMP(3),
  "reconciledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PayoutBatch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PayoutBatch_reference_key" ON "PayoutBatch"("reference");
CREATE INDEX IF NOT EXISTS "PayoutBatch_periodStart_status_idx" ON "PayoutBatch"("periodStart", "status");

CREATE TABLE IF NOT EXISTS "PayoutBatchLine" (
  "id" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "status" "PayoutBatchLineStatus" NOT NULL DEFAULT 'PENDING',
  "payeeType" "PayoutPayeeType" NOT NULL,
  "payeeKey" TEXT NOT NULL,
  "payeeName" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "amountKsh" INTEGER NOT NULL,
  "items" JSONB NOT NULL,
  "payoutId" TEXT,
  "mpesaCode" TEXT,
  "resultStatus" TEXT,
  "resultReason" TEXT,
  "resultCompletedAt" TEXT,
  "resultAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PayoutBatchLine_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PayoutBatchLine_reference_key" ON "PayoutBatchLine"("reference");
CREATE UNIQUE INDEX IF NOT EXISTS "PayoutBatchLine_payoutId_key" ON "PayoutBatchLine"("payoutId");
CREATE INDEX IF NOT EXISTS "PayoutBatchLine_batchId_idx" ON "PayoutBatchLine"("batchId");
CREATE INDEX IF NOT EXISTS "PayoutBatchLine_payeeKey_status_idx" ON "PayoutBatchLine"("payeeKey", "status");

DO $$ BEGIN
  ALTER TABLE "PayoutBatch" ADD CONSTRAINT "PayoutBatch_exportedByAdminUserId_fkey"
    FOREIGN KEY ("exportedByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "PayoutBatchLine" ADD CONSTRAINT "PayoutBatchLine_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "PayoutBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "PayoutBatchLine" ADD CONSTRAINT "PayoutBatchLine_payoutId_fkey"
    FOREIGN KEY ("payoutId") REFERENCES "Payout"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
