-- Exchange top-up payment code (owner request, 2026-11-03).
--
-- When an exchange is for a dearer garment the customer pays the difference and
-- staff record the M-Pesa transaction code on the exchange. Unique, so one
-- payment cannot cover two exchanges.
--
-- Additive only: one nullable column and its unique index.

ALTER TABLE "OrderExchange" ADD COLUMN IF NOT EXISTS "topUpMpesaCode" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "OrderExchange_topUpMpesaCode_key" ON "OrderExchange"("topUpMpesaCode");
