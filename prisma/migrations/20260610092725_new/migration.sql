/*
  Warnings:

  - The values [FULFILLED] on the enum `ORDER_STATUS` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "ORDER_STATUS_new" AS ENUM ('PENDING', 'PAID', 'SHIPPED', 'DELIVERED', 'FAILED', 'CANCELLED', 'REFUNDED', 'EXPIRED', 'RETURNED');
ALTER TABLE "public"."Order" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Order" ALTER COLUMN "status" TYPE "ORDER_STATUS_new" USING ("status"::text::"ORDER_STATUS_new");
ALTER TABLE "OrderStatusHistory" ALTER COLUMN "fromStatus" TYPE "ORDER_STATUS_new" USING ("fromStatus"::text::"ORDER_STATUS_new");
ALTER TABLE "OrderStatusHistory" ALTER COLUMN "toStatus" TYPE "ORDER_STATUS_new" USING ("toStatus"::text::"ORDER_STATUS_new");
ALTER TYPE "ORDER_STATUS" RENAME TO "ORDER_STATUS_old";
ALTER TYPE "ORDER_STATUS_new" RENAME TO "ORDER_STATUS";
DROP TYPE "public"."ORDER_STATUS_old";
ALTER TABLE "Order" ALTER COLUMN "status" SET DEFAULT 'PENDING';
COMMIT;
