-- DropIndex
DROP INDEX "Payment_orderId_key";

-- CreateIndex
CREATE INDEX "Payment_orderId_idx" ON "Payment"("orderId");
