-- AlterTable
ALTER TABLE "AttendanceRecord" ADD COLUMN     "selfiePurgedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "dataRetentionMonths" INTEGER NOT NULL DEFAULT 12;

-- CreateIndex
CREATE INDEX "AttendanceRecord_companyId_selfiePurgedAt_serverTimestamp_idx" ON "AttendanceRecord"("companyId", "selfiePurgedAt", "serverTimestamp");
