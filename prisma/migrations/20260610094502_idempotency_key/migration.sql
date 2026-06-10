/*
  Warnings:

  - A unique constraint covering the columns `[idempotencyKey,userId]` on the table `Order` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "Order_idempotencyKey_key";

-- CreateIndex
CREATE UNIQUE INDEX "Order_idempotencyKey_userId_key" ON "Order"("idempotencyKey", "userId");
