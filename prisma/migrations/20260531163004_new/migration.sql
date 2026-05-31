/*
  Warnings:

  - You are about to drop the `ProductImage` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[idempotencyKey]` on the table `Order` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `imageUrl` to the `ProductVariant` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "ProductImage" DROP CONSTRAINT "ProductImage_productId_fkey";

-- DropIndex
DROP INDEX "Order_userId_idempotencyKey_key";

-- AlterTable
ALTER TABLE "Cart" ADD COLUMN     "expiresAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "brand" TEXT;

-- AlterTable
ALTER TABLE "ProductVariant" ADD COLUMN     "imageUrl" TEXT NOT NULL,
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;

-- DropTable
DROP TABLE "ProductImage";

-- CreateTable
CREATE TABLE "ProductVariantImage" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "productVariantId" TEXT NOT NULL,
    "position" INTEGER DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariantImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductVariantImage_productVariantId_idx" ON "ProductVariantImage"("productVariantId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariantImage_productVariantId_position_key" ON "ProductVariantImage"("productVariantId", "position");

-- CreateIndex
CREATE INDEX "Address_userId_idx" ON "Address"("userId");

-- CreateIndex
CREATE INDEX "Coupon_isActive_idx" ON "Coupon"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Order_idempotencyKey_key" ON "Order"("idempotencyKey");

-- CreateIndex
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

-- CreateIndex
CREATE INDEX "OrderItem_productId_idx" ON "OrderItem"("productId");

-- CreateIndex
CREATE INDEX "OrderItem_variantId_idx" ON "OrderItem"("variantId");

-- AddForeignKey
ALTER TABLE "ProductVariantImage" ADD CONSTRAINT "ProductVariantImage_productVariantId_fkey" FOREIGN KEY ("productVariantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
