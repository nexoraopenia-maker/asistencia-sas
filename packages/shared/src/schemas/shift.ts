import { z } from "zod";
import { PunchType, ShiftType } from "../enums.js";
import { dateStringSchema, idSchema, timeStringSchema } from "./common.js";

/**
 * Un turno es un tramo con tipo. Una jornada normal se compone de dos filas:
 * WORK 09:00:00-18:00:00 y LUNCH 13:00:00-14:00:00. Modelarlo asi (en vez de
 * campos `lunchStart`/`lunchEnd` dentro del turno de trabajo) permite jornadas
 * partidas, dobles refrigerios o turnos sin almuerzo sin cambiar el esquema.
 */
export const shiftSchema = z.object({
  userId: idSchema,
  date: dateStringSchema,
  type: z.nativeEnum(ShiftType),
  startTime: timeStringSchema,
  endTime: timeStringSchema,
  branchId: idSchema.optional(),
  notes: z.string().max(300).optional(),
});
export type ShiftInput = z.infer<typeof shiftSchema>;

export const createShiftSchema = shiftSchema;

export const updateShiftSchema = shiftSchema.partial().extend({ id: idSchema });
export type UpdateShiftInput = z.infer<typeof updateShiftSchema>;

/** Asignacion masiva: una plantilla aplicada a N empleados en un rango de fechas. */
export const bulkAssignShiftsSchema = z
  .object({
    userIds: z.array(idSchema).min(1).max(500),
    from: dateStringSchema,
    to: dateStringSchema,
    /** 0 = domingo ... 6 = sabado. Dias de la semana en los que aplica. */
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    branchId: idSchema.optional(),
    blocks: z
      .array(
        z.object({
          type: z.nativeEnum(ShiftType),
          startTime: timeStringSchema,
          endTime: timeStringSchema,
        }),
      )
      .min(1)
      .max(6),
    /** Si ya existen turnos en esas fechas: reemplazarlos o dejarlos intactos. */
    overwriteExisting: z.boolean().default(false),
  })
  .refine((v) => v.from <= v.to, {
    message: "La fecha inicial no puede ser posterior a la final",
    path: ["from"],
  });
export type BulkAssignShiftsInput = z.infer<typeof bulkAssignShiftsSchema>;

/** Consulta del calendario semanal del movil (`Dom 12` .. `Sab 18`). */
export const weeklyScheduleQuerySchema = z.object({
  userId: idSchema.optional(),
  /** Cualquier fecha dentro de la semana buscada. */
  weekOf: dateStringSchema,
});
export type WeeklyScheduleQuery = z.infer<typeof weeklyScheduleQuerySchema>;

export interface ShiftBlock {
  id: string;
  type: ShiftType;
  startTime: string;
  endTime: string;
  /** Duracion programada en minutos. */
  durationMinutes: number;
}

export interface PunchSummary {
  id: string;
  punchType: PunchType;
  /** `HH:mm:ss` ya convertido a la zona horaria de la empresa. */
  time: string;
  serverTimestamp: string;
  isVerified: boolean;
  hasAlert: boolean;
}

/** Un dia del CalendarStrip semanal, con lo programado y lo realmente marcado. */
export interface DaySchedule {
  date: string;
  /** Etiqueta corta para la tira semanal: "Dom", "Lun"... */
  weekdayLabel: string;
  dayOfMonth: number;
  isToday: boolean;
  work: ShiftBlock | null;
  lunch: ShiftBlock | null;
  extraBlocks: ShiftBlock[];
  punches: PunchSummary[];
  status: "SCHEDULED" | "PRESENT" | "LATE" | "ABSENT" | "REST" | "JUSTIFIED";
  /** Minutos efectivamente trabajados, descontando refrigerio. */
  workedMinutes: number;
  lunchMinutes: number;
  tardinessMinutes: number;
}

export interface WeeklySchedule {
  userId: string;
  weekStart: string;
  weekEnd: string;
  days: DaySchedule[];
  totals: {
    scheduledMinutes: number;
    workedMinutes: number;
    lunchMinutes: number;
    tardinessMinutes: number;
    overtimeMinutes: number;
  };
}
