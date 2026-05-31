/*
  Warnings:

  - Added the required column `shippingMethod` to the `Shipment` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "SHIPPING_METHOD" AS ENUM ('COLLISSIMO', 'FAST_DELIVERY');

-- AlterTable
ALTER TABLE "Shipment" ADD COLUMN     "shippingMethod" "SHIPPING_METHOD" NOT NULL;
