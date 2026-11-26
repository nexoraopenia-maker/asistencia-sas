import { z } from "zod";
import { AbsenceStatus, AbsenceType } from "../enums.js";
import { dateStringSchema, idSchema } from "./common.js";

/**
 * Ausencias y excepciones: bajas medicas, tardanzas justificadas y solicitudes
 * de horas extra comparten tabla porque comparten ciclo de vida
 * (solicitud -> revision -> aprobacion/rechazo) y todas afectan al calculo de
 * nomina del mismo modo.
 */
export const createAbsenceSchema = z
  .object({
    userId: idSchema.optional(),
    type: z.nativeEnum(AbsenceType),
    startDate: dateStringSchema,
    endDate: dateStringSchema,
    reason: z.string().trim().min(5, "Describe el motivo").max(1000),
    /** Clave del justificante en S3/R2 (certificado medico, etc.). Nunca una URL publica. */
    attachmentObjectKey: z.string().max(512).optional(),
    /** Solo para OVERTIME_REQUEST. */
    requestedMinutes: z.number().int().min(1).max(1440).optional(),
  })
  .refine((v) => v.startDate <= v.endDate, {
    message: "La fecha inicial no puede ser posterior a la final",
    path: ["startDate"],
  })
  .refine(
    (v) => v.type !== AbsenceType.OVERTIME_REQUEST || v.requestedMinutes !== undefined,
    { message: "Indica los minutos de horas extra solicitados", path: ["requestedMinutes"] },
  );
export type CreateAbsenceInput = z.infer<typeof createAbsenceSchema>;

export const reviewAbsenceSchema = z.object({
  id: idSchema,
  status: z.enum([AbsenceStatus.APPROVED, AbsenceStatus.REJECTED]),
  reviewNotes: z.string().trim().max(500).optional(),
  /** Solo horas extra: minutos aprobados. Por defecto, los solicitados. */
  approvedMinutes: z.number().int().min(1).max(1440).optional(),
});
export type ReviewAbsenceInput = z.infer<typeof reviewAbsenceSchema>;

export const listAbsencesQuerySchema = z.object({
  userId: idSchema.optional(),
  branchId: idSchema.optional(),
  type: z.nativeEnum(AbsenceType).optional(),
  status: z.nativeEnum(AbsenceStatus).optional(),
  from: dateStringSchema.optional(),
  to: dateStringSchema.optional(),
});
export type ListAbsencesQuery = z.infer<typeof listAbsencesQuerySchema>;
