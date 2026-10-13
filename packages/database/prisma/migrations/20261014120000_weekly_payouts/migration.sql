-- Weekly manual M-Pesa payouts (owner, 2026-10-14, "做法一").
--
-- Finance sends each promoter's commission and each rider's delivery pay by
-- hand with M-Pesa Send Money, then records the transaction code here. One
-- Payout row per person per payment; every commission and rider fee it covered
-- points back to it, so nothing can be listed or paid twice.
--
-- Additive only: a new enum, a new table, two nullable columns and indexes. No
-- existing row changes, no state machine changes, and code that predates this
-- keeps working while it rolls out.

DO $$ BEGIN
  CREATE TYPE "PayoutPayeeType" AS ENUM ('AFFILIATE', 'RIDER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "Payout" (
  "id" TEXT NOT NULL,
  "payeeType" "PayoutPayeeType" NOT NULL,
  "payeeKey" TEXT NOT NULL,
  "affiliateId" TEXT,
  "deliveryRiderId" TEXT,
  "payeeName" TEXT NOT NULL,
  "payeePhone" TEXT,
  "amountKsh" INTEGER NOT NULL,
  "itemCount" INTEGER NOT NULL,
  "mpesaCode" TEXT NOT NULL,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL,
  "paidByAdminUserId" TEXT NOT NULL,
  "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Payout_mpesaCode_key" ON "Payout"("mpesaCode");
CREATE INDEX IF NOT EXISTS "Payout_payeeType_paidAt_idx" ON "Payout"("payeeType", "paidAt");
CREATE INDEX IF NOT EXISTS "Payout_affiliateId_paidAt_idx" ON "Payout"("affiliateId", "paidAt");
CREATE INDEX IF NOT EXISTS "Payout_deliveryRiderId_paidAt_idx" ON "Payout"("deliveryRiderId", "paidAt");
CREATE INDEX IF NOT EXISTS "Payout_payeeKey_periodStart_idx" ON "Payout"("payeeKey", "periodStart");

ALTER TABLE "Commission" ADD COLUMN IF NOT EXISTS "payoutId" TEXT;
CREATE INDEX IF NOT EXISTS "Commission_payoutId_idx" ON "Commission"("payoutId");

ALTER TABLE "OrderFulfillment" ADD COLUMN IF NOT EXISTS "riderFeePayoutId" TEXT;
CREATE INDEX IF NOT EXISTS "OrderFulfillment_riderFeePayoutId_idx" ON "OrderFulfillment"("riderFeePayoutId");
CREATE INDEX IF NOT EXISTS "OrderFulfillment_status_completedAt_idx" ON "OrderFulfillment"("status", "completedAt");

DO $$ BEGIN
  ALTER TABLE "Payout" ADD CONSTRAINT "Payout_affiliateId_fkey"
    FOREIGN KEY ("affiliateId") REFERENCES "Affiliate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Payout" ADD CONSTRAINT "Payout_deliveryRiderId_fkey"
    FOREIGN KEY ("deliveryRiderId") REFERENCES "DeliveryRider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Payout" ADD CONSTRAINT "Payout_paidByAdminUserId_fkey"
    FOREIGN KEY ("paidByAdminUserId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Commission" ADD CONSTRAINT "Commission_payoutId_fkey"
    FOREIGN KEY ("payoutId") REFERENCES "Payout"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "OrderFulfillment" ADD CONSTRAINT "OrderFulfillment_riderFeePayoutId_fkey"
    FOREIGN KEY ("riderFeePayoutId") REFERENCES "Payout"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
