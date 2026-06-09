/*
  Warnings:

  - A unique constraint covering the columns `[orderId]` on the table `Payment` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "Payment_orderId_idx";

-- CreateIndex
CREATE UNIQUE INDEX "Payment_orderId_key" ON "Payment"("orderId");
