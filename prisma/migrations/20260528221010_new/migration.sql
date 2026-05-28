/*
  Warnings:

  - Added the required column `variantName` to the `OrderItem` table without a default value. This is not possible if the table is not empty.
  - Made the column `verified` on table `twoFactor` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE "ProductImage" DROP CONSTRAINT "ProductImage_productId_fkey";

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "variantName" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Promotion" ALTER COLUMN "currency" DROP NOT NULL;

-- AlterTable
ALTER TABLE "twoFactor" ALTER COLUMN "verified" SET NOT NULL,
ALTER COLUMN "verified" SET DEFAULT false;

-- AddForeignKey
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
