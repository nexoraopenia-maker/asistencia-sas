-- Reglas de jornada y calculo laboral por empresa.
-- Solo ADD COLUMN con valor por defecto: no reescribe ni borra datos.
ALTER TABLE "Company"
  ADD COLUMN "maxShiftHours" INTEGER NOT NULL DEFAULT 16,
  ADD COLUMN "allowSplitShifts" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "dailyOrdinaryMinutes" INTEGER NOT NULL DEFAULT 480,
  ADD COLUMN "weeklyOrdinaryMinutes" INTEGER NOT NULL DEFAULT 2880,
  ADD COLUMN "overtimeThresholdMinutes" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "overtimeTier1Minutes" INTEGER NOT NULL DEFAULT 120,
  ADD COLUMN "overtimeTier1RatePct" INTEGER NOT NULL DEFAULT 25,
  ADD COLUMN "overtimeTier2RatePct" INTEGER NOT NULL DEFAULT 35,
  ADD COLUMN "nightStartTime" VARCHAR(8) NOT NULL DEFAULT '22:00:00',
  ADD COLUMN "nightEndTime" VARCHAR(8) NOT NULL DEFAULT '06:00:00',
  ADD COLUMN "nightSurchargePct" INTEGER NOT NULL DEFAULT 35,
  ADD COLUMN "nightShiftMinSharePct" INTEGER NOT NULL DEFAULT 50,
  ADD COLUMN "minimumWage" DECIMAL(10,2),
  ADD COLUMN "hourlyDivisor" INTEGER NOT NULL DEFAULT 240,
  ADD COLUMN "payrollCurrency" VARCHAR(3) NOT NULL DEFAULT 'PEN';
