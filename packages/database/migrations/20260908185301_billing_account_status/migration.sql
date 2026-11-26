/*
  Warnings:

  - You are about to drop the column `isActive` on the `Company` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'SUSPENDED');

-- DropIndex
DROP INDEX "Company_tier_isActive_idx";

-- AlterTable
ALTER TABLE "Company" DROP COLUMN "isActive",
ADD COLUMN     "accountStatus" "AccountStatus" NOT NULL DEFAULT 'TRIALING',
ADD COLUMN     "graceEndsAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Company_tier_accountStatus_idx" ON "Company"("tier", "accountStatus");

-- CreateIndex
CREATE INDEX "Company_accountStatus_graceEndsAt_idx" ON "Company"("accountStatus", "graceEndsAt");
