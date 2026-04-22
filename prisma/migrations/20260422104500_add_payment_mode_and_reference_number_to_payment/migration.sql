-- CreateEnum
CREATE TYPE "PaymentMode" AS ENUM ('CASH', 'CHEQUE', 'BANK_TRANSFER', 'UPI');

-- AlterTable
ALTER TABLE "Payment"
ADD COLUMN "paymentMode" "PaymentMode",
ADD COLUMN "referenceNumber" TEXT;
