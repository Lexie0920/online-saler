-- Exchange top-ups as real payment records (owner request, 2026-11-03).
--
-- A customer who exchanges for a dearer garment pays the difference by M-Pesa.
-- Staff record it as a Payment of this kind so it counts as money received:
-- the order total went up by the same amount, and the checks that compare
-- successful payments with the order total (handover, commission, refund cap)
-- stay true.
--
-- Additive only: one new enum value.

ALTER TYPE "PaymentKind" ADD VALUE IF NOT EXISTS 'EXCHANGE_TOPUP';
