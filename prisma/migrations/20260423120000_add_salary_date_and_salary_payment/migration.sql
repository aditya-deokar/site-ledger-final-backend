-- AlterEnum
ALTER TYPE "MovementType" ADD VALUE 'SALARY_PAYMENT';

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN "salaryDate" INTEGER;
