-- Order exchanges (owner request, 2026-11-03).
--
-- A garment on an order can be swapped for another. One row is one swap; the
-- order line itself is edited in place, so this table is the only history of
-- what it used to hold.
--
-- Additive only: one enum, one table, two indexes and one foreign key. No
-- existing row or column changes.

DO $$ BEGIN
  CREATE TYPE "OrderExchangeKind" AS ENUM ('STANDARD', 'RETURN_TO_EXCHANGE');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "OrderExchange" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "orderItemId" TEXT NOT NULL,
  "kind" "OrderExchangeKind" NOT NULL DEFAULT 'STANDARD',
  "oldProductId" TEXT NOT NULL,
  "newProductId" TEXT NOT NULL,
  "oldPriceKsh" INTEGER NOT NULL,
  "newPriceKsh" INTEGER NOT NULL,
  "topUpKsh" INTEGER NOT NULL DEFAULT 0,
  "discountKsh" INTEGER NOT NULL DEFAULT 0,
  "reason" TEXT NOT NULL,
  "performedByAdminUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderExchange_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "OrderExchange_orderId_createdAt_idx" ON "OrderExchange"("orderId", "createdAt");
CREATE INDEX IF NOT EXISTS "OrderExchange_createdAt_idx" ON "OrderExchange"("createdAt");

DO $$ BEGIN
  ALTER TABLE "OrderExchange" ADD CONSTRAINT "OrderExchange_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
