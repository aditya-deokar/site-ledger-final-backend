-- CreateEnum
CREATE TYPE "InvestorFixedRateCadence" AS ENUM ('YEARLY', 'MONTHLY');

-- AlterTable
ALTER TABLE "Investor"
ADD COLUMN     "fixedRateCadence" "InvestorFixedRateCadence";

-- Backfill existing fixed-rate investors to annual cadence.
UPDATE "Investor"
SET "fixedRateCadence" = 'YEARLY'
WHERE "type" = 'FIXED_RATE' AND "fixedRateCadence" IS NULL;
