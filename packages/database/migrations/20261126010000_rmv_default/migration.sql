-- RMV vigente desde el 01/10/2026 (D.S. 015-2026-TR) como valor por defecto.
ALTER TABLE "Company" ALTER COLUMN "minimumWage" SET DEFAULT 1230;

-- Empresas en soles que aun no la habian configurado. No toca valores propios.
UPDATE "Company" SET "minimumWage" = 1230
WHERE "minimumWage" IS NULL AND "payrollCurrency" = 'PEN';
