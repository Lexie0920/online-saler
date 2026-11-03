-- Commission adjustments caused by exchanges (owner request, 2026-11-03).
--
-- When an exchange changes the price of an order whose commission was already
-- paid out, the paid commission is left alone and one signed line is recorded
-- here. The payout export lists it until the affiliate's next payout is recorded,
-- so finance can add it to, or take it off, that transfer.
--
-- Additive only: one new table.

CREATE TABLE "CommissionExchangeAdjustment" (
    "id" TEXT NOT NULL,
    "commissionId" TEXT NOT NULL,
    "orderExchangeId" TEXT NOT NULL,
    "amountKsh" INTEGER NOT NULL,
    "beforeAmountKsh" INTEGER NOT NULL,
    "afterAmountKsh" INTEGER NOT NULL,
    "recordedByAdminUserId" TEXT NOT NULL,
    "settledAt" TIMESTAMP(3),
    "settledPayoutId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommissionExchangeAdjustment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CommissionExchangeAdjustment_orderExchangeId_key" ON "CommissionExchangeAdjustment"("orderExchangeId");

CREATE INDEX "CommissionExchangeAdjustment_commissionId_idx" ON "CommissionExchangeAdjustment"("commissionId");

CREATE INDEX "CommissionExchangeAdjustment_settledAt_idx" ON "CommissionExchangeAdjustment"("settledAt");

ALTER TABLE "CommissionExchangeAdjustment" ADD CONSTRAINT "CommissionExchangeAdjustment_commissionId_fkey" FOREIGN KEY ("commissionId") REFERENCES "Commission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CommissionExchangeAdjustment" ADD CONSTRAINT "CommissionExchangeAdjustment_orderExchangeId_fkey" FOREIGN KEY ("orderExchangeId") REFERENCES "OrderExchange"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
