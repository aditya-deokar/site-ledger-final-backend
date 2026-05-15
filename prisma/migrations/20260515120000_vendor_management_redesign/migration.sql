-- CreateEnum
CREATE TYPE "VendorStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'BLOCKED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "VendorSiteAssignmentStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- AlterTable
ALTER TABLE "Vendor"
ADD COLUMN "status" "VendorStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN "contactPersonName" TEXT,
ADD COLUMN "address" TEXT,
ADD COLUMN "gstin" TEXT,
ADD COLUMN "pan" TEXT,
ADD COLUMN "bankAccountName" TEXT,
ADD COLUMN "bankName" TEXT,
ADD COLUMN "accountNumber" TEXT,
ADD COLUMN "ifscCode" TEXT,
ADD COLUMN "upiId" TEXT,
ADD COLUMN "paymentTermsDays" INTEGER,
ADD COLUMN "notes" TEXT,
ADD COLUMN "openingBalanceAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN "openingBalanceDate" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Expense"
ADD COLUMN "billNumber" TEXT,
ADD COLUMN "billDate" TIMESTAMP(3),
ADD COLUMN "dueDate" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "VendorSiteAssignment" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "status" "VendorSiteAssignmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "isPreferred" BOOLEAN NOT NULL DEFAULT false,
    "paymentTermsDaysOverride" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VendorSiteAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VendorDocument" (
    "id" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "siteId" TEXT,
    "expenseId" TEXT,
    "documentType" TEXT NOT NULL,
    "documentName" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "note" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VendorDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Vendor_companyId_status_createdAt_idx" ON "Vendor"("companyId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "VendorSiteAssignment_vendorId_siteId_key" ON "VendorSiteAssignment"("vendorId", "siteId");

-- CreateIndex
CREATE INDEX "VendorSiteAssignment_siteId_status_createdAt_idx" ON "VendorSiteAssignment"("siteId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "VendorDocument_vendorId_uploadedAt_idx" ON "VendorDocument"("vendorId", "uploadedAt");

-- CreateIndex
CREATE INDEX "VendorDocument_expenseId_idx" ON "VendorDocument"("expenseId");

-- CreateIndex
CREATE INDEX "VendorDocument_siteId_idx" ON "VendorDocument"("siteId");

-- AddForeignKey
ALTER TABLE "VendorSiteAssignment" ADD CONSTRAINT "VendorSiteAssignment_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorSiteAssignment" ADD CONSTRAINT "VendorSiteAssignment_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorDocument" ADD CONSTRAINT "VendorDocument_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorDocument" ADD CONSTRAINT "VendorDocument_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VendorDocument" ADD CONSTRAINT "VendorDocument_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill vendor bills with bill/due dates from createdAt
UPDATE "Expense"
SET
  "billDate" = COALESCE("billDate", "createdAt"),
  "dueDate" = COALESCE("dueDate", "createdAt")
WHERE "vendorId" IS NOT NULL;

-- Backfill vendor-site assignments from historical vendor expenses
INSERT INTO "VendorSiteAssignment" (
  "id",
  "vendorId",
  "siteId",
  "status",
  "isPreferred",
  "createdAt",
  "updatedAt"
)
SELECT
  CONCAT('vsa_', md5(CONCAT("vendorId", ':', "siteId"))),
  "vendorId",
  "siteId",
  'ACTIVE'::"VendorSiteAssignmentStatus",
  false,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM (
  SELECT DISTINCT "vendorId", "siteId"
  FROM "Expense"
  WHERE "vendorId" IS NOT NULL
) AS distinct_vendor_sites
ON CONFLICT ("vendorId", "siteId") DO NOTHING;
