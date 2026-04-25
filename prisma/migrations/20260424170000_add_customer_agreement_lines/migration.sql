-- CreateEnum
CREATE TYPE "CustomerAgreementLineType" AS ENUM ('BASE_PRICE', 'CHARGE', 'TAX', 'DISCOUNT', 'CREDIT');

-- CreateTable
CREATE TABLE "CustomerAgreementLine" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "siteId" TEXT,
    "type" "CustomerAgreementLineType" NOT NULL,
    "label" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "ratePercent" DOUBLE PRECISION,
    "calculationBase" DECIMAL(18,2),
    "affectsProfit" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerAgreementLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomerAgreementLine_customerId_isDeleted_createdAt_idx" ON "CustomerAgreementLine"("customerId", "isDeleted", "createdAt");

-- CreateIndex
CREATE INDEX "CustomerAgreementLine_siteId_isDeleted_type_idx" ON "CustomerAgreementLine"("siteId", "isDeleted", "type");

-- CreateIndex
CREATE INDEX "CustomerAgreementLine_companyId_isDeleted_type_idx" ON "CustomerAgreementLine"("companyId", "isDeleted", "type");

-- AddForeignKey
ALTER TABLE "CustomerAgreementLine" ADD CONSTRAINT "CustomerAgreementLine_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill existing customers so legacy sellingPrice becomes an editable base agreement line.
INSERT INTO "CustomerAgreementLine" (
    "id",
    "customerId",
    "companyId",
    "siteId",
    "type",
    "label",
    "amount",
    "affectsProfit",
    "note",
    "createdAt",
    "updatedAt"
)
SELECT
    'legacy_agreement_' || "id",
    "id",
    "companyId",
    "siteId",
    'BASE_PRICE'::"CustomerAgreementLineType",
    'Base flat price',
    ROUND(("sellingPrice")::numeric, 2),
    true,
    'Migrated from customer selling price',
    "createdAt",
    CURRENT_TIMESTAMP
FROM "Customer";
