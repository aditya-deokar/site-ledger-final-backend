-- CreateTable
CREATE TABLE "Wing" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wing_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Floor" ADD COLUMN "wingId" TEXT;

-- CreateIndex
CREATE INDEX "Wing_siteId_createdAt_idx" ON "Wing"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "Floor_wingId_floorNumber_idx" ON "Floor"("wingId", "floorNumber");

-- AddForeignKey
ALTER TABLE "Wing" ADD CONSTRAINT "Wing_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Floor" ADD CONSTRAINT "Floor_wingId_fkey" FOREIGN KEY ("wingId") REFERENCES "Wing"("id") ON DELETE SET NULL ON UPDATE CASCADE;
