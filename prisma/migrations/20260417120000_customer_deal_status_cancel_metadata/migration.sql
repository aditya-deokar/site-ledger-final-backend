-- CreateEnum
CREATE TYPE "CustomerDealStatus" AS ENUM ('ACTIVE', 'CANCELLED');

-- AlterTable
ALTER TABLE "Customer"
ADD COLUMN     "dealStatus" "CustomerDealStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancellationReason" TEXT,
ADD COLUMN     "cancelledByUserId" TEXT,
ADD COLUMN     "cancelledFromFlatStatus" "FlatStatus",
ADD COLUMN     "cancelledFlatId" TEXT,
ADD COLUMN     "cancelledFlatDisplay" TEXT,
ADD COLUMN     "cancelledFloorNumber" INTEGER,
ADD COLUMN     "cancelledFloorName" TEXT;

-- CreateIndex
CREATE INDEX "Customer_companyId_dealStatus_createdAt_idx" ON "Customer"("companyId", "dealStatus", "createdAt");

-- CreateIndex
CREATE INDEX "Customer_siteId_dealStatus_createdAt_idx" ON "Customer"("siteId", "dealStatus", "createdAt");
