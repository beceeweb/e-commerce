/*
  Warnings:

  - A unique constraint covering the columns `[userId,idempotencyKey]` on the table `Order` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `billingAddress` to the `Order` table without a default value. This is not possible if the table is not empty.
  - Added the required column `discountAmount` to the `Order` table without a default value. This is not possible if the table is not empty.
  - Added the required column `shippingAddress` to the `Order` table without a default value. This is not possible if the table is not empty.
  - Added the required column `shippingAmount` to the `Order` table without a default value. This is not possible if the table is not empty.
  - Added the required column `subtotalAmount` to the `Order` table without a default value. This is not possible if the table is not empty.
  - Added the required column `taxAmount` to the `Order` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "billingAddress" TEXT NOT NULL,
ADD COLUMN     "discountAmount" INTEGER NOT NULL,
ADD COLUMN     "expiredAt" TIMESTAMP(3),
ADD COLUMN     "shippingAddress" TEXT NOT NULL,
ADD COLUMN     "shippingAmount" INTEGER NOT NULL,
ADD COLUMN     "subtotalAmount" INTEGER NOT NULL,
ADD COLUMN     "taxAmount" INTEGER NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Order_userId_idempotencyKey_key" ON "Order"("userId", "idempotencyKey");
